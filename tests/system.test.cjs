"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { getDevices, getSystemStatus, setChargeLimit, setPowerProfile } = require("../electron/main.cjs");

test("system status uses actual host telemetry with explicit unavailable values", async () => {
  const status = await getSystemStatus();

  assert.ok(["macOS", "Windows", "Linux"].includes(status.platform));
  assert.equal(typeof status.hostname, "string");
  assert.equal(typeof status.cpuModel, "string");
  assert.ok(status.cpuLoad === null || (Number.isFinite(status.cpuLoad) && status.cpuLoad >= 0 && status.cpuLoad <= 100));
  assert.ok(Number.isFinite(status.memoryTotalBytes) && status.memoryTotalBytes > 0);
  assert.ok(Number.isFinite(status.memoryFreeBytes) && status.memoryFreeBytes > 0);
  assert.ok(status.battery === null || (Number.isFinite(status.battery.percent) && status.battery.percent >= 0 && status.battery.percent <= 100));
  assert.ok(status.temperatureC === null || Number.isFinite(status.temperatureC));
  assert.ok(status.fanRpm === null || Number.isFinite(status.fanRpm));
});

test("USB enumeration returns only named host devices", async () => {
  const devices = await getDevices();
  assert.ok(Array.isArray(devices));
  for (const device of devices) {
    assert.equal(typeof device.name, "string");
    assert.ok(device.name.length > 0);
    assert.equal(typeof device.bus, "string");
  }
});

test("unsupported or malformed control requests fail without touching hardware", async () => {
  assert.deepEqual(await setPowerProfile("Unrestricted"), { ok: false, reason: "invalid-profile" });
  assert.deepEqual(await setChargeLimit("80"), { ok: false, reason: "invalid-setting" });
});
