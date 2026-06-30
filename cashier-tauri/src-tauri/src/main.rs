#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use keyring::Entry;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::process::Command;
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
fn open_update_download(url: String) -> Result<(), String> {
    if !url.starts_with("https://visionarypos.cloud/downloads/") {
        return Err("invalid_download_url".into());
    }

    #[cfg(target_os = "windows")]
    {
        Command::new("cmd")
            .args(["/C", "start", "", &url])
            .spawn()
            .map_err(|err| err.to_string())?;
    }

    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(&url)
            .spawn()
            .map_err(|err| err.to_string())?;
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        Command::new("xdg-open")
            .arg(&url)
            .spawn()
            .map_err(|err| err.to_string())?;
    }

    Ok(())
}

#[tauri::command]
async fn fetch_update_manifest() -> Result<Value, String> {
    let url = format!("{}/downloads/release.json", API_BASE_URL);
    let client = reqwest::Client::builder()
        .https_only(true)
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|err| err.to_string())?;

    let response = client
        .get(url)
        .header("Accept", "application/json")
        .header("Cache-Control", "no-store")
        .send()
        .await
        .map_err(|err| err.to_string())?;
    let status = response.status();
    let text = response.text().await.map_err(|err| err.to_string())?;
    if !status.is_success() {
        return Err(format!("update_manifest_{}", status.as_u16()));
    }
    serde_json::from_str(&text).map_err(|err| err.to_string())
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            save_terminal_credentials,
            load_terminal_credentials,
            clear_terminal_credentials,
            close_app,
            open_update_download,
            fetch_update_manifest,
            api_request
        ])
        .run(tauri::generate_context!())
        .expect("error while running VISIONPOS Cashier");
}

fn main() {
    run();
}
