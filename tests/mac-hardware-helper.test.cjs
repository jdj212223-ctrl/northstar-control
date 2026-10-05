"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createMacHardwareHelper } = require("../electron/mac-hardware-helper.cjs");

function helperWith(run, options = {}) {
  return createMacHardwareHelper({
    platform: options.platform || "darwin",
    candidates: ["/test/smctl"],
    existsSync: () => options.installed !== false,
    run
  });
}

test("macOS helper reports fan and charging capabilities from the installed daemon", async () => {
  const helper = helperWith(async (_file, args) => ({
    stdout: args[0] === "fan"
      ? JSON.stringify({ profile: "auto", fans: [{ actualRPM: 1200, minimumRPM: 1000, maximumRPM: 4900, mode: "auto" }] })
      : JSON.stringify({ chargingControlSupported: true, configuredLimit: "80" })
  }));

  assert.deepEqual(await helper.getStatus(), {
    installed: true,
    daemonAvailable: true,
    fanAvailable: true,
    fanProfile: "auto",
    fanMode: "auto",
    fanMinimumRpm: 1000,
    fanMaximumRpm: 4900,
    chargeLimitAvailable: true,
    fanRpm: 1200,
    chargeLimit: 80
  });
});

test("macOS helper reports absent installation and does not execute commands", async () => {
  let calls = 0;
  const helper = helperWith(async () => { calls += 1; }, { installed: false });

  assert.equal((await helper.getStatus()).installed, false);
  assert.deepEqual(await helper.setFanProfile("Auto"), { ok: false, reason: "helper-not-installed" });
  assert.equal(calls, 0);
});

test("fan profile requests use a conservative allowlist and reject full-speed profiles", async () => {
  const calls = [];
  const helper = helperWith(async (_file, args) => { calls.push(args); return { stdout: "" }; });

  assert.deepEqual(await helper.setFanProfile("Quiet"), { ok: true, profile: "Quiet" });
  assert.deepEqual(calls, [["fan", "profile", "quiet"]]);
  assert.deepEqual(await helper.setFanProfile("Cool"), { ok: false, reason: "invalid-profile" });
  assert.deepEqual(await helper.setFanProfile("Unrestricted"), { ok: false, reason: "invalid-profile" });
  assert.equal(calls.length, 1);
});

test("charge-limit requests set an 80% limit or stop maintaining it", async () => {
  const calls = [];
  const helper = helperWith(async (_file, args) => { calls.push(args); return { stdout: "" }; });

  assert.deepEqual(await helper.setChargeLimit(true), { ok: true, enabled: true, chargeLimit: 80 });
  assert.deepEqual(await helper.setChargeLimit(false), { ok: true, enabled: false, chargeLimit: null });
  assert.deepEqual(calls, [["battery", "maintain", "80"], ["battery", "maintain", "stop"]]);
  assert.deepEqual(await helper.setChargeLimit("80"), { ok: false, reason: "invalid-setting" });
});

test("helper commands fail explicitly if the daemon or hardware rejects them", async () => {
  const helper = helperWith(async () => { throw new Error("helper unavailable"); });

  assert.deepEqual(await helper.setFanProfile("Quiet"), { ok: false, reason: "helper-or-hardware-unavailable" });
  assert.deepEqual(await helper.setChargeLimit(true), { ok: false, reason: "helper-or-hardware-unavailable" });
  const status = await helper.getStatus();
  assert.equal(status.installed, true);
  assert.equal(status.daemonAvailable, false);
  assert.equal(status.fanAvailable, false);
  assert.equal(status.fanProfile, null);
  assert.equal(status.fanMode, null);
  assert.equal(status.chargeLimitAvailable, false);
});

test("macOS helper is not invoked on other platforms", async () => {
  let calls = 0;
  const helper = helperWith(async () => { calls += 1; }, { platform: "linux" });

  assert.equal((await helper.getStatus()).installed, false);
  assert.deepEqual(await helper.setChargeLimit(true), { ok: false, reason: "helper-not-installed" });
  assert.equal(calls, 0);
});
