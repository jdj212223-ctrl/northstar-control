"use strict";

const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { performance } = require("node:perf_hooks");

const execFileAsync = promisify(execFile);
const previousCpuTimes = new Map();
let previousWindowsSampleAt = null;
const previousLinuxCpuTimes = new Map();
let previousLinuxTotalCpu = null;

function parseUnixProcessList(output) {
  const processes = [];
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+)\s+\d+\s+([\d.]+)\s+(\d+)\s+(.+?)\s*$/);
    if (!match) continue;
    const command = match[4];
    const cpuPercent = Number(match[2]);
    const memoryBytes = Number(match[3]) * 1024;
    if (!Number.isFinite(cpuPercent) || !Number.isFinite(memoryBytes) || !command) continue;
    processes.push({
      pid: Number(match[1]),
      name: path.basename(command),
      command,
      cpuPercent,
      memoryBytes
    });
  }
  return processes;
}

function parseLinuxProcessStat(output) {
  const match = output.match(/^(\d+) \((.*)\) (.*)$/);
  if (!match) return null;
  const fields = match[3].trim().split(/\s+/);
  const userTicks = Number(fields[11]);
  const systemTicks = Number(fields[12]);
  const ppid = Number(fields[1]);
  if (![userTicks, systemTicks, ppid].every(Number.isFinite)) return null;
  return { pid: Number(match[1]), ppid, cpuTicks: userTicks + systemTicks, name: match[2] };
}

function parseMacTopCpu(output) {
  const headers = [...output.matchAll(/^PID\s+%CPU.*$/gm)];
  if (!headers.length) throw new Error("macOS top did not report per-process CPU usage");
  const latest = output.slice(headers[headers.length - 1].index + headers[headers.length - 1][0].length);
  const cpuByPid = new Map();
  for (const line of latest.split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+)\s+([\d.]+)(?:\s|$)/);
    if (match) cpuByPid.set(Number(match[1]), Number(match[2]));
  }
  return cpuByPid;
}

function parseWindowsProcessList(output) {
  const data = JSON.parse(output.replace(/^\uFEFF/, "").trim());
  if (data === null || data === undefined) return [];
  const rows = Array.isArray(data) ? data : [data];
  return rows.flatMap((row) => {
    const pid = Number(row.pid ?? row.Id);
    const name = String(row.name ?? row.ProcessName ?? "").trim();
    if (!Number.isInteger(pid) || pid <= 0 || !name) return [];
    const rawCpuSeconds = row.cpuSeconds ?? row.CPU;
    const rawMemoryBytes = row.memoryBytes ?? row.WorkingSet64;
    const cpuSeconds = rawCpuSeconds === null || rawCpuSeconds === undefined ? null : Number(rawCpuSeconds);
    const memoryBytes = Number(rawMemoryBytes);
    return [{
      pid,
      name,
      command: String(row.command ?? row.Path ?? name).trim() || name,
      cpuSeconds: Number.isFinite(cpuSeconds) ? cpuSeconds : null,
      memoryBytes: Number.isFinite(memoryBytes) && memoryBytes >= 0 ? memoryBytes : 0
    }];
  });
}

function sampleWindowsCpu(processes, sampledAt) {
  const elapsedSeconds = previousWindowsSampleAt === null
    ? null
    : Math.max((sampledAt - previousWindowsSampleAt) / 1000, 0.001);
  const nextCpuTimes = new Map();
  const sampled = processes.map(({ cpuSeconds, ...item }) => {
    if (cpuSeconds === null) return { ...item, cpuPercent: null };
    nextCpuTimes.set(item.pid, cpuSeconds);
    const previousCpuSeconds = previousCpuTimes.get(item.pid);
    const cpuPercent = elapsedSeconds !== null && previousCpuSeconds !== undefined && cpuSeconds >= previousCpuSeconds
      ? Math.max(0, ((cpuSeconds - previousCpuSeconds) / elapsedSeconds) * 100)
      : null;
    return { ...item, cpuPercent };
  });
  previousCpuTimes.clear();
  for (const [pid, cpuSeconds] of nextCpuTimes) previousCpuTimes.set(pid, cpuSeconds);
  previousWindowsSampleAt = sampledAt;
  return sampled;
}

function groupProcesses(processes) {
  const groups = new Map();
  for (const process of processes) {
    const command = process.command || process.name;
    const key = command.toLowerCase();
    const group = groups.get(key) || {
      name: process.name,
      command,
      cpuPercent: 0,
      cpuAvailable: false,
      memoryBytes: 0,
      processCount: 0
    };
    if (Number.isFinite(process.cpuPercent)) {
      group.cpuPercent += process.cpuPercent;
      group.cpuAvailable = true;
    }
    group.memoryBytes += process.memoryBytes;
    group.processCount += 1;
    groups.set(key, group);
  }
  return [...groups.values()]
    .map(({ cpuAvailable, ...group }) => ({ ...group, cpuPercent: cpuAvailable ? group.cpuPercent : null }))
    .sort((left, right) => (right.cpuPercent ?? -1) - (left.cpuPercent ?? -1));
}

async function getLinuxProcessActivity() {
  const procRoot = "/proc";
  const [procEntries, cpuLine] = await Promise.all([
    fs.promises.readdir(procRoot),
    fs.promises.readFile(path.join(procRoot, "stat"), "utf8").then((contents) => contents.split(/\r?\n/, 1)[0])
  ]);
  const cpuFields = cpuLine.match(/^cpu\s+(.+)$/)?.[1].trim().split(/\s+/).slice(0, 8).map(Number) || [];
  const totalCpuTicks = cpuFields.reduce((total, ticks) => total + ticks, 0);
  if (!Number.isFinite(totalCpuTicks) || totalCpuTicks <= 0) throw new Error("Linux CPU counters are unavailable");

  const sampledAt = performance.now();
  const pids = procEntries.filter((entry) => /^\d+$/.test(entry));
  const rawProcesses = [];
  for (let index = 0; index < pids.length; index += 64) {
    const batch = await Promise.all(pids.slice(index, index + 64).map(async (pidText) => {
      const directory = path.join(procRoot, pidText);
      try {
        const [statText, statusText, command, comm] = await Promise.all([
          fs.promises.readFile(path.join(directory, "stat"), "utf8"),
          fs.promises.readFile(path.join(directory, "status"), "utf8"),
          fs.promises.readlink(path.join(directory, "exe")).catch(() => ""),
          fs.promises.readFile(path.join(directory, "comm"), "utf8").catch(() => "")
        ]);
        const stat = parseLinuxProcessStat(statText);
        const memoryKb = Number(statusText.match(/^VmRSS:\s+(\d+)\s+kB$/m)?.[1]);
        if (!stat || !Number.isFinite(memoryKb)) return null;
        return {
          pid: stat.pid,
          name: stat.name || comm.trim() || path.basename(command),
          command: command.replace(/ \(deleted\)$/, "") || comm.trim() || stat.name,
          cpuTicks: stat.cpuTicks,
          memoryBytes: memoryKb * 1024
        };
      } catch {
        return null;
      }
    }));
    rawProcesses.push(...batch.filter(Boolean));
  }

  const elapsedTicks = previousLinuxTotalCpu === null ? null : totalCpuTicks - previousLinuxTotalCpu;
  const currentCpuTimes = new Map();
  const processes = rawProcesses.map(({ cpuTicks, ...item }) => {
    currentCpuTimes.set(item.pid, cpuTicks);
    const previousTicks = previousLinuxCpuTimes.get(item.pid);
    const cpuPercent = elapsedTicks && previousTicks !== undefined && cpuTicks >= previousTicks
      ? ((cpuTicks - previousTicks) / elapsedTicks) * os.cpus().length * 100
      : null;
    return { ...item, cpuPercent };
  });
  previousLinuxCpuTimes.clear();
  for (const [pid, cpuTicks] of currentCpuTimes) previousLinuxCpuTimes.set(pid, cpuTicks);
  previousLinuxTotalCpu = totalCpuTicks;
  return processes;
}

async function getProcessActivity(platform = process.platform) {
  let processes;
  if (platform === "win32") {
    const powershell = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const script = "Get-Process | ForEach-Object { [pscustomobject]@{ pid=$_.Id; name=$_.ProcessName; cpuSeconds=$_.CPU; memoryBytes=$_.WorkingSet64; command=$_.Path } } | ConvertTo-Json -Compress";
    const { stdout } = await execFileAsync(powershell, ["-NoProfile", "-NonInteractive", "-Command", script], {
      timeout: 8000,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024
    });
    processes = sampleWindowsCpu(parseWindowsProcessList(stdout.trim()), performance.now());
  } else if (platform === "linux") {
    processes = await getLinuxProcessActivity();
  } else if (platform === "darwin") {
    const [processOutput, topOutput] = await Promise.all([
      execFileAsync("ps", ["-axo", "pid=,ppid=,%cpu=,rss=,comm="], {
        timeout: 8000,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024
      }),
      execFileAsync("top", ["-l", "2", "-n", "1000", "-stats", "pid,cpu"], {
        timeout: 8000,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024
      })
    ]);
    const cpuByPid = parseMacTopCpu(topOutput.stdout);
    processes = parseUnixProcessList(processOutput.stdout).map(({ pid, ...item }) => ({
      ...item,
      cpuPercent: cpuByPid.get(pid) ?? null
    }));
  } else {
    throw new Error(`Process activity is unsupported on ${platform}`);
  }
  return {
    processes: groupProcesses(processes),
    capturedAt: new Date().toISOString()
  };
}

module.exports = { getProcessActivity, groupProcesses, parseLinuxProcessStat, parseMacTopCpu, parseUnixProcessList, parseWindowsProcessList };
