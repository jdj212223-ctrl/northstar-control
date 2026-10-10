use crate::channel::{Channel, TO_SERVICE};
use crate::store;
use crate::system;
use crate::util::*;
use futures_util::{SinkExt, StreamExt};
use rand::RngCore;
use regex::Regex;
use serde_json::json;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, Mutex};
use tokio_tungstenite::tungstenite::{self, client::IntoClientRequest, protocol::WebSocketConfig, Message};

const TRUSTED_HOSTS: [&str; 4] = ["northstar-control.fly.dev", "localhost", "127.0.0.1", "[::1]"];
const CONFIG_FILE: &str = "remote.json";
const SECRET_NAME: &str = "remote-device";
const MAX_PAYLOAD: usize = 16 * 1024;

pub fn normalize_server_url(value: &str) -> Option<String> {
    if value.len() > 2048 {
        return None;
    }
    let url = url::Url::parse(value.trim()).ok()?;
    let host = url.host_str()?;
    let host = if host.contains(':') { format!("[{host}]") } else { host.to_string() };
    let local = ["localhost", "127.0.0.1", "[::1]"].contains(&host.as_str());
    let scheme_ok = url.scheme() == "https" || (url.scheme() == "http" && local);
    if !scheme_ok
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || (url.path() != "/" && !url.path().is_empty())
        || !TRUSTED_HOSTS.contains(&host.as_str())
    {
        return None;
    }
    let port = url.port().map(|port| format!(":{port}")).unwrap_or_default();
    Some(format!("{}://{host}{port}", url.scheme()))
}

#[derive(Clone)]
struct Device {
    id: String,
    token: String,
    name: String,
    platform: String,
}

struct State {
    server_url: String,
    device: Option<Device>,
    connected: bool,
    task: Option<tokio::task::JoinHandle<()>>,
    terminal_grant: Option<(String, Instant)>,
    loaded: bool,
}

pub type StatusHook = Arc<dyn Fn(Json) + Send + Sync>;

pub struct RemoteAgent {
    state: Mutex<State>,
    http: reqwest::Client,
    confirm: ConfirmFn,
    on_status: StatusHook,
}

fn status_of(state: &State) -> Json {
    json!({
        "configured": !state.server_url.is_empty(),
        "serverUrl": state.server_url,
        "paired": state.device.is_some(),
        "device": state.device.as_ref().map(|device| json!({"id": device.id, "name": device.name, "platform": device.platform})),
        "connected": state.connected
    })
}

impl RemoteAgent {
    pub fn new(confirm: ConfirmFn, on_status: StatusHook) -> Arc<Self> {
        Arc::new(RemoteAgent {
            state: Mutex::new(State {
                server_url: String::new(),
                device: None,
                connected: false,
                task: None,
                terminal_grant: None,
                loaded: false,
            }),
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(10))
                .user_agent("Northstar-Control")
                .build()
                .expect("http client"),
            confirm,
            on_status,
        })
    }

    fn load(state: &mut State) {
        if state.loaded {
            return;
        }
        state.loaded = true;
        if let Some(config) = store::read_config(CONFIG_FILE) {
            state.server_url = config["serverUrl"].as_str().and_then(normalize_server_url).unwrap_or_default();
        }
        if let Some(saved) = store::get(SECRET_NAME).and_then(|text| parse_json(&text)) {
            if let (Some(id), Some(token), Some(name), Some(platform)) = (
                saved["id"].as_str(),
                saved["token"].as_str(),
                saved["name"].as_str(),
                saved["platform"].as_str(),
            ) {
                state.device = Some(Device { id: id.into(), token: token.into(), name: name.into(), platform: platform.into() });
            }
        }
    }

    fn persist(state: &State) -> Result<(), String> {
        store::write_config(CONFIG_FILE, &json!({"serverUrl": state.server_url}))?;
        match &state.device {
            Some(device) => store::set(
                SECRET_NAME,
                &json!({"id": device.id, "token": device.token, "name": device.name, "platform": device.platform}).to_string(),
            ),
            None => {
                store::delete(SECRET_NAME);
                Ok(())
            }
        }
    }

    pub async fn status(&self) -> Json {
        let mut state = self.state.lock().await;
        Self::load(&mut state);
        status_of(&state)
    }

    async fn notify(&self) {
        let snapshot = status_of(&*self.state.lock().await);
        (self.on_status)(snapshot);
    }

    pub async fn start(self: &Arc<Self>) -> Json {
        let mut state = self.state.lock().await;
        Self::load(&mut state);
        if state.device.is_some() && state.task.is_none() {
            state.task = Some(self.spawn_connection());
        }
        status_of(&state)
    }

    fn spawn_connection(self: &Arc<Self>) -> tokio::task::JoinHandle<()> {
        let agent = Arc::clone(self);
        tokio::spawn(async move { agent.connection_loop().await })
    }

    pub async fn pair(self: &Arc<Self>, server_url: &str, code: &str, name: &str) -> Json {
        {
            let mut state = self.state.lock().await;
            Self::load(&mut state);
        }
        let Some(url) = normalize_server_url(server_url) else {
            return json!({"ok": false, "reason": "invalid-server-url"});
        };
        if !tokio::task::spawn_blocking(store::available).await.unwrap_or(false) {
            return json!({"ok": false, "reason": "secure-storage-unavailable"});
        }
        let code_ok = Regex::new(r"^[A-Za-z0-9 -]{8,16}$").map(|re| re.is_match(code.trim())).unwrap_or(false);
        if !code_ok {
            return json!({"ok": false, "reason": "invalid-pairing-code"});
        }
        let name = name.trim();
        if name.is_empty() || name.chars().count() > 80 {
            return json!({"ok": false, "reason": "invalid-device-name"});
        }
        let response = self
            .http
            .post(format!("{url}/api/device/pair"))
            .header("Accept", "application/json")
            .json(&json!({"code": code.trim(), "name": name, "platform": platform_name()}))
            .send()
            .await;
        let Ok(response) = response else {
            return json!({"ok": false, "reason": "server-unreachable"});
        };
        let ok = response.status().is_success();
        let data: Json = response.json().await.unwrap_or(Json::Null);
        let (Some(id), Some(token)) = (data["id"].as_str(), data["deviceToken"].as_str()) else {
            let reason = data["error"].as_str().unwrap_or("pairing-failed").to_string();
            return json!({"ok": false, "reason": reason});
        };
        if !ok {
            let reason = data["error"].as_str().unwrap_or("pairing-failed").to_string();
            return json!({"ok": false, "reason": reason});
        }
        let device = Device {
            id: id.into(),
            token: token.into(),
            name: data["name"].as_str().unwrap_or(name).into(),
            platform: data["platform"].as_str().unwrap_or(platform_name()).into(),
        };
        let summary = json!({"id": device.id, "name": device.name, "platform": device.platform});
        {
            let mut state = self.state.lock().await;
            if let Some(task) = state.task.take() {
                task.abort();
            }
            state.connected = false;
            state.server_url = url;
            state.device = Some(device);
            if let Err(_) = Self::persist(&state) {
                state.device = None;
                return json!({"ok": false, "reason": "secure-storage-unavailable"});
            }
            state.task = Some(self.spawn_connection());
        }
        self.notify().await;
        json!({"ok": true, "device": summary})
    }

    pub async fn unpair(&self) -> Json {
        let (server_url, token) = {
            let mut state = self.state.lock().await;
            Self::load(&mut state);
            let Some(device) = state.device.clone() else { return json!({"ok": true}) };
            (state.server_url.clone(), device.token)
        };
        let response = self
            .http
            .post(format!("{server_url}/api/device/unpair"))
            .header("Authorization", format!("Bearer {token}"))
            .header("Accept", "application/json")
            .send()
            .await;
        let Ok(response) = response else {
            return json!({"ok": false, "reason": "server-unreachable"});
        };
        if !response.status().is_success() && response.status().as_u16() != 401 {
            return json!({"ok": false, "reason": "server-revocation-failed"});
        }
        {
            let mut state = self.state.lock().await;
            if let Some(task) = state.task.take() {
                task.abort();
            }
            state.connected = false;
            state.device = None;
            let _ = Self::persist(&state);
        }
        self.notify().await;
        json!({"ok": true})
    }

    pub async fn stop(&self) {
        let mut state = self.state.lock().await;
        if let Some(task) = state.task.take() {
            task.abort();
        }
        state.connected = false;
    }

    async fn clear_credentials(&self) {
        {
            let mut state = self.state.lock().await;
            state.device = None;
            state.connected = false;
            let _ = Self::persist(&state);
        }
        self.notify().await;
    }

    async fn set_connected(&self, connected: bool) {
        self.state.lock().await.connected = connected;
        self.notify().await;
    }

    async fn connection_loop(self: Arc<Self>) {
        let mut delay = Duration::from_secs(1);
        loop {
            let Some((server_url, device)) = ({
                let state = self.state.lock().await;
                state.device.clone().map(|device| (state.server_url.clone(), device))
            }) else {
                return;
            };
            match self.connect_once(&server_url, &device).await {
                Outcome::Revoked => {
                    self.clear_credentials().await;
                    return;
                }
                Outcome::Opened => delay = Duration::from_secs(1),
                Outcome::Failed => {}
            }
            self.set_connected(false).await;
            tokio::time::sleep(delay).await;
            delay = (delay * 2).min(Duration::from_secs(30));
        }
    }

    async fn connect_once(self: &Arc<Self>, server_url: &str, device: &Device) -> Outcome {
        use base64::Engine;
        let endpoint = format!("{}/device", server_url.replacen("http", "ws", 1));
        let mut nonce = [0_u8; 16];
        rand::thread_rng().fill_bytes(&mut nonce);
        let nonce_text = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(nonce);
        let Ok(mut request) = endpoint.into_client_request() else { return Outcome::Failed };
        let headers = request.headers_mut();
        let (Ok(auth), Ok(nonce_header)) = (
            format!("Bearer {}", device.token).parse(),
            nonce_text.parse(),
        ) else {
            return Outcome::Failed;
        };
        headers.insert("Authorization", auth);
        headers.insert("X-Northstar-Nonce", nonce_header);

        let mut config = WebSocketConfig::default();
        config.max_message_size = Some(MAX_PAYLOAD);
        config.max_frame_size = Some(MAX_PAYLOAD);
        let connected = tokio::time::timeout(
            Duration::from_secs(10),
            tokio_tungstenite::connect_async_with_config(request, Some(config), false),
        )
        .await;
        let socket = match connected {
            Ok(Ok((socket, _))) => socket,
            Ok(Err(tungstenite::Error::Http(response))) if response.status().as_u16() == 401 => return Outcome::Revoked,
            _ => return Outcome::Failed,
        };

        let channel = Arc::new(std::sync::Mutex::new(Channel::new(&device.token, &nonce, TO_SERVICE)));
        let (mut sink, mut stream) = socket.split();
        let (outgoing, mut queue) = mpsc::unbounded_channel::<Json>();
        self.set_connected(true).await;
        let _ = outgoing.send(telemetry_message().await);
        let mut telemetry = tokio::time::interval(Duration::from_secs(30));
        telemetry.tick().await;
        let mut revoked = false;

        loop {
            tokio::select! {
                _ = telemetry.tick() => {
                    let _ = outgoing.send(telemetry_message().await);
                }
                Some(message) = queue.recv() => {
                    let frame = channel.lock().map(|mut guard| guard.seal(&message)).unwrap_or_default();
                    if sink.send(Message::Binary(frame.into())).await.is_err() { break; }
                }
                incoming = stream.next() => {
                    match incoming {
                        Some(Ok(Message::Binary(bytes))) => {
                            let opened = channel.lock().ok().and_then(|mut guard| guard.open(&bytes));
                            let Some(message) = opened else {
                                let _ = sink.close().await;
                                break;
                            };
                            let agent = Arc::clone(self);
                            let reply = outgoing.clone();
                            tokio::spawn(async move {
                                if let Some(result) = agent.handle_command(message).await {
                                    let _ = reply.send(result);
                                }
                            });
                        }
                        Some(Ok(Message::Close(frame))) => {
                            revoked = frame.map(|item| u16::from(item.code) == 4001).unwrap_or(false);
                            break;
                        }
                        Some(Ok(Message::Ping(_))) | Some(Ok(Message::Pong(_))) => {}
                        Some(Ok(_)) => { let _ = sink.close().await; break; }
                        Some(Err(_)) | None => break,
                    }
                }
            }
        }
        if revoked { Outcome::Revoked } else { Outcome::Opened }
    }

    async fn confirm(&self, title: &str, message: String, detail: String, ok_label: &str) -> bool {
        (self.confirm)(ConfirmRequest { title: title.into(), message, detail, ok_label: ok_label.into() }).await
    }

    async fn handle_command(&self, message: Json) -> Option<Json> {
        let request_id = message["requestId"].as_str()?.to_string();
        let id_ok = Regex::new(r"^[0-9a-fA-F-]{36}$").map(|re| re.is_match(&request_id)).unwrap_or(false);
        if message["type"] != "command" || !id_ok || message["command"].is_null() {
            return None;
        }
        let requested_by = message["requestedBy"]
            .as_str()
            .filter(|name| name.len() <= 39 && !name.is_empty() && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-'))
            .unwrap_or("your Northstar account")
            .to_string();
        let command = &message["command"];
        let mut result = json!({"ok": false, "reason": "unsupported-command"});

        match command["type"].as_str() {
            Some("power-profile") => {
                if let Some(profile) = command["profile"].as_str().filter(|p| ["Efficiency", "Balanced", "Performance"].contains(p)) {
                    let approved = self
                        .confirm(
                            "Allow remote power change?",
                            format!("@{requested_by} requested the {profile} power profile."),
                            "Northstar will ask the operating system to apply this profile. This approval is only for this change.".into(),
                            "Apply power profile",
                        )
                        .await;
                    result = if approved {
                        system::set_power_profile(profile).await
                    } else {
                        json!({"ok": false, "reason": "declined-on-device"})
                    };
                }
            }
            Some("charge-limit") => {
                if let Some(enabled) = command["enabled"].as_bool() {
                    let subject = if enabled { "an 80% battery charge limit" } else { "removing the battery charge limit" };
                    let approved = self
                        .confirm(
                            "Allow remote battery change?",
                            format!("@{requested_by} requested {subject}."),
                            "This change will only be applied if the operating system exposes a writable control.".into(),
                            "Apply battery setting",
                        )
                        .await;
                    result = if approved {
                        system::set_charge_limit(enabled, &self.confirm).await
                    } else {
                        json!({"ok": false, "reason": "declined-on-device"})
                    };
                }
            }
            Some("terminal") => {
                if let Some(text) = command["command"].as_str().filter(|text| text.chars().count() <= 500) {
                    let granted = {
                        let state = self.state.lock().await;
                        matches!(&state.terminal_grant, Some((user, expires)) if *user == requested_by && *expires > Instant::now())
                    };
                    let mut allowed = granted;
                    if !granted {
                        self.state.lock().await.terminal_grant = None;
                        let approved = self
                            .confirm(
                                "Allow remote terminal access?",
                                format!("@{requested_by} wants to run commands on this computer for 10 minutes."),
                                format!("First command: {text}\n\nOnly approve this if you started it. Commands run with your user account's permissions."),
                                "Allow for 10 minutes",
                            )
                            .await;
                        if approved {
                            self.state.lock().await.terminal_grant =
                                Some((requested_by.clone(), Instant::now() + Duration::from_secs(600)));
                            allowed = true;
                        }
                    }
                    result = if allowed { run_terminal(text).await } else { json!({"ok": false, "reason": "declined-on-device"}) };
                }
            }
            _ => {}
        }
        Some(json!({"type": "command-result", "requestId": request_id, "result": result}))
    }
}

enum Outcome {
    Opened,
    Failed,
    Revoked,
}

async fn telemetry_message() -> Json {
    json!({"type": "telemetry", "data": system::get_system_status().await})
}

fn truncate(text: &str) -> String {
    text.chars().take(8000).collect()
}

async fn run_terminal(command: &str) -> Json {
    let (file, args): (String, Vec<&str>) = if is_windows() {
        (windows_powershell(), vec!["-NoProfile", "-NonInteractive", "-Command", command])
    } else {
        ("/bin/sh".into(), vec!["-c", command])
    };
    match run_raw(&file, &args, 10_000).await {
        Ok(output) => {
            let combined = format!("{}{}", output.stdout, output.stderr);
            if output.success {
                json!({"ok": true, "output": truncate(&combined)})
            } else {
                json!({"ok": false, "reason": "command-failed", "output": truncate(&combined)})
            }
        }
        Err(error) if error == "timed out" => json!({"ok": false, "reason": "command-timed-out", "output": error}),
        Err(error) => json!({"ok": false, "reason": "command-failed", "output": truncate(&error)}),
    }
}

#[cfg(test)]
mod tests {
    use super::normalize_server_url;

    #[test]
    fn only_trusted_origins_are_accepted() {
        assert_eq!(normalize_server_url("https://northstar-control.fly.dev/").as_deref(), Some("https://northstar-control.fly.dev"));
        assert_eq!(normalize_server_url("http://localhost:8080").as_deref(), Some("http://localhost:8080"));
        assert!(normalize_server_url("http://northstar-control.fly.dev").is_none());
        assert!(normalize_server_url("https://evil.example").is_none());
        assert!(normalize_server_url("https://northstar-control.fly.dev/x").is_none());
        assert!(normalize_server_url("https://user:pw@northstar-control.fly.dev").is_none());
        assert!(normalize_server_url("https://northstar-control.fly.dev/?a=1").is_none());
    }
}
