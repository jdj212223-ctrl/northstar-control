"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const WebSocket = require("ws");
const { createRemoteServer } = require("../server/index.cjs");

const origin = "https://northstar.test";

async function startServer(context, fetchImpl) {
  const remote = createRemoteServer({
    allowedOrigins: [origin],
    clientId: "NorthstarClient123456",
    databasePath: ":memory:",
    fetchImpl
  });
  await new Promise((resolve) => remote.server.listen(0, "127.0.0.1", resolve));
  context.after(() => remote.close());
  const address = remote.server.address();
  return { remote, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function request(baseUrl, route, { method = "GET", body, cookie, csrf, requestOrigin = origin } = {}) {
  const headers = {};
  if (requestOrigin) headers.Origin = requestOrigin;
  if (cookie) headers.Cookie = cookie;
  if (csrf) headers["X-Northstar-CSRF"] = csrf;
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { response, data: await response.json() };
}

async function authorize(baseUrl) {
  const start = await request(baseUrl, "/api/auth/device/start", { method: "POST", body: {} });
  assert.equal(start.response.status, 200);
  const poll = await request(baseUrl, "/api/auth/device/poll", {
    method: "POST",
    body: { flowId: start.data.flowId }
  });
  assert.equal(poll.data.status, "authorized");
  return {
    account: poll.data.account,
    csrf: poll.data.csrfToken,
    cookie: poll.response.headers.get("set-cookie").match(/__Host-northstar_session=[^;]+/)[0]
  };
}

test("remote API signs in, pairs a device, relays telemetry and approved commands, and revokes it", async (context) => {
  let tokenPolls = 0;
  const fetchImpl = async (url, init) => {
    if (url.endsWith("/login/device/code")) {
      return Response.json({
        device_code: "server-private-device-code",
        user_code: "NSTR-ABCD",
        verification_uri: "https://github.com/login/device",
        expires_in: 600,
        interval: 5
      });
    }
    if (url.endsWith("/login/oauth/access_token")) {
      tokenPolls += 1;
      return Response.json({ access_token: "github-short-lived-token" });
    }
    assert.equal(url, "https://api.github.com/user");
    assert.equal(init.headers.Authorization, "Bearer github-short-lived-token");
    return Response.json({
      id: 123,
      login: "test-owner",
      name: "Test Owner",
      avatar_url: "https://avatars.githubusercontent.com/u/1",
      html_url: "https://github.com/test-owner"
    });
  };
  const { baseUrl } = await startServer(context, fetchImpl);
  const owner = await authorize(baseUrl);

  const csrfRejected = await request(baseUrl, "/api/device/pair-code", {
    method: "POST",
    cookie: owner.cookie,
    body: {}
  });
  assert.equal(csrfRejected.response.status, 403);
  const devicesBeforePairing = await request(baseUrl, "/api/devices", { cookie: owner.cookie });
  assert.deepEqual(devicesBeforePairing.data.devices, []);
  const codeResponse = await request(baseUrl, "/api/device/pair-code", {
    method: "POST",
    cookie: owner.cookie,
    csrf: owner.csrf,
    body: { name: "Studio Mac" }
  });
  assert.equal(codeResponse.response.status, 201);
  const paired = await request(baseUrl, "/api/device/pair", {
    method: "POST",
    requestOrigin: null,
    body: { code: codeResponse.data.code, name: "Studio Mac", platform: "macOS" }
  });
  assert.equal(paired.response.status, 201);
  assert.equal(paired.data.name, "Studio Mac");

  const socket = new WebSocket(`${baseUrl.replace("http:", "ws:")}/device`, {
    headers: { Authorization: `Bearer ${paired.data.deviceToken}` }
  });
  context.after(() => socket.close());
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  socket.send(JSON.stringify({
    type: "telemetry",
    data: {
      platform: "macOS",
      hostname: "Studio Mac",
      cpuLoad: 20,
      battery: { percent: 85, status: "Charging" },
      temperatureC: 42,
      powerProfile: { current: "Managed by macOS", available: [] }
    }
  }));

  let listing;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    listing = await request(baseUrl, "/api/devices", { cookie: owner.cookie });
    if (listing.data.devices[0]?.telemetry) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(listing.data.devices.length, 1);
  assert.equal(listing.data.devices[0].online, true);
  assert.equal(listing.data.devices[0].telemetry.battery.percent, 85);

  const commandRequest = request(baseUrl, `/api/devices/${paired.data.id}/commands`, {
    method: "POST",
    cookie: owner.cookie,
    csrf: owner.csrf,
    body: { type: "power-profile", profile: "Performance" }
  });
  const command = JSON.parse(await new Promise((resolve) => socket.once("message", (message) => resolve(message.toString()))));
  assert.deepEqual(command.command, { type: "power-profile", profile: "Performance" });
  socket.send(JSON.stringify({
    type: "command-result",
    requestId: command.requestId,
    result: { ok: true }
  }));
  const commandResult = await commandRequest;
  assert.equal(commandResult.response.status, 200);
  assert.equal(commandResult.data.ok, true);

  const invalidCommand = await request(baseUrl, `/api/devices/${paired.data.id}/commands`, {
    method: "POST",
    cookie: owner.cookie,
    csrf: owner.csrf,
    body: { type: "overclock", frequency: 9000 }
  });
  assert.equal(invalidCommand.response.status, 400);

  const removed = await request(baseUrl, `/api/devices/${paired.data.id}/unpair`, {
    method: "POST",
    cookie: owner.cookie,
    csrf: owner.csrf,
    body: {}
  });
  assert.equal(removed.response.status, 200);
  assert.deepEqual((await request(baseUrl, "/api/devices", { cookie: owner.cookie })).data.devices, []);
  assert.equal(tokenPolls, 1);
});

test("remote API requires same-site authentication for pairing and commands", async (context) => {
  const { baseUrl } = await startServer(context, async () => {
    throw new Error("GitHub must not be called");
  });
  const badOrigin = await request(baseUrl, "/api/auth/device/start", {
    method: "POST",
    requestOrigin: "https://attacker.test",
    body: {}
  });
  assert.equal(badOrigin.response.status, 403);
  const unauthenticated = await request(baseUrl, "/api/device/pair-code", { method: "POST", body: {} });
  assert.equal(unauthenticated.response.status, 401);
  const missingCsrf = await request(baseUrl, "/api/auth/logout", {
    method: "POST",
    body: {}
  });
  assert.equal(missingCsrf.response.status, 401);
});
