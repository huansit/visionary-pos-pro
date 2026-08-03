#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use keyring::Entry;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream};
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::OnceLock;
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
const API_HOST: &str = "visionarypos.cloud";
const API_ORIGIN_IPV4: Ipv4Addr = Ipv4Addr::new(187, 124, 43, 10);

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

const SECUGEN_ENDPOINTS: [(&str, u16); 4] = [
    ("https://localhost:8443", 8443),
    ("http://127.0.0.1:8000", 8000),
    ("https://localhost:8000", 8000),
    ("http://127.0.0.1:8080", 8080),
];
const NO_SECUGEN_ENDPOINT: usize = usize::MAX;
const SECUGEN_START_ATTEMPTS: usize = 40;
const SECUGEN_DEVICE_RELEASE_DELAY_MS: u64 = 400;
const SECUGEN_BUSY_RETRY_DELAYS_MS: [u64; 3] = [150, 300, 500];
const SECUGEN_RESTART_RETRY_DELAYS_MS: [u64; 4] = [250, 400, 650, 900];
static SECUGEN_ENDPOINT_INDEX: AtomicUsize = AtomicUsize::new(NO_SECUGEN_ENDPOINT);
static API_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
static API_ORIGIN_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
static API_ORIGIN_PREFERRED: AtomicBool = AtomicBool::new(false);
static SECUGEN_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
static SECUGEN_REQUEST_LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();

fn api_client() -> Result<&'static reqwest::Client, String> {
    if let Some(client) = API_CLIENT.get() {
        return Ok(client);
    }
    let client = reqwest::Client::builder()
        .https_only(true)
        .connect_timeout(Duration::from_secs(4))
        .build()
        .map_err(|err| err.to_string())?;
    let _ = API_CLIENT.set(client);
    API_CLIENT
        .get()
        .ok_or_else(|| "api_client_initialization_failed".to_string())
}

fn api_origin_client() -> Result<&'static reqwest::Client, String> {
    if let Some(client) = API_ORIGIN_CLIENT.get() {
        return Ok(client);
    }
    let origin = SocketAddr::new(IpAddr::V4(API_ORIGIN_IPV4), 443);
    let client = reqwest::Client::builder()
        .https_only(true)
        .connect_timeout(Duration::from_secs(4))
        // Keep the production hostname for TLS and HTTP while bypassing a
        // broken DNS or Cloudflare route on an affected workstation.
        .resolve(API_HOST, origin)
        .build()
        .map_err(|err| err.to_string())?;
    let _ = API_ORIGIN_CLIENT.set(client);
    API_ORIGIN_CLIENT
        .get()
        .ok_or_else(|| "api_origin_client_initialization_failed".to_string())
}

fn secugen_client() -> Result<&'static reqwest::Client, String> {
    if let Some(client) = SECUGEN_CLIENT.get() {
        return Ok(client);
    }
    let client = reqwest::Client::builder()
        // This client is used only with the fixed loopback endpoint list.
        .danger_accept_invalid_certs(true)
        // The vendor service can retain exclusive access to the reader while
        // an idle HTTP connection remains pooled.
        .pool_max_idle_per_host(0)
        .build()
        .map_err(|err| err.to_string())?;
    let _ = SECUGEN_CLIENT.set(client);
    SECUGEN_CLIENT
        .get()
        .ok_or_else(|| "secugen_client_initialization_failed".to_string())
}

fn secugen_request_lock() -> &'static tokio::sync::Mutex<()> {
    SECUGEN_REQUEST_LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

fn secugen_port_is_ready(port: u16) -> bool {
    let address = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port);
    TcpStream::connect_timeout(&address, Duration::from_millis(40)).is_ok()
}

fn secugen_client_is_ready() -> bool {
    [8443_u16, 8000, 8080]
        .into_iter()
        .any(secugen_port_is_ready)
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

#[cfg(target_os = "windows")]
fn restart_secugen_client() -> Result<(), String> {
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    SECUGEN_ENDPOINT_INDEX.store(NO_SECUGEN_ENDPOINT, Ordering::Relaxed);
    let result = Command::new("taskkill.exe")
        .args(["/F", "/IM", "sgibiosrv.exe"])
        .creation_flags(CREATE_NO_WINDOW)
        .status()
        .map_err(|error| format!("secugen_webapi_restart_failed: {error}"))?;
    if !result.success() && secugen_client_is_ready() {
        return Err("secugen_webapi_restart_failed".into());
    }
    for _ in 0..20 {
        if !secugen_client_is_ready() {
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    if secugen_client_is_ready() {
        return Err("secugen_webapi_restart_failed".into());
    }
    // The process can release its TCP port before the USB driver releases its
    // exclusive device handle. Starting a replacement immediately can make
    // the first capture fail with SecuGen error 59 on every attempt.
    std::thread::sleep(Duration::from_millis(SECUGEN_DEVICE_RELEASE_DELAY_MS));
    start_secugen_client()
}

#[cfg(not(target_os = "windows"))]
fn start_secugen_client() -> Result<(), String> {
    Err("secugen_webapi_unsupported_platform".into())
}

#[cfg(not(target_os = "windows"))]
fn restart_secugen_client() -> Result<(), String> {
    Err("secugen_webapi_unsupported_platform".into())
}

async fn wait_for_secugen_client() -> bool {
    for _ in 0..SECUGEN_START_ATTEMPTS {
        tokio::time::sleep(Duration::from_millis(250)).await;
        if secugen_client_is_ready() {
            return true;
        }
    }
    false
}

async fn try_secugen_request(
    client: &reqwest::Client,
    req: &SecugenRequest,
    request_timeout: Duration,
) -> Result<Value, String> {
    let mut last_error = "secugen_webapi_unreachable".to_string();
    let preferred = SECUGEN_ENDPOINT_INDEX.load(Ordering::Relaxed);
    let mut endpoint_indices = Vec::with_capacity(SECUGEN_ENDPOINTS.len());
    if preferred < SECUGEN_ENDPOINTS.len() {
        endpoint_indices.push(preferred);
    }
    endpoint_indices.extend((0..SECUGEN_ENDPOINTS.len()).filter(|index| *index != preferred));

    for index in endpoint_indices {
        let (base, port) = SECUGEN_ENDPOINTS[index];
        if !secugen_port_is_ready(port) {
            continue;
        }
        let url = format!("{}{}", base, req.path);
        match client
            .post(url)
            .timeout(request_timeout)
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
                    SECUGEN_ENDPOINT_INDEX.store(index, Ordering::Relaxed);
                    return Ok(value);
                }
                let parsed = text
                    .split('&')
                    .filter_map(|pair| pair.split_once('='))
                    .map(|(key, value)| (key.to_string(), Value::String(value.to_string())))
                    .collect::<serde_json::Map<String, Value>>();
                SECUGEN_ENDPOINT_INDEX.store(index, Ordering::Relaxed);
                return Ok(Value::Object(parsed));
            }
            Err(error) => {
                if index == preferred {
                    SECUGEN_ENDPOINT_INDEX.store(NO_SECUGEN_ENDPOINT, Ordering::Relaxed);
                }
                last_error = error.to_string();
            }
        }
    }

    Err(last_error)
}

fn secugen_response_error_code(value: &Value) -> Option<i64> {
    ["ErrorCode", "errorCode", "error_code"]
        .into_iter()
        .find_map(|key| {
            let raw = value.get(key)?;
            raw.as_i64()
                .or_else(|| raw.as_str().and_then(|text| text.trim().parse::<i64>().ok()))
        })
}

fn secugen_device_is_busy(value: &Value) -> bool {
    secugen_response_error_code(value) == Some(59)
}

async fn try_secugen_request_with_recovery(
    client: &reqwest::Client,
    req: &SecugenRequest,
    request_timeout: Duration,
    retry_delays_ms: &[u64],
) -> Result<Value, String> {
    let mut last_error = "secugen_webapi_unreachable".to_string();

    for attempt in 0..=retry_delays_ms.len() {
        match try_secugen_request(client, req, request_timeout).await {
            Ok(value) if secugen_device_is_busy(&value) => {
                last_error = "secugen_device_busy".to_string();
            }
            Ok(value) => return Ok(value),
            Err(error) => last_error = error,
        }

        if let Some(delay_ms) = retry_delays_ms.get(attempt) {
            tokio::time::sleep(Duration::from_millis(*delay_ms)).await;
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
    let mut payload = Vec::with_capacity(safe_text.len() + 64);
    payload.extend_from_slice(&[0x1b, 0x40]); // ESC @: initialize printer.
    for (index, line) in safe_text.lines().enumerate() {
        if index == 0 {
            payload.extend_from_slice(&[0x1b, 0x61, 0x01]); // ESC a: centered.
            payload.extend_from_slice(&[0x1b, 0x45, 0x01]); // ESC E: bold on.
            payload.extend_from_slice(&[0x1d, 0x21, 0x11]); // GS !: double width and height.
            payload.extend_from_slice(line.trim().as_bytes());
            payload.extend_from_slice(b"\n");
            payload.extend_from_slice(&[0x1d, 0x21, 0x00]);
            payload.extend_from_slice(&[0x1b, 0x45, 0x00]);
            payload.extend_from_slice(&[0x1b, 0x61, 0x00]);
            continue;
        }

        if line.starts_with("TOTAL") {
            payload.extend_from_slice(&[0x1b, 0x45, 0x01]); // Bold total.
            payload.extend_from_slice(&[0x1b, 0x21, 0x10]); // Double-height total.
            payload.extend_from_slice(line.as_bytes());
            payload.extend_from_slice(b"\n");
            payload.extend_from_slice(&[0x1b, 0x21, 0x00]);
            payload.extend_from_slice(&[0x1b, 0x45, 0x00]);
            continue;
        }

        payload.extend_from_slice(line.as_bytes());
        payload.extend_from_slice(b"\n");
    }
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

fn is_allowed_api_header(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "x-terminal-uuid"
            | "x-terminal-secret"
            | "x-session-token"
            | "x-visionpos-app-version"
            | "content-type"
            | "accept"
            | "cache-control"
            | "pragma"
    )
}

fn build_api_request(
    client: &reqwest::Client,
    method: &reqwest::Method,
    url: &str,
    headers: &Option<HashMap<String, String>>,
    body: &Option<Value>,
) -> reqwest::RequestBuilder {
    let mut request = client
        .request(method.clone(), url)
        .timeout(Duration::from_secs(20))
        .header("Accept", "application/json")
        .header("Content-Type", "application/json");

    if let Some(headers) = headers {
        for (key, value) in headers {
            if is_allowed_api_header(key) {
                request = request.header(key, value);
            }
        }
    }

    if let Some(body) = body {
        request = request.json(body);
    }

    request
}

#[tauri::command]
async fn api_request(req: ApiRequest) -> Result<ApiResponse, String> {
    if !req.path.starts_with("/api/") {
        return Err("invalid_api_path".into());
    }

    let method = reqwest::Method::from_bytes(req.method.to_uppercase().as_bytes())
        .map_err(|_| "invalid_http_method".to_string())?;
    let url = format!("{}{}", API_BASE_URL, req.path);
    let cloud_client = api_client()?;
    let origin_client = api_origin_client()?;
    let prefer_origin = API_ORIGIN_PREFERRED.load(Ordering::Relaxed);
    let (first_client, first_route, second_client, second_route) = if prefer_origin {
        (origin_client, "direct_origin", cloud_client, "cloudflare")
    } else {
        (cloud_client, "cloudflare", origin_client, "direct_origin")
    };

    let response = match build_api_request(
        first_client,
        &method,
        &url,
        &req.headers,
        &req.body,
    )
    .send()
    .await
    {
        Ok(response) => {
            API_ORIGIN_PREFERRED.store(first_route == "direct_origin", Ordering::Relaxed);
            response
        }
        Err(first_error) => match build_api_request(
            second_client,
            &method,
            &url,
            &req.headers,
            &req.body,
        )
        .send()
        .await
        {
            Ok(response) => {
                API_ORIGIN_PREFERRED.store(second_route == "direct_origin", Ordering::Relaxed);
                response
            }
            Err(second_error) => {
                return Err(format!(
                    "api_connectivity_failed: {first_route}={first_error}; {second_route}={second_error}"
                ));
            }
        },
    };
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
    let _request_guard = secugen_request_lock().lock().await;

    let request_timeout = if req.path == "/SGIFPCapture" {
        let capture_timeout = req
            .params
            .get("Timeout")
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(6_000);
        Duration::from_millis(capture_timeout.saturating_add(1_500).clamp(2_500, 8_000))
    } else {
        Duration::from_secs(4)
    };
    if !secugen_client_is_ready() {
        start_secugen_client()?;
        if !wait_for_secugen_client().await {
            return Err("secugen_webapi_start_timeout".into());
        }
    }

    let client = secugen_client()?;
    if let Ok(value) = try_secugen_request_with_recovery(
        client,
        &req,
        request_timeout,
        &SECUGEN_BUSY_RETRY_DELAYS_MS,
    )
    .await
    {
        return Ok(value);
    }

    // A stale SecuGen process can keep its port open while no longer answering
    // requests. Restart it once, then retry this operation once.
    restart_secugen_client()?;
    if !wait_for_secugen_client().await {
        return Err("secugen_webapi_start_timeout".into());
    }
    try_secugen_request_with_recovery(
        client,
        &req,
        request_timeout,
        &SECUGEN_RESTART_RETRY_DELAYS_MS,
    )
    .await
    .map_err(|error| {
        if error == "secugen_device_busy" {
            error
        } else {
            "secugen_webapi_unreachable".to_string()
        }
    })
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

#[cfg(test)]
mod tests {
    use super::{
        is_allowed_api_header, secugen_device_is_busy, secugen_response_error_code, API_BASE_URL,
        API_HOST, API_ORIGIN_IPV4, SECUGEN_ENDPOINTS,
    };

    #[test]
    fn native_api_bridge_forwards_only_supported_authentication_headers() {
        assert!(is_allowed_api_header("X-VISIONPOS-App-Version"));
        assert!(is_allowed_api_header("x-visionpos-app-version"));
        assert!(is_allowed_api_header("X-Session-Token"));
        assert!(is_allowed_api_header("x-session-token"));
        assert!(!is_allowed_api_header("authorization"));
        assert!(!is_allowed_api_header("cookie"));
    }

    #[test]
    fn secugen_https_endpoints_preserve_vendor_localhost_host_name() {
        assert_eq!(SECUGEN_ENDPOINTS[0], ("https://localhost:8443", 8443));
        assert_eq!(SECUGEN_ENDPOINTS[2], ("https://localhost:8000", 8000));
    }

    #[test]
    fn secugen_device_busy_accepts_numeric_and_string_error_codes() {
        let numeric = serde_json::json!({ "ErrorCode": 59 });
        let string = serde_json::json!({ "errorCode": "59" });
        let ready = serde_json::json!({ "ErrorCode": 0 });

        assert_eq!(secugen_response_error_code(&numeric), Some(59));
        assert!(secugen_device_is_busy(&numeric));
        assert!(secugen_device_is_busy(&string));
        assert!(!secugen_device_is_busy(&ready));
    }

    #[test]
    fn direct_origin_fallback_preserves_the_production_tls_hostname() {
        assert_eq!(API_BASE_URL, "https://visionarypos.cloud");
        assert_eq!(API_HOST, "visionarypos.cloud");
        assert_eq!(API_ORIGIN_IPV4.to_string(), "187.124.43.10");
    }
}
