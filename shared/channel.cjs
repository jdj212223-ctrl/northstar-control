"use strict";

const crypto = require("node:crypto");

// Private binary framing between the Northstar app and service ("NSP1").
// Every frame is authenticated with a key derived from the device token and a per-connection nonce,
// and carries a strictly increasing counter, so frames cannot be forged, altered or replayed.
// A browser page has neither the token nor the format, so it cannot speak this channel.
const MAGIC = Buffer.from([0x4e, 0x53, 0x50, 0x01]);
const HEADER_BYTES = MAGIC.length + 1 + 8 + 32;
const DIRECTIONS = Object.freeze({ toService: 1, toDevice: 2 });

function deriveKey(token, nonce) {
  return crypto.createHmac("sha256", token).update(Buffer.concat([Buffer.from("northstar-channel-v1"), nonce])).digest();
}

function parseNonce(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{22,43}$/.test(value)) return null;
  const nonce = Buffer.from(value, "base64url");
  return nonce.length >= 16 ? nonce : null;
}

function createChannel({ token, nonce, sendDirection }) {
  const key = deriveKey(token, nonce);
  const receiveDirection = sendDirection === DIRECTIONS.toService ? DIRECTIONS.toDevice : DIRECTIONS.toService;
  let sendCounter = 0n;
  let receiveCounter = 0n;

  function tag(direction, counter, body) {
    const header = Buffer.alloc(9);
    header.writeUInt8(direction, 0);
    header.writeBigUInt64BE(counter, 1);
    return crypto.createHmac("sha256", key).update(header).update(body).digest();
  }

  return {
    seal(message) {
      const body = Buffer.from(JSON.stringify(message), "utf8");
      sendCounter += 1n;
      const header = Buffer.alloc(MAGIC.length + 1 + 8);
      MAGIC.copy(header, 0);
      header.writeUInt8(sendDirection, MAGIC.length);
      header.writeBigUInt64BE(sendCounter, MAGIC.length + 1);
      return Buffer.concat([header, tag(sendDirection, sendCounter, body), body]);
    },
    open(frame) {
      if (!Buffer.isBuffer(frame) || frame.length <= HEADER_BYTES || !frame.subarray(0, MAGIC.length).equals(MAGIC)) return null;
      if (frame.readUInt8(MAGIC.length) !== receiveDirection) return null;
      const counter = frame.readBigUInt64BE(MAGIC.length + 1);
      if (counter <= receiveCounter) return null;
      const received = frame.subarray(MAGIC.length + 9, HEADER_BYTES);
      const body = frame.subarray(HEADER_BYTES);
      if (!crypto.timingSafeEqual(received, tag(receiveDirection, counter, body))) return null;
      receiveCounter = counter;
      try { return JSON.parse(body.toString("utf8")); } catch { return null; }
    }
  };
}

module.exports = { createChannel, parseNonce, DIRECTIONS };
