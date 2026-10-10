"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { pickAsset, installUpdate, macAppPath, DOWNLOAD_PREFIX } = require("../electron/installer.cjs");

const asset = (name) => ({ name, url: `${DOWNLOAD_PREFIX}v1.2.10/${name}`, digest: "", size: 1 });
const assets = ["Northstar.Control.Setup.1.2.10.exe", "Northstar.Control-1.2.10-universal-mac.zip", "Northstar.Control-1.2.10.AppImage", "x.deb"].map(asset);

test("picks the right installer per platform", () => {
  assert.match(pickAsset(assets, { platform: "win32" }).name, /Setup.*\.exe$/);
  assert.match(pickAsset(assets, { platform: "darwin" }).name, /mac\.zip$/);
  assert.match(pickAsset(assets, { platform: "linux", appImage: "/a.AppImage" }).name, /AppImage$/);
  assert.equal(pickAsset(assets, { platform: "linux", appImage: null }), undefined);
});

test("ignores assets outside the project's releases", () => {
  const evil = [{ name: "Northstar.Control.Setup.9.9.9.exe", url: "https://evil.example/a.exe", digest: "", size: 1 }];
  assert.equal(pickAsset(evil, { platform: "win32" }), undefined);
});

test("refuses to install without a checksum and falls back to manual", async () => {
  await assert.rejects(installUpdate({ assets, platform: "win32", fetchImpl: async () => ({ ok: true, body: {} }), quit() { throw new Error("must not quit"); } }), /checksum/);
  const manual = await installUpdate({ assets, platform: "linux", env: {}, quit() {} });
  assert.equal(manual.manual, true);
});

test("locates the mac app bundle", () => {
  assert.equal(macAppPath("/Applications/Northstar Control.app/Contents/MacOS/Northstar Control"), "/Applications/Northstar Control.app");
});
