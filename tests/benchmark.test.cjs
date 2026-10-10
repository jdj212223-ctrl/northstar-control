"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { decideFanProfile } = require("../electron/fan-curve.cjs");
const { benchDisk, benchMemory, listVolumes } = require("../electron/benchmark.cjs");

test("fan curve uses hysteresis and a hold time", () => {
  const now = 1_000_000;
  assert.equal(decideFanProfile({ tempC: 55, current: "Auto", lastChangeAt: 0, now }).profile, "Quiet");
  assert.equal(decideFanProfile({ tempC: 72, current: "Auto", lastChangeAt: 0, now }).changed, false);
  assert.equal(decideFanProfile({ tempC: 72, current: "Quiet", lastChangeAt: 0, now }).profile, "Quiet");
  assert.equal(decideFanProfile({ tempC: 80, current: "Quiet", lastChangeAt: 0, now }).profile, "Auto");
  assert.equal(decideFanProfile({ tempC: 80, current: "Quiet", lastChangeAt: now - 1000, now }).profile, "Quiet");
  assert.equal(decideFanProfile({ tempC: 95, current: "Quiet", lastChangeAt: now - 1000, now }).profile, "Auto");
  assert.equal(decideFanProfile({ tempC: null, current: "Quiet", now }).profile, "Auto");
});

test("disk benchmark measures and cleans up", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ns-bench-"));
  const result = benchDisk(dir, 64);
  assert.ok(result.writeMBps > 0 && result.readMBps > 0);
  assert.deepEqual(fs.readdirSync(dir), []);
  assert.throws(() => benchDisk(dir, 7), /Unsupported/);
  fs.rmSync(dir, { recursive: true });
});

test("memory benchmark and volume listing return data", async () => {
  assert.ok(benchMemory().copyGBps > 0);
  const volumes = await listVolumes();
  assert.equal(volumes[0].id, "home");
});
