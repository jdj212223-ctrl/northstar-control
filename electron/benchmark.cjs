"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { Worker } = require("node:worker_threads");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);
const CPU_ITERATIONS = 60_000_000;
const MIB = 1024 * 1024;
const DISK_SIZES_MB = Object.freeze([64, 256, 1024]);

function runCpuWorker(iterations) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, "bench-worker.cjs"), { workerData: { bench: "cpu", iterations } });
    worker.once("message", (message) => resolve(message.ms));
    worker.once("error", reject);
  });
}

async function benchCpu() {
  const threads = Math.max(1, os.availableParallelism ? os.availableParallelism() : os.cpus().length);
  const singleMs = await runCpuWorker(CPU_ITERATIONS);
  const multiTimes = await Promise.all(Array.from({ length: threads }, () => runCpuWorker(CPU_ITERATIONS)));
  const multiMs = Math.max(...multiTimes);
  const single = CPU_ITERATIONS / singleMs / 1000; // millions of iterations per second
  const multi = (CPU_ITERATIONS * threads) / multiMs / 1000;
  return {
    model: os.cpus()[0]?.model || "Unknown CPU",
    threads,
    singleScore: Math.round(single * 10),
    multiScore: Math.round(multi * 10),
    scaling: Number((multi / single).toFixed(2))
  };
}

function benchMemory() {
  const size = 64 * MIB;
  const source = Buffer.alloc(size, 0x5a);
  const target = Buffer.alloc(size);
  source.copy(target);
  const rounds = 12;
  const start = process.hrtime.bigint();
  for (let i = 0; i < rounds; i += 1) source.copy(target);
  const seconds = Number(process.hrtime.bigint() - start) / 1e9;
  return { copyGBps: Number(((size * rounds) / seconds / 1e9).toFixed(2)), totalGB: Number((os.totalmem() / 1e9).toFixed(1)) };
}

function benchDisk(directory, sizeMb, { shouldCancel = () => false, onProgress = () => {} } = {}) {
  if (!DISK_SIZES_MB.includes(sizeMb)) throw new Error("Unsupported test size.");
  const stat = fs.statSync(directory);
  if (!stat.isDirectory()) throw new Error("Target is not a folder.");
  fs.accessSync(directory, fs.constants.W_OK);
  const free = fs.statfsSync(directory);
  if (free.bavail * free.bsize < (sizeMb + 64) * MIB) throw new Error("Not enough free space for this test size.");

  const file = path.join(directory, `.northstar-bench-${crypto.randomBytes(6).toString("hex")}.tmp`);
  const chunk = crypto.randomBytes(4 * MIB);
  const chunks = (sizeMb * MIB) / chunk.length;
  try {
    let fd = fs.openSync(file, "w", 0o600);
    const writeStart = process.hrtime.bigint();
    for (let i = 0; i < chunks; i += 1) {
      if (shouldCancel()) throw new Error("Cancelled.");
      fs.writeSync(fd, chunk);
      if (i % 4 === 0) onProgress(Math.round((i / chunks) * 50));
    }
    fs.fsyncSync(fd);
    const writeSeconds = Number(process.hrtime.bigint() - writeStart) / 1e9;
    fs.closeSync(fd);

    fd = fs.openSync(file, "r");
    const readBuffer = Buffer.alloc(chunk.length);
    const readStart = process.hrtime.bigint();
    for (let i = 0; i < chunks; i += 1) {
      if (shouldCancel()) throw new Error("Cancelled.");
      fs.readSync(fd, readBuffer, 0, readBuffer.length, i * readBuffer.length);
      if (i % 4 === 0) onProgress(50 + Math.round((i / chunks) * 50));
    }
    const readSeconds = Number(process.hrtime.bigint() - readStart) / 1e9;
    fs.closeSync(fd);

    return {
      sizeMb,
      writeMBps: Math.round(sizeMb / writeSeconds),
      readMBps: Math.round(sizeMb / readSeconds),
      // The OS may serve part of the read from its cache, so read speed can be optimistic.
      readMayBeCached: true
    };
  } finally {
    fs.rmSync(file, { force: true });
  }
}

async function listVolumes(platform = process.platform) {
  const volumes = [{ id: "home", label: "This computer (home folder)", path: os.homedir(), external: false }];
  try {
    if (platform === "darwin") {
      for (const name of fs.readdirSync("/Volumes")) {
        const full = path.join("/Volumes", name);
        let real;
        try { real = fs.realpathSync(full); } catch { continue; }
        if (real === "/") continue;
        volumes.push({ id: full, label: name, path: full, external: true });
      }
    } else if (platform === "win32") {
      const removable = new Set();
      try {
        const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-Command", "Get-Volume | Where-Object DriveType -eq 'Removable' | ForEach-Object { $_.DriveLetter }"], { timeout: 6000, windowsHide: true });
        stdout.split(/\s+/).filter(Boolean).forEach((letter) => removable.add(letter.toUpperCase()));
      } catch { /* labels fall back to "Drive" */ }
      for (const letter of "CDEFGHIJKLMNOPQRSTUVWXYZ") {
        const root = `${letter}:\\`;
        if (fs.existsSync(root)) volumes.push({ id: root, label: `Drive ${letter}:${removable.has(letter) ? " (USB / removable)" : ""}`, path: root, external: removable.has(letter) });
      }
    } else {
      for (const base of [`/run/media/${os.userInfo().username}`, `/media/${os.userInfo().username}`, "/mnt"]) {
        if (!fs.existsSync(base)) continue;
        for (const name of fs.readdirSync(base)) {
          const full = path.join(base, name);
          if (fs.statSync(full).isDirectory()) volumes.push({ id: full, label: name, path: full, external: base !== "/mnt" });
        }
      }
    }
  } catch { /* the home folder entry is always available */ }
  return volumes;
}

module.exports = { benchCpu, benchMemory, benchDisk, listVolumes, DISK_SIZES_MB };
