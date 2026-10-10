(() => {
  "use strict";
  const api = window.northstar;
  const button = document.getElementById("activity-isolate");
  const note = document.getElementById("isolate-note");
  if (!api || !api.isolate || !button || !note) return;

  button.addEventListener("click", async () => {
    button.disabled = true;
    note.textContent = "Finding what is hogging the CPU…";
    try {
      const result = await api.isolate();
      if (!result || !result.ok) {
        note.textContent = "Couldn't isolate right now.";
      } else if (!result.demoted.length) {
        note.textContent = result.failed
          ? "Couldn't lower priority for the busy apps (not permitted)."
          : "Nothing is hogging the CPU right now, so nothing needed isolating.";
      } else {
        const names = result.demoted.map((item) => `${item.name} (${item.cpuPercent}%)`).join(", ");
        note.textContent = `Isolated ${result.demoted.length} busy ${result.demoted.length === 1 ? "app" : "apps"} to low priority: ${names}. Your active app and the system stay untouched. Priority resets when they relaunch.`;
      }
    } catch {
      note.textContent = "Couldn't isolate right now.";
    } finally {
      button.disabled = false;
    }
  });
})();
