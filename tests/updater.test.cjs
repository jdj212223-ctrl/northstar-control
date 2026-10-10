"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createUpdater, isNewerVersion, parseRelease } = require("../electron/updater.cjs");

const url = "https://github.com/jdj212223-ctrl/northstar-control/releases/tag/v1.2.6";

test("compares versions numerically", () => {
  assert.equal(isNewerVersion("v1.2.10", "1.2.9"), true);
  assert.equal(isNewerVersion("1.2.6", "1.2.6"), false);
  assert.equal(isNewerVersion("1.2.5", "1.2.6"), false);
  assert.equal(isNewerVersion("garbage", "1.2.6"), false);
});

test("ignores drafts, prereleases and foreign URLs", () => {
  assert.equal(parseRelease({ tag_name: "v1.2.6", html_url: url }, "1.2.5").available, true);
  assert.equal(parseRelease({ tag_name: "v1.2.6", html_url: url, draft: true }, "1.2.5").available, false);
  assert.equal(parseRelease({ tag_name: "v1.2.6", html_url: url, prerelease: true }, "1.2.5").available, false);
  assert.equal(parseRelease({ tag_name: "v1.2.6", html_url: "https://evil.example/x" }, "1.2.5").available, false);
});

test("check reports an available update and handles failures", async () => {
  const ok = createUpdater({ currentVersion: "1.2.5", fetchImpl: async () => ({ ok: true, json: async () => ({ tag_name: "v1.2.6", html_url: url }) }) });
  assert.equal((await ok.check()).version, "1.2.6");
  const bad = createUpdater({ currentVersion: "1.2.5", fetchImpl: async () => ({ ok: false, status: 403 }) });
  const state = await bad.check();
  assert.equal(state.available, false);
  assert.match(state.error, /403/);
});
