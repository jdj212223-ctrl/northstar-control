use crate::store;
use crate::util::*;
use regex::Regex;
use serde_json::json;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

const DEVICE_ENDPOINT: &str = "https://github.com/login/device/code";
const TOKEN_ENDPOINT: &str = "https://github.com/login/oauth/access_token";
const PROFILE_ENDPOINT: &str = "https://api.github.com/user";
const API_VERSION: &str = "2022-11-28";
const DEFAULT_CLIENT_ID: &str = "Ov23liuh8l0EjSIdKmzt";
const CONFIG_FILE: &str = "github.json";
const SECRET_NAME: &str = "github-account";

fn client_id_valid(value: &str) -> bool {
    Regex::new(r"^[A-Za-z0-9._-]{8,128}$").map(|re| re.is_match(value)).unwrap_or(false)
}

struct Flow {
    device_code: String,
    expires_at: Instant,
    interval: u64,
    next_poll_at: Instant,
    id: u64,
}

struct State {
    client_id: String,
    account: Option<Json>,
    flow: Option<Flow>,
    flow_counter: u64,
    loaded: bool,
}

pub struct GitHubAuth {
    state: Mutex<State>,
    http: reqwest::Client,
}

impl GitHubAuth {
    pub fn new() -> Self {
        GitHubAuth {
            state: Mutex::new(State {
                client_id: if client_id_valid(DEFAULT_CLIENT_ID) { DEFAULT_CLIENT_ID.into() } else { String::new() },
                account: None,
                flow: None,
                flow_counter: 0,
                loaded: false,
            }),
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(10))
                .user_agent("Northstar-Control")
                .build()
                .expect("http client"),
        }
    }

    fn load(state: &mut State) {
        if state.loaded {
            return;
        }
        state.loaded = true;
        if let Some(config) = store::read_config(CONFIG_FILE) {
            if let Some(id) = config["clientId"].as_str().filter(|id| client_id_valid(id)) {
                state.client_id = id.to_string();
            }
        }
        if let Some(saved) = store::get(SECRET_NAME).and_then(|text| parse_json(&text)) {
            if saved["accessToken"].is_string() && saved["profile"]["login"].is_string() {
                state.account = Some(saved["profile"].clone());
            }
        }
    }

    fn persist_client_id(client_id: &str) {
        let _ = store::write_config(CONFIG_FILE, &json!({"clientId": client_id}));
    }

    pub async fn get_status(&self) -> Json {
        let mut state = self.state.lock().await;
        Self::load(&mut state);
        let secure = tokio::task::spawn_blocking(store::available).await.unwrap_or(false);
        json!({
            "configured": !state.client_id.is_empty(),
            "secureStorageAvailable": secure,
            "clientId": state.client_id,
            "account": state.account
        })
    }

    pub async fn save_client_id(&self, value: &str) -> Json {
        let mut state = self.state.lock().await;
        Self::load(&mut state);
        let next = value.trim();
        if !client_id_valid(next) {
            return json!({"ok": false, "reason": "invalid-client-id"});
        }
        if next != state.client_id {
            state.account = None;
            store::delete(SECRET_NAME);
        }
        state.client_id = next.to_string();
        state.flow = None;
        Self::persist_client_id(next);
        json!({"ok": true, "configured": true})
    }

    pub async fn begin(&self) -> Json {
        let client_id = {
            let mut state = self.state.lock().await;
            Self::load(&mut state);
            state.client_id.clone()
        };
        if client_id.is_empty() {
            return json!({"ok": false, "reason": "client-id-required"});
        }
        if !tokio::task::spawn_blocking(store::available).await.unwrap_or(false) {
            return json!({"ok": false, "reason": "secure-storage-unavailable"});
        }
        let response = self
            .http
            .post(DEVICE_ENDPOINT)
            .header("Accept", "application/json")
            .json(&json!({"client_id": client_id, "scope": "read:user"}))
            .send()
            .await;
        let Ok(response) = response else {
            return json!({"ok": false, "reason": "github-device-request-failed"});
        };
        let ok = response.status().is_success();
        let data: Json = response.json().await.unwrap_or(Json::Null);
        let (Some(device_code), Some(user_code), Some(verification)) = (
            data["device_code"].as_str(),
            data["user_code"].as_str(),
            data["verification_uri"].as_str(),
        ) else {
            return json!({"ok": false, "reason": "github-device-request-failed"});
        };
        if !ok || data["error"].is_string() {
            return json!({"ok": false, "reason": "github-device-request-failed"});
        }
        let Ok(url) = url::Url::parse(verification) else {
            return json!({"ok": false, "reason": "github-invalid-verification-url"});
        };
        if url.scheme() != "https" || url.host_str() != Some("github.com") || url.path() != "/login/device" {
            return json!({"ok": false, "reason": "github-invalid-verification-url"});
        }
        let expires_in = data["expires_in"].as_f64().unwrap_or(0.0);
        let interval = data["interval"].as_f64().unwrap_or(0.0);
        if !(expires_in > 0.0 && expires_in <= 3600.0) || !(1.0..=300.0).contains(&interval) {
            return json!({"ok": false, "reason": "github-invalid-device-response"});
        }
        let interval = interval.floor() as u64;
        let mut state = self.state.lock().await;
        state.flow_counter += 1;
        let id = state.flow_counter;
        state.flow = Some(Flow {
            device_code: device_code.to_string(),
            expires_at: Instant::now() + Duration::from_secs_f64(expires_in),
            interval,
            next_poll_at: Instant::now(),
            id,
        });
        json!({
            "ok": true, "userCode": user_code, "verificationUrl": url.as_str(),
            "expiresIn": expires_in, "interval": interval
        })
    }

    pub async fn poll(&self) -> Json {
        let (client_id, device_code, flow_id) = {
            let mut state = self.state.lock().await;
            Self::load(&mut state);
            let client_id = state.client_id.clone();
            let Some(flow) = state.flow.as_mut() else { return json!({"status": "not-started"}) };
            let now = Instant::now();
            if now >= flow.expires_at {
                state.flow = None;
                return json!({"status": "expired"});
            }
            if now < flow.next_poll_at {
                let wait = flow.next_poll_at - now;
                return json!({"status": "pending", "retryAfterMs": wait.as_millis() as u64});
            }
            flow.next_poll_at = now + Duration::from_secs(flow.interval);
            (client_id, flow.device_code.clone(), flow.id)
        };
        let response = self
            .http
            .post(TOKEN_ENDPOINT)
            .header("Accept", "application/json")
            .json(&json!({
                "client_id": client_id,
                "device_code": device_code,
                "grant_type": "urn:ietf:params:oauth:grant-type:device_code"
            }))
            .send()
            .await;
        let Ok(response) = response else { return json!({"status": "failed"}) };
        let ok = response.status().is_success();
        let data: Json = response.json().await.unwrap_or(Json::Null);

        let mut state = self.state.lock().await;
        if state.flow.as_ref().map(|flow| flow.id) != Some(flow_id) {
            return json!({"status": "cancelled"});
        }
        match data["error"].as_str() {
            Some("authorization_pending") => {
                let interval = state.flow.as_ref().map(|flow| flow.interval).unwrap_or(5);
                return json!({"status": "pending", "retryAfterMs": interval * 1000});
            }
            Some("slow_down") => {
                let flow = state.flow.as_mut().expect("flow present");
                flow.interval = (flow.interval + 5).min(60);
                return json!({"status": "pending", "retryAfterMs": flow.interval * 1000});
            }
            Some("access_denied") => {
                state.flow = None;
                return json!({"status": "denied"});
            }
            Some("expired_token") => {
                state.flow = None;
                return json!({"status": "expired"});
            }
            _ => {}
        }
        let Some(token) = data["access_token"].as_str().filter(|_| ok).map(str::to_string) else {
            state.flow = None;
            return json!({"status": "failed"});
        };
        drop(state);

        let profile = self
            .http
            .get(PROFILE_ENDPOINT)
            .header("Accept", "application/vnd.github+json")
            .header("Authorization", format!("Bearer {token}"))
            .header("X-GitHub-Api-Version", API_VERSION)
            .send()
            .await;
        let (profile_ok, account) = match profile {
            Ok(resp) => (resp.status().is_success(), resp.json::<Json>().await.unwrap_or(Json::Null)),
            Err(_) => (false, Json::Null),
        };
        let mut state = self.state.lock().await;
        if state.flow.as_ref().map(|flow| flow.id) != Some(flow_id) {
            return json!({"status": "cancelled"});
        }
        let (Some(login), Some(avatar), Some(html)) = (
            account["login"].as_str(),
            account["avatar_url"].as_str(),
            account["html_url"].as_str(),
        ) else {
            state.flow = None;
            return json!({"status": "profile-failed"});
        };
        if !profile_ok {
            state.flow = None;
            return json!({"status": "profile-failed"});
        }
        let name = account["name"].as_str().map(str::trim).filter(|text| !text.is_empty()).unwrap_or(login);
        let profile = json!({"login": login, "name": name, "avatarUrl": avatar, "profileUrl": html});
        let saved = json!({"accessToken": token, "profile": profile}).to_string();
        if store::set(SECRET_NAME, &saved).is_err() {
            state.flow = None;
            return json!({"status": "failed"});
        }
        state.account = Some(profile.clone());
        state.flow = None;
        json!({"status": "authorized", "account": profile})
    }

    pub async fn cancel(&self) -> Json {
        self.state.lock().await.flow = None;
        json!({"ok": true})
    }

    pub async fn sign_out(&self) -> Json {
        let mut state = self.state.lock().await;
        Self::load(&mut state);
        state.account = None;
        state.flow = None;
        store::delete(SECRET_NAME);
        json!({"ok": true})
    }
}
