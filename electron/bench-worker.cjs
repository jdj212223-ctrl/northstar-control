"use strict";

const { parentPort, workerData, isMainThread } = require("node:worker_threads");

// Fixed amount of mixed integer and floating-point work, so results are comparable.
function kernel(iterations) {
  let a = 0x9e3779b9 | 0;
  let x = 1.000001;
  let sum = 0;
  for (let i = 0; i < iterations; i += 1) {
    a = Math.imul(a ^ (a >>> 15), 0x2c1b3c6d) | 0;
    a ^= a >>> 12;
    x = x * 1.0000001 + Math.sin(i * 0.001) * 0.0000001;
    sum += (a & 0xff) + x;
  }
  return sum;
}

if (!isMainThread && workerData && workerData.bench === "cpu") {
  const start = process.hrtime.bigint();
  const sum = kernel(workerData.iterations);
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  parentPort.postMessage({ ms, sum });
}

module.exports = { kernel };
