#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use keyring::Entry;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream};
use std::path::PathBuf;
use std::process::Command;
use std::time::Duration;
use zeroize::Zeroizing;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
#[cfg(target_os = "windows")]
use windows_sys::Win32::Graphics::Printing::{
    ClosePrinter, DOC_INFO_1W, EndDocPrinter, EndPagePrinter, GetDefaultPrinterW,
    OpenPrinterW, PRINTER_HANDLE, StartDocPrinterW, StartPagePrinter, WritePrinter,
};

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

const SECUGEN_ENDPOINTS: [&str; 4] = [
    "http://127.0.0.1:8000",
    "https://localhost:8000",
    "https://localhost:8443",
    "http://127.0.0.1:8080",
];

fn secugen_client_is_ready() -> bool {
    [8000_u16, 8443, 8080].into_iter().any(|port| {
        let address = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port);
        TcpStream::connect_timeout(&address, Duration::from_millis(80)).is_ok()
    })
}

#[cfg(target_os = "windows")]
fn secugen_client_paths() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    for root in [std::env::var_os("ProgramFiles"), std::env::var_os("ProgramFiles(x86)")]
        .into_iter()
        .flatten()
    {
        paths.push(PathBuf::from(root).join("SecuGen/SgiBioSrv/sgibiosrv.exe"));
    }
    paths
}

#[cfg(target_os = "windows")]
fn start_secugen_client() -> Result<(), String> {
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    if secugen_client_is_ready() {
        return Ok(());
    }
    let executable = secugen_client_paths()
        .into_iter()
        .find(|path| path.is_file())
        .ok_or_else(|| "secugen_webapi_not_installed".to_string())?;
    let working_directory = executable
        .parent()
        .ok_or_else(|| "secugen_webapi_invalid_install".to_string())?;

    Command::new(&executable)
        .current_dir(working_directory)
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("secugen_webapi_start_failed: {error}"))
}

#[cfg(not(target_os = "windows"))]
fn start_secugen_client() -> Result<(), String> {
    Err("secugen_webapi_unsupported_platform".into())
}

async fn try_secugen_request(
    client: &reqwest::Client,
    req: &SecugenRequest,
) -> Result<Value, String> {
    let mut last_error = "secugen_webapi_unreachable".to_string();

    for base in SECUGEN_ENDPOINTS {
        let url = format!("{}{}", base, req.path);
        match client
            .post(url)
            // SecuGen rejects native HTTP clients with ErrorCode 10004 when
            // the browser-origin header is absent. Use the licensed VisionPOS
            // application origin for this loopback-only request.
            .header(reqwest::header::ORIGIN, API_BASE_URL)
            .header(reqwest::header::REFERER, format!("{API_BASE_URL}/"))
            .form(&req.params)
            .send()
            .await
        {
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

    Err(last_error)
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

#[cfg(target_os = "windows")]
fn wide_string(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

#[cfg(target_os = "windows")]
fn default_printer_name() -> Result<Vec<u16>, String> {
    let mut length = 0_u32;
    unsafe {
        GetDefaultPrinterW(std::ptr::null_mut(), &mut length);
    }
    if length == 0 {
        return Err("default_printer_not_configured".into());
    }

    let mut name = vec![0_u16; length as usize];
    let result = unsafe { GetDefaultPrinterW(name.as_mut_ptr(), &mut length) };
    if result == 0 {
        return Err(format!(
            "default_printer_lookup_failed: {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(name)
}

#[cfg(target_os = "windows")]
fn print_raw_to_default_printer(receipt_text: &str) -> Result<String, String> {
    if receipt_text.is_empty() || receipt_text.len() > 64 * 1024 {
        return Err("invalid_receipt_payload".into());
    }

    let printer_name = default_printer_name()?;
    let mut printer = PRINTER_HANDLE::default();
    let opened = unsafe {
        OpenPrinterW(
            printer_name.as_ptr(),
            &mut printer,
            std::ptr::null(),
        )
    };
    if opened == 0 {
        return Err(format!(
            "default_printer_open_failed: {}",
            std::io::Error::last_os_error()
        ));
    }

    let document_name = wide_string("VISIONPOS receipt");
    let raw_type = wide_string("RAW");
    let document = DOC_INFO_1W {
        pDocName: document_name.as_ptr() as *mut u16,
        pOutputFile: std::ptr::null_mut(),
        pDatatype: raw_type.as_ptr() as *mut u16,
    };

    let job = unsafe { StartDocPrinterW(printer, 1, &document) };
    if job == 0 {
        unsafe { ClosePrinter(printer) };
        return Err(format!(
            "receipt_print_job_failed: {}",
            std::io::Error::last_os_error()
        ));
    }

    if unsafe { StartPagePrinter(printer) } == 0 {
        unsafe {
            EndDocPrinter(printer);
            ClosePrinter(printer);
        }
        return Err(format!(
            "receipt_print_page_failed: {}",
            std::io::Error::last_os_error()
        ));
    }

    // Only plain receipt text is accepted from the webview. Printer control
    // bytes are appended here so receipt data cannot inject spooler commands.
    let safe_text: String = receipt_text
        .chars()
        .filter(|character| *character == '\n' || *character == '\r' || *character == '\t' || !character.is_control())
        .collect();
    let mut payload = Vec::with_capacity(safe_text.len() + 16);
    payload.extend_from_slice(&[0x1b, 0x40]); // ESC @: initialize printer.
    payload.extend_from_slice(safe_text.as_bytes());
    payload.extend_from_slice(b"\n\n\n\n");
    payload.extend_from_slice(&[0x1d, 0x56, 0x00]); // GS V: full cut when supported.

    let mut written = 0_u32;
    let write_result = unsafe {
        WritePrinter(
            printer,
            payload.as_ptr().cast(),
            payload.len() as u32,
            &mut written,
        )
    };
    unsafe {
        EndPagePrinter(printer);
        EndDocPrinter(printer);
        ClosePrinter(printer);
    }

    if write_result == 0 || written != payload.len() as u32 {
        return Err(format!(
            "receipt_print_write_failed: {}",
            std::io::Error::last_os_error()
        ));
    }

    let end = printer_name.iter().position(|value| *value == 0).unwrap_or(printer_name.len());
    Ok(String::from_utf16_lossy(&printer_name[..end]))
}

#[cfg(not(target_os = "windows"))]
fn print_raw_to_default_printer(_receipt_text: &str) -> Result<String, String> {
    Err("direct_receipt_printing_unsupported".into())
}

#[tauri::command]
fn print_thermal_receipt(receipt_text: String) -> Result<String, String> {
    print_raw_to_default_printer(&receipt_text)
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
    if let Ok(value) = try_secugen_request(&client, &req).await {
        return Ok(value);
    }

    start_secugen_client()?;
    for _ in 0..20 {
        tokio::time::sleep(Duration::from_millis(500)).await;
        if let Ok(value) = try_secugen_request(&client, &req).await {
            return Ok(value);
        }
    }

    Err("secugen_webapi_start_timeout".into())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|_| {
            // Starting the installed vendor client here removes the need for
            // cashiers to run PowerShell or launch SecuGen manually.
            let _ = start_secugen_client();
            Ok(())
        })
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            save_terminal_credentials,
            load_terminal_credentials,
            clear_terminal_credentials,
            close_app,
            print_thermal_receipt,
            api_request,
            secugen_request
        ])
        .run(tauri::generate_context!())
        .expect("error while running VISIONPOS Cashier");
}

fn main() {
    run();
}
