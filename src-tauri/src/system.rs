use crate::helper;
use crate::util::*;
use regex::Regex;
use serde_json::json;
use std::path::Path;
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use sysinfo::System;
use tokio::sync::Mutex;

const PROFILES: [&str; 3] = ["Efficiency", "Balanced", "Performance"];
const LINUX_IDS: [(&str, &str); 3] = [
    ("power-saver", "Efficiency"),
    ("balanced", "Balanced"),
    ("performance", "Performance"),
];
const WINDOWS_PLANS: [(&str, &str); 3] = [
    ("Efficiency", "a1841308-3541-4fab-bc81-f71556f20b4a"),
    ("Balanced", "381b4222-f694-41f0-9685-ff5bb260df2e"),
    ("Performance", "8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c"),
];
const POWERPROFILESCTL: [&str; 3] = [
    "/usr/bin/powerprofilesctl",
    "/usr/local/bin/powerprofilesctl",
    "/bin/powerprofilesctl",
];

fn read_trimmed(path: &Path) -> Option<String> {
    std::fs::read_to_string(path).ok().map(|text| text.trim().to_string())
}

fn linux_batteries() -> Vec<std::path::PathBuf> {
    let Ok(entries) = std::fs::read_dir("/sys/class/power_supply") else { return vec![] };
    entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|dir| read_trimmed(&dir.join("type")).as_deref() == Some("Battery"))
        .collect()
}

fn read_linux_battery() -> Json {
    for dir in linux_batteries() {
        let percent = read_trimmed(&dir.join("capacity")).and_then(|text| text.parse::<u32>().ok());
        let status = read_trimmed(&dir.join("status"));
        if let (Some(percent), Some(status)) = (percent, status) {
            if percent <= 100 {
                return json!({"percent": percent, "status": status});
            }
        }
        return Json::Null;
    }
    Json::Null
}

async fn read_mac_battery() -> Json {
    let Ok(text) = run("/usr/sbin/ioreg", &["-r", "-c", "AppleSmartBattery", "-d", "1"], 4000).await else {
        return Json::Null;
    };
    let number = |key: &str| -> Option<f64> {
        Regex::new(&format!(r#""{key}"\s*=\s*(\d+)"#))
            .ok()?
            .captures(&text)?
            .get(1)?
            .as_str()
            .parse()
            .ok()
    };
    let (Some(current), Some(maximum)) = (number("CurrentCapacity"), number("MaxCapacity")) else {
        return Json::Null;
    };
    if maximum == 0.0 {
        return Json::Null;
    }
    let charging = Regex::new(r#""IsCharging"\s*=\s*Yes"#).map(|re| re.is_match(&text)).unwrap_or(false);
    let percent = ((current / maximum) * 100.0).round().clamp(0.0, 100.0) as u32;
    json!({"percent": percent, "status": if charging { "Charging" } else { "On battery" }})
}

async fn read_windows_battery() -> Json {
    let script = "$b=Get-CimInstance -ClassName Win32_Battery | Select-Object -First 1 EstimatedChargeRemaining,BatteryStatus; if ($null -eq $b) { 'null' } else { $b | ConvertTo-Json -Compress }";
    let Ok(text) = run(&windows_powershell(), &["-NoProfile", "-NonInteractive", "-Command", script], 7000).await else {
        return Json::Null;
    };
    let Some(data) = parse_json(&text) else { return Json::Null };
    let Some(percent) = data["EstimatedChargeRemaining"].as_u64() else { return Json::Null };
    let charging = matches!(data["BatteryStatus"].as_u64(), Some(2 | 6 | 7 | 8 | 9));
    json!({"percent": percent, "status": if charging { "Charging" } else { "On battery" }})
}

async fn read_battery() -> Json {
    if is_mac() {
        read_mac_battery().await
    } else if is_windows() {
        read_windows_battery().await
    } else {
        tokio::task::spawn_blocking(read_linux_battery).await.unwrap_or(Json::Null)
    }
}

struct LinuxSensors {
    temperature_c: Option<i64>,
    fan_rpm: Option<i64>,
    charge_limit: Option<i64>,
    writable_charge_limit: bool,
}

fn read_linux_sensors() -> LinuxSensors {
    let mut result = LinuxSensors { temperature_c: None, fan_rpm: None, charge_limit: None, writable_charge_limit: false };
    let mut temperatures: Vec<(i64, String)> = vec![];
    if let Ok(zones) = std::fs::read_dir("/sys/class/thermal") {
        for zone in zones.flatten() {
            let name = zone.file_name().to_string_lossy().into_owned();
            if !name.starts_with("thermal_zone") {
                continue;
            }
            let dir = zone.path();
            let source = read_trimmed(&dir.join("type")).unwrap_or_else(|| "system sensor".into());
            if let Some(raw) = read_trimmed(&dir.join("temp")).and_then(|text| text.parse::<i64>().ok()) {
                if raw > 0 {
                    let celsius = if raw > 1000 { raw as f64 / 1000.0 } else { raw as f64 };
                    if celsius > -30.0 && celsius < 130.0 {
                        temperatures.push((celsius.round() as i64, source));
                    }
                }
            }
        }
    }
    let preferred = temperatures.iter().find(|(_, source)| {
        let lower = source.to_lowercase();
        lower.contains("cpu") || lower.contains("pkg") || lower.contains("soc")
    });
    result.temperature_c = preferred.or_else(|| temperatures.first()).map(|(celsius, _)| *celsius);

    'fans: {
        let Ok(roots) = std::fs::read_dir("/sys/class/hwmon") else { break 'fans };
        for root in roots.flatten() {
            let Ok(files) = std::fs::read_dir(root.path()) else { continue };
            for file in files.flatten() {
                let name = file.file_name().to_string_lossy().into_owned();
                if name.starts_with("fan") && name.ends_with("_input") {
                    if let Some(rpm) = read_trimmed(&file.path()).and_then(|text| text.parse::<i64>().ok()) {
                        if rpm > 0 {
                            result.fan_rpm = Some(rpm);
                            break 'fans;
                        }
                    }
                }
            }
        }
    }

    for dir in linux_batteries() {
        let threshold = dir.join("charge_control_end_threshold");
        if let Some(value) = read_trimmed(&threshold).and_then(|text| text.parse::<i64>().ok()) {
            result.charge_limit = Some(value);
            result.writable_charge_limit = std::fs::OpenOptions::new().write(true).open(&threshold).is_ok();
            break;
        }
    }
    result
}

async fn find_powerprofilesctl() -> Option<&'static str> {
    POWERPROFILESCTL.iter().copied().find(|path| Path::new(path).exists())
}

async fn read_power_profile() -> Json {
    let unknown = json!({"current": "Unknown", "supported": false, "available": []});
    if is_linux() {
        let Some(tool) = find_powerprofilesctl().await else { return unknown };
        let (active, listed) = tokio::join!(run(tool, &["get"], 5000), run(tool, &["list"], 5000));
        let (Ok(active), Ok(listed)) = (active, listed) else { return unknown };
        let listed = listed.to_lowercase();
        let current = LINUX_IDS
            .iter()
            .find(|(id, _)| *id == active.trim().to_lowercase())
            .map(|(_, name)| *name)
            .unwrap_or("Unknown");
        let available: Vec<&str> = LINUX_IDS
            .iter()
            .filter(|(id, _)| listed.contains(&format!("{id}:")))
            .map(|(_, name)| *name)
            .collect();
        return json!({"current": current, "supported": !available.is_empty(), "available": available});
    }
    if is_windows() {
        let Ok(text) = run(&windows_powercfg(), &["/list"], 5000).await else { return unknown };
        let lower = text.to_lowercase();
        let available: Vec<&str> = WINDOWS_PLANS
            .iter()
            .filter(|(_, id)| lower.contains(id))
            .map(|(name, _)| *name)
            .collect();
        let active = Regex::new(r"(?i)([a-f0-9-]{36})\s*\*")
            .ok()
            .and_then(|re| re.captures(&text).map(|caps| caps[1].to_lowercase()));
        let current = match active {
            Some(id) => WINDOWS_PLANS.iter().find(|(_, plan)| *plan == id).map(|(name, _)| *name).unwrap_or("Custom"),
            None => "Unknown",
        };
        return json!({"current": current, "supported": !available.is_empty(), "available": available});
    }
    json!({"current": "Managed by macOS", "supported": false, "available": []})
}

fn sample_system() -> (Json, String, u64, u64, u64) {
    let mut system = System::new();
    system.refresh_cpu_usage();
    std::thread::sleep(Duration::from_millis(200));
    system.refresh_cpu_usage();
    system.refresh_memory();
    let load = system.global_cpu_usage().round().clamp(0.0, 100.0);
    let model = system.cpus().first().map(|cpu| cpu.brand().trim().to_string()).filter(|text| !text.is_empty());
    (
        json!(load),
        model.unwrap_or_else(|| "CPU information unavailable".into()),
        System::uptime(),
        system.total_memory(),
        system.available_memory(),
    )
}

static CACHE: OnceLock<Mutex<Option<(Instant, Json)>>> = OnceLock::new();

// One sample is shared between the dashboard and remote telemetry.
pub async fn get_system_status() -> Json {
    let cache = CACHE.get_or_init(|| Mutex::new(None));
    let mut guard = cache.lock().await;
    if let Some((at, value)) = guard.as_ref() {
        if at.elapsed() < Duration::from_secs(8) {
            return value.clone();
        }
    }
    let value = read_system_status().await;
    *guard = Some((Instant::now(), value.clone()));
    value
}

async fn read_system_status() -> Json {
    let (battery, linux, power_profile, sample, hardware, sensors) = tokio::join!(
        read_battery(),
        async {
            if is_linux() {
                tokio::task::spawn_blocking(read_linux_sensors).await.ok()
            } else {
                None
            }
        },
        read_power_profile(),
        async { tokio::task::spawn_blocking(sample_system).await.ok() },
        helper::get_status(),
        helper::get_sensors()
    );
    let (cpu_load, cpu_model, uptime, total, free) =
        sample.unwrap_or((Json::Null, "CPU information unavailable".into(), 0, 0, 0));
    let linux_temperature = linux.as_ref().and_then(|item| item.temperature_c);
    let linux_fan = linux.as_ref().and_then(|item| item.fan_rpm);
    let linux_limit = linux.as_ref().and_then(|item| item.charge_limit);
    let linux_writable = linux.as_ref().map(|item| item.writable_charge_limit).unwrap_or(false);
    json!({
        "platform": platform_name(),
        "hostname": System::host_name().unwrap_or_else(|| "This computer".into()),
        "cpuModel": cpu_model,
        "cpuLoad": cpu_load,
        "uptimeSeconds": uptime,
        "memoryTotalBytes": total,
        "memoryFreeBytes": free,
        "battery": battery,
        "temperatureC": sensors.as_ref().and_then(|item| item.temperature_c).or(linux_temperature),
        "packagePowerW": sensors.as_ref().and_then(|item| item.package_power_w),
        "systemPowerW": sensors.as_ref().and_then(|item| item.system_power_w),
        "thermalPressure": sensors.as_ref().and_then(|item| item.thermal_pressure.clone()),
        "fanRpm": if hardware["fanRpm"].is_null() { json!(linux_fan) } else { hardware["fanRpm"].clone() },
        "fanMode": hardware["fanMode"],
        "fanMinimumRpm": hardware["fanMinimumRpm"],
        "fanMaximumRpm": hardware["fanMaximumRpm"],
        "chargeLimit": if hardware["chargeLimit"].is_null() { json!(linux_limit) } else { hardware["chargeLimit"].clone() },
        "writableChargeLimit": hardware["chargeLimitAvailable"] == true || linux_writable,
        "hardwareControls": hardware,
        "powerProfile": power_profile
    })
}

pub async fn get_devices() -> Json {
    let mut devices: Vec<Json> = vec![];
    if is_linux() {
        let found = tokio::task::spawn_blocking(|| {
            let mut list = vec![];
            let pattern = Regex::new(r"^\d+-[\d.]+$").unwrap();
            if let Ok(entries) = std::fs::read_dir("/sys/bus/usb/devices") {
                for entry in entries.flatten() {
                    let name = entry.file_name().to_string_lossy().into_owned();
                    if !pattern.is_match(&name) {
                        continue;
                    }
                    let product = read_trimmed(&entry.path().join("product")).unwrap_or_default();
                    let maker = read_trimmed(&entry.path().join("manufacturer")).unwrap_or_default();
                    let label = [maker, product].iter().filter(|part| !part.is_empty()).cloned().collect::<Vec<_>>().join(" ");
                    if !label.is_empty() {
                        list.push(json!({"name": label, "bus": name}));
                    }
                }
            }
            list
        })
        .await
        .unwrap_or_default();
        devices = found;
    } else if is_windows() {
        let script = "Get-PnpDevice -Class USB -ErrorAction SilentlyContinue | Where-Object { $_.Status -eq 'OK' } | Select-Object -First 30 FriendlyName,InstanceId | ConvertTo-Json -Compress";
        if let Ok(text) = run(&windows_powershell(), &["-NoProfile", "-NonInteractive", "-Command", script], 7000).await {
            if let Some(data) = parse_json(&text) {
                let rows = if data.is_array() { data.as_array().cloned().unwrap_or_default() } else { vec![data] };
                for row in rows {
                    devices.push(json!({
                        "name": row["FriendlyName"].as_str().unwrap_or("USB device"),
                        "bus": row["InstanceId"].as_str().unwrap_or("")
                    }));
                }
            }
        }
    } else if is_mac() {
        if let Ok(text) = run("/usr/sbin/ioreg", &["-p", "IOUSB", "-l", "-w", "0"], 5000).await {
            if let Ok(re) = Regex::new(r#""USB Product Name"\s*=\s*"([^"]+)""#) {
                for caps in re.captures_iter(&text) {
                    devices.push(json!({"name": &caps[1], "bus": ""}));
                }
            }
        }
    }
    Json::Array(devices)
}

pub async fn set_power_profile(profile: &str) -> Json {
    if !PROFILES.contains(&profile) {
        return json!({"ok": false, "reason": "invalid-profile"});
    }
    if is_linux() {
        let id = LINUX_IDS.iter().find(|(_, name)| *name == profile).map(|(id, _)| *id).unwrap_or("balanced");
        let Some(tool) = find_powerprofilesctl().await else {
            return json!({"ok": false, "reason": "unsupported"});
        };
        let Ok(listed) = run(tool, &["list"], 5000).await else {
            return json!({"ok": false, "reason": "authorization-or-platform-error"});
        };
        if !listed.to_lowercase().contains(&format!("{id}:")) {
            return json!({"ok": false, "reason": "profile-not-installed"});
        }
        return match run(tool, &["set", id], 5000).await {
            Ok(_) => json!({"ok": true, "profile": profile}),
            Err(_) => json!({"ok": false, "reason": "authorization-or-platform-error"}),
        };
    }
    if is_windows() {
        let plan = WINDOWS_PLANS.iter().find(|(name, _)| *name == profile).map(|(_, id)| *id).unwrap_or("");
        let tool = windows_powercfg();
        return match run(&tool, &["/list"], 5000).await {
            Ok(text) if text.to_lowercase().contains(plan) => match run(&tool, &["/setactive", plan], 5000).await {
                Ok(_) => json!({"ok": true, "profile": profile}),
                Err(_) => json!({"ok": false, "reason": "authorization-or-platform-error"}),
            },
            Ok(_) => json!({"ok": false, "reason": "profile-not-installed"}),
            Err(_) => json!({"ok": false, "reason": "authorization-or-platform-error"}),
        };
    }
    json!({"ok": false, "reason": "managed-by-operating-system"})
}

pub async fn confirm_hardware_change(confirm: &ConfirmFn, message: &str, detail: &str) -> bool {
    confirm(ConfirmRequest {
        title: "Confirm hardware change".into(),
        message: message.into(),
        detail: detail.into(),
        ok_label: "Apply".into(),
    })
    .await
}

pub async fn set_charge_limit(enabled: bool, confirm: &ConfirmFn) -> Json {
    if is_mac() {
        let status = helper::get_status().await;
        if status["chargeLimitAvailable"] != true {
            let reason = if status["installed"] == true { "helper-or-hardware-unavailable" } else { "helper-not-installed" };
            return json!({"ok": false, "reason": reason});
        }
        let detail = if enabled {
            "Keep this MacBook's battery near 80% while connected to power?"
        } else {
            "Return battery charging to normal macOS control?"
        };
        if !confirm_hardware_change(confirm, "Change battery charge limit?", detail).await {
            return json!({"ok": false, "reason": "cancelled"});
        }
        return helper::set_charge_limit(enabled).await;
    }
    if !is_linux() {
        return json!({"ok": false, "reason": "unsupported"});
    }
    tokio::task::spawn_blocking(move || {
        let supplies = linux_batteries();
        if supplies.is_empty() {
            return json!({"ok": false, "reason": "unsupported"});
        }
        for dir in supplies {
            let setting = dir.join("charge_control_end_threshold");
            match std::fs::write(&setting, if enabled { "80" } else { "100" }) {
                Ok(_) => return json!({"ok": true, "enabled": enabled}),
                Err(error) if matches!(error.kind(), std::io::ErrorKind::NotFound | std::io::ErrorKind::PermissionDenied) => continue,
                Err(_) => return json!({"ok": false, "reason": "hardware-write-failed"}),
            }
        }
        json!({"ok": false, "reason": "helper-or-hardware-required"})
    })
    .await
    .unwrap_or_else(|_| json!({"ok": false, "reason": "hardware-write-failed"}))
}

pub async fn set_fan_profile(profile: &str, confirm: &ConfirmFn) -> Json {
    if helper::fan_profile_arg(profile).is_none() {
        return json!({"ok": false, "reason": "invalid-profile"});
    }
    if !is_mac() {
        return json!({"ok": false, "reason": "unsupported"});
    }
    let status = helper::get_status().await;
    if status["fanAvailable"] != true {
        let reason = if status["installed"] == true { "helper-or-hardware-unavailable" } else { "helper-not-installed" };
        return json!({"ok": false, "reason": reason});
    }
    let message = format!("Apply {} fan profile?", profile.to_lowercase());
    if !confirm_hardware_change(
        confirm,
        &message,
        "Fan behavior is hardware-dependent. You can restore automatic fan control at any time.",
    )
    .await
    {
        return json!({"ok": false, "reason": "cancelled"});
    }
    helper::set_fan_profile(profile).await
}

pub async fn get_gpus() -> Json {
    let mut adapters: Vec<Json> = vec![];
    if is_mac() {
        if let Ok(text) = run("/usr/sbin/system_profiler", &["SPDisplaysDataType", "-json"], 8000).await {
            if let Some(data) = parse_json(&text) {
                for item in data["SPDisplaysDataType"].as_array().cloned().unwrap_or_default() {
                    let name = item["sppci_model"].as_str().or(item["_name"].as_str()).unwrap_or("GPU");
                    adapters.push(json!({"vendorId": 0, "deviceId": adapters.len(), "active": true, "name": name, "driver": null}));
                }
            }
        }
    } else if is_windows() {
        let script = "Get-CimInstance Win32_VideoController | Select-Object Name,DriverVersion | ConvertTo-Json -Compress";
        if let Ok(text) = run(&windows_powershell(), &["-NoProfile", "-NonInteractive", "-Command", script], 7000).await {
            if let Some(data) = parse_json(&text) {
                let rows = if data.is_array() { data.as_array().cloned().unwrap_or_default() } else { vec![data] };
                for row in rows {
                    adapters.push(json!({"vendorId": 0, "deviceId": adapters.len(), "active": true, "name": row["Name"], "driver": row["DriverVersion"]}));
                }
            }
        }
    } else if let Ok(text) = run("lspci", &[], 5000).await {
        for line in text.lines().filter(|line| line.contains("VGA compatible") || line.contains("3D controller") || line.contains("Display controller")) {
            let name = line.splitn(2, ": ").nth(1).unwrap_or(line);
            adapters.push(json!({"vendorId": 0, "deviceId": adapters.len(), "active": true, "name": name, "driver": null}));
        }
    }
    Json::Array(adapters)
}
