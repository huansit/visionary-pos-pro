import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const cashierDir = path.resolve(scriptDir, "..");
const projectDir = path.resolve(cashierDir, "..");
const candidateDir = path.join(cashierDir, "release-out");
const candidateManifestPath = path.join(candidateDir, "release-candidate.json");
const downloadsDir = path.join(projectDir, "frontend", "public", "downloads");
const releaseManifestPath = path.join(downloadsDir, "release.json");
const latestManifestPath = path.join(downloadsDir, "latest.json");
const staticPages = [path.join(downloadsDir, "index.html"), path.join(projectDir, "frontend", "public", "downloads.html")];

function fail(message) {
  console.error(`Release publication failed: ${message}`);
  process.exit(1);
}
function sha512(file) {
  return createHash("sha512").update(fs.readFileSync(file)).digest("hex").toUpperCase();
}
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (error) { fail(`cannot read ${file}: ${error.message}`); }
}
function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

const candidate = readJson(candidateManifestPath);
const version = String(candidate.version || "").trim();
const installerName = path.basename(String(candidate.installer || "").trim());
if (!/^\d+\.\d+\.\d+$/.test(version)) fail("candidate version is invalid");
if (!/^VISIONPOS-Cashier_\d+\.\d+\.\d+_x64-setup\.exe$/.test(installerName)) fail("candidate installer name is invalid");
const installerPath = path.join(candidateDir, installerName);
if (!fs.existsSync(installerPath)) fail(`candidate installer is missing: ${installerPath}`);
const digest = sha512(installerPath);
if (digest !== String(candidate.sha512 || "").toUpperCase()) fail("candidate SHA-512 does not match release-candidate.json");
if (candidate.timestamped !== true || !String(candidate.signer || "").includes("VISIONPOS Internal Code Signing")) fail("candidate must be signed and timestamped by the VISIONPOS signing certificate");

fs.mkdirSync(downloadsDir, { recursive: true });
const publishedInstallerPath = path.join(downloadsDir, installerName);
fs.copyFileSync(installerPath, publishedInstallerPath);
if (sha512(publishedInstallerPath) !== digest) fail("published installer SHA-512 verification failed");

const notes = [
  `VISIONPOS Cashier ${version}`,
  "Manual signed and timestamped Cashier installer.",
  "Automatic desktop updates are disabled.",
  "Supervisor-only stock counts are available on cashier terminals.",
  "Cashier, supervisor, owner, and admin terminal sign-in paths are clearly separated.",
  "Opening and approving a count requires a fresh supervisor PIN or enrolled fingerprint.",
  "Stock count, quick inventory, and correction variances never create cashier debt automatically.",
  "All approved count adjustments are written to the shared stock ledger for every device.",
];
writeJson(releaseManifestPath, {
  version,
  platform: "windows",
  installer: `/downloads/${installerName}`,
  size: fs.statSync(publishedInstallerPath).size,
  sha512: digest,
  releaseNotes: notes,
});
writeJson(latestManifestPath, {
  version,
  notes: notes.join("\n"),
  pub_date: new Date().toISOString(),
  platforms: { "windows-x86_64": { url: `/downloads/${installerName}`, signature: "" } },
});

for (const page of staticPages) {
  let html = fs.readFileSync(page, "utf8");
  html = html
    .replace(/Version \d+\.\d+\.\d+/, `Version ${version}`)
    .replace(/\/downloads\/VISIONPOS-Cashier_\d+\.\d+\.\d+_x64-setup\.exe/g, `/downloads/${installerName}`)
    .replace(/SHA-512:\s*<code>[A-Fa-f0-9]+<\/code>/, `SHA-512: <code>${digest}</code>`);
  fs.writeFileSync(page, html);
}

console.log(JSON.stringify({
  published: true,
  version,
  installer: publishedInstallerPath,
  sha512: digest,
  releaseManifest: releaseManifestPath,
}, null, 2));
