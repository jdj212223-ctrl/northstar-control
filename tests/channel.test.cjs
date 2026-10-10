"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createChannel, parseNonce, DIRECTIONS } = require("../shared/channel.cjs");

const nonce = Buffer.alloc(16, 7);
const make = () => ({
  device: createChannel({ token: "device-token", nonce, sendDirection: DIRECTIONS.toService }),
  service: createChannel({ token: "device-token", nonce, sendDirection: DIRECTIONS.toDevice })
});

test("channel round-trips authenticated frames", () => {
  const { device, service } = make();
  const frame = device.seal({ type: "telemetry", data: { cpuLoad: 5 } });
  assert.equal(frame.subarray(0, 4).toString("hex"), "4e535001");
  const toDevice = service.seal({ type: "command", requestId: "x" });
  assert.deepEqual(device.open(toDevice), { type: "command", requestId: "x" });
});

test("channel rejects replay, tampering, reflection and wrong keys", () => {
  const { device, service } = make();
  const toService = device.seal({ type: "ping" });
  const toDevice = service.seal({ type: "command" });
  const otherService = createChannel({ token: "device-token", nonce, sendDirection: DIRECTIONS.toService });
  assert.equal(otherService.open(toService), null);
  const receiver = createChannel({ token: "device-token", nonce, sendDirection: DIRECTIONS.toDevice });
  assert.deepEqual(receiver.open(toService), { type: "ping" });
  assert.equal(receiver.open(toService), null);
  const tampered = Buffer.from(toDevice);
  tampered[tampered.length - 1] ^= 1;
  assert.equal(device.open(tampered), null);
  const wrongKey = createChannel({ token: "other", nonce, sendDirection: DIRECTIONS.toService });
  assert.equal(wrongKey.open(toDevice), null);
  assert.equal(device.open(Buffer.from(JSON.stringify({ type: "command" }))), null);
  assert.equal(parseNonce("short"), null);
  assert.ok(parseNonce(nonce.toString("base64url")));
});
