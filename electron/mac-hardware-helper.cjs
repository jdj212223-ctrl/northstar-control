"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const fanProfiles = Object.freeze({
  Auto: "auto",
  Quiet: "quiet"
});

function parseJson(stdout) {
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

function createMacHardwareHelper(options = {}) {
  const platform = options.platform || process.platform;
  const existsSync = options.existsSync || fs.existsSync;
  const run = options.run || ((file, args) => {
    const { execFile } = require("node:child_process");
    const { promisify } = require("node:util");
    return promisify(execFile)(file, args, { timeout: 8000, windowsHide: true, maxBuffer: 1024 * 1024 });
  });
  const home = options.home || os.homedir();
  const candidates = options.candidates || [
    "/opt/homebrew/bin/smctl",
    "/usr/local/bin/smctl",
    path.join(home, ".linuxbrew", "bin", "smctl")
  ];

  function executablePath() {
    if (platform !== "darwin") return null;
    return candidates.find((candidate) => existsSync(candidate)) || null;
  }

  async function getStatus() {
    const executable = executablePath();
    if (!executable) {
      return { installed: false, daemonAvailable: false, fanAvailable: false, chargeLimitAvailable: false, fanRpm: null, chargeLimit: null };
    }

    const [fanResult, batteryResult] = await Promise.allSettled([
      run(executable, ["fan", "status", "--json"]),
      run(executable, ["battery", "status", "--json"])
    ]);
    const fans = fanResult.status === "fulfilled" ? parseJson(fanResult.value.stdout)?.fans : null;
    const fanProfile = fanResult.status === "fulfilled" ? parseJson(fanResult.value.stdout)?.profile : null;
    const battery = batteryResult.status === "fulfilled" ? parseJson(batteryResult.value.stdout) : null;
    const fan = Array.isArray(fans) ? fans.find((item) => Number.isFinite(item.actualRPM)) : null;
    const chargeLimit = battery?.configuredLimit && /^\d+$/.test(battery.configuredLimit)
      ? Number(battery.configuredLimit)
      : null;
    const daemonAvailable = fanResult.status === "fulfilled" || batteryResult.status === "fulfilled";

    return {
      installed: true,
      daemonAvailable,
      fanAvailable: Array.isArray(fans) && fans.length > 0,
      fanProfile: typeof fanProfile === "string" ? fanProfile : null,
      fanMode: typeof fan?.mode === "string" ? fan.mode : null,
      fanMinimumRpm: Number.isFinite(fan?.minimumRPM) ? Math.round(fan.minimumRPM) : null,
      fanMaximumRpm: Number.isFinite(fan?.maximumRPM) ? Math.round(fan.maximumRPM) : null,
      fanAtReportedMinimum: Number.isFinite(fan?.minimumRPM)
        && Number.isFinite(fan?.actualRPM)
        && Math.abs(fan.actualRPM - fan.minimumRPM) <= 2,
      chargeLimitAvailable: battery?.chargingControlSupported === true,
      fanRpm: fan ? Math.round(fan.actualRPM) : null,
      chargeLimit
    };
  }

  async function setFanProfile(profile) {
    if (!Object.hasOwn(fanProfiles, profile)) return { ok: false, reason: "invalid-profile" };
    const executable = executablePath();
    if (!executable) return { ok: false, reason: "helper-not-installed" };
    try {
      await run(executable, ["fan", "profile", fanProfiles[profile]]);
      return { ok: true, profile };
    } catch {
      return { ok: false, reason: "helper-or-hardware-unavailable" };
    }
  }

  async function setChargeLimit(enabled) {
    if (typeof enabled !== "boolean") return { ok: false, reason: "invalid-setting" };
    const executable = executablePath();
    if (!executable) return { ok: false, reason: "helper-not-installed" };
    try {
      await run(executable, ["battery", "maintain", enabled ? "80" : "stop"]);
      return { ok: true, enabled, chargeLimit: enabled ? 80 : null };
    } catch {
      return { ok: false, reason: "helper-or-hardware-unavailable" };
    }
  }

  // Read-only; smctl reads these without root or the daemon.
  async function getSensors() {
    const executable = executablePath();
    if (!executable) return null;
    const [sensorsResult, powerResult] = await Promise.allSettled([
      run(executable, ["sensors", "--json"]),
      run(executable, ["power", "status", "--json"])
    ]);
    const sensors = sensorsResult.status === "fulfilled" ? parseJson(sensorsResult.value.stdout) : null;
    const power = powerResult.status === "fulfilled" ? parseJson(powerResult.value.stdout) : null;
    const temps = (Array.isArray(sensors?.temperatures) ? sensors.temperatures : [])
      .filter((item) => ["Tp", "Tg"].includes(item.group) && Number.isFinite(item.celsius) && item.celsius > 0 && item.celsius < 130)
      .map((item) => item.celsius);
    const finite = (value) => (Number.isFinite(value) ? Number(value.toFixed(2)) : null);
    return {
      temperatureC: temps.length ? Math.round(Math.max(...temps)) : null,
      packagePowerW: finite(power?.packagePowerWatts),
      systemPowerW: finite(power?.systemPowerWatts),
      thermalPressure: typeof power?.thermalPressure === "string" ? power.thermalPressure : null
    };
  }

  return { getStatus, getSensors, setFanProfile, setChargeLimit };
}

module.exports = { createMacHardwareHelper };
