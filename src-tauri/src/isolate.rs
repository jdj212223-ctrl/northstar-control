use crate::util::Json;
use serde_json::json;
use std::time::Duration;
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};

const CPU_THRESHOLD: f32 = 8.0;
const MAX_TARGETS: usize = 12;

// Core OS and shell processes that must never be slowed down.
const PROTECTED: &[&str] = &[
    "windowserver", "kernel_task", "launchd", "finder", "dock", "loginwindow", "systemuiserver",
    "coreaudiod", "hidd", "controlcenter", "notificationcenter", "csrss.exe", "dwm.exe", "explorer.exe",
    "system", "winlogon.exe", "services.exe", "svchost.exe", "lsass.exe", "xorg", "gnome-shell",
    "kwin_x11", "kwin_wayland", "systemd", "pipewire", "pulseaudio", "northstar-control",
    "northstar control", "northstar",
];

fn foreground_pid() -> Option<u32> {
    if !cfg!(target_os = "macos") {
        return None;
    }
    let front = std::process::Command::new("lsappinfo").arg("front").output().ok()?;
    let asn = String::from_utf8_lossy(&front.stdout).trim().to_string();
    if asn.is_empty() {
        return None;
    }
    let info = std::process::Command::new("lsappinfo").args(["info", "-only", "pid", &asn]).output().ok()?;
    let text = String::from_utf8_lossy(&info.stdout);
    text.split("pid = ").nth(1)?.split(|c: char| !c.is_ascii_digit()).next()?.parse().ok()
}

fn lower_priority(pid: u32) -> bool {
    if cfg!(windows) {
        let script = format!("(Get-Process -Id {pid}).PriorityClass='BelowNormal'");
        return std::process::Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .output()
            .map(|out| out.status.success())
            .unwrap_or(false);
    }
    std::process::Command::new("renice")
        .args(["-n", "15", "-p", &pid.to_string()])
        .output()
        .map(|out| out.status.success())
        .unwrap_or(false)
}

fn run() -> Json {
    let mut system = System::new();
    system.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::everything());
    std::thread::sleep(Duration::from_millis(600));
    system.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::everything());

    let own = std::process::id();
    let front = foreground_pid();
    let front_exe = front
        .and_then(|pid| system.process(Pid::from_u32(pid)))
        .and_then(|process| process.exe().map(|path| path.to_path_buf()));

    let ps = crate::util::ps_cpu_map();
    let mut candidates: Vec<(u32, String, f32)> = system
        .processes()
        .iter()
        .filter_map(|(pid, process)| {
            let id = pid.as_u32();
            let name = process.name().to_string_lossy().into_owned();
            let lower = name.to_lowercase();
            let exe = process.exe().map(|path| path.to_string_lossy().into_owned()).unwrap_or_default();
            let system_path = exe.starts_with("/System/") || exe.starts_with("/usr/") || exe.starts_with("/sbin/")
                || exe.to_lowercase().starts_with("c:\\windows\\");
            let same_app_as_front = front_exe.as_ref().is_some_and(|path| path.to_string_lossy() == exe.as_str());
            let guarded = id == own || Some(id) == front || same_app_as_front || system_path
                || PROTECTED.contains(&lower.as_str());
            let cpu = ps.as_ref().and_then(|map| map.get(&id).copied()).unwrap_or_else(|| process.cpu_usage());
            (cpu >= CPU_THRESHOLD && !guarded).then_some((id, name, cpu))
        })
        .collect();
    candidates.sort_by(|left, right| right.2.partial_cmp(&left.2).unwrap_or(std::cmp::Ordering::Equal));
    candidates.truncate(MAX_TARGETS);

    let mut demoted = Vec::new();
    let mut failed = 0_u32;
    for (pid, name, cpu) in candidates {
        if lower_priority(pid) {
            demoted.push(json!({"pid": pid, "name": name, "cpuPercent": (cpu * 10.0).round() / 10.0}));
        } else {
            failed += 1;
        }
    }
    json!({"ok": true, "demoted": demoted, "failed": failed, "foregroundProtected": front.is_some()})
}

pub async fn isolate() -> Json {
    tokio::task::spawn_blocking(run)
        .await
        .unwrap_or_else(|error| json!({"ok": false, "reason": error.to_string()}))
}

#[cfg(test)]
mod tests {
    #[test]
    fn protected_list_is_lowercase() {
        assert!(super::PROTECTED.iter().all(|name| name.to_lowercase() == *name));
    }

    #[test]
    #[ignore = "really lowers priority of busy processes"]
    fn run_never_touches_this_process() {
        let report = super::run();
        let _ = &report;
        let own = std::process::id();
        assert!(report["demoted"].as_array().unwrap().iter().all(|item| item["pid"] != own));
    }
}
