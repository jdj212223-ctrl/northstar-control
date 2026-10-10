"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { createRemoteAgent, normalizeServerUrl } = require("../electron/remote-agent.cjs");
const { createRemoteServer } = require("../server/index.cjs");

const origin = "https://northstar.test";

function testSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => "gnome_libsecret",
    encryptString: (value) => Buffer.from(`encrypted:${value}`),
    decryptString: (value) => {
      const decoded = value.toString();
      assert.ok(decoded.startsWith("encrypted:"));
      return decoded.slice("encrypted:".length);
    }
  };
}

async function jsonRequest(baseUrl, route, options = {}) {
  const headers = {};
  if (options.origin !== null) headers.Origin = options.origin || origin;
  if (options.cookie) headers.Cookie = options.cookie;
  if (options.csrf) headers["X-Northstar-CSRF"] = options.csrf;
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(`${baseUrl}${route}`, {
    method: options.method || "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  return { response, data: await response.json() };
}

test("remote agent stores pairing credentials encrypted and requires local confirmation", async (context) => {
  let githubTokenPoll = 0;
  const githubFetch = async (url) => {
    if (url.endsWith("/login/device/code")) {
      return Response.json({
        device_code: "private-server-device-code",
        user_code: "ABCD-EFGH",
        verification_uri: "https://github.com/login/device",
        expires_in: 600,
        interval: 5
      });
    }
    if (url.endsWith("/login/oauth/access_token")) {
      githubTokenPoll += 1;
      return Response.json({ access_token: "github-token" });
    }
    return Response.json({
      id: 2468,
      login: "device-owner",
      name: "Device Owner",
      avatar_url: "https://avatars.githubusercontent.com/u/2468",
      html_url: "https://github.com/device-owner"
    });
  };
  const remote = createRemoteServer({
    allowedOrigins: [origin],
    clientId: "NorthstarClient123456",
    databasePath: ":memory:",
    stripeWebhookSecret: "whsec_test",
    fetchImpl: githubFetch
  });
  await new Promise((resolve) => remote.server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${remote.server.address().port}`;
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "northstar-agent-test-"));
  const storagePath = path.join(tempDirectory, "remote-device.json");
  let localConfirmations = 0;
  let appliedProfile = null;
  const agent = createRemoteAgent({
    safeStorage: testSafeStorage(),
    storagePath,
    getSystemStatus: async () => ({
      platform: "Linux",
      hostname: "Workshop PC",
      cpuLoad: 17,
      uptimeSeconds: 55,
      memoryTotalBytes: 4096,
      memoryFreeBytes: 1024,
      battery: null,
      temperatureC: 51,
      fanRpm: null,
      chargeLimit: 80,
      writableChargeLimit: true,
      powerProfile: { current: "Balanced", available: ["Efficiency", "Balanced", "Performance"] }
    }),
    setPowerProfile: async (profile) => {
      appliedProfile = profile;
      return { ok: true, profile };
    },
    setChargeLimit: async (enabled) => ({ ok: true, enabled }),
    confirmCommand: async () => {
      localConfirmations += 1;
      return true;
    },
    platform: "linux"
  });
  context.after(async () => {
    agent.stop();
    await remote.close();
    await fs.rm(tempDirectory, { recursive: true, force: true });
  });

  const flow = (await jsonRequest(baseUrl, "/api/auth/device/start", { method: "POST", body: {} })).data;
  const signedIn = await jsonRequest(baseUrl, "/api/auth/device/poll", {
    method: "POST",
    body: { flowId: flow.flowId }
  });
  const cookie = signedIn.response.headers.get("set-cookie").match(/__Host-northstar_session=[^;]+/)[0];
  const payload = JSON.stringify({ type: "checkout.session.completed", data: { object: { mode: "subscription", client_reference_id: String(signedIn.data.account.id), customer: "cus_1", subscription: "sub_1", metadata: { plan: "plus" } } } });
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = require("node:crypto").createHmac("sha256", "whsec_test").update(`${timestamp}.${payload}`).digest("hex");
  await fetch(`${baseUrl}/api/stripe/webhook`, { method: "POST", headers: { "Content-Type": "application/json", "Stripe-Signature": `t=${timestamp},v1=${signature}` }, body: payload });
  const code = await jsonRequest(baseUrl, "/api/device/pair-code", {
    method: "POST",
    cookie,
    csrf: signedIn.data.csrfToken,
    body: {}
  });
  const paired = await agent.pair({ serverUrl: baseUrl, code: code.data.code, name: "Workshop PC" });
  assert.equal(paired.ok, true);
  assert.equal((await agent.status()).paired, true);
  const saved = await fs.readFile(storagePath, "utf8");
  assert.ok(!saved.includes(code.data.code));
  assert.ok(!saved.includes("deviceToken"));
  assert.ok(!saved.includes("token"));

  for (let attempt = 0; attempt < 40; attempt += 1) {
    const devices = await jsonRequest(baseUrl, "/api/devices", { cookie });
    if (devices.data.devices?.[0]?.online) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const listing = await jsonRequest(baseUrl, "/api/devices", { cookie });
  assert.equal(listing.data.devices[0].online, true);
  assert.equal(listing.data.devices[0].telemetry.hostname, "Workshop PC");

  const command = jsonRequest(baseUrl, `/api/devices/${paired.device.id}/commands`, {
    method: "POST",
    cookie,
    csrf: signedIn.data.csrfToken,
    body: { type: "power-profile", profile: "Performance" }
  });
  const result = await command;
  assert.equal(result.response.status, 200);
  assert.equal(result.data.ok, true);
  assert.equal(appliedProfile, "Performance");
  assert.equal(localConfirmations, 1);

  await jsonRequest(baseUrl, `/api/devices/${paired.device.id}/unpair`, {
    method: "POST",
    cookie,
    csrf: signedIn.data.csrfToken,
    body: {}
  });
  for (let attempt = 0; attempt < 20 && (await agent.status()).paired; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal((await agent.status()).paired, false);
});

test("remote service URLs require HTTPS except for local development", () => {
  assert.equal(normalizeServerUrl("https://northstar.example/"), "https://northstar.example");
  assert.equal(normalizeServerUrl("http://localhost:8787"), "http://localhost:8787");
  assert.equal(normalizeServerUrl("http://northstar.example"), null);
  assert.equal(normalizeServerUrl("https://user:password@northstar.example"), null);
  assert.equal(normalizeServerUrl("https://northstar.example/path"), null);
});
