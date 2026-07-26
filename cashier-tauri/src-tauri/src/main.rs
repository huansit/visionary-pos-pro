#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use keyring::Entry;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::time::Duration;
use zeroize::Zeroizing;

const SERVICE: &str = "cloud.visionarypos.cashier";
const TERMINAL_ACCOUNT: &str = "terminal-credentials";
const API_BASE_URL: &str = "https://visionarypos.cloud";

#[derive(Debug, Deserialize)]
struct ApiRequest {
    method: String,
    path: String,
    headers: Option<HashMap<String, String>>,
    body: Option<Value>,
}

#[derive(Debug, Serialize)]
struct ApiResponse {
    status: u16,
    ok: bool,
    body: Value,
}

#[derive(Debug, Deserialize)]
struct SecugenRequest {
    path: String,
    params: HashMap<String, String>,
}

#[tauri::command]
fn save_terminal_credentials(payload: String) -> Result<(), String> {
    let payload = Zeroizing::new(payload);
    let entry = Entry::new(SERVICE, TERMINAL_ACCOUNT).map_err(|err| err.to_string())?;
    entry.set_password(payload.as_str()).map_err(|err| err.to_string())
}

#[tauri::command]
fn load_terminal_credentials() -> Result<Option<String>, String> {
    let entry = Entry::new(SERVICE, TERMINAL_ACCOUNT).map_err(|err| err.to_string())?;
    match entry.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(err) => Err(err.to_string()),
    }
}

#[tauri::command]
fn clear_terminal_credentials() -> Result<(), String> {
    let entry = Entry::new(SERVICE, TERMINAL_ACCOUNT).map_err(|err| err.to_string())?;
    match entry.delete_password() {
        Ok(_) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(err) => Err(err.to_string()),
    }
}

#[tauri::command]
fn close_app(app: tauri::AppHandle) {
    app.exit(0);
}

#[tauri::command]
async fn api_request(req: ApiRequest) -> Result<ApiResponse, String> {
    if !req.path.starts_with("/api/") {
        return Err("invalid_api_path".into());
    }

    let method = reqwest::Method::from_bytes(req.method.to_uppercase().as_bytes())
        .map_err(|_| "invalid_http_method".to_string())?;
    let url = format!("{}{}", API_BASE_URL, req.path);
    let client = reqwest::Client::builder()
        .https_only(true)
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|err| err.to_string())?;

    let mut request = client
        .request(method, url)
        .header("Accept", "application/json")
        .header("Content-Type", "application/json");

    if let Some(headers) = req.headers {
        for (key, value) in headers {
            let normalized = key.to_ascii_lowercase();
            if matches!(
                normalized.as_str(),
                "x-terminal-uuid" | "x-terminal-secret" | "content-type" | "accept" | "cache-control" | "pragma"
            ) {
                request = request.header(key, value);
            }
        }
    }

    if let Some(body) = req.body {
        request = request.json(&body);
    }

    let response = request.send().await.map_err(|err| err.to_string())?;
    let status = response.status();
    let status_code = status.as_u16();
    let ok = status.is_success();
    let text = response.text().await.map_err(|err| err.to_string())?;
    let body = serde_json::from_str(&text).unwrap_or_else(|_| json!({ "raw": text }));

    Ok(ApiResponse {
        status: status_code,
        ok,
        body,
    })
}

#[tauri::command]
async fn secugen_request(req: SecugenRequest) -> Result<Value, String> {
    if !matches!(req.path.as_str(), "/SGIFPCapture" | "/SGIMatchScore") {
        return Err("invalid_secugen_path".into());
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        // SecuGen installs a local certificate. Restricting this client to the
        // two loopback WebAPI endpoints prevents this exception from weakening
        // any cloud request made by the cashier app.
        .danger_accept_invalid_certs(true)
        .build()
        .map_err(|err| err.to_string())?;
    let mut last_error = "secugen_webapi_unreachable".to_string();

    for base in ["https://localhost:8443", "http://127.0.0.1:8080"] {
        let url = format!("{}{}", base, req.path);
        match client.post(url).form(&req.params).send().await {
            Ok(response) => {
                let status = response.status();
                let text = response.text().await.map_err(|err| err.to_string())?;
                if !status.is_success() {
                    last_error = format!("secugen_webapi_http_{}", status.as_u16());
                    continue;
                }
                if let Ok(value) = serde_json::from_str::<Value>(&text) {
                    return Ok(value);
                }
                let parsed = text
                    .split('&')
                    .filter_map(|pair| pair.split_once('='))
                    .map(|(key, value)| (key.to_string(), Value::String(value.to_string())))
                    .collect::<serde_json::Map<String, Value>>();
                return Ok(Value::Object(parsed));
            }
            Err(error) => last_error = error.to_string(),
        }
    }

    Err(format!("secugen_webapi_unreachable: {last_error}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            save_terminal_credentials,
            load_terminal_credentials,
            clear_terminal_credentials,
            close_app,
            api_request,
            secugen_request
        ])
        .run(tauri::generate_context!())
        .expect("error while running VISIONPOS Cashier");
}

fn main() {
    run();
}
