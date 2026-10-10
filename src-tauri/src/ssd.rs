use crate::util::*;
use serde_json::json;

const NVME_UNIT_BYTES: f64 = 512_000.0;
const TB: f64 = 1e12;
// Typical consumer TLC endurance is roughly 600 TB written per TB of capacity.
const ESTIMATED_TBW_PER_TB: f64 = 600.0;
const MARKETING_SIZES_GB: [f64; 11] = [
    120.0, 128.0, 240.0, 256.0, 480.0, 512.0, 960.0, 1000.0, 2000.0, 4000.0, 8000.0,
];

fn marketing_capacity_gb(bytes: f64) -> f64 {
    let gb = bytes / 1e9;
    MARKETING_SIZES_GB
        .iter()
        .copied()
        .find(|size| gb <= size * 1.03)
        .unwrap_or(gb.round())
}

fn status_label(health: f64) -> &'static str {
    if health >= 80.0 {
        "Good"
    } else if health >= 50.0 {
        "Fair"
    } else if health >= 20.0 {
        "Worn"
    } else {
        "Replace soon"
    }
}

fn ata_attribute(info: &Json, id: u64) -> Option<&Json> {
    info["ata_smart_attributes"]["table"]
        .as_array()?
        .iter()
        .find(|attribute| attribute["id"].as_u64() == Some(id))
}

// Turns one `smartctl -a -j` document into a health report. Pure so it can be tested.
pub fn parse_smartctl(info: &Json, fallback_capacity: Option<f64>) -> Option<Json> {
    let model = info["model_name"].as_str().unwrap_or("Unknown drive").to_string();
    if info["rotation_rate"].as_u64().unwrap_or(0) > 0 {
        return None; // spinning disk: no flash wear to report
    }
    let capacity = info["user_capacity"]["bytes"]
        .as_f64()
        .or_else(|| info["nvme_total_capacity"].as_f64())
        .or(fallback_capacity);

    let mut written_bytes: Option<f64> = None;
    let mut drive_used: Option<f64> = None;
    let mut spare: Option<f64> = None;
    let mut power_on_hours = info["power_on_time"]["hours"].as_f64();
    let mut temperature = info["temperature"]["current"].as_f64();
    let mut media_errors: Option<f64> = None;
    let mut critical = false;

    let nvme = &info["nvme_smart_health_information_log"];
    if nvme.is_object() {
        written_bytes = nvme["data_units_written"].as_f64().map(|units| units * NVME_UNIT_BYTES);
        drive_used = nvme["percentage_used"].as_f64();
        spare = nvme["available_spare"].as_f64();
        power_on_hours = nvme["power_on_hours"].as_f64().or(power_on_hours);
        temperature = nvme["temperature"].as_f64().or(temperature);
        media_errors = nvme["media_errors"].as_f64();
        critical = nvme["critical_warning"].as_f64().unwrap_or(0.0) > 0.0;
    } else if info["ata_smart_attributes"].is_object() {
        if let Some(lbas) = ata_attribute(info, 241).or_else(|| ata_attribute(info, 246)) {
            let raw = lbas["raw"]["value"].as_f64();
            let sector = info["logical_block_size"].as_f64().unwrap_or(512.0);
            written_bytes = raw.map(|value| value * sector);
        }
        // Normalised values count down from 100 as the drive wears.
        for id in [231_u64, 233, 177, 202] {
            if let Some(value) = ata_attribute(info, id).and_then(|a| a["value"].as_f64()) {
                if value > 0.0 && value <= 100.0 {
                    drive_used = Some(100.0 - value);
                    break;
                }
            }
        }
        if let Some(raw) = ata_attribute(info, 9).and_then(|a| a["raw"]["value"].as_f64()) {
            power_on_hours = Some(raw);
        }
    } else {
        return None;
    }

    let smart_passed = info["smart_status"]["passed"].as_bool();
    Some(build_report(
        model,
        capacity,
        written_bytes,
        drive_used,
        spare,
        power_on_hours,
        temperature,
        media_errors,
        critical || smart_passed == Some(false),
    ))
}

#[allow(clippy::too_many_arguments)]
pub fn build_report(
    model: String,
    capacity: Option<f64>,
    written_bytes: Option<f64>,
    drive_used: Option<f64>,
    spare: Option<f64>,
    power_on_hours: Option<f64>,
    temperature: Option<f64>,
    media_errors: Option<f64>,
    attention: bool,
) -> Json {
    let written_tb = written_bytes.map(|bytes| bytes / TB);
    let rated_tbw = capacity.map(|bytes| marketing_capacity_gb(bytes) / 1000.0 * ESTIMATED_TBW_PER_TB);
    let estimated = match (written_tb, rated_tbw) {
        (Some(written), Some(rated)) if rated > 0.0 => Some((100.0 - written / rated * 100.0).clamp(0.0, 100.0)),
        _ => None,
    };
    let reported = drive_used.map(|used| (100.0 - used).clamp(0.0, 100.0));
    // The headline score is computed from total data written; the drive's own wear is secondary.
    let health = estimated.map(|value| value.round().clamp(1.0, 100.0)).or(reported);
    let source = if estimated.is_some() { "writes" } else if reported.is_some() { "drive" } else { "none" };

    // Years left at the average write rate since the drive was new.
    let years_left = match (written_tb, rated_tbw, power_on_hours) {
        (Some(written), Some(rated), Some(hours)) if hours >= 24.0 && written > 0.0 => {
            let per_day = written / (hours / 24.0);
            let basis = if let Some(used) = drive_used.filter(|u| *u > 0.0) {
                // Use the drive's own wear figure to project the total life.
                written / (used / 100.0) - written
            } else {
                rated - written
            };
            Some((basis.max(0.0) / per_day / 365.0 * 10.0).round() / 10.0)
        }
        _ => None,
    };

    let mut status = health.map(status_label).unwrap_or("Unknown").to_string();
    if attention || media_errors.unwrap_or(0.0) > 0.0 {
        status = "Attention".into();
    }
    json!({
        "model": model,
        "capacityGB": capacity.map(|bytes| (bytes / 1e9).round()),
        "writtenTB": written_tb.map(|value| (value * 100.0).round() / 100.0),
        "ratedTBW": rated_tbw.map(|value| value.round()),
        "healthPercent": health.map(|value| value.round()),
        "healthSource": source,
        "estimatedHealthPercent": estimated.map(|value| value.round()),
        "driveHealthPercent": reported.map(|value| value.round()),
        "driveWearPercent": drive_used,
        "availableSparePercent": spare,
        "powerOnHours": power_on_hours,
        "temperatureC": temperature,
        "mediaErrors": media_errors,
        "yearsLeft": years_left,
        "status": status
    })
}

fn smartctl_path() -> Option<String> {
    let candidates = [
        "/opt/homebrew/bin/smartctl",
        "/usr/local/bin/smartctl",
        "/usr/sbin/smartctl",
        "/usr/bin/smartctl",
        "C:\\Program Files\\smartmontools\\bin\\smartctl.exe",
    ];
    candidates.iter().find(|path| std::path::Path::new(path).exists()).map(|path| path.to_string())
}

async fn scan_count(executable: &str) -> usize {
    match run_raw(executable, &["--scan", "-j"], 10_000).await {
        Ok(scan) => parse_json(&scan.stdout).and_then(|v| v["devices"].as_array().map(|a| a.len())).unwrap_or(0),
        Err(_) => 0,
    }
}

// Some drives (Apple's) don't report capacity to SMART; use the largest internal volume instead.
fn internal_capacity() -> Option<f64> {
    sysinfo::Disks::new_with_refreshed_list()
        .iter()
        .filter(|disk| !disk.is_removable())
        .map(|disk| disk.total_space() as f64)
        .fold(None, |best: Option<f64>, size| Some(best.map_or(size, |b| b.max(size))))
}

async fn smartctl_reports(executable: &str) -> Vec<Json> {
    let mut reports = Vec::new();
    let single = scan_count(executable).await == 1;
    let fallback = if single { internal_capacity() } else { None };
    let Ok(scan) = run_raw(executable, &["--scan", "-j"], 10_000).await else { return reports };
    let Some(scan) = parse_json(&scan.stdout) else { return reports };
    for device in scan["devices"].as_array().cloned().unwrap_or_default() {
        let (Some(name), Some(kind)) = (device["name"].as_str(), device["type"].as_str()) else { continue };
        // smartctl exits non-zero for benign warnings; the JSON is still valid.
        let Ok(output) = run_raw(executable, &["-a", "-j", "-d", kind, name], 15_000).await else { continue };
        if let Some(report) = parse_json(&output.stdout).and_then(|info| parse_smartctl(&info, fallback)) {
            let mut report = report;
            report["device"] = json!(name);
            reports.push(report);
        }
    }
    reports
}

async fn windows_reports() -> Vec<Json> {
    let script = "Get-PhysicalDisk | ForEach-Object { $r = $_ | Get-StorageReliabilityCounter; [pscustomobject]@{ name=$_.FriendlyName; media=[string]$_.MediaType; size=$_.Size; wear=$r.Wear; hours=$r.PowerOnHours; temp=$r.Temperature; readErr=$r.ReadErrorsUncorrected } } | ConvertTo-Json -Compress";
    let Ok(output) = run(&windows_powershell(), &["-NoProfile", "-Command", script], 15_000).await else { return vec![] };
    let Some(parsed) = parse_json(&output) else { return vec![] };
    let list = if parsed.is_array() { parsed.as_array().cloned().unwrap_or_default() } else { vec![parsed] };
    list.iter()
        .filter(|disk| disk["media"].as_str() == Some("SSD"))
        .map(|disk| {
            let mut report = build_report(
                disk["name"].as_str().unwrap_or("SSD").to_string(),
                disk["size"].as_f64(),
                None,
                disk["wear"].as_f64(),
                None,
                disk["hours"].as_f64(),
                disk["temp"].as_f64(),
                disk["readErr"].as_f64(),
                false,
            );
            report["device"] = json!(disk["name"]);
            report
        })
        .collect()
}

pub async fn get_ssd_health() -> Json {
    let mut reports = Vec::new();
    let tool = smartctl_path();
    if let Some(executable) = &tool {
        reports = smartctl_reports(executable).await;
    }
    if reports.is_empty() && is_windows() {
        reports = windows_reports().await;
    }
    if !reports.is_empty() {
        return json!({ "ok": true, "drives": reports });
    }
    let reason = match (&tool, is_linux()) {
        (None, _) => "smartctl-missing",
        (Some(_), true) => "permission-or-unsupported",
        _ => "unsupported",
    };
    json!({ "ok": false, "reason": reason, "drives": [] })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nvme_uses_drive_reported_wear_and_counts_writes() {
        let info = json!({
            "model_name": "TEST NVME",
            "user_capacity": { "bytes": 251_000_000_000_u64 },
            "smart_status": { "passed": true },
            "nvme_smart_health_information_log": {
                "percentage_used": 4, "available_spare": 100, "data_units_written": 111_141_507_u64,
                "power_on_hours": 1150, "temperature": 37, "media_errors": 0, "critical_warning": 0
            }
        });
        let report = parse_smartctl(&info, None).unwrap();
        assert_eq!(report["writtenTB"], json!(56.9));
        assert_eq!(report["healthPercent"], json!(63.0)); // 100 - 56.9/154 written
        assert_eq!(report["driveHealthPercent"], json!(96.0));
        assert_eq!(report["healthSource"], json!("writes"));
        assert_eq!(report["ratedTBW"], json!(154.0)); // 256 GB class
        assert_eq!(report["status"], json!("Fair"));
    }

    #[test]
    fn ata_falls_back_to_written_bytes_estimate() {
        let info = json!({
            "model_name": "TEST SATA",
            "user_capacity": { "bytes": 500_107_862_016_u64 },
            "logical_block_size": 512,
            "ata_smart_attributes": { "table": [
                { "id": 241, "value": 100, "raw": { "value": 300_000_000_000_u64 } },
                { "id": 9, "value": 99, "raw": { "value": 8760 } }
            ] }
        });
        let report = parse_smartctl(&info, None).unwrap();
        assert_eq!(report["healthSource"], json!("writes"));
        assert_eq!(report["writtenTB"], json!(153.6));
        // 512 GB class → 307 TBW rated; 153.6 written → about half left.
        assert_eq!(report["healthPercent"], json!(50.0));
        assert_eq!(report["status"], json!("Fair"));
    }

    #[test]
    fn hard_disks_and_media_errors() {
        assert!(parse_smartctl(&json!({ "model_name": "HDD", "rotation_rate": 7200 }), None).is_none());
        let failing = build_report("X".into(), Some(1e12), Some(1e12), Some(10.0), None, None, None, Some(3.0), false);
        assert_eq!(failing["status"], json!("Attention"));
    }

    #[tokio::test]
    #[ignore = "reads this machine's real drive"]
    async fn live_drive_report() {
        println!("{}", get_ssd_health().await);
    }
}
