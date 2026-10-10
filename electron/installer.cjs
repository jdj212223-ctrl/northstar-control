"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn, execFileSync } = require("node:child_process");
const { Readable } = require("node:stream");
const { pipeline } = require("node:stream/promises");

const DOWNLOAD_PREFIX = "https://github.com/jdj212223-ctrl/northstar-control/releases/download/";
const MAX_BYTES = 600 * 1024 * 1024;

function pickAsset(assets, { platform, appImage }) {
  const find = (re) => assets.find((asset) => re.test(asset.name) && asset.url.startsWith(DOWNLOAD_PREFIX));
  if (platform === "win32") return find(/^Northstar\.Control\.Setup\.[\d.]+\.exe$/);
  if (platform === "darwin") return find(/-universal-mac\.zip$/);
  if (platform === "linux" && appImage) return find(/\.AppImage$/);
  return undefined;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

async function download(asset, destination, fetchImpl) {
  const expected = /^sha256:([0-9a-f]{64})$/i.exec(asset.digest || "");
  if (!expected) throw new Error("The release has no SHA-256 checksum, so it will not be installed automatically.");
  const response = await fetchImpl(asset.url, { headers: { "User-Agent": "Northstar-Control" }, redirect: "follow" });
  if (!response.ok || !response.body) throw new Error(`Download failed (${response.status}).`);
  const hash = crypto.createHash("sha256");
  let bytes = 0;
  const source = Readable.fromWeb(response.body);
  source.on("data", (chunk) => {
    bytes += chunk.length;
    hash.update(chunk);
    if (bytes > MAX_BYTES) source.destroy(new Error("Download is larger than expected."));
  });
  await pipeline(source, fs.createWriteStream(destination, { mode: 0o600 }));
  if (hash.digest("hex") !== expected[1].toLowerCase()) {
    fs.rmSync(destination, { force: true });
    throw new Error("Downloaded update failed its checksum and was discarded.");
  }
}

function macAppPath(execPath) {
  const match = /^(.*\.app)\/Contents\/MacOS\//.exec(execPath);
  return match ? match[1] : null;
}

function launchDetached(command, args) {
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.unref();
}

// Returns { ok, manual?, message } and calls quit() when the handoff is ready.
async function installUpdate({ assets, platform = process.platform, execPath = process.execPath, env = process.env, fetchImpl = globalThis.fetch, quit, tmpRoot = os.tmpdir() }) {
  const appImage = env.APPIMAGE && fs.existsSync(env.APPIMAGE) ? env.APPIMAGE : null;
  const asset = pickAsset(assets || [], { platform, appImage });
  if (!asset) return { ok: false, manual: true, message: "This install type can't update itself. Opening the release page instead." };

  const dir = fs.mkdtempSync(path.join(tmpRoot, "northstar-update-"));
  const file = path.join(dir, asset.name);
  await download(asset, file, fetchImpl);

  if (platform === "win32") {
    launchDetached(file, ["/S", "--force-run"]);
    quit();
    return { ok: true, message: "Installing…" };
  }

  if (platform === "darwin") {
    const target = macAppPath(execPath);
    if (!target) return { ok: false, manual: true, message: "Could not locate the installed app." };
    try { fs.accessSync(path.dirname(target), fs.constants.W_OK); } catch {
      return { ok: false, manual: true, message: "The app folder isn't writable, so it can't update itself." };
    }
    const extracted = path.join(dir, "extracted");
    fs.mkdirSync(extracted);
    execFileSync("/usr/bin/ditto", ["-x", "-k", file, extracted]);
    const bundle = fs.readdirSync(extracted).find((name) => name.endsWith(".app"));
    if (!bundle) throw new Error("The update package did not contain an app.");
    const staged = path.join(extracted, bundle);
    const script = path.join(dir, "install.sh");
    fs.writeFileSync(script, [
      "#!/bin/sh",
      `while kill -0 ${process.pid} 2>/dev/null; do sleep 0.3; done`,
      `BACKUP=${shellQuote(target + ".old")}`,
      `rm -rf "$BACKUP"`,
      `mv ${shellQuote(target)} "$BACKUP" || exit 1`,
      `if /usr/bin/ditto ${shellQuote(staged)} ${shellQuote(target)}; then`,
      `  /usr/bin/xattr -cr ${shellQuote(target)}`,
      `  rm -rf "$BACKUP"`,
      "else",
      `  rm -rf ${shellQuote(target)}; mv "$BACKUP" ${shellQuote(target)}`,
      "fi",
      `/usr/bin/open ${shellQuote(target)}`,
      `rm -rf ${shellQuote(dir)}`
    ].join("\n"), { mode: 0o700 });
    launchDetached("/bin/sh", [script]);
    quit();
    return { ok: true, message: "Installing…" };
  }

  // Linux AppImage: replace the file in place, then start it.
  fs.chmodSync(file, 0o755);
  const backup = `${appImage}.old`;
  fs.renameSync(appImage, backup);
  try {
    fs.copyFileSync(file, appImage);
    fs.chmodSync(appImage, 0o755);
    fs.rmSync(backup, { force: true });
  } catch (error) {
    fs.rmSync(appImage, { force: true });
    fs.renameSync(backup, appImage);
    throw error;
  }
  launchDetached(appImage, []);
  quit();
  return { ok: true, message: "Installing…" };
}

module.exports = { installUpdate, pickAsset, macAppPath, DOWNLOAD_PREFIX };
