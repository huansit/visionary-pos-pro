import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const tauriDir = path.join(root, "src-tauri");
const tauriConfigPath = path.join(tauriDir, "tauri.conf.json");
const keyPath = path.join(tauriDir, "gen", "visionpos-updater.key");
const nsisDir = path.join(tauriDir, "target", "release", "bundle", "nsis");
const outDir = path.join(root, "release-out");
const frontendDownloadsDir = path.resolve(root, "..", "frontend", "public", "downloads");
const trustCertificatePath = path.join(root, "signing", "visionpos-internal-code-signing.cer");
const trustInstallerPath = path.join(root, "scripts", "install-internal-trust.ps1");
const downloadsBaseUrl = process.env.VISIONPOS_DOWNLOADS_BASE_URL || "https://www.visionarypos.cloud/downloads";
const platform = "windows-x86_64";

function fail(message) {
  console.error(`\nRelease failed: ${message}\n`);
  process.exit(1);
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    shell: false,
    env: process.env
  });

  if (result.status !== 0) {
    fail(`${command} ${args.join(" ")} exited with code ${result.status}`);
  }
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function sha512(file) {
  return createHash("sha512").update(fs.readFileSync(file)).digest("hex").toUpperCase();
}

function latestFile(dir, predicate) {
  return fs
    .readdirSync(dir)
    .filter(predicate)
    .map((name) => {
      const fullPath = path.join(dir, name);
      return { name, fullPath, mtime: fs.statSync(fullPath).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime)[0];
}

if (!fs.existsSync(tauriConfigPath)) {
  fail(`Missing Tauri config: ${tauriConfigPath}`);
}

const tauriConfig = readJson(tauriConfigPath);
const version = tauriConfig.version;
const expectedAuthenticodeThumbprint = String(
  tauriConfig.bundle?.windows?.certificateThumbprint || ""
).replace(/\s/g, "").toUpperCase();

if (!version) {
  fail("src-tauri/tauri.conf.json does not contain a version.");
}

if (!/^[A-F0-9]{40}$/.test(expectedAuthenticodeThumbprint)) {
  fail("bundle.windows.certificateThumbprint must contain one SHA-1 certificate thumbprint.");
}

if (!process.env.TAURI_SIGNING_PRIVATE_KEY) {
  fail(`TAURI_SIGNING_PRIVATE_KEY is not set. Load it from ${keyPath}; do not print or commit it.`);
}

process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ??= "";

console.log(`Building VISIONPOS Cashier ${version}...`);
const npmCli = process.env.npm_execpath;
if (!npmCli || !fs.existsSync(npmCli)) {
  fail("npm CLI path is unavailable. Run this script through `npm run release`.");
}

function powershellJson(command) {
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
    cwd: root,
    encoding: "utf8",
    shell: false
  });
  if (result.status !== 0) {
    fail(String(result.stderr || result.stdout || "PowerShell command failed.").trim());
  }
  try {
    return JSON.parse(String(result.stdout).trim());
  } catch {
    fail(`PowerShell returned invalid JSON: ${String(result.stdout).trim()}`);
  }
}

function assertSigningCertificateReady() {
  if (process.platform !== "win32") {
    fail("Windows releases must be built and Authenticode-signed on Windows.");
  }
  const certificate = powershellJson([
    `$certificate = Get-Item -LiteralPath 'Cert:\\CurrentUser\\My\\${expectedAuthenticodeThumbprint}' -ErrorAction Stop`,
    "[ordered]@{ HasPrivateKey = $certificate.HasPrivateKey; NotAfter = $certificate.NotAfter.ToUniversalTime().ToString('o'); Subject = $certificate.Subject; Thumbprint = $certificate.Thumbprint } | ConvertTo-Json -Compress"
  ].join("; "));
  if (!certificate.HasPrivateKey) {
    fail(`Signing certificate ${expectedAuthenticodeThumbprint} does not have its private key.`);
  }
  if (new Date(certificate.NotAfter) <= new Date()) {
    fail(`Signing certificate expired at ${certificate.NotAfter}.`);
  }
  if (String(certificate.Thumbprint).toUpperCase() !== expectedAuthenticodeThumbprint) {
    fail(`Unexpected signing certificate thumbprint ${certificate.Thumbprint}.`);
  }
  console.log(`Authenticode signer ready: ${certificate.Subject} (${certificate.Thumbprint})`);
}

function assertValidAuthenticode(file) {
  if (!fs.existsSync(file)) {
    fail(`Windows release file was not found: ${file}`);
  }
  const escapedPath = file.replaceAll("'", "''");
  const signature = powershellJson([
    `$signature = Get-AuthenticodeSignature -LiteralPath '${escapedPath}'`,
    "[ordered]@{ Status = $signature.Status.ToString(); Subject = $signature.SignerCertificate.Subject; Thumbprint = $signature.SignerCertificate.Thumbprint; TimestampSubject = $signature.TimeStamperCertificate.Subject } | ConvertTo-Json -Compress"
  ].join("; "));
  if (signature.Status !== "Valid") {
    fail(`Windows Authenticode signature is not valid for ${file} (status: ${signature.Status}).`);
  }
  if (String(signature.Thumbprint).toUpperCase() !== expectedAuthenticodeThumbprint) {
    fail(`Unexpected Authenticode signer for ${file}: ${signature.Subject} (${signature.Thumbprint}).`);
  }
  if (!signature.TimestampSubject) {
    fail(`Authenticode signature is not timestamped: ${file}`);
  }
}

function findSevenZip() {
  const candidates = [
    process.env.VISIONPOS_7ZIP_PATH,
    path.join(process.env.ProgramFiles || "C:\\Program Files", "7-Zip", "7z.exe"),
    path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "7-Zip", "7z.exe")
  ].filter(Boolean);

  const where = spawnSync("where.exe", ["7z.exe"], { encoding: "utf8", shell: false });
  if (where.status === 0) {
    candidates.push(...String(where.stdout).split(/\r?\n/).filter(Boolean));
  }

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  const discovery = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$roots = @($env:ProgramFiles, ${env:ProgramFiles(x86)}) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }; Get-ChildItem -LiteralPath $roots -Filter 7z.exe -File -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName"
    ],
    { encoding: "utf8", shell: false }
  );
  const discovered = String(discovery.stdout || "").trim();
  if (discovery.status === 0 && discovered && fs.existsSync(discovered)) return discovered;

  fail("7z.exe is required to verify the signed application embedded in the NSIS installer. Set VISIONPOS_7ZIP_PATH.");
}

function assertEmbeddedAppAuthenticode(installerPath) {
  const extractDir = fs.mkdtempSync(path.join(os.tmpdir(), "visionpos-nsis-"));
  try {
    const sevenZip = findSevenZip();
    run(sevenZip, ["e", "-y", `-o${extractDir}`, installerPath, "visionpos_cashier.exe"]);
    const embeddedAppPath = path.join(extractDir, "visionpos_cashier.exe");
    if (!fs.existsSync(embeddedAppPath)) {
      fail(`The NSIS installer does not contain visionpos_cashier.exe: ${installerPath}`);
    }
    assertValidAuthenticode(embeddedAppPath);
  } finally {
    fs.rmSync(extractDir, { recursive: true, force: true });
  }
}

assertSigningCertificateReady();
run(process.execPath, [npmCli, "run", "build"]);
run(process.execPath, [npmCli, "exec", "--", "tauri", "build"]);

if (!fs.existsSync(nsisDir)) {
  fail(`NSIS bundle directory was not found: ${nsisDir}`);
}

const installer = latestFile(nsisDir, (name) => name.endsWith(".exe"));
if (!installer) {
  fail(`No NSIS installer .exe found in ${nsisDir}`);
}

assertValidAuthenticode(installer.fullPath);
assertEmbeddedAppAuthenticode(installer.fullPath);

const signaturePath = `${installer.fullPath}.sig`;
if (!fs.existsSync(signaturePath)) {
  fail(`Missing updater signature: ${signaturePath}`);
}

const signature = fs.readFileSync(signaturePath, "utf8").trim();
if (!signature) {
  fail(`Updater signature is empty: ${signaturePath}`);
}

const safeVersion = version.replace(/[^\w.-]/g, "_");
const versionedInstallerName = `VISIONPOS-Cashier_${safeVersion}_x64-setup.exe`;
const versionedInstallerPath = path.join(outDir, versionedInstallerName);
const stableInstallerPath = path.join(outDir, "VISIONPOS-Cashier-Setup.exe");
const latestJsonPath = path.join(outDir, "latest.json");
const compatibilityJsonPath = path.join(outDir, "release.json");
const installerUrl = `${downloadsBaseUrl.replace(/\/$/, "")}/${versionedInstallerName}`;
const releaseNotes = [
  `VISIONPOS Cashier ${version}`,
  "Favorites now shows the branch's most commonly sold products from the last 30 days.",
  "Common products are ranked by units sold, invoice frequency, and latest sale, with approved voids excluded.",
  "The Sales Today Pending count now represents invoice void requests awaiting supervisor approval.",
  "Today's invoice list marks pending void requests with a distinct red treatment while keeping them available for review.",
  "Cashier dashboards now sync each cashier's missing-inventory joint debt and retain it for offline viewing.",
  "Open, overdue, carried invoice debt, and missing-inventory debt are displayed as separate categories with accurate totals.",
  "Unpaid invoices become overdue after one day but become cashier debt only after End of Day carries them forward.",
  "Cashier sessions now sign out after 15 minutes of inactivity, including after sleep, backgrounding, or window suspension.",
  "Fingerprint operations are serialized to prevent overlapping scans; a busy SecuGen reader is retried immediately, then the stale WebAPI client is restarted once before VisionPOS reports a clear device-busy message.",
  "Cashier API requests now switch to the verified direct IPv4 origin when Cloudflare cannot be reached, restoring login, fingerprint templates, checkout, and sync on affected terminals.",
  "Update checks now retry through the DNS-only IPv4 recovery route before sign-in.",
  "Active cashier sessions now renew during normal use to prevent overnight login failures.",
  "Expired checkout sessions recover from the same verified fingerprint without requiring a second scan.",
  "Fingerprint login and checkout reuse warmed connections and avoid unnecessary template refreshes.",
  "An unresponsive SecuGen service is restarted automatically and the fingerprint operation is retried once.",
  "Updates are now detected and can be installed before cashier sign-in or terminal activation.",
  "The native API bridge now forwards the installed cashier version so the admin terminal dashboard updates during normal activity.",
  "The cashier executable and installer are Authenticode-signed and timestamped for trusted VISIONPOS workstations.",
  "Native in-app updater package with automatic signature verification and restart."
];

fs.mkdirSync(outDir, { recursive: true });
fs.copyFileSync(installer.fullPath, versionedInstallerPath);
fs.copyFileSync(installer.fullPath, stableInstallerPath);

const latest = {
  version,
  notes: releaseNotes.join("\n"),
  pub_date: new Date().toISOString(),
  platforms: {
    [platform]: {
      signature,
      url: installerUrl
    }
  }
};

if (latest.version !== version) {
  fail(`latest.json.version (${latest.version}) does not match tauri.conf.json version (${version}).`);
}

const compatibilityRelease = {
  version: latest.version,
  platform: "windows",
  installer: `/${new URL(installerUrl).pathname.replace(/^\/+/, "")}`,
  size: fs.statSync(versionedInstallerPath).size,
  sha512: sha512(versionedInstallerPath),
  releaseNotes
};

if (compatibilityRelease.version !== version) {
  fail(`release.json.version (${compatibilityRelease.version}) does not match tauri.conf.json version (${version}).`);
}

fs.writeFileSync(latestJsonPath, `${JSON.stringify(latest, null, 2)}\n`);
fs.writeFileSync(compatibilityJsonPath, `${JSON.stringify(compatibilityRelease, null, 2)}\n`);

const generatedLatest = readJson(latestJsonPath);
if (generatedLatest.version !== version) {
  fail(`Generated latest.json has stale version ${generatedLatest.version}; expected ${version}.`);
}

// Keep the web download bundle synchronized with the signed Tauri release.
// Vite copies this directory to production, so stale files here would otherwise
// overwrite the current updater manifest during every admin frontend deploy.
fs.mkdirSync(frontendDownloadsDir, { recursive: true });
const frontendReleaseFiles = [
  [versionedInstallerPath, path.join(frontendDownloadsDir, versionedInstallerName)],
  [stableInstallerPath, path.join(frontendDownloadsDir, "VISIONPOS-Cashier-Setup.exe")],
  [latestJsonPath, path.join(frontendDownloadsDir, "latest.json")],
  [compatibilityJsonPath, path.join(frontendDownloadsDir, "release.json")],
  [trustCertificatePath, path.join(frontendDownloadsDir, "VISIONPOS-Cashier-Internal-Trust.cer")],
  [trustInstallerPath, path.join(frontendDownloadsDir, "Install-VISIONPOS-Cashier-Trust.ps1")]
];
for (const [source, destination] of frontendReleaseFiles) {
  if (!fs.existsSync(source)) {
    fail(`Required release file was not found: ${source}`);
  }
  fs.copyFileSync(source, destination);
}

const frontendLatest = readJson(path.join(frontendDownloadsDir, "latest.json"));
if (frontendLatest.version !== version) {
  fail(`Frontend latest.json has stale version ${frontendLatest.version}; expected ${version}.`);
}

console.log("\nRelease files ready to upload:");
console.log(`- ${versionedInstallerPath} -> ${installerUrl}`);
console.log(`- ${stableInstallerPath} -> ${downloadsBaseUrl.replace(/\/$/, "")}/VISIONPOS-Cashier-Setup.exe`);
console.log(`- ${latestJsonPath} -> ${downloadsBaseUrl.replace(/\/$/, "")}/latest.json`);
console.log(`- ${compatibilityJsonPath} -> ${downloadsBaseUrl.replace(/\/$/, "")}/release.json`);
console.log("\nFrontend download assets synchronized:");
for (const [, destination] of frontendReleaseFiles) {
  console.log(`- ${destination}`);
}
console.log("\nKeep publishing release.json only during the 2.0.17 transition window; new app builds use latest.json only.");
