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
  }

  function applyPreferences(preferences) {
    unitSelect.value = preferences.temperatureUnit === "fahrenheit" ? "fahrenheit" : "celsius";
    compactToggle.checked = preferences.compact === true;
    themeSelect.value = preferences.theme === "light" ? "light" : "dark";
    document.documentElement.dataset.theme = themeSelect.value;
    document.documentElement.classList.toggle("compact", compactToggle.checked);
  }

  function readPreferences() {
    try {
      const saved = window.localStorage.getItem(preferenceKey);
      if (!saved) return {};
      const parsed = JSON.parse(saved);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      saveStatus.textContent = "Browser storage is unavailable; preferences won't persist.";
      return {};
    }
  }

  function savePreferences() {
    const preferences = {
      temperatureUnit: unitSelect.value,
      compact: compactToggle.checked,
      theme: themeSelect.value
    };
    applyPreferences(preferences);
    try {
      window.localStorage.setItem(preferenceKey, JSON.stringify(preferences));
      saveStatus.textContent = "Preferences saved in this browser.";
    } catch {
      saveStatus.textContent = "Could not save preferences; browser storage is unavailable.";
    }
  }

  navigation.forEach((item) => item.addEventListener("click", () => setView(item.dataset.view)));
  document.querySelectorAll("[data-view]:not(.nav-item)").forEach((item) => item.addEventListener("click", () => setView(item.dataset.view)));
  [unitSelect, compactToggle, themeSelect].forEach((input) => input.addEventListener("change", savePreferences));
  document.getElementById("clear-preferences").addEventListener("click", () => {
    try {
      window.localStorage.removeItem(preferenceKey);
      applyPreferences({});
      saveStatus.textContent = "Browser preferences have been reset.";
    } catch {
      saveStatus.textContent = "Could not reset preferences; browser storage is unavailable.";
    }
  });

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
})();
