"use strict";

const { pathToFileURL } = require("node:url");
const isElectron = Boolean(process.versions.electron);
const electron = isElectron ? require("electron") : null;
const { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } = electron || {};
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { createGitHubAuth } = require("./github-auth.cjs");
const { createRemoteAgent } = require("./remote-agent.cjs");
const { createMacHardwareHelper } = require("./mac-hardware-helper.cjs");
const { getProcessActivity } = require("./activity-monitor.cjs");
const { createUpdater, RELEASE_PREFIX } = require("./updater.cjs");
const { installUpdate } = require("./installer.cjs");

const execFileAsync = promisify(execFile);
const powerPlanIds = Object.freeze({
  Efficiency: "a1841308-3541-4fab-bc81-f71556f20b4a",
  Balanced: "381b4222-f694-41f0-9685-ff5bb260df2e",
  Performance: "8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c"
});
const profilesById = Object.freeze({
  "power-saver": "Efficiency",
  balanced: "Balanced",
  performance: "Performance"
});
const validProfiles = new Set(["Efficiency", "Balanced", "Performance"]);
let githubAuth;
let remoteAgent;
let updater;
const DEFAULT_GITHUB_CLIENT_ID = "Ov23liuh8l0EjSIdKmzt";
const windowsSystemRoot = process.env.SystemRoot || "C:\\Windows";
const windowsPowerCfg = path.join(windowsSystemRoot, "System32", "powercfg.exe");
const windowsPowerShell = path.join(windowsSystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const windowOptions = {
  width: 1360,
  height: 900,
  minWidth: 840,
  minHeight: 650,
  title: "Northstar Control",
  backgroundColor: "#0c0e13",
  ...(process.platform === "win32" || process.platform === "linux"
    ? { icon: path.join(__dirname, "..", "assets", process.platform === "win32" ? "northstar.ico" : "northstar.png") }
    : {}),
  show: false,
  webPreferences: {
    preload: path.join(__dirname, "preload.cjs"),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webSecurity: true
  }
};

function run(file, args, timeout = 5000) {
  return execFileAsync(file, args, { timeout, windowsHide: true, maxBuffer: 1024 * 1024 });
}

function platformName() {
  if (process.platform === "darwin") return "macOS";
  if (process.platform === "win32") return "Windows";
  if (process.platform === "linux") return "Linux";
  return process.platform;
}

async function readLinuxBattery() {
  const root = "/sys/class/power_supply";
  let entries;
  try {
    entries = await fs.promises.readdir(root);
  } catch {
    return null;
  }
  for (const entry of entries) {
    const directory = path.join(root, entry);
    let type;
    try {
      type = (await fs.promises.readFile(path.join(directory, "type"), "utf8")).trim();
    } catch {
      continue;
    }
    if (type !== "Battery") continue;
    try {
      const [capacity, status] = await Promise.all([
        fs.promises.readFile(path.join(directory, "capacity"), "utf8"),
        fs.promises.readFile(path.join(directory, "status"), "utf8")
      ]);
      const percent = Number.parseInt(capacity, 10);
      if (Number.isFinite(percent) && percent >= 0 && percent <= 100) {
        return { percent, status: status.trim() };
      }
    } catch {
      return null;
    }
  }
  return null;
}

async function readMacBattery() {
  try {
    const { stdout } = await run("/usr/sbin/ioreg", ["-r", "-c", "AppleSmartBattery", "-d", "1"], 4000);
    const current = stdout.match(/"CurrentCapacity"\s*=\s*(\d+)/);
    const maximum = stdout.match(/"MaxCapacity"\s*=\s*(\d+)/);
    const charging = /"IsCharging"\s*=\s*Yes/.test(stdout);
    if (!current || !maximum || Number(maximum[1]) === 0) return null;
    const percent = Math.max(0, Math.min(100, Math.round((Number(current[1]) / Number(maximum[1])) * 100)));
    return { percent, status: charging ? "Charging" : "On battery" };
  } catch {
    return null;
  }
}

async function readWindowsBattery() {
  const script = "$b=Get-CimInstance -ClassName Win32_Battery | Select-Object -First 1 EstimatedChargeRemaining,BatteryStatus; if ($null -eq $b) { 'null' } else { $b | ConvertTo-Json -Compress }";
  try {
    const { stdout } = await run(windowsPowerShell, ["-NoProfile", "-NonInteractive", "-Command", script], 7000);
    const data = JSON.parse(stdout.trim());
    if (!data || !Number.isFinite(data.EstimatedChargeRemaining)) return null;
    const charging = [2, 6, 7, 8, 9].includes(Number(data.BatteryStatus));
    return { percent: data.EstimatedChargeRemaining, status: charging ? "Charging" : "On battery" };
  } catch {
    return null;
  }
}

async function readBattery() {
  if (process.platform === "linux") return readLinuxBattery();
  if (process.platform === "darwin") return readMacBattery();
  if (process.platform === "win32") return readWindowsBattery();
  return null;
}

async function readLinuxSensors() {
  const result = { temperatureC: null, temperatureSource: null, fanRpm: null, chargeLimit: null, writableChargeLimit: false };
  try {
    const thermalZones = await fs.promises.readdir("/sys/class/thermal");
    const temperatures = [];
    for (const zone of thermalZones.filter((name) => /^thermal_zone\d+$/.test(name))) {
      try {
        const source = (await fs.promises.readFile(path.join("/sys/class/thermal", zone, "type"), "utf8").catch(() => "system sensor")).trim();
        const raw = Number.parseInt(await fs.promises.readFile(path.join("/sys/class/thermal", zone, "temp"), "utf8"), 10);
        if (Number.isFinite(raw) && raw > 0) {
          const celsius = raw > 1000 ? raw / 1000 : raw;
          if (celsius > -30 && celsius < 130) temperatures.push({ celsius: Math.round(celsius), source });
        }
      } catch {
        continue;
      }
    }
    const reading = temperatures.find(({ source }) => /cpu|pkg|soc/i.test(source)) || temperatures[0];
    if (reading) {
      result.temperatureC = reading.celsius;
      result.temperatureSource = reading.source;
    }
  } catch {
    // Thermal zones are optional kernel interfaces.
  }
  try {
    const hwmonRoots = await fs.promises.readdir("/sys/class/hwmon");
    for (const root of hwmonRoots) {
      const directory = path.join("/sys/class/hwmon", root);
      const files = await fs.promises.readdir(directory);
      for (const file of files.filter((name) => /^fan\d+_input$/.test(name))) {
        try {
          const rpm = Number.parseInt(await fs.promises.readFile(path.join(directory, file), "utf8"), 10);
          if (Number.isFinite(rpm) && rpm > 0) {
            result.fanRpm = rpm;
            break;
          }
        } catch {
          continue;
        }
      }
      if (result.fanRpm !== null) break;
    }
  } catch {
    // Hardware monitor interfaces are optional and may require kernel drivers.
  }
  try {
    const supplies = await fs.promises.readdir("/sys/class/power_supply");
    for (const supply of supplies) {
      const directory = path.join("/sys/class/power_supply", supply);
      try {
        const type = (await fs.promises.readFile(path.join(directory, "type"), "utf8")).trim();
        if (type !== "Battery") continue;
        for (const name of ["charge_control_end_threshold", "charge_behaviour", "charge_control_end_threshold_max"]) {
          const candidate = path.join(directory, name);
          try {
            const value = Number.parseInt(await fs.promises.readFile(candidate, "utf8"), 10);
            if (name === "charge_control_end_threshold" && Number.isFinite(value)) {
              result.chargeLimit = value;
              await fs.promises.access(candidate, fs.constants.W_OK);
              result.writableChargeLimit = true;
              break;
            }
          } catch {
            continue;
          }
        }
      } catch {
        continue;
      }
    }
  } catch {
    // Battery thresholds are not exposed by every device.
  }
  return result;
}

async function readPowerProfile() {
  if (process.platform === "linux") {
    for (const candidate of ["/usr/bin/powerprofilesctl", "/usr/local/bin/powerprofilesctl", "/bin/powerprofilesctl"]) {
      if (!fs.existsSync(candidate)) continue;
      try {
        const [{ stdout: active }, { stdout: listed }] = await Promise.all([run(candidate, ["get"]), run(candidate, ["list"])]);
        const profile = active.trim().toLowerCase();
        const availableIds = Object.keys(profilesById).filter((id) => listed.toLowerCase().includes(`${id}:`));
        return {
          current: profilesById[profile] || "Unknown",
          supported: availableIds.length > 0,
          available: availableIds.map((id) => profilesById[id])
        };
      } catch {
        return { current: "Unknown", supported: false, available: [] };
      }
    }
    return { current: "Unknown", supported: false, available: [] };
  }
  if (process.platform === "win32") {
    try {
      const { stdout } = await run(windowsPowerCfg, ["/list"]);
      const available = Object.entries(powerPlanIds)
        .filter(([, id]) => stdout.toLowerCase().includes(id))
        .map(([name]) => name);
      const active = stdout.match(/([a-f0-9-]{36})\s*\*/i);
      return {
        current: active ? (Object.keys(powerPlanIds).find((name) => powerPlanIds[name] === active[1].toLowerCase()) || "Custom") : "Unknown",
        supported: available.length > 0,
        available
      };
    } catch {
      return { current: "Unknown", supported: false, available: [] };
    }
  }
  return { current: "Managed by macOS", supported: false, available: [] };
}

async function cpuLoadPercent() {
  const first = os.cpus();
  await new Promise((resolve) => setTimeout(resolve, 120));
  const second = os.cpus();
  let idle = 0;
  let total = 0;
  for (let index = 0; index < second.length; index += 1) {
    const before = first[index].times;
    const after = second[index].times;
    const idleDelta = after.idle - before.idle;
    const totalDelta = Object.keys(after).reduce((sum, key) => sum + after[key] - before[key], 0);
    idle += idleDelta;
    total += totalDelta;
  }
  return total ? Math.max(0, Math.min(100, Math.round((1 - idle / total) * 100))) : null;
}

let statusCache = { at: 0, pending: null };

// Share one sample between the UI and the remote agent so hardware probes are not spawned repeatedly.
function getSystemStatus() {
  if (statusCache.pending && Date.now() - statusCache.at < 8000) return statusCache.pending;
  statusCache = { at: Date.now(), pending: readSystemStatus() };
  statusCache.pending.catch(() => { statusCache = { at: 0, pending: null }; });
  return statusCache.pending;
}

async function readSystemStatus() {
  const macHelper = createMacHardwareHelper();
  const [battery, sensors, powerProfile, cpuLoad, hardwareControls] = await Promise.all([
    readBattery(),
    process.platform === "linux" ? readLinuxSensors() : Promise.resolve({ temperatureC: null, temperatureSource: null, fanRpm: null, chargeLimit: null, writableChargeLimit: false }),
    readPowerProfile(),
    cpuLoadPercent(),
    process.platform === "darwin"
      ? macHelper.getStatus()
      : Promise.resolve({ installed: false, daemonAvailable: false, fanAvailable: false, chargeLimitAvailable: false, fanRpm: null, chargeLimit: null })
  ]);
  return {
    platform: platformName(),
    hostname: os.hostname(),
    cpuModel: os.cpus()[0]?.model || "CPU information unavailable",
    cpuLoad,
    uptimeSeconds: os.uptime(),
    memoryTotalBytes: os.totalmem(),
    memoryFreeBytes: os.freemem(),
    battery,
    temperatureC: sensors.temperatureC,
    fanRpm: hardwareControls.fanRpm ?? sensors.fanRpm,
    fanMode: hardwareControls.fanMode ?? null,
    fanMinimumRpm: hardwareControls.fanMinimumRpm ?? null,
    fanMaximumRpm: hardwareControls.fanMaximumRpm ?? null,
    chargeLimit: hardwareControls.chargeLimit ?? sensors.chargeLimit,
    writableChargeLimit: hardwareControls.chargeLimitAvailable || sensors.writableChargeLimit,
    hardwareControls,
    powerProfile
  };
}

async function getDevices() {
  if (process.platform === "linux") {
    const root = "/sys/bus/usb/devices";
    const names = await fs.promises.readdir(root);
    const devices = [];
    for (const name of names) {
      if (!/^\d+-[\d.]+$/.test(name)) continue;
      const directory = path.join(root, name);
      try {
        const [product, manufacturer] = await Promise.all([
          fs.promises.readFile(path.join(directory, "product"), "utf8").catch(() => ""),
          fs.promises.readFile(path.join(directory, "manufacturer"), "utf8").catch(() => "")
        ]);
        const label = [manufacturer.trim(), product.trim()].filter(Boolean).join(" ");
        if (label) devices.push({ name: label, bus: name });
      } catch {
        continue;
      }
    }
    return devices;
  }
  if (process.platform === "win32") {
    const script = "Get-PnpDevice -Class USB -ErrorAction SilentlyContinue | Where-Object { $_.Status -eq 'OK' } | Select-Object -First 30 FriendlyName,InstanceId | ConvertTo-Json -Compress";
    const { stdout } = await run(windowsPowerShell, ["-NoProfile", "-NonInteractive", "-Command", script], 7000);
    if (!stdout.trim()) return [];
    const result = JSON.parse(stdout.trim());
    return (Array.isArray(result) ? result : [result]).map((item) => ({ name: item.FriendlyName || "USB device", bus: item.InstanceId || "" }));
  }
  if (process.platform === "darwin") {
    const { stdout } = await run("/usr/sbin/ioreg", ["-p", "IOUSB", "-l", "-w", "0"], 5000);
    const devices = [];
    for (const match of stdout.matchAll(/"USB Product Name"\s*=\s*"([^"]+)"/g)) devices.push({ name: match[1], bus: "" });
    return devices;
  }
  return [];
}

async function setPowerProfile(profile) {
  if (!validProfiles.has(profile)) return { ok: false, reason: "invalid-profile" };
  if (process.platform === "linux") {
    const profileId = { Efficiency: "power-saver", Balanced: "balanced", Performance: "performance" }[profile];
    for (const candidate of ["/usr/bin/powerprofilesctl", "/usr/local/bin/powerprofilesctl", "/bin/powerprofilesctl"]) {
      if (!fs.existsSync(candidate)) continue;
      try {
        const { stdout: available } = await run(candidate, ["list"]);
        if (!available.toLowerCase().includes(`${profileId}:`)) return { ok: false, reason: "profile-not-installed" };
        await run(candidate, ["set", profileId]);
        return { ok: true, profile };
      } catch (error) {
        return { ok: false, reason: error.code === "ENOENT" ? "unsupported" : "authorization-or-platform-error" };
      }
    }
    return { ok: false, reason: "unsupported" };
  }
  if (process.platform === "win32") {
    const planId = powerPlanIds[profile];
    try {
      const { stdout } = await run(windowsPowerCfg, ["/list"]);
      if (!stdout.toLowerCase().includes(planId)) return { ok: false, reason: "profile-not-installed" };
      await run(windowsPowerCfg, ["/setactive", planId]);
      return { ok: true, profile };
    } catch {
      return { ok: false, reason: "authorization-or-platform-error" };
    }
  }
  return { ok: false, reason: "managed-by-operating-system" };
}

async function setChargeLimit(enabled) {
  if (typeof enabled !== "boolean") return { ok: false, reason: "invalid-setting" };
  if (process.platform === "darwin") {
    const helper = createMacHardwareHelper();
    const status = await helper.getStatus();
    if (!status.chargeLimitAvailable) return { ok: false, reason: status.installed ? "helper-or-hardware-unavailable" : "helper-not-installed" };
    const confirmed = await confirmHardwareChange(
      "Change battery charge limit?",
      enabled ? "Keep this MacBook's battery near 80% while connected to power?" : "Return battery charging to normal macOS control?"
    );
    if (!confirmed) return { ok: false, reason: "cancelled" };
    return helper.setChargeLimit(enabled);
  }
  if (process.platform !== "linux") return { ok: false, reason: "unsupported" };
  let supplies;
  try {
    supplies = await fs.promises.readdir("/sys/class/power_supply");
  } catch {
    return { ok: false, reason: "unsupported" };
  }
  for (const supply of supplies) {
    const directory = path.join("/sys/class/power_supply", supply);
    try {
      const type = (await fs.promises.readFile(path.join(directory, "type"), "utf8")).trim();
      if (type !== "Battery") continue;
      const setting = path.join(directory, "charge_control_end_threshold");
      await fs.promises.access(setting, fs.constants.W_OK);
      await fs.promises.writeFile(setting, enabled ? "80" : "100", "utf8");
      return { ok: true, enabled };
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "EACCES" && error.code !== "EPERM") return { ok: false, reason: "hardware-write-failed" };
    }
  }
  return { ok: false, reason: "helper-or-hardware-required" };
}

async function confirmHardwareChange(message, detail) {
  const result = await dialog.showMessageBox({
    type: "warning",
    title: "Confirm hardware change",
    message,
    detail,
    buttons: ["Cancel", "Apply"],
    defaultId: 0,
    cancelId: 0,
    noLink: true
  });
  return result.response === 1;
}

async function setFanProfile(profile) {
  if (!["Auto", "Quiet"].includes(profile)) return { ok: false, reason: "invalid-profile" };
  if (process.platform !== "darwin") return { ok: false, reason: "unsupported" };
  const helper = createMacHardwareHelper();
  const status = await helper.getStatus();
  if (!status.fanAvailable) return { ok: false, reason: status.installed ? "helper-or-hardware-unavailable" : "helper-not-installed" };
  const confirmed = await confirmHardwareChange(
    `Apply ${profile.toLowerCase()} fan profile?`,
    "Fan behavior is hardware-dependent. You can restore automatic fan control at any time."
  );
  if (!confirmed) return { ok: false, reason: "cancelled" };
  return helper.setFanProfile(profile);
}

function getMacHelperAccessMessage(status) {
  if (status.installed && status.daemonAvailable) {
    const capabilities = [
      status.fanAvailable ? "Fan telemetry is available." : "This Mac did not report a controllable fan.",
      status.chargeLimitAvailable ? "Battery charge control is available." : "This Mac did not report battery charge-limit support."
    ];
    return {
      message: "The macOS hardware helper is installed and running.",
      detail: `${capabilities.join(" ")} USB port power is not supported.`
    };
  }
  if (status.installed) {
    return {
      message: "The smctl command is installed, but its helper is not responding.",
      detail: "Authorize or restart the helper from Terminal with `sudo smctl daemon install`. Northstar does not run privileged installers for you."
    };
  }
  return {
    message: "The optional macOS hardware helper is not installed.",
    detail: "For supported Apple Silicon Macs, download the signed smctl release from https://github.com/leaperone/smctl/releases and install its smctl and smctld binaries. Then run `sudo smctl daemon install` in Terminal. The Homebrew formula builds from source and requires the full Xcode app. USB port power is not supported."
  };
}

function registerIpc() {
  function assertLocalRenderer(event) {
    const expected = pathToFileURL(path.join(__dirname, "..", "app", "index.html")).href;
    if (event.senderFrame?.url !== expected) throw new Error("Rejected IPC from an untrusted renderer");
  }
  ipcMain.handle("system:activity", (event) => { assertLocalRenderer(event); return getProcessActivity(); });
  ipcMain.handle("system:status", (event) => { assertLocalRenderer(event); return getSystemStatus(); });
  ipcMain.handle("system:devices", (event) => { assertLocalRenderer(event); return getDevices(); });
  ipcMain.handle("system:set-power-profile", (event, profile) => { assertLocalRenderer(event); return setPowerProfile(profile); });
  ipcMain.handle("system:set-charge-limit", (event, enabled) => { assertLocalRenderer(event); return setChargeLimit(enabled); });
  ipcMain.handle("system:set-fan-profile", (event, profile) => { assertLocalRenderer(event); return setFanProfile(profile); });
  ipcMain.handle("system:request-hardware-access", async (event) => {
    assertLocalRenderer(event);
    if (process.platform === "darwin") {
      const helperStatus = await createMacHardwareHelper().getStatus();
      const helperMessage = getMacHelperAccessMessage(helperStatus);
      await dialog.showMessageBox({
        type: "info",
        title: "macOS hardware helper status",
        ...helperMessage,
        buttons: ["OK"],
        noLink: true
      });
      return helperStatus.daemonAvailable
        ? { ok: true }
        : { ok: false, reason: "macos-helper-not-ready" };
    }
    await dialog.showMessageBox({
      type: "info",
      title: "Hardware service unavailable",
      message: "This build has no authorized hardware service.",
      detail: "Only public operating-system controls exposed by your device are available. Fan, USB power and overclock controls need additional hardware-specific services.",
      buttons: ["OK"],
      noLink: true
    });
    return { ok: false, reason: "hardware-service-not-installed" };
  });
  ipcMain.handle("remote:status", async (event) => { assertLocalRenderer(event); return remoteAgent.status(); });
  ipcMain.handle("remote:pair", async (event, options) => {
    assertLocalRenderer(event);
    if (!options || typeof options !== "object" || Array.isArray(options)) return { ok: false, reason: "invalid-pairing-request" };
    return remoteAgent.pair({
      serverUrl: options.serverUrl,
      code: options.code,
      name: options.name
    });
  });
  ipcMain.handle("remote:unpair", async (event) => { assertLocalRenderer(event); return remoteAgent.unpair(); });
  ipcMain.handle("github:status", (event) => { assertLocalRenderer(event); return githubAuth.getStatus(); });
  ipcMain.handle("github:save-client-id", (event, clientId) => { assertLocalRenderer(event); return githubAuth.saveClientId(clientId); });
  ipcMain.handle("github:begin", (event) => { assertLocalRenderer(event); return githubAuth.begin(); });
  ipcMain.handle("github:poll", (event) => { assertLocalRenderer(event); return githubAuth.poll(); });
  ipcMain.handle("github:cancel", (event) => { assertLocalRenderer(event); return githubAuth.cancel(); });
  ipcMain.handle("github:sign-out", (event) => { assertLocalRenderer(event); return githubAuth.signOut(); });
  ipcMain.handle("update:state", (event) => { assertLocalRenderer(event); return updater.getState(); });
  ipcMain.handle("update:check", (event) => { assertLocalRenderer(event); return updater.check(); });
  ipcMain.handle("update:open", async (event) => {
    assertLocalRenderer(event);
    const { url } = updater.getState();
    if (url && url.startsWith(RELEASE_PREFIX)) await shell.openExternal(url);
  });
  let installing = false;
  ipcMain.handle("update:install", async (event) => {
    assertLocalRenderer(event);
    const state = updater.getState();
    if (!state.available || installing) return { ok: false, message: "No update to install." };
    installing = true;
    try {
      const result = await installUpdate({ assets: state.assets, quit: () => setTimeout(() => app.quit(), 300) });
      if (result.manual && state.url && state.url.startsWith(RELEASE_PREFIX)) await shell.openExternal(state.url);
      if (!result.ok) installing = false;
      return result;
    } catch (error) {
      installing = false;
      return { ok: false, message: error.message };
    }
  });
  ipcMain.handle("github:open-registration", async (event) => {
    assertLocalRenderer(event);
    await shell.openExternal("https://github.com/settings/developers");
  });
  ipcMain.handle("github:open-verification", async (event) => {
    assertLocalRenderer(event);
    await shell.openExternal("https://github.com/login/device");
  });
}

async function runTerminalCommand(command) {
  const [file, args] = process.platform === "win32"
    ? [windowsPowerShell, ["-NoProfile", "-NonInteractive", "-Command", command]]
    : ["/bin/sh", ["-c", command]];
  try {
    const { stdout, stderr } = await execFileAsync(file, args, { timeout: 10000, maxBuffer: 64 * 1024, windowsHide: true });
    return { ok: true, output: `${stdout}${stderr}`.slice(0, 8000) };
  } catch (error) {
    const output = `${error.stdout || ""}${error.stderr || ""}` || error.message;
    return { ok: false, reason: error.killed ? "command-timed-out" : "command-failed", output: String(output).slice(0, 8000) };
  }
}

function lockDownSession(electronSession) {
  electronSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  electronSession.setPermissionCheckHandler(() => false);
  // The UI only ever talks to the main process over IPC; block every other network request from it.
  electronSession.webRequest.onBeforeRequest((details, callback) => {
    const allowed = details.url.startsWith("file://") || details.url.startsWith("devtools://") || details.url.startsWith("data:");
    callback({ cancel: !allowed });
  });
}

function createWindow() {
  const window = new BrowserWindow(windowOptions);
  window.once("ready-to-show", () => window.show());
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
  window.webContents.on("will-redirect", (event) => event.preventDefault());
  window.webContents.on("will-navigate", (event, destination) => {
    if (destination !== pathToFileURL(path.join(__dirname, "..", "app", "index.html")).href) event.preventDefault();
  });
  window.loadFile(path.join(__dirname, "..", "app", "index.html"));
}

if (isElectron) {
  app.whenReady().then(() => {
    if (process.platform === "linux") safeStorage.setUsePlainTextEncryption(false);
    githubAuth = createGitHubAuth({
      defaultClientId: DEFAULT_GITHUB_CLIENT_ID,
      safeStorage,
      storagePath: path.join(app.getPath("userData"), "github-account.json")
    });
    remoteAgent = createRemoteAgent({
      safeStorage,
      storagePath: path.join(app.getPath("userData"), "remote-device.json"),
      getSystemStatus,
      setPowerProfile,
      setChargeLimit,
      runTerminal: runTerminalCommand,
      confirmCommand: async ({ title, message, detail, confirmLabel }) => {
        const result = await dialog.showMessageBox({
          type: "warning",
          title,
          message,
          detail,
          buttons: ["Decline", confirmLabel],
          defaultId: 0,
          cancelId: 0,
          noLink: true
        });
        return result.response === 1;
      }
    });
    updater = createUpdater({
      currentVersion: app.getVersion(),
      onChange: (state) => {
        for (const window of BrowserWindow.getAllWindows()) window.webContents.send("update:changed", state);
      }
    });
    void remoteAgent.start().catch((error) => {
      console.error("Could not restore the Northstar remote-device connection:", error.message);
    });
    registerIpc();
    lockDownSession(electron.session.defaultSession);
    createWindow();
    updater.start();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
  app.on("before-quit", () => remoteAgent?.stop());
}

module.exports = { getSystemStatus, getDevices, getProcessActivity, setPowerProfile, setChargeLimit, setFanProfile, getMacHelperAccessMessage };
