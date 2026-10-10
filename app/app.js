(() => {
  "use strict";

  let platform = detectPlatform();
  const NORTHSTAR_SERVICE_URL = "https://northstar-control.fly.dev";
  const nativeApp = Boolean(window.northstar);
  const views = [...document.querySelectorAll(".page-view")];
  const navItems = [...document.querySelectorAll(".nav-item[data-view]")];
  const modal = document.getElementById("modal-backdrop");
  const modalPlatformNote = document.getElementById("modal-platform-note");
  const modalTitle = document.getElementById("modal-title");
  const modalCopy = document.getElementById("modal-copy");
  const toast = document.getElementById("toast");
  let toastTimer;
  let lastFocusedElement;
  let githubFlowActive = false;
  let githubFlowGeneration = 0;
  const cpuHistory = [];
  const memoryHistory = [];
  const temperatureHistory = [];
  let activityMetric = "cpu";
  let activityProcesses = [];
  document.getElementById("current-date").textContent = new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" }).toUpperCase();

  function detectPlatform() {
    const value = `${navigator.userAgentData?.platform || ""} ${navigator.platform || ""} ${navigator.userAgent || ""}`.toLowerCase();
    if (value.includes("mac") || value.includes("iphone") || value.includes("ipad")) return "macOS";
    if (value.includes("win")) return "Windows";
    if (value.includes("linux") || value.includes("x11")) return "Linux";
    return "Unknown platform";
  }

  document.getElementById("platform-name").textContent = nativeApp ? `${platform} · Reading system…` : `${platform} · Open desktop app for live data`;
  document.getElementById("app-state").textContent = nativeApp ? "CONNECTING" : "DESKTOP APP REQUIRED";
  document.getElementById("connection-label").textContent = nativeApp ? "Connecting…" : "Desktop app required";
  document.getElementById("settings-platform").textContent = platform;
  document.getElementById("device-name").textContent = platform === "macOS" ? "This Mac" : platform === "Windows" ? "This PC" : platform === "Linux" ? "This Linux computer" : "Your computer";
  if (nativeApp && window.northstar.update) {
    const pill = document.getElementById("update-pill");
    const renderUpdate = (state) => {
      if (!state || !state.available) { pill.hidden = true; return; }
      pill.textContent = `Update available · v${state.version}`;
      pill.title = "Open the Northstar Control release page to download the update";
      pill.hidden = false;
    };
    pill.addEventListener("click", () => window.northstar.update.openRelease());
    window.northstar.update.onChange(renderUpdate);
    window.northstar.update.getState().then(renderUpdate).catch(() => {});
  }
  if (!nativeApp) {
    document.getElementById("remote-pair-button").disabled = true;
    document.getElementById("remote-device-status").textContent = "Launch the Northstar desktop app to pair this computer.";
  }
  if (platform !== "macOS") document.getElementById("mac-helper-button").closest(".setting-row").hidden = true;
  if (platform === "Windows" || platform === "Linux") {
    document.getElementById("overclock-state-title").textContent = "No validated tuner available";
  } else if (platform === "macOS") {
    document.getElementById("overclock-state-title").textContent = "Not available on macOS";
    document.getElementById("overclock-state-copy").textContent = "Clock tuning is not offered on macOS. Fan and battery controls require a signed, user-approved helper.";
    document.querySelector(".supported-os").hidden = true;
  }

  if (platform === "macOS") {
    document.getElementById("helper-title").textContent = "macOS helper access required";
    document.getElementById("helper-copy").textContent = "Install the signed smctl helper to enable fan controls on supported Apple Silicon Macs.";
    document.getElementById("battery-helper-title").textContent = "macOS helper access required";
    document.getElementById("battery-helper-copy").textContent = "Install the signed smctl helper to enable charge limits on supported MacBooks.";
    document.getElementById("overclock-note").textContent = "Overclocking is not offered on macOS.";
    document.getElementById("mac-helper-button").textContent = "Set up helper";
  } else if (platform === "Windows") {
    document.getElementById("helper-title").textContent = "Windows service required";
    document.getElementById("helper-copy").textContent = "Fan changes need hardware support and an authorized vendor-specific service.";
    document.getElementById("battery-helper-title").textContent = "Windows service required";
    document.getElementById("battery-helper-copy").textContent = "Battery features depend on device firmware and a signed, elevated service.";
    document.getElementById("overclock-note").textContent = "Clock tuning requires a validated hardware-specific driver; none is connected.";
  } else if (platform === "Linux") {
    document.getElementById("helper-title").textContent = "Linux system service required";
    document.getElementById("helper-copy").textContent = "Fan changes need hardware support and a system service authorized through the OS.";
    document.getElementById("battery-helper-title").textContent = "Linux system service required";
    document.getElementById("battery-helper-copy").textContent = "Battery controls vary by kernel, firmware, and hardware support.";
    document.getElementById("overclock-note").textContent = "Clock tuning requires a validated hardware-specific driver; none is connected.";
  }

  function showView(name) {
    const target = document.getElementById(`view-${name}`);
    if (!target) return;
    views.forEach((view) => view.classList.toggle("active", view === target));
    navItems.forEach((item) => item.classList.toggle("active", item.dataset.view === name));
    const breadcrumbNames = { power: "Power & battery", activity: "Activity monitor" };
    document.getElementById("breadcrumb-current").textContent = breadcrumbNames[name] || name[0].toUpperCase() + name.slice(1);
    window.scrollTo({ top: 0, behavior: "smooth" });
    if (name === "activity") refreshActivity();
  }

  navItems.forEach((item) => item.addEventListener("click", () => showView(item.dataset.view)));
  document.querySelectorAll("[data-open]").forEach((button) => button.addEventListener("click", () => showView(button.dataset.open)));
  document.querySelectorAll(".choice-card[data-fan]").forEach((button) => button.addEventListener("click", async () => {
    if (!nativeApp) {
      openAccessDialog();
      return;
    }
    if (platform !== "macOS") {
      openAccessDialog();
      return;
    }
    try {
      const result = await window.northstar.setFanProfile(button.dataset.fan);
      if (!result.ok) {
        if (result.reason === "helper-not-installed") openAccessDialog("mac");
        else if (result.reason !== "cancelled") showToast("Fan control is unavailable for this helper or hardware.");
        return;
      }
      document.querySelectorAll(".choice-card[data-fan]").forEach((choice) => choice.classList.toggle("selected", choice === button));
      showToast(`${button.dataset.fan} fan profile applied.`);
      await refreshStatus();
    } catch {
      showToast("Could not apply the fan profile.");
    }
  }));

  function selectProfile(profile) {
    if (!nativeApp) {
      showToast("Launch Northstar Control as a desktop app to read or change real system power profiles.");
      return;
    }
    window.northstar.setPowerProfile(profile).then(async (result) => {
      if (!result.ok) {
        const message = result.reason === "profile-not-installed"
          ? platform === "Windows" ? `${profile} is not available in your Windows power plans.` : `${profile} is not available in the system power profiles.`
          : result.reason === "managed-by-operating-system"
            ? "macOS manages this power profile."
            : result.reason === "unsupported"
              ? "No supported system power-profile service was found."
              : "The operating system did not allow this profile change.";
        showToast(message);
        return;
      }
      await refreshStatus();
      showToast(`${profile} system power profile applied.`);
    }).catch(() => showToast("Could not change the system power profile."));
  }

  document.querySelectorAll(".profile-option").forEach((button) => button.addEventListener("click", () => selectProfile(button.dataset.profile)));
  document.getElementById("profile-button").addEventListener("click", () => showView("power"));
  document.getElementById("profile-button-bottom").addEventListener("click", () => showView("power"));

  function openAccessDialog(context = "general") {
    lastFocusedElement = document.activeElement;
    document.getElementById("github-device-panel").hidden = true;
    document.getElementById("modal-cancel").textContent = "Got it";
    document.getElementById("modal-confirm").textContent = "Understood";
    if (nativeApp) {
      requestHardwareAccess();
      return;
    }
    if (context === "mac") {
      modalTitle.textContent = "macOS hardware helper setup";
      modalCopy.textContent = "Northstar can use smctl's independently signed helper for fan profiles on supported Apple Silicon Macs and charge limits on supported MacBooks. It does not control USB port power.";
      modalPlatformNote.textContent = "Download the signed helper from https://github.com/leaperone/smctl/releases, install smctl and smctld, then run sudo smctl daemon install in Terminal. Homebrew builds from source and requires the full Xcode app. Open the desktop app to see whether a helper is already active.";
    } else if (platform === "macOS") {
      modalTitle.textContent = "Hardware helper setup";
      modalCopy.textContent = "Use Set up helper for the signed smctl installation steps. Only Mac models reported as supported by the helper can change fan or charging behavior.";
      modalPlatformNote.textContent = "Fan, battery, and USB controls are not universal macOS features. Northstar does not request access for unsupported hardware.";
    } else if (platform === "Windows") {
      modalTitle.textContent = "Hardware access needs your approval.";
      modalCopy.textContent = "Fan, battery, and USB power controls require supported hardware and an authorized service. This build does not install a service.";
      modalPlatformNote.textContent = "Overclocking requires separate hardware-specific validation and is not available here.";
    } else if (platform === "Linux") {
      modalTitle.textContent = "Hardware access needs your approval.";
      modalCopy.textContent = "Fan, battery, and USB power controls require supported hardware and an authorized service. This build does not install a service or change permissions.";
      modalPlatformNote.textContent = "Overclocking requires separate hardware-specific validation and is not available here.";
    } else {
      modalTitle.textContent = "Hardware service unavailable.";
      modalCopy.textContent = "This build has no platform service. It cannot request privileged access or change hardware settings.";
      modalPlatformNote.textContent = "No settings were changed.";
    }
    modal.hidden = false;
    document.getElementById("modal-close").focus();
  }

  function closeAccessDialog() {
    modal.hidden = true;
    if (githubFlowActive && nativeApp) {
      githubFlowActive = false;
      githubFlowGeneration += 1;
      window.northstar.github.cancel().catch(() => showToast("Could not cancel GitHub sign-in."));
    }
    if (lastFocusedElement instanceof HTMLElement) lastFocusedElement.focus();
  }

  document.getElementById("connection-action").addEventListener("click", () => openAccessDialog());
  document.getElementById("help-button").addEventListener("click", () => openAccessDialog());
  document.getElementById("helper-button").addEventListener("click", () => openAccessDialog(platform === "macOS" ? "mac" : "general"));
  document.getElementById("mac-helper-button").addEventListener("click", () => openAccessDialog("mac"));
  document.querySelectorAll("[data-helper]").forEach((button) => button.addEventListener("click", () => openAccessDialog(platform === "macOS" ? "mac" : "general")));
  document.getElementById("modal-close").addEventListener("click", closeAccessDialog);
  document.getElementById("modal-cancel").addEventListener("click", closeAccessDialog);
  document.getElementById("modal-confirm").addEventListener("click", closeAccessDialog);
  document.getElementById("github-sign-in").addEventListener("click", startGitHubSignIn);
  document.getElementById("github-sign-out").addEventListener("click", signOutGitHub);
  document.getElementById("remote-pair-button").addEventListener("click", pairRemoteComputer);
  document.getElementById("remote-unpair-button").addEventListener("click", unpairRemoteComputer);
  document.getElementById("github-save-client-id").addEventListener("click", saveGitHubClientId);
  document.getElementById("github-open-verification").addEventListener("click", async () => {
    try {
      await window.northstar.github.openVerification();
    } catch {
      document.getElementById("github-device-status").textContent = "Could not open GitHub. Visit github.com/login/device in your browser.";
    }
  });
  document.getElementById("github-registration-link").addEventListener("click", async () => {
    if (!nativeApp) {
      showToast("Open the desktop app to open GitHub Developer Settings.");
      return;
    }
    try {
      await window.northstar.github.openRegistration();
    } catch {
      showToast("Could not open GitHub Developer Settings.");
    }
  });
  document.getElementById("github-client-id").addEventListener("keydown", (event) => {
    if (event.key === "Enter") saveGitHubClientId();
  });
  modal.addEventListener("click", (event) => {
    if (event.target === modal) closeAccessDialog();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !modal.hidden) closeAccessDialog();
  });

  function showToast(message) {
    window.clearTimeout(toastTimer);
    toast.textContent = message;
    toast.classList.add("visible");
    toastTimer = window.setTimeout(() => toast.classList.remove("visible"), 3200);
  }

  function requestHardwareAccess() {
    if (!nativeApp) {
      openAccessDialog();
      return;
    }
    window.northstar.requestHardwareAccess().catch(() => showToast("Could not open hardware access information."));
  }

  function setGitHubAccount(account) {
      const connected = Boolean(account);
      document.getElementById("account-name").textContent = connected ? account.name : "Not connected";
      document.getElementById("account-detail").textContent = connected ? `@${account.login} · GitHub account` : "Your GitHub account is not linked.";
      document.getElementById("account-status").textContent = connected ? "CONNECTED" : "SIGNED OUT";
      document.getElementById("account-status").classList.toggle("muted-value", !connected);
      document.getElementById("account-status").classList.toggle("connected-value", connected);
      document.getElementById("github-sign-in").hidden = connected;
      document.getElementById("github-sign-out").hidden = !connected;
      const initial = connected ? account.login.slice(0, 1).toUpperCase() : "N";
      document.getElementById("account-avatar").textContent = initial;
      document.getElementById("sidebar-account-avatar").textContent = initial;
      document.getElementById("sidebar-account-name").textContent = connected ? account.login : "Local profile";
      document.getElementById("sidebar-account-detail").textContent = connected ? "GitHub connected" : "GitHub not connected";
      document.getElementById("github-action-status").textContent = connected
        ? "GitHub confirms your identity. Computer-control permissions remain separate."
        : "GitHub login only identifies your account. It does not grant access to control hardware.";
    }

  async function loadGitHubStatus() {
      if (!nativeApp) {
        document.getElementById("github-action-status").textContent = "Launch the desktop app to configure or sign in to a GitHub account.";
        document.getElementById("github-sign-in").disabled = true;
        document.getElementById("github-save-client-id").disabled = true;
        return;
      }
      try {
        const status = await window.northstar.github.getStatus();
        setGitHubAccount(status.account);
        document.getElementById("github-client-id").value = status.clientId || "";
        if (!status.secureStorageAvailable) {
          document.getElementById("github-action-status").textContent = "Secure credential storage is unavailable. Set up the operating system's secure keychain before signing in.";
          document.getElementById("github-sign-in").disabled = true;
        }
      } catch {
        document.getElementById("github-action-status").textContent = "Could not read GitHub account settings.";
      }
    }

  async function saveGitHubClientId() {
      if (!nativeApp) {
        showToast("Open the desktop app to save GitHub account settings.");
        return;
      }
      const status = document.getElementById("github-action-status");
      status.textContent = "Saving GitHub OAuth Client ID…";
      try {
        const result = await window.northstar.github.saveClientId(document.getElementById("github-client-id").value);
        if (!result.ok) {
          status.textContent = "That Client ID format is not valid. Copy the public Client ID from your GitHub OAuth App.";
          return;
        }
        await loadGitHubStatus();
        status.textContent = "Client ID saved. GitHub sign-in is ready when the OAuth App has Device Flow enabled.";
      } catch {
        status.textContent = "Could not save the OAuth Client ID.";
      }
    }

  async function startGitHubSignIn() {
      if (!nativeApp) {
        showToast("Open the desktop app to sign in with GitHub.");
        return;
      }
      let config;
      try {
        config = await window.northstar.github.getStatus();
      } catch {
        showToast("Could not read GitHub account settings.");
        return;
      }
      if (!config.configured) {
        showView("settings");
        document.getElementById("github-client-id").focus();
        document.getElementById("github-action-status").textContent = "First add the public Client ID from your GitHub OAuth App and enable Device Flow.";
        return;
      }
      if (!config.secureStorageAvailable) {
        document.getElementById("github-action-status").textContent = "Secure credential storage is unavailable. GitHub sign-in is disabled to protect your account.";
        return;
      }
      lastFocusedElement = document.activeElement;
      modalTitle.textContent = "Connect GitHub account";
      modalCopy.textContent = "Authorize Northstar Control to read your public GitHub account profile. This confirms your identity only; it does not grant permission to control this computer.";
      modalPlatformNote.textContent = "Only the read:user profile permission is requested. Sign-in can be cancelled at any time.";
      document.getElementById("github-device-panel").hidden = false;
      document.getElementById("github-device-status").textContent = "Requesting a one-time sign-in code…";
      document.getElementById("github-open-verification").disabled = false;
      document.getElementById("modal-cancel").textContent = "Cancel";
      document.getElementById("modal-confirm").textContent = "Cancel sign-in";
      modal.hidden = false;
      document.getElementById("modal-close").focus();
      githubFlowActive = true;
      const generation = ++githubFlowGeneration;
      try {
        const flow = await window.northstar.github.begin();
        if (!githubFlowActive || generation !== githubFlowGeneration) return;
        if (!flow.ok) {
          document.getElementById("github-device-panel").hidden = true;
          document.getElementById("modal-cancel").textContent = "Close";
          document.getElementById("modal-confirm").textContent = "Understood";
          document.getElementById("github-device-status").textContent = "";
          if (flow.reason === "secure-storage-unavailable") {
            modalTitle.textContent = "Secure storage unavailable";
            modalCopy.textContent = "Northstar Control cannot safely store GitHub credentials on this system.";
            modalPlatformNote.textContent = "Enable an operating-system keychain (such as macOS Keychain, Windows Credential Manager, or a Linux Secret Service) before signing in.";
          } else {
            modalTitle.textContent = "GitHub sign-in could not start";
            modalCopy.textContent = flow.reason === "client-id-required" ? "Save a valid GitHub OAuth App Client ID in Settings first." : "GitHub did not provide a valid device authorization response. Check your network and OAuth App Device Flow settings.";
            modalPlatformNote.textContent = "No access token was saved.";
          }
          githubFlowActive = false;
          return;
        }
        document.getElementById("github-user-code").textContent = flow.userCode;
        document.getElementById("github-device-status").textContent = "Waiting for you to authorize this app on GitHub…";
        pollGitHubSignIn(generation, flow.interval * 1000, Date.now() + flow.expiresIn * 1000);
      } catch {
        if (!githubFlowActive || generation !== githubFlowGeneration) return;
        githubFlowActive = false;
        document.getElementById("github-device-panel").hidden = true;
        modalTitle.textContent = "GitHub sign-in could not start";
        modalCopy.textContent = "Could not contact GitHub. Check your network connection and try again.";
        modalPlatformNote.textContent = "No access token was saved.";
        document.getElementById("modal-cancel").textContent = "Close";
        document.getElementById("modal-confirm").textContent = "Understood";
      }
    }

  function pollGitHubSignIn(generation, retryAfterMs, expiresAt) {
      window.setTimeout(async () => {
        if (!githubFlowActive || generation !== githubFlowGeneration) return;
        if (Date.now() >= expiresAt) {
          githubFlowActive = false;
          document.getElementById("github-device-status").textContent = "This code expired. Close this dialog and try again.";
          return;
        }
        try {
          const result = await window.northstar.github.poll();
          if (!githubFlowActive || generation !== githubFlowGeneration) return;
          if (result.status === "pending") {
            document.getElementById("github-device-status").textContent = "Waiting for authorization on GitHub…";
            pollGitHubSignIn(generation, result.retryAfterMs || retryAfterMs, expiresAt);
          } else if (result.status === "authorized") {
            githubFlowActive = false;
            setGitHubAccount(result.account);
            document.getElementById("github-device-status").textContent = `Connected as @${result.account.login}.`;
            document.getElementById("github-device-panel").hidden = true;
            document.getElementById("modal-cancel").textContent = "Close";
            document.getElementById("modal-confirm").textContent = "Done";
            document.getElementById("github-action-status").textContent = "GitHub confirms your identity. Computer-control permissions remain separate.";
          } else {
            githubFlowActive = false;
            const message = result.status === "denied" ? "GitHub authorization was denied." : result.status === "expired" ? "This code expired. Close this dialog and try again." : "GitHub authorization did not complete. Try again.";
            document.getElementById("github-device-status").textContent = message;
          }
        } catch {
          if (!githubFlowActive || generation !== githubFlowGeneration) return;
          githubFlowActive = false;
          document.getElementById("github-device-status").textContent = "Could not check authorization with GitHub. Check the network, then try again.";
        }
      }, Math.max(1000, retryAfterMs));
    }

  async function signOutGitHub() {
      if (!nativeApp) return;
      try {
        await window.northstar.github.signOut();
        setGitHubAccount(null);
      } catch {
        document.getElementById("github-action-status").textContent = "Could not remove the saved GitHub account from secure storage.";
      }
  }

      async function refreshRemoteStatus() {
        if (!nativeApp) return;
        try {
          const status = await window.northstar.remote.getStatus();
          
          const pairButton = document.getElementById("remote-pair-button");
          const unpairButton = document.getElementById("remote-unpair-button");
          const codeInput = document.getElementById("remote-pairing-code");
          pairButton.disabled = status.paired;
          codeInput.disabled = status.paired;
          unpairButton.hidden = !status.paired;
          const message = status.paired
            ? `${status.device.name} is paired · ${status.connected ? "connected and sharing live status" : "reconnecting"}`
            : "This computer is not paired to a remote account.";
          document.getElementById("remote-device-status").textContent = message;
        } catch {
          document.getElementById("remote-device-status").textContent = "Could not read secure remote-pairing status.";
        }
      }

      async function pairRemoteComputer() {
        const button = document.getElementById("remote-pair-button");
        const status = document.getElementById("remote-device-status");
        button.disabled = true;
        status.textContent = "Pairing this computer securely…";
        try {
          const system = await window.northstar.getSystemStatus();
          const result = await window.northstar.remote.pair({
            serverUrl: NORTHSTAR_SERVICE_URL,
            code: document.getElementById("remote-pairing-code").value,
            name: system.hostname || document.getElementById("device-name").textContent
          });
          if (!result.ok) {
            const messages = {
              "invalid-server-url": "The Northstar service address is invalid.",
              "invalid-pairing-code": "Enter the one-time pairing code shown by the signed-in web dashboard.",
              "secure-storage-unavailable": "Pairing is disabled because OS-backed secure storage is unavailable.",
              "server-unreachable": "Could not reach Northstar. Try again in a moment.",
              "pairing-code-invalid-or-expired": "That pairing code expired or was already used. Generate a new code on the website."
            };
            status.textContent = messages[result.reason] || `Pairing failed: ${result.reason}.`;
            button.disabled = false;
            return;
          }
          document.getElementById("remote-pairing-code").value = "";
          await refreshRemoteStatus();
          showToast("This computer is paired. It will share live status with the account.");
        } catch {
          status.textContent = "Pairing failed. Check the code and try again.";
          button.disabled = false;
        }
      }

      async function unpairRemoteComputer() {
        const status = document.getElementById("remote-device-status");
        if (!window.confirm("Remove this computer from the Northstar account and revoke its remote access?")) return;
        try {
          const result = await window.northstar.remote.unpair();
          if (!result.ok) {
            status.textContent = result.reason === "server-unreachable"
              ? "Could not reach the service to revoke this computer. It remains paired; reconnect and try again."
              : "The server did not confirm revocation. This computer remains paired.";
            return;
          }
          await refreshRemoteStatus();
          showToast("Remote access for this computer has been revoked.");
        } catch {
          status.textContent = "Could not revoke remote access. This computer remains paired.";
        }
      }
  function formatGigabytes(bytes) {
    return (bytes / (1024 ** 3)).toFixed(1);
  }

  function applySystemStatus(status) {
    platform = status.platform;
    document.getElementById("platform-name").textContent = `${status.platform} · live system telemetry`;
    document.getElementById("settings-platform").textContent = status.platform;
    document.getElementById("device-name").textContent = status.hostname || "This computer";
    document.getElementById("connection-label").textContent = "Live system connection";
    document.getElementById("connection-action").textContent = "About hardware access ↗";
    document.getElementById("app-state").textContent = "LIVE";
    document.getElementById("uptime-value").textContent = formatUptime(status.uptimeSeconds);

    const temperature = document.getElementById("cpu-temperature-value");
    temperature.firstChild.textContent = status.temperatureC === null ? "—" : String(status.temperatureC);
    document.getElementById("temperature-description").textContent = status.temperatureC === null ? "No temperature sensor exposed by this system" : `Detected · ${status.temperatureSource || "system sensor"}`;
    document.getElementById("detail-temperature").firstChild.textContent = status.temperatureC === null ? "—" : String(status.temperatureC);
    document.getElementById("temperature-meter").style.width = status.temperatureC === null ? "0%" : `${Math.min(100, Math.round((status.temperatureC / 110) * 100))}%`;
    if (status.temperatureC !== null) addHistoryPoint(temperatureHistory, status.temperatureC, 1800000);
    updateHistoryPath(temperatureHistory, "temperature-line", "temperature-fill", 320, 42, 1800000, 20, 100);

    const helper = status.hardwareControls;
    const macFanAvailable = platform !== "macOS" || !helper?.installed || (helper.daemonAvailable && helper.fanAvailable);
    document.querySelector("#view-cooling .demo-chip").textContent = platform === "macOS" && helper?.fanAvailable
      ? "HELPER CONNECTED"
      : "FAN CONTROL UNAVAILABLE";
    const reportedRpm = status.fanRpm === null
      ? "—"
      : platform === "macOS" && helper?.fanAtReportedMinimum
        ? `≈ ${helper.fanMinimumRpm.toLocaleString()}`
        : platform === "macOS"
          ? `≈ ${status.fanRpm.toLocaleString()}`
          : status.fanRpm.toLocaleString();
    document.getElementById("fan-rpm").textContent = reportedRpm;
    document.getElementById("detail-rpm").firstChild.textContent = `${reportedRpm} `;
    document.getElementById("fan-description").textContent = status.fanRpm === null
      ? platform === "macOS" && helper?.installed && !helper.daemonAvailable ? "smctl helper installed; daemon is not responding" : "No supported fan sensor exposed by this system"
      : platform === "macOS" && helper?.fanAtReportedMinimum ? "At the helper-reported minimum · Apple SMC telemetry"
      : platform === "macOS" && macFanAvailable ? `Apple SMC report · ${helper.fanMode || "mode unknown"}` : "Detected hardware fan · read only";
    document.getElementById("detail-fan-description").textContent = status.fanRpm === null
      ? "Fan telemetry unavailable"
      : platform === "macOS"
        ? `${helper?.fanAtReportedMinimum ? "At reported minimum · " : ""}Apple SMC report · ${helper?.fanMode || "mode unknown"} · range ${helper?.fanMinimumRpm ?? "—"}–${helper?.fanMaximumRpm ?? "—"} RPM`
        : "Detected hardware fan · read only";
    document.querySelectorAll(".choice-card[data-fan]").forEach((choice) => {
      choice.disabled = !macFanAvailable || (platform === "macOS" && !helper?.daemonAvailable);
      if (helper?.fanProfile) choice.classList.toggle("selected", choice.dataset.fan.toLowerCase() === helper.fanProfile.toLowerCase());
    });
    const helperButton = document.getElementById("helper-button");
    if (platform === "macOS") {
      document.getElementById("helper-title").textContent = helper?.installed
        ? helper.daemonAvailable ? "macOS helper connected" : "macOS helper needs authorization"
        : "macOS helper setup";
      document.getElementById("helper-copy").textContent = helper?.installed
        ? helper.daemonAvailable ? "Fan access is available where supported by this Mac." : "Run sudo smctl daemon install in Terminal to authorize and start the helper."
        : "Install the signed smctl helper to enable supported fan controls.";
      helperButton.textContent = helper?.installed && helper.daemonAvailable ? "Helper ready" : "Setup steps";
    }
    document.getElementById("battery-percent").textContent = status.battery ? String(status.battery.percent) : "—";
    document.getElementById("battery-status").textContent = status.battery ? status.battery.status : "Battery telemetry unavailable";
    document.getElementById("battery-description").textContent = status.battery ? "Live battery charge level" : "Battery telemetry unavailable";
    document.getElementById("detail-battery-percent").firstChild.textContent = status.battery ? String(status.battery.percent) : "—";
    document.getElementById("detail-battery-status").textContent = status.battery ? status.battery.status : "Battery telemetry unavailable";
    document.getElementById("detail-battery-health").textContent = "NOT REPORTED";
    document.querySelector(".battery-case div").style.width = status.battery ? `${status.battery.percent}%` : "0%";
    document.querySelector(".large-battery div").style.width = status.battery ? `${status.battery.percent}%` : "0%";
    document.getElementById("battery-health").textContent = "Not reported";

    const memoryUsed = status.memoryTotalBytes - status.memoryFreeBytes;
    const memoryPercent = status.memoryTotalBytes ? Math.round((memoryUsed / status.memoryTotalBytes) * 100) : 0;
    document.getElementById("cpu-load").firstChild.textContent = status.cpuLoad ?? "—";
    document.getElementById("cpu-meter").style.width = `${status.cpuLoad ?? 0}%`;
    document.getElementById("memory-use").firstChild.textContent = formatGigabytes(memoryUsed);
    document.getElementById("memory-use").querySelector("small").textContent = ` / ${formatGigabytes(status.memoryTotalBytes)} GB`;
    document.getElementById("memory-meter").style.width = `${memoryPercent}%`;
    if (status.cpuLoad !== null) addHistoryPoint(cpuHistory, status.cpuLoad, 300000);
    addHistoryPoint(memoryHistory, memoryPercent, 300000);
    updateHistoryPath(cpuHistory, "cpu-activity-line", "cpu-activity-fill", 390, 128, 300000, 0, 100);
    updateHistoryPath(memoryHistory, "memory-activity-line", null, 390, 128, 300000, 0, 100);

    if (status.powerProfile?.current) {
      document.getElementById("profile-name").textContent = status.powerProfile.current;
      document.getElementById("active-profile-title").textContent = `${status.powerProfile.current} mode`;
      document.querySelectorAll(".profile-option").forEach((option) => option.classList.toggle("selected", option.dataset.profile === status.powerProfile.current));
    }
    const chargeSetting = document.querySelector('[data-setting="chargeLimit"]');
    chargeSetting.disabled = platform === "macOS" && helper?.installed && !helper.chargeLimitAvailable;
    chargeSetting.checked = Boolean(status.writableChargeLimit && status.chargeLimit !== null && status.chargeLimit < 100);
    document.getElementById("battery-helper-copy").textContent = status.writableChargeLimit
      ? `Current limit: ${status.chargeLimit}%. The operating system exposes a writable charge threshold.`
      : platform === "macOS"
        ? helper?.chargeLimitAvailable
          ? "The signed helper reports charge-limit support for this Mac."
          : helper?.installed
            ? "No supported battery charge control was reported. This may be a desktop Mac or an unsupported MacBook."
            : "Install the signed smctl helper. Charge limits are available only on supported MacBooks."
        : "This system does not expose a writable battery charge limit to this app.";
    document.getElementById("updated-label").textContent = `Live · ${new Date().toLocaleTimeString()}`;
  }

  function formatUptime(seconds) {
    if (!Number.isFinite(seconds)) return "—";
    const totalMinutes = Math.floor(seconds / 60);
    const days = Math.floor(totalMinutes / 1440);
    const hours = Math.floor((totalMinutes % 1440) / 60);
    return days ? `${days}d ${hours}h` : `${hours}h ${totalMinutes % 60}m`;
  }

  function addHistoryPoint(history, value, duration) {
    const now = Date.now();
    history.push({ value, time: now });
    while (history.length && now - history[0].time > duration) history.shift();
  }

  function updateHistoryPath(history, lineId, fillId, width, height, duration, min, max) {
    const now = Date.now();
    const points = history.map(({ value, time }) => ({
      x: Math.max(0, Math.min(width, width * (1 - (now - time) / duration))),
      y: height - Math.max(0, Math.min(1, (value - min) / (max - min))) * (height - 3)
    }));
    const line = points.map(({ x, y }, index) => `${index ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
    document.getElementById(lineId).setAttribute("d", line);
    if (fillId) {
      const fill = points.length ? `${line} L${points[points.length - 1].x.toFixed(1)},${height} L${points[0].x.toFixed(1)},${height} Z` : "";
      document.getElementById(fillId).setAttribute("d", fill);
    }
  }

  async function refreshStatus() {
    if (!nativeApp) {
      showToast("Launch the installed desktop app to read live system status.");
      return;
    }
    try {
      applySystemStatus(await window.northstar.getSystemStatus());
    } catch {
      showToast("Could not read system telemetry. Check the app installation and system permissions.");
    }
  }

  function setActivityMetric(metric) {
    if (!["cpu", "gpu", "power", "memory", "fps"].includes(metric)) return;
    activityMetric = metric;
    document.querySelectorAll(".activity-category").forEach((button) => {
      const selected = button.dataset.activityMetric === metric;
      button.classList.toggle("selected", selected);
      button.setAttribute("aria-pressed", String(selected));
    });
    document.getElementById("activity-usage-heading").textContent = `${metric === "fps" ? "FPS" : metric.toUpperCase()} USAGE`;
    const explanations = {
      cpu: "CPU usage includes OS-reported iCPU and SoC work. Executable commands are shown without arguments to avoid exposing secrets.",
      memory: "Memory is the working set summed across each executable’s processes. Command arguments are hidden to avoid exposing secrets.",
      gpu: "GPU utilization for integrated graphics, discrete GPUs, and SoC graphics requires driver counters this host does not expose. No GPU values are estimated.",
      power: "Per-application power attribution is not exposed by this system. Northstar does not guess per-app wattage.",
      fps: "Frame rate is specific to each running app and is not exposed system-wide for other processes."
    };
    document.getElementById("activity-capability-note").textContent = explanations[metric];
    const available = metric === "cpu" || metric === "memory";
    document.getElementById("activity-table-wrap").hidden = !available;
    const unavailable = document.getElementById("activity-unavailable");
    unavailable.hidden = available;
    if (!available) unavailable.textContent = explanations[metric];
    else renderActivityProcesses();
  }

  function renderActivityProcesses() {
    const list = document.getElementById("activity-process-list");
    list.replaceChildren();
    const sorted = [...activityProcesses].sort((left, right) => {
      const leftUsage = activityMetric === "memory" ? left.memoryBytes : left.cpuPercent;
      const rightUsage = activityMetric === "memory" ? right.memoryBytes : right.cpuPercent;
      if (!Number.isFinite(leftUsage)) return Number.isFinite(rightUsage) ? 1 : 0;
      if (!Number.isFinite(rightUsage)) return -1;
      return rightUsage - leftUsage;
    });
    if (!sorted.length) {
      const row = document.createElement("tr");
      const cell = document.createElement("td");
      cell.colSpan = 4;
      cell.className = "activity-empty";
      cell.textContent = "No process activity was reported by the operating system.";
      row.append(cell);
      list.append(row);
      return;
    }
    for (const process of sorted.slice(0, 100)) {
      const row = document.createElement("tr");
      const appCell = document.createElement("td");
      const appName = document.createElement("strong");
      appName.textContent = process.name;
      appCell.append(appName);
      const commandCell = document.createElement("td");
      const command = document.createElement("code");
      command.textContent = process.command;
      command.title = process.command;
      commandCell.append(command);
      const usageCell = document.createElement("td");
      usageCell.className = "activity-usage";
      if (activityMetric === "memory") {
        usageCell.textContent = formatActivityMemory(process.memoryBytes);
      } else {
        usageCell.textContent = Number.isFinite(process.cpuPercent) ? `${process.cpuPercent.toFixed(1)}%` : "Sampling…";
      }
      const countCell = document.createElement("td");
      countCell.textContent = String(process.processCount);
      row.append(appCell, commandCell, usageCell, countCell);
      list.append(row);
    }
  }

  function formatActivityMemory(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) return "—";
    const megabytes = bytes / (1024 * 1024);
    return megabytes >= 1024 ? `${(megabytes / 1024).toFixed(2)} GB` : `${megabytes.toFixed(0)} MB`;
  }

  async function refreshActivity() {
    if (!nativeApp) {
      document.getElementById("activity-updated").textContent = "Desktop app required";
      return;
    }
    try {
      const [activity, status] = await Promise.all([window.northstar.getActivity(), window.northstar.getSystemStatus()]);
      activityProcesses = activity.processes;
      document.getElementById("activity-cpu").textContent = status.cpuLoad === null ? "—" : `${status.cpuLoad}%`;
      document.getElementById("activity-battery").textContent = status.battery ? `${status.battery.percent}%` : "—";
      document.getElementById("activity-battery-detail").textContent = status.battery ? status.battery.status : "Battery telemetry unavailable";
      const memoryUsed = status.memoryTotalBytes - status.memoryFreeBytes;
      document.getElementById("activity-memory").textContent = formatActivityMemory(memoryUsed);
      document.getElementById("activity-memory-detail").textContent = `of ${formatActivityMemory(status.memoryTotalBytes)} total`;
      document.getElementById("activity-updated").textContent = `Updated ${new Date(activity.capturedAt).toLocaleTimeString()}`;
      if (activityMetric === "cpu" || activityMetric === "memory") renderActivityProcesses();
    } catch {
      document.getElementById("activity-updated").textContent = "Activity query failed";
      showToast("Could not read application activity from the operating system.");
    }
  }

  function renderDevices(devices) {
    const list = document.getElementById("device-list");
    list.replaceChildren();
    document.getElementById("device-count").textContent = `${devices.length} USB ${devices.length === 1 ? "device" : "devices"} detected`;
    document.getElementById("overview-device-count").textContent = `${devices.length} DEVICES`;
    if (devices.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty-devices";
      empty.textContent = "No named USB devices were reported by the operating system.";
      list.append(empty);
      return;
    }
    for (const device of devices) {
      const row = document.createElement("div");
      row.className = "device-row";
      const icon = document.createElement("span");
      icon.className = "usb-device-icon";
      icon.textContent = "⌁";
      const copy = document.createElement("div");
      copy.className = "sensor-copy";
      const name = document.createElement("strong");
      name.textContent = device.name;
      const bus = document.createElement("span");
      bus.textContent = device.bus || "USB device · details not reported";
      copy.append(name, bus);
      const action = document.createElement("button");
      action.className = "device-action";
      action.type = "button";
      action.textContent = "Power options →";
      action.addEventListener("click", requestHardwareAccess);
      row.append(icon, copy, action);
      list.append(row);
    }
  }

  async function refreshDevices() {
    if (!nativeApp) {
      document.getElementById("device-count").textContent = "Desktop app required for device discovery";
      document.getElementById("overview-device-count").textContent = "— DEVICES";
      document.getElementById("device-list").textContent = "Open the Northstar Control desktop app to query connected devices.";
      return;
    }
    try {
      renderDevices(await window.northstar.getDevices());
    } catch {
      document.getElementById("device-count").textContent = "Device query failed";
      document.getElementById("device-list").textContent = "The operating system could not enumerate USB devices.";
    }
  }

  document.getElementById("refresh-button").addEventListener("click", (event) => {
    event.currentTarget.querySelector(".refresh-icon").animate([{ transform: "rotate(0)" }, { transform: "rotate(360deg)" }], { duration: 420 });
    refreshStatus();
  });
  document.getElementById("scan-button").addEventListener("click", refreshDevices);
  document.getElementById("activity-refresh").addEventListener("click", (event) => {
    event.currentTarget.querySelector(".refresh-icon").animate([{ transform: "rotate(0)" }, { transform: "rotate(360deg)" }], { duration: 420 });
    refreshActivity();
  });
  document.querySelectorAll(".activity-category").forEach((button) => {
    button.addEventListener("click", () => setActivityMetric(button.dataset.activityMetric));
  });
  document.querySelectorAll('input[type="checkbox"][data-setting]').forEach((input) => {
    input.addEventListener("change", () => {
      const enabled = input.checked;
      if (!nativeApp) {
        input.checked = !enabled;
        openAccessDialog();
        return;
      }
      window.northstar.setChargeLimit(enabled).then(async (result) => {
        if (!result.ok) {
          input.checked = !enabled;
          if (result.reason === "helper-not-installed") openAccessDialog("mac");
          else if (result.reason !== "cancelled") showToast("This system does not expose a supported writable battery charge limit.");
          return;
        }
        await refreshStatus();
      }).catch(() => {
        input.checked = !enabled;
        showToast("Could not update the battery charge limit.");
      });
    });
  });
  if (nativeApp) {
    refreshStatus();
    refreshDevices();
    loadGitHubStatus();
    refreshRemoteStatus();
    // Skip all background polling while the window is hidden so Northstar stays idle and quiet.
    window.setInterval(() => { if (!document.hidden) refreshStatus(); }, 15000);
    window.setInterval(() => { if (!document.hidden) refreshRemoteStatus(); }, 10000);
    window.setInterval(() => {
      if (!document.hidden && document.getElementById("view-activity").classList.contains("active")) refreshActivity();
    }, 10000);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshStatus(); });
  } else {
    document.getElementById("app-state").textContent = "DESKTOP APP REQUIRED";
    document.getElementById("connection-label").textContent = "Desktop app required";
    document.getElementById("device-count").textContent = "Desktop app required for device discovery";
    document.getElementById("device-list").textContent = "Open the Northstar Control desktop app to query connected devices.";
    document.getElementById("updated-label").textContent = "Live readings load in the desktop app";
    setGitHubAccount(null);
    loadGitHubStatus();
  }
})();
