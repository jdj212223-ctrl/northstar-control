"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { getProcessActivity, groupProcesses, parseLinuxProcessStat, parseMacTopCpu, parseUnixProcessList, parseWindowsProcessList } = require("../electron/activity-monitor.cjs");

test("Unix process parsing keeps executable paths and omits command arguments", () => {
  const processes = parseUnixProcessList([
    "  123  1  12.5  24576 /Applications/Editor App/Editor",
    "  456  1   0.0   1024 /usr/bin/helper"
  ].join("\n"));

  assert.deepEqual(processes, [
    { pid: 123, name: "Editor", command: "/Applications/Editor App/Editor", cpuPercent: 12.5, memoryBytes: 24576 * 1024 },
    { pid: 456, name: "helper", command: "/usr/bin/helper", cpuPercent: 0, memoryBytes: 1024 * 1024 }
  ]);
});

test("Linux process stat handles command names containing spaces or parentheses", () => {
  assert.deepEqual(parseLinuxProcessStat("123 (editor (gpu)) R 1 2 3 4 5 6 7 8 9 10 100 20 0 0 20 0 1 0 12345 500000 42"), {
    pid: 123,
    ppid: 1,
    cpuTicks: 120,
    name: "editor (gpu)"
  });
  assert.equal(parseLinuxProcessStat("malformed"), null);
});

test("macOS top parsing uses the latest process CPU table", () => {
  const cpuByPid = parseMacTopCpu("PID %CPU\n1 1.5\n\nCPU usage: 50% idle\nPID %CPU COMMAND\n1 3.5 launchd\n2 12 Code");
  assert.deepEqual([...cpuByPid], [[1, 3.5], [2, 12]]);
});

test("Windows process parsing accepts one or many processes and rejects malformed rows", () => {
  assert.deepEqual(parseWindowsProcessList(JSON.stringify([
    { Id: 10, ProcessName: "Editor", CPU: 3.5, WorkingSet64: 1024, Path: "C:\\Apps\\Editor.exe" },
    { Id: "invalid", ProcessName: "bad" }
  ])), [{
    pid: 10,
    name: "Editor",
    command: "C:\\Apps\\Editor.exe",
    cpuSeconds: 3.5,
    memoryBytes: 1024
  }]);
  assert.deepEqual(parseWindowsProcessList("null"), []);
});

test("processes are grouped by executable and totals are sortable", () => {
  const groups = groupProcesses([
    { name: "editor", command: "/opt/editor", cpuPercent: 2, memoryBytes: 100, pid: 1 },
    { name: "editor", command: "/opt/EDITOR", cpuPercent: 3, memoryBytes: 200, pid: 2 },
    { name: "browser", command: "/opt/browser", cpuPercent: null, memoryBytes: 400, pid: 3 }
  ]);

  assert.deepEqual(groups, [
    { name: "editor", command: "/opt/editor", cpuPercent: 5, memoryBytes: 300, processCount: 2 },
    { name: "browser", command: "/opt/browser", cpuPercent: null, memoryBytes: 400, processCount: 1 }
  ]);
});

test("host process activity returns safe, well-shaped application statistics", async () => {
  const snapshot = await getProcessActivity();
  assert.ok(Number.isFinite(Date.parse(snapshot.capturedAt)));
  assert.ok(Array.isArray(snapshot.processes) && snapshot.processes.length > 0);
  for (const application of snapshot.processes) {
    assert.equal(typeof application.name, "string");
    assert.equal(typeof application.command, "string");
    assert.ok(application.cpuPercent === null || (Number.isFinite(application.cpuPercent) && application.cpuPercent >= 0));
    assert.ok(Number.isFinite(application.memoryBytes) && application.memoryBytes >= 0);
    assert.ok(Number.isInteger(application.processCount) && application.processCount > 0);
  }
});
