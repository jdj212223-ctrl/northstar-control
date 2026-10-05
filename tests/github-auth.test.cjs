"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { createGitHubAuth } = require("../electron/github-auth.cjs");

function encryptedStorage(available = true) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (value) => Buffer.from(`encrypted:${value}`),
    decryptString: (value) => {
      const decoded = value.toString();
      assert.ok(decoded.startsWith("encrypted:"));
      return decoded.slice("encrypted:".length);
    }
  };
}

async function createAuth(fetchImpl, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "northstar-github-test-"));
  const storagePath = path.join(directory, "github-account.json");
  return {
    auth: createGitHubAuth({
      safeStorage: options.safeStorage || encryptedStorage(),
      storagePath,
      fetchImpl,
      now: options.now
    }),
    directory,
    storagePath
  };
}

test("GitHub sign-in requires a valid public Client ID and secure credential storage", async (context) => {
  const { auth, directory } = await createAuth(async () => {
    throw new Error("Network must not be called before setup");
  });
  context.after(() => fs.rm(directory, { recursive: true, force: true }));

  assert.deepEqual(await auth.begin(), { ok: false, reason: "client-id-required" });
  assert.deepEqual(await auth.saveClientId("bad"), { ok: false, reason: "invalid-client-id" });
  assert.deepEqual(await auth.saveClientId("AbC12345678901234567"), { ok: true, configured: true });
  assert.deepEqual(await auth.getStatus(), {
    configured: true,
    secureStorageAvailable: true,
    clientId: "AbC12345678901234567",
    account: null
  });
});

test("GitHub device flow requests only profile access and encrypts the linked account", async (context) => {
  let now = 1000;
  const requests = [];
  let tokenPolls = 0;
  const fetchImpl = async (url, init) => {
    requests.push({ url, init });
    if (url.endsWith("/login/device/code")) {
      return Response.json({
        device_code: "private-device-code",
        user_code: "ABCD-EFGH",
        verification_uri: "https://github.com/login/device",
        expires_in: 600,
        interval: 5
      });
    }
    if (url.endsWith("/login/oauth/access_token")) {
      tokenPolls += 1;
      return tokenPolls === 1
        ? Response.json({ error: "authorization_pending" })
        : Response.json({ access_token: "private-access-token" });
    }
    assert.equal(url, "https://api.github.com/user");
    assert.equal(init.headers.Authorization, "Bearer private-access-token");
    return Response.json({
      login: "northstar-user",
      name: "Northstar User",
      avatar_url: "https://avatars.githubusercontent.com/u/123",
      html_url: "https://github.com/northstar-user"
    });
  };
  const { auth, directory, storagePath } = await createAuth(fetchImpl, { now: () => now });
  context.after(() => fs.rm(directory, { recursive: true, force: true }));

  await auth.saveClientId("AbC12345678901234567");
  const flow = await auth.begin();
  assert.equal(flow.userCode, "ABCD-EFGH");
  assert.equal(flow.verificationUrl, "https://github.com/login/device");
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    client_id: "AbC12345678901234567",
    scope: "read:user"
  });
  assert.equal(requests[0].init.headers.Accept, "application/json");

  assert.deepEqual(await auth.poll(), { status: "pending", retryAfterMs: 5000 });
  assert.deepEqual(await auth.poll(), { status: "pending", retryAfterMs: 5000 });
  now += 5000;
  const completed = await auth.poll();
  assert.deepEqual(completed, {
    status: "authorized",
    account: {
      login: "northstar-user",
      name: "Northstar User",
      avatarUrl: "https://avatars.githubusercontent.com/u/123",
      profileUrl: "https://github.com/northstar-user"
    }
  });

  const persisted = await fs.readFile(storagePath, "utf8");
  assert.ok(!persisted.includes("private-access-token"));
  assert.ok(!persisted.includes("northstar-user"));
  assert.equal((await auth.getStatus()).account.login, "northstar-user");
  const restored = createGitHubAuth({
    safeStorage: encryptedStorage(),
    storagePath,
    fetchImpl
  });
  assert.equal((await restored.getStatus()).account.login, "northstar-user");
  assert.deepEqual(await auth.signOut(), { ok: true });
  assert.equal((await auth.getStatus()).account, null);
});

test("GitHub device flow rejects an unexpected authorization destination", async (context) => {
  const { auth, directory } = await createAuth(async () => Response.json({
    device_code: "private-device-code",
    user_code: "ABCD-EFGH",
    verification_uri: "https://example.com/collect",
    expires_in: 600,
    interval: 5
  }));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));

  await auth.saveClientId("AbC12345678901234567");
  assert.deepEqual(await auth.begin(), { ok: false, reason: "github-invalid-verification-url" });
});

test("GitHub sign-in is disabled when OS-backed encryption is unavailable", async (context) => {
  const { auth, directory } = await createAuth(async () => {
    throw new Error("Network must not be called without secure storage");
  }, { safeStorage: encryptedStorage(false) });
  context.after(() => fs.rm(directory, { recursive: true, force: true }));

  await auth.saveClientId("AbC12345678901234567");
  assert.deepEqual(await auth.begin(), { ok: false, reason: "secure-storage-unavailable" });
});

test("cancelling GitHub device flow discards its pending device code", async (context) => {
  const { auth, directory } = await createAuth(async () => Response.json({
    device_code: "private-device-code",
    user_code: "ABCD-EFGH",
    verification_uri: "https://github.com/login/device",
    expires_in: 600,
    interval: 5
  }));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));

  await auth.saveClientId("AbC12345678901234567");
  assert.equal((await auth.begin()).ok, true);
  assert.deepEqual(await auth.cancel(), { ok: true });
  assert.deepEqual(await auth.poll(), { status: "not-started" });
});
