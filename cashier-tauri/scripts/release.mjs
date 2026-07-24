import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const tauriDir = path.join(root, "src-tauri");
const tauriConfigPath = path.join(tauriDir, "tauri.conf.json");
const keyPath = path.join(tauriDir, "gen", "visionpos-updater.key");
const nsisDir = path.join(tauriDir, "target", "release", "bundle", "nsis");
const outDir = path.join(root, "release-out");
const frontendDownloadsDir = path.resolve(root, "..", "frontend", "public", "downloads");
const downloadsBaseUrl = process.env.VISIONPOS_DOWNLOADS_BASE_URL || "https://visionarypos.cloud/downloads";
const platform = "windows-x86_64";

function fail(message) {
  console.error(`\nRelease failed: ${message}\n`);
  process.exit(1);
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    shell: process.platform === "win32",
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

if (!version) {
  fail("src-tauri/tauri.conf.json does not contain a version.");
}

if (!process.env.TAURI_SIGNING_PRIVATE_KEY) {
  fail(`TAURI_SIGNING_PRIVATE_KEY is not set. Load it from ${keyPath}; do not print or commit it.`);
}

process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ??= "";

console.log(`Building VISIONPOS Cashier ${version}...`);
run("npm", ["run", "build"]);
run("npx", ["tauri", "build"]);

if (!fs.existsSync(nsisDir)) {
  fail(`NSIS bundle directory was not found: ${nsisDir}`);
}

const installer = latestFile(nsisDir, (name) => name.endsWith(".exe"));
if (!installer) {
  fail(`No NSIS installer .exe found in ${nsisDir}`);
}

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
  "The normal product catalogue now displays the complete branch catalogue instead of stopping after 80 products.",
  "Cape Town product names remain attached when global catalogue and branch pricing records are merged.",
  "Browse and search now use the same synchronized product set.",
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
  [compatibilityJsonPath, path.join(frontendDownloadsDir, "release.json")]
];
for (const [source, destination] of frontendReleaseFiles) {
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
