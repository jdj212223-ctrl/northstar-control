(() => {
  "use strict";

  const preferenceKey = "northstar-control-web-preferences";
  const views = [...document.querySelectorAll(".view")];
  const navigation = [...document.querySelectorAll(".nav-item[data-view]")];
  const crumb = document.getElementById("crumb-current");
  const unitSelect = document.getElementById("temperature-unit");
  const compactToggle = document.getElementById("compact-mode");
  const themeSelect = document.getElementById("theme-select");
  const saveStatus = document.getElementById("save-status");
  const sidebar = document.getElementById("sidebar");
  const menuButton = document.getElementById("menu-button");
  const scrim = document.getElementById("mobile-scrim");
  const apiInput = document.getElementById("api-base-url");
  const apiStatus = document.getElementById("api-status");
  const DEFAULT_API_URL = "https://northstar-control.fly.dev";
  let apiBase = DEFAULT_API_URL;
  let csrfToken = "";
  let account = null;
  let deviceFlowId = "";
  let deviceFlowTimer = null;
  let pairCodeTimer = null;
  let deviceRefreshTimer = null;

  function normalizeApiUrl(value) {
    if (typeof value !== "string" || value.length > 2048) return null;
    try {
      const url = new URL(value.trim());
      const localHttp = url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
      if (url.username || url.password || url.search || url.hash || !["https:", ...(localHttp ? ["http:"] : [])].includes(url.protocol)) return null;
      if (url.pathname !== "/" && url.pathname !== "") return null;
      return url.origin;
    } catch {
      return null;
    }
  }

  function setView(name) {
    const view = document.getElementById(`view-${name}`);
    if (!view) return;
    views.forEach((candidate) => {
      const active = candidate === view;
      candidate.hidden = !active;
      candidate.classList.toggle("active", active);
    });
    navigation.forEach((item) => {
      const active = item.dataset.view === name;
      item.classList.toggle("active", active);
      if (active) item.setAttribute("aria-current", "page");
      else item.removeAttribute("aria-current");
    });
    crumb.textContent = name === "settings" ? "Account & settings" : name === "devices" ? "Computers" : "Overview";
    sidebar.classList.remove("open");
    scrim.hidden = true;
    menuButton.setAttribute("aria-expanded", "false");
    window.history.replaceState(null, "", `#${name}`);
    window.scrollTo({ top: 0, behavior: "smooth" });
    if (name === "devices") void refreshDevices();
  }

  function readPreferences() {
    try {
      const saved = window.localStorage.getItem(preferenceKey);
      if (!saved) return {};
      const parsed = JSON.parse(saved);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      saveStatus.textContent = "Browser storage is unavailable; preferences won't persist.";
      return {};
    }
  }

  function applyPreferences(preferences) {
    unitSelect.value = preferences.temperatureUnit === "fahrenheit" ? "fahrenheit" : "celsius";
    compactToggle.checked = preferences.compact === true;
    themeSelect.value = preferences.theme === "light" ? "light" : "dark";
    document.documentElement.dataset.theme = themeSelect.value;
    document.documentElement.classList.toggle("compact", compactToggle.checked);
    apiBase = DEFAULT_API_URL;
    apiInput.value = apiBase;
  }

  function savePreferences() {
    const preferences = {
      temperatureUnit: unitSelect.value,
      compact: compactToggle.checked,
      theme: themeSelect.value,
      apiUrl: apiBase
    };
    applyPreferences(preferences);
    try {
      window.localStorage.setItem(preferenceKey, JSON.stringify(preferences));
      saveStatus.textContent = "Preferences saved in this browser.";
    } catch {
      saveStatus.textContent = "Could not save preferences; browser storage is unavailable.";
    }
  }

  function remoteServiceError(error) {
    if (error instanceof TypeError || error?.name === "NetworkError") {
      const isLocal = apiBase && ["localhost", "127.0.0.1", "[::1]"].includes(new URL(apiBase).hostname);
      return isLocal
        ? `Cannot reach the Northstar service at ${apiBase}. Start it with PORT=18878 NORTHSTAR_ALLOWED_ORIGINS=http://localhost:18879 npm run serve, or set the URL to a running HTTPS backend.`
        : `Cannot reach the Northstar service at ${apiBase}. Check that it is running, uses HTTPS, and allows this website origin in NORTHSTAR_ALLOWED_ORIGINS.`;
    }
    return error.message;
  }

  async function apiRequest(route, { method = "GET", body, requireCsrf = method !== "GET" } = {}) {
    if (!apiBase) throw new Error("Set the remote-service URL first.");
    const headers = { Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (requireCsrf && csrfToken) headers["X-Northstar-CSRF"] = csrfToken;
    const response = await fetch(new URL(route, `${apiBase}/`), {
      method,
      credentials: "include",
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
      redirect: "error"
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.error || `Remote service returned HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return data;
  }

  function updateAccountUI() {
    const signedIn = Boolean(account);
    const login = signedIn ? account.login : "Not signed in";
    document.getElementById("github-account-name").textContent = login;
    document.getElementById("github-account-detail").textContent = signedIn ? account.name : "Connect your GitHub account to see your computers";
    document.getElementById("sidebar-account-name").textContent = signedIn ? account.login : "Local browser";
    document.getElementById("sidebar-account-detail").textContent = signedIn ? "GitHub account connected" : "Not signed in";
    document.getElementById("github-profile-link").hidden = !signedIn;
    if (signedIn) document.getElementById("github-profile-link").href = account.profileUrl;
    document.getElementById("web-sign-in").hidden = signedIn;
    document.getElementById("web-sign-out").hidden = !signedIn;
    document.getElementById("generate-pair-code").disabled = !signedIn;
    document.getElementById("overview-account-name").textContent = login;
    document.getElementById("overview-account-status").textContent = signedIn ? "Signed in with GitHub" : "Connect to your remote service to manage computers";
    document.getElementById("sidebar-connection-title").textContent = signedIn ? "Account connected" : "Remote access is off";
    document.getElementById("sidebar-connection-copy").textContent = signedIn
      ? "Pair a computer to view its live status."
      : "Configure your service to see paired computers here.";
    document.getElementById("account-connection-title").textContent = signedIn ? `Signed in as @${account.login}` : "Connect to your remote service";
    document.getElementById("account-connection-copy").textContent = signedIn
      ? "Your GitHub identity is connected. Pair individual computers to view their status."
      : "The service handles GitHub Device Flow and keeps GitHub access tokens on the server. The website receives only a secure session cookie.";
    document.getElementById("web-auth-status").textContent = signedIn
      ? "Your account session is active. Hardware changes still require approval on each computer."
      : "Sign-in uses GitHub Device Flow; the access token stays on the service.";
    if (!signedIn) {
      document.getElementById("paired-count").textContent = "0";
      document.getElementById("online-count").textContent = "0";
      document.getElementById("paired-caption").textContent = "Sign in to view paired computers";
      document.getElementById("remote-device-list").replaceChildren();
      document.getElementById("device-empty").hidden = false;
    }
  }

  async function refreshSession() {
    if (!apiBase) {
      account = null;
      csrfToken = "";
      updateAccountUI();
      apiStatus.textContent = "Enter your Northstar backend URL. The GitHub Pages website alone cannot sign in or relay device status.";
      document.getElementById("remote-connection-title").textContent = "Remote service is not configured";
      document.getElementById("remote-connection-copy").textContent = "Set your backend URL in Account & settings to connect the dashboard with paired computers.";
      document.getElementById("device-connection-title").textContent = "Connect to your remote service";
      document.getElementById("device-connection-copy").textContent = "Sign in to see computers paired with your account.";
      return;
    }
    try {
      const session = await apiRequest("/api/auth/session");
      account = session.account;
      csrfToken = typeof session.csrfToken === "string" ? session.csrfToken : "";
      apiStatus.textContent = "Connected securely to your Northstar service.";
      document.getElementById("remote-connection-title").textContent = account ? `Signed in as @${account.login}` : "Northstar service is ready · Sign in to view devices";
      document.getElementById("remote-connection-copy").textContent = account
        ? "Live status comes from the computers paired to your account."
        : "Sign in with GitHub to create one-time pairing codes and manage your computers.";
      document.getElementById("device-connection-title").textContent = account ? `Connected as @${account.login}` : "Sign in to manage computers";
      document.getElementById("device-connection-copy").textContent = account
        ? "Generate a pairing code here, then enter it in the desktop app on the computer."
        : "Sign in with GitHub before creating a one-time pairing code.";
      updateAccountUI();
      if (account) await refreshDevices();
      else {
        document.getElementById("paired-count").textContent = "0";
        document.getElementById("online-count").textContent = "0";
        document.getElementById("paired-caption").textContent = "Sign in to view paired computers";
      }
    } catch (error) {
      account = null;
      csrfToken = "";
      updateAccountUI();
      const message = remoteServiceError(error);
      apiStatus.textContent = message;
      document.getElementById("remote-connection-title").textContent = "Remote service is unavailable";
      document.getElementById("remote-connection-copy").textContent = message;
      document.getElementById("device-connection-title").textContent = "Remote service connection failed";
      document.getElementById("device-connection-copy").textContent = message;
    }
  }

  async function pollDeviceFlow() {
    if (!deviceFlowId) return;
    try {
      const result = await apiRequest("/api/auth/device/poll", {
        method: "POST",
        body: { flowId: deviceFlowId },
        requireCsrf: false
      });
      if (result.status === "authorized") {
        deviceFlowId = "";
        window.clearTimeout(deviceFlowTimer);
        document.getElementById("web-device-status").textContent = `Connected as @${result.account.login}.`;
        await refreshSession();
        await refreshDevices();
        return;
      }
      if (result.status === "pending") {
        document.getElementById("web-device-status").textContent = "Waiting for GitHub authorization…";
        deviceFlowTimer = window.setTimeout(pollDeviceFlow, Math.max(1000, result.retryAfterMs || 5000));
        return;
      }
      deviceFlowId = "";
      document.getElementById("web-device-status").textContent = result.status === "denied"
        ? "GitHub authorization was denied."
        : result.status === "expired" ? "This code expired. Start sign-in again." : "GitHub sign-in did not complete.";
    } catch (error) {
      deviceFlowId = "";
      document.getElementById("web-device-status").textContent = `Could not check sign-in: ${error.message}`;
    }
  }

  async function startSignIn() {
    const status = document.getElementById("web-auth-status");
    if (!apiBase) {
      status.textContent = "The Northstar service is not configured.";
      setView("settings");
      apiInput.focus();
      return;
    }
    const button = document.getElementById("web-sign-in");
    button.disabled = true;
    status.textContent = "Contacting GitHub…";
    // Opened synchronously so the click gesture keeps popup blockers happy; pointed at GitHub once it answers.
    const githubTab = window.open("about:blank", "_blank");
    if (githubTab) githubTab.opener = null;
    try {
      const flow = await apiRequest("/api/auth/device/start", { method: "POST", body: {} });
      deviceFlowId = flow.flowId;
      document.getElementById("web-device-code").textContent = flow.userCode;
      document.getElementById("web-device-status").textContent = "Enter this code on GitHub to authorize Northstar Control.";
      document.getElementById("web-device-flow").hidden = false;
      if (flow.verificationUrl === "https://github.com/login/device" && githubTab) {
        githubTab.location.href = flow.verificationUrl;
        status.textContent = "GitHub opened in a new tab. Enter the code shown here.";
      } else {
        status.textContent = "Open github.com/login/device and enter the code shown here.";
      }
      deviceFlowTimer = window.setTimeout(pollDeviceFlow, Math.max(1000, flow.interval * 1000));
      window.setTimeout(() => {
        if (!deviceFlowId) return;
        deviceFlowId = "";
        window.clearTimeout(deviceFlowTimer);
        document.getElementById("web-device-status").textContent = "The code expired. Start sign-in again.";
      }, flow.expiresIn * 1000);
    } catch (error) {
      if (githubTab) githubTab.close();
      const message = remoteServiceError(error);
      status.textContent = message;
      apiStatus.textContent = message;
      document.getElementById("remote-connection-title").textContent = "Remote service is unavailable";
      document.getElementById("remote-connection-copy").textContent = message;
    } finally {
      button.disabled = false;
    }
  }

  async function cancelSignIn() {
    window.clearTimeout(deviceFlowTimer);
    const flowId = deviceFlowId;
    deviceFlowId = "";
    document.getElementById("web-device-flow").hidden = true;
    if (flowId && apiBase) {
      try {
        await apiRequest("/api/auth/device/cancel", { method: "POST", body: { flowId }, requireCsrf: false });
      } catch {
        document.getElementById("web-auth-status").textContent = "Sign-in was hidden; its temporary code will expire automatically.";
      }
    }
  }

  async function signOut() {
    try {
      await apiRequest("/api/auth/logout", { method: "POST", body: {} });
      account = null;
      csrfToken = "";
      updateAccountUI();
      document.getElementById("web-auth-status").textContent = "You have signed out of this browser.";
      await refreshDevices();
    } catch (error) {
      document.getElementById("web-auth-status").textContent = `Could not sign out: ${error.message}`;
    }
  }

  function formatWhen(timestamp) {
    if (!Number.isFinite(timestamp)) return "Never connected";
    const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
    if (seconds < 10) return "Seen just now";
    if (seconds < 60) return `Seen ${seconds}s ago`;
    if (seconds < 3600) return `Seen ${Math.floor(seconds / 60)}m ago`;
    return `Seen ${new Date(timestamp).toLocaleString()}`;
  }

  function appendMetric(parent, label, value) {
    const item = document.createElement("div");
    const title = document.createElement("span");
    title.textContent = label;
    const reading = document.createElement("strong");
    reading.textContent = value;
    item.append(title, reading);
    parent.append(item);
  }

  function renderDevice(device) {
    const card = document.createElement("article");
    card.className = "remote-device";
    card.dataset.deviceId = device.id;
    const header = document.createElement("div");
    header.className = "remote-device-head";
    const icon = document.createElement("span");
    icon.className = "device-platform-icon";
    icon.textContent = device.platform === "macOS" ? "⌘" : device.platform === "Windows" ? "⊞" : "◈";
    const title = document.createElement("div");
    title.className = "remote-device-title";
    const name = document.createElement("strong");
    name.textContent = device.name;
    const status = document.createElement("span");
    status.className = device.online ? "device-online" : "device-offline";
    status.textContent = `${device.online ? "Online" : "Offline"} · ${device.platform} · ${formatWhen(device.lastSeen)}`;
    title.append(name, status);
    const remove = document.createElement("button");
    remove.className = "device-remove";
    remove.type = "button";
    remove.textContent = "Remove";
    remove.addEventListener("click", () => void removeDevice(device, card));
    header.append(icon, title, remove);
    card.append(header);

    const telemetry = device.telemetry;
    const metrics = document.createElement("div");
    metrics.className = "device-telemetry";
    appendMetric(metrics, "CPU LOAD", telemetry?.cpuLoad === null || telemetry?.cpuLoad === undefined ? "Unavailable" : `${Math.round(telemetry.cpuLoad)}%`);
    appendMetric(metrics, "TEMPERATURE", telemetry?.temperatureC === null || telemetry?.temperatureC === undefined
      ? "Unavailable"
      : `${unitSelect.value === "fahrenheit" ? Math.round(telemetry.temperatureC * 9 / 5 + 32) : Math.round(telemetry.temperatureC)}°${unitSelect.value === "fahrenheit" ? "F" : "C"}`);
    appendMetric(metrics, "BATTERY", telemetry?.battery?.percent === null || telemetry?.battery?.percent === undefined ? "Unavailable" : `${Math.round(telemetry.battery.percent)}%`);
    appendMetric(metrics, "POWER PROFILE", telemetry?.powerProfile?.current || "Unavailable");
    card.append(metrics);

    const controls = document.createElement("div");
    controls.className = "device-controls";
    const profileSelect = document.createElement("select");
    profileSelect.setAttribute("aria-label", `Power profile for ${device.name}`);
    const available = telemetry?.powerProfile?.available || [];
    for (const profile of available) {
      const option = document.createElement("option");
      option.value = profile;
      option.textContent = profile;
      profileSelect.append(option);
    }
    const message = document.createElement("span");
    message.className = "device-message";
    if (device.online && available.length) {
      const apply = document.createElement("button");
      apply.className = "button button-secondary";
      apply.type = "button";
      apply.textContent = "Request power change";
      apply.addEventListener("click", () => void runDeviceCommand(device, {
        type: "power-profile",
        profile: profileSelect.value
      }, message));
      controls.append(profileSelect, apply);
    } else {
      message.textContent = device.online
        ? "No remote power profiles are available on this computer."
        : "This computer must be online before it can accept a request.";
    }
    if (device.online && telemetry?.writableChargeLimit) {
      const charge = document.createElement("button");
      charge.className = "button button-secondary";
      charge.type = "button";
      charge.textContent = telemetry.chargeLimit === 80 ? "Remove 80% charge limit" : "Set 80% charge limit";
      charge.addEventListener("click", () => void runDeviceCommand(device, {
        type: "charge-limit",
        enabled: telemetry.chargeLimit !== 80
      }, message));
      controls.append(charge);
    }
    const limitation = document.createElement("span");
    limitation.className = "device-message";
    limitation.textContent = "Fan-speed and clock/voltage controls are unavailable.";
    controls.append(message, limitation);
    card.append(controls);
    return card;
  }

  async function runDeviceCommand(device, command, message) {
    const description = command.type === "power-profile"
      ? `Request ${command.profile} power mode on ${device.name}? The computer will ask for approval locally.`
      : `Request this battery setting on ${device.name}? The computer will ask for approval locally.`;
    if (!window.confirm(description)) return;
    message.textContent = "Waiting for confirmation on the computer…";
    try {
      const result = await apiRequest(`/api/devices/${device.id}/commands`, { method: "POST", body: command });
      message.textContent = result.ok ? "The computer applied the change." : `The computer declined or could not apply it: ${result.reason || "unsupported"}.`;
      window.setTimeout(() => void refreshDevices(), 1200);
    } catch (error) {
      message.textContent = error.status === 504
        ? "No response from the computer. It may be offline or the local approval timed out."
        : `Could not apply the request: ${error.message}`;
    }
  }

  async function removeDevice(device, card) {
    if (!window.confirm(`Remove ${device.name} from your account and revoke its remote access?`)) return;
    try {
      await apiRequest(`/api/devices/${device.id}/unpair`, { method: "POST", body: {} });
      card.remove();
      await refreshDevices();
    } catch (error) {
      document.getElementById("device-connection-copy").textContent = `Could not remove this computer: ${error.message}`;
    }
  }

  async function refreshDevices() {
    if (!account || !apiBase) return;
    try {
      const result = await apiRequest("/api/devices");
      const list = document.getElementById("remote-device-list");
      list.replaceChildren(...result.devices.map(renderDevice));
      document.getElementById("device-empty").hidden = result.devices.length > 0;
      document.getElementById("paired-count").textContent = String(result.devices.length);
      document.getElementById("online-count").textContent = String(result.devices.filter((device) => device.online).length);
      document.getElementById("paired-caption").textContent = result.devices.length === 1 ? "Computer paired to your account" : "Computers paired to your account";
      const badge = document.querySelector(".count-pill");
      const indicator = document.createElement("i");
      badge.replaceChildren(indicator, document.createTextNode(`${result.devices.length} ${result.devices.length === 1 ? "COMPUTER" : "COMPUTERS"}`));
      document.getElementById("device-connection-title").textContent = `${result.devices.filter((device) => device.online).length} of ${result.devices.length} computers online`;
      document.getElementById("device-connection-copy").textContent = result.devices.length
        ? "Choose a supported power request to send. The computer must approve it locally."
        : "Generate a one-time code and enter it in Northstar Control on the computer.";
      document.getElementById("remote-connection-title").textContent = `${result.devices.filter((device) => device.online).length} computers online`;
      document.getElementById("remote-connection-copy").textContent = `${result.devices.length} computer${result.devices.length === 1 ? "" : "s"} paired to @${account.login}.`;
    } catch (error) {
      document.getElementById("device-connection-copy").textContent = `Could not load computers: ${error.message}`;
    }
  }

  async function createPairingCode() {
    const output = document.getElementById("pair-code-output");
    const button = document.getElementById("generate-pair-code");
    button.disabled = true;
    try {
      const result = await apiRequest("/api/device/pair-code", { method: "POST", body: {} });
      document.getElementById("pair-code-value").textContent = result.code.match(/.{1,4}/g).join("-");
      let remaining = result.expiresIn;
      const expiry = document.getElementById("pair-code-expiry");
      output.hidden = false;
      window.clearInterval(pairCodeTimer);
      const updateExpiry = () => {
        expiry.textContent = `Expires in ${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")}. Enter it on the target computer.`;
        remaining -= 1;
        if (remaining < 0) {
          window.clearInterval(pairCodeTimer);
          expiry.textContent = "This code expired. Generate a new one.";
        }
      };
      updateExpiry();
      pairCodeTimer = window.setInterval(updateExpiry, 1000);
    } catch (error) {
      document.getElementById("device-connection-copy").textContent = `Could not create a pairing code: ${error.message}`;
    } finally {
      button.disabled = !account;
    }
  }

  async function saveApiUrl() {
    const normalized = normalizeApiUrl(apiInput.value);
    if (!normalized) {
      apiStatus.textContent = "Enter a valid HTTPS service URL. Plain HTTP is permitted only for localhost testing.";
      return;
    }
    apiBase = normalized;
    apiInput.value = normalized;
    const preferences = readPreferences();
    preferences.apiUrl = normalized;
    try {
      window.localStorage.setItem(preferenceKey, JSON.stringify(preferences));
    } catch {
      apiStatus.textContent = "Browser storage is unavailable; the service URL could not be saved.";
      return;
    }
    apiStatus.textContent = "Checking the Northstar service…";
    try {
      await refreshSession();
    } catch {
      apiStatus.textContent = "Could not connect to the Northstar service.";
    }
  }

  navigation.forEach((item) => item.addEventListener("click", () => setView(item.dataset.view)));
  document.querySelectorAll("[data-view]:not(.nav-item)").forEach((item) => item.addEventListener("click", () => setView(item.dataset.view)));
  [unitSelect, compactToggle, themeSelect].forEach((input) => input.addEventListener("change", () => {
    savePreferences();
    if (account) void refreshDevices();
  }));
  document.getElementById("clear-preferences").addEventListener("click", () => {
    try {
      window.localStorage.removeItem(preferenceKey);
      applyPreferences({});
      saveStatus.textContent = "Browser preferences have been reset.";
      void refreshSession();
    } catch {
      saveStatus.textContent = "Could not reset preferences; browser storage is unavailable.";
    }
  });
  document.getElementById("save-api-url").addEventListener("click", () => void saveApiUrl());
  apiInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") void saveApiUrl();
  });
  document.getElementById("web-sign-in").addEventListener("click", () => void startSignIn());
  document.getElementById("web-sign-out").addEventListener("click", () => void signOut());
  document.getElementById("cancel-web-sign-in").addEventListener("click", () => void cancelSignIn());
  document.getElementById("generate-pair-code").addEventListener("click", () => void createPairingCode());

  menuButton.addEventListener("click", () => {
    const open = !sidebar.classList.contains("open");
    sidebar.classList.toggle("open", open);
    scrim.hidden = !open;
    menuButton.setAttribute("aria-expanded", String(open));
  });
  scrim.addEventListener("click", () => {
    sidebar.classList.remove("open");
    scrim.hidden = true;
    menuButton.setAttribute("aria-expanded", "false");
  });

  applyPreferences(readPreferences());
  const initialView = window.location.hash.slice(1);
  setView(["overview", "devices", "settings"].includes(initialView) ? initialView : "overview");
  if (apiBase) {
    apiStatus.textContent = "Connecting to your Northstar service…";
    void refreshSession();
    deviceRefreshTimer = window.setInterval(() => {
      if (account) void refreshDevices();
    }, 10000);
  } else {
    updateAccountUI();
    void refreshSession();
  }
})();
