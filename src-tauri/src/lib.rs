mod activity;
mod bench;
mod channel;
mod fan;
mod github;
mod helper;
mod remote;
mod store;
mod system;
mod updater;
mod util;

use serde_json::json;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use util::{ConfirmFn, ConfirmRequest, Json};

struct AppState {
    smart_fan: fan::SmartFan,
    bench_cancel: Arc<AtomicBool>,
    bench_running: AtomicBool,
    github: github::GitHubAuth,
    remote: Arc<remote::RemoteAgent>,
    updater: Arc<updater::Updater>,
    confirm: ConfirmFn,
    app: AppHandle,
}

fn make_confirm(app: AppHandle) -> ConfirmFn {
    Arc::new(move |request: ConfirmRequest| {
        let app = app.clone();
        Box::pin(async move {
            let text = if request.detail.is_empty() {
                request.message
            } else {
                format!("{}\n\n{}", request.message, request.detail)
            };
            tokio::task::spawn_blocking(move || {
                app.dialog()
                    .message(text)
                    .title(request.title)
                    .kind(MessageDialogKind::Warning)
                    .buttons(MessageDialogButtons::OkCancelCustom(request.ok_label, "Cancel".into()))
                    .blocking_show()
            })
            .await
            .unwrap_or(false)
        })
    })
}

async fn info_dialog(app: &AppHandle, title: &str, message: String) {
    let app = app.clone();
    let title = title.to_string();
    let _ = tokio::task::spawn_blocking(move || {
        app.dialog()
            .message(message)
            .title(title)
            .kind(MessageDialogKind::Info)
            .buttons(MessageDialogButtons::Ok)
            .blocking_show()
    })
    .await;
}

#[tauri::command]
async fn system_status() -> Json {
    system::get_system_status().await
}

#[tauri::command]
async fn system_activity() -> Result<Json, String> {
    activity::get_process_activity().await
}

#[tauri::command]
async fn system_devices() -> Json {
    system::get_devices().await
}

#[tauri::command]
async fn set_power_profile(profile: String) -> Json {
    system::set_power_profile(&profile).await
}

#[tauri::command]
async fn set_charge_limit(enabled: bool, app_handle: AppHandle) -> Json {
    let state = app_handle.state::<Arc<AppState>>().inner().clone();
    system::set_charge_limit(enabled, &state.confirm).await
}

#[tauri::command]
async fn set_fan_profile(profile: String, app_handle: AppHandle) -> Json {
    let state = app_handle.state::<Arc<AppState>>().inner().clone();
    system::set_fan_profile(&profile, &state.confirm).await
}

#[tauri::command]
async fn request_hardware_access(app_handle: AppHandle) -> Json {
    let state = app_handle.state::<Arc<AppState>>().inner().clone();
    if util::is_mac() {
        let status = helper::get_status().await;
        let (message, detail) = helper::access_message(&status);
        info_dialog(&state.app, "macOS hardware helper status", format!("{message}\n\n{detail}")).await;
        return if status["daemonAvailable"] == true {
            json!({"ok": true})
        } else {
            json!({"ok": false, "reason": "macos-helper-not-ready"})
        };
    }
    info_dialog(
        &state.app,
        "Hardware service unavailable",
        "This build has no authorized hardware service.\n\nOnly public operating-system controls exposed by your device are available. Fan, USB power and overclock controls need additional hardware-specific services.".into(),
    )
    .await;
    json!({"ok": false, "reason": "hardware-service-not-installed"})
}

#[tauri::command]
async fn fan_smart_state(app_handle: AppHandle) -> Json {
    let state = app_handle.state::<Arc<AppState>>().inner().clone();
    state.smart_fan.state().await
}

#[tauri::command]
async fn fan_smart_set(enabled: bool, app_handle: AppHandle) -> Json {
    let state = app_handle.state::<Arc<AppState>>().inner().clone();
    state.smart_fan.set(enabled, state.confirm.clone()).await
}

#[tauri::command]
async fn bench_volumes() -> Vec<Json> {
    bench::list_volumes().await
}

#[tauri::command]
async fn bench_gpus() -> Json {
    system::get_gpus().await
}

#[tauri::command]
async fn bench_cancel(app_handle: AppHandle) -> Result<(), String> {
    let state = app_handle.state::<Arc<AppState>>().inner().clone();
    state.bench_cancel.store(true, Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
async fn bench_run(request: Json, app_handle: AppHandle) -> Result<Json, String> {
    let state = app_handle.state::<Arc<AppState>>().inner().clone();
    if state.bench_running.swap(true, Ordering::SeqCst) {
        return Ok(json!({"ok": false, "reason": "busy"}));
    }
    state.bench_cancel.store(false, Ordering::Relaxed);
    let kind = request["kind"].as_str().unwrap_or("").to_string();
    let result = run_benchmark(&kind, &request, &state).await;
    state.bench_running.store(false, Ordering::SeqCst);
    Ok(result)
}

async fn run_benchmark(kind: &str, request: &Json, state: &Arc<AppState>) -> Json {
    match kind {
        "cpu" => match tokio::task::spawn_blocking(bench::bench_cpu).await {
            Ok(result) => json!({"ok": true, "kind": kind, "result": result}),
            Err(error) => json!({"ok": false, "reason": error.to_string()}),
        },
        "memory" => match tokio::task::spawn_blocking(bench::bench_memory).await {
            Ok(result) => json!({"ok": true, "kind": kind, "result": result}),
            Err(error) => json!({"ok": false, "reason": error.to_string()}),
        },
        "disk" => {
            let volumes = bench::list_volumes().await;
            let wanted = request["volume"].as_str().unwrap_or("");
            let Some(volume) = volumes.iter().find(|item| item["id"].as_str() == Some(wanted)) else {
                return json!({"ok": false, "reason": "unknown-volume"});
            };
            let path = std::path::PathBuf::from(volume["path"].as_str().unwrap_or(""));
            let label = volume["label"].as_str().unwrap_or("").to_string();
            let size = request["sizeMb"].as_u64().unwrap_or(0);
            let cancel = state.bench_cancel.clone();
            let app = state.app.clone();
            let kind_owned = kind.to_string();
            let outcome = tokio::task::spawn_blocking(move || {
                bench::bench_disk(&path, size, &cancel, &|percent| {
                    let _ = app.emit("bench:progress", json!({"kind": kind_owned, "percent": percent}));
                })
            })
            .await;
            match outcome {
                Ok(Ok(result)) => json!({"ok": true, "kind": kind, "volume": label, "result": result}),
                Ok(Err(message)) => json!({"ok": false, "reason": message}),
                Err(error) => json!({"ok": false, "reason": error.to_string()}),
            }
        }
        _ => json!({"ok": false, "reason": "unknown-benchmark"}),
    }
}

#[tauri::command]
async fn update_state(app_handle: AppHandle) -> Json {
    let state = app_handle.state::<Arc<AppState>>().inner().clone();
    state.updater.get_state().await
}

#[tauri::command]
async fn update_check(app_handle: AppHandle) -> Json {
    let state = app_handle.state::<Arc<AppState>>().inner().clone();
    state.updater.check().await
}

#[tauri::command]
async fn update_open(app_handle: AppHandle) -> Result<(), String> {
    let state = app_handle.state::<Arc<AppState>>().inner().clone();
    if let Some(url) = state.updater.release_url().await {
        util::open_https(&url);
    }
    Ok(())
}

#[tauri::command]
async fn update_install(app_handle: AppHandle) -> Json {
    let state = app_handle.state::<Arc<AppState>>().inner().clone();
    let app = state.app.clone();
    let quit: Box<dyn FnOnce() + Send> = Box::new(move || {
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(300));
            app.exit(0);
        });
    });
    state.updater.install(quit).await
}

#[tauri::command]
async fn remote_status(app_handle: AppHandle) -> Json {
    let state = app_handle.state::<Arc<AppState>>().inner().clone();
    state.remote.status().await
}

#[tauri::command]
async fn remote_pair(options: Json, app_handle: AppHandle) -> Json {
    let state = app_handle.state::<Arc<AppState>>().inner().clone();
    if !options.is_object() {
        return json!({"ok": false, "reason": "invalid-pairing-request"});
    }
    let field = |name: &str| options[name].as_str().unwrap_or("").to_string();
    state.remote.pair(&field("serverUrl"), &field("code"), &field("name")).await
}

#[tauri::command]
async fn remote_unpair(app_handle: AppHandle) -> Json {
    let state = app_handle.state::<Arc<AppState>>().inner().clone();
    state.remote.unpair().await
}

#[tauri::command]
async fn github_status(app_handle: AppHandle) -> Json {
    let state = app_handle.state::<Arc<AppState>>().inner().clone();
    state.github.get_status().await
}

#[tauri::command]
async fn github_save_client_id(client_id: String, app_handle: AppHandle) -> Json {
    let state = app_handle.state::<Arc<AppState>>().inner().clone();
    state.github.save_client_id(&client_id).await
}

#[tauri::command]
async fn github_begin(app_handle: AppHandle) -> Json {
    let state = app_handle.state::<Arc<AppState>>().inner().clone();
    state.github.begin().await
}

#[tauri::command]
async fn github_poll(app_handle: AppHandle) -> Json {
    let state = app_handle.state::<Arc<AppState>>().inner().clone();
    state.github.poll().await
}

#[tauri::command]
async fn github_cancel(app_handle: AppHandle) -> Json {
    let state = app_handle.state::<Arc<AppState>>().inner().clone();
    state.github.cancel().await
}

#[tauri::command]
async fn github_sign_out(app_handle: AppHandle) -> Json {
    let state = app_handle.state::<Arc<AppState>>().inner().clone();
    state.github.sign_out().await
}

#[tauri::command]
async fn github_open_registration() -> Result<(), String> {
    util::open_https("https://github.com/settings/developers");
    Ok(())
}

#[tauri::command]
async fn github_open_verification() -> Result<(), String> {
    util::open_https("https://github.com/login/device");
    Ok(())
}

pub fn run() {
    let _ = rustls::crypto::ring::default_provider().install_default();

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            system_status,
            system_activity,
            system_devices,
            set_power_profile,
            set_charge_limit,
            set_fan_profile,
            request_hardware_access,
            fan_smart_state,
            fan_smart_set,
            bench_volumes,
            bench_gpus,
            bench_run,
            bench_cancel,
            update_state,
            update_check,
            update_open,
            update_install,
            remote_status,
            remote_pair,
            remote_unpair,
            github_status,
            github_save_client_id,
            github_begin,
            github_poll,
            github_cancel,
            github_sign_out,
            github_open_registration,
            github_open_verification
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            let confirm = make_confirm(handle.clone());
            let status_handle = handle.clone();
            let update_handle = handle.clone();
            let state = Arc::new(AppState {
                smart_fan: fan::SmartFan::new(),
                bench_cancel: Arc::new(AtomicBool::new(false)),
                bench_running: AtomicBool::new(false),
                github: github::GitHubAuth::new(),
                remote: remote::RemoteAgent::new(
                    confirm.clone(),
                    Arc::new(move |status| {
                        let _ = status_handle.emit("remote:changed", status);
                    }),
                ),
                updater: updater::Updater::new(
                    env!("CARGO_PKG_VERSION"),
                    Arc::new(move |state| {
                        let _ = update_handle.emit("update:changed", state);
                    }),
                ),
                confirm,
                app: handle.clone(),
            });
            app.manage(state.clone());

            // The UI is only ever the bundled app; any other navigation is refused.
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Northstar Control")
                .inner_size(1360.0, 900.0)
                .min_inner_size(840.0, 650.0)
                .background_color(tauri::utils::config::Color(7, 8, 13, 255))
                .on_navigation(|url| {
                    url.scheme() == "tauri" || matches!(url.host_str(), Some("tauri.localhost") | Some("localhost"))
                })
                .build()?;

            let remote = state.remote.clone();
            tauri::async_runtime::spawn(async move {
                remote.start().await;
            });
            let updater = state.updater.clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    updater.check().await;
                    tokio::time::sleep(Duration::from_secs(6 * 60 * 60)).await;
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Northstar Control");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            if let Some(state) = handle.try_state::<Arc<AppState>>() {
                let state = state.inner().clone();
                tauri::async_runtime::block_on(async move {
                    state.smart_fan.stop().await;
                    state.remote.stop().await;
                });
            }
        }
    });
}
