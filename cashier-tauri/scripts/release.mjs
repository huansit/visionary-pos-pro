import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const tauriDir = path.join(root, "src-tauri");
const tauriConfig = JSON.parse(fs.readFileSync(path.join(tauriDir, "tauri.conf.json"), "utf8"));
const version = String(tauriConfig.version || "");
const expectedThumbprint = String(tauriConfig.bundle?.windows?.certificateThumbprint || "").replace(/\s/g, "").toUpperCase();
const nsisDir = path.join(tauriDir, "target", "release", "bundle", "nsis");
const outDir = path.join(root, "release-out");

function fail(message) {
  console.error(`\nRelease failed: ${message}\n`);
  process.exit(1);
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", shell: false, env: process.env });
  if (result.status !== 0) fail(`${command} ${args.join(" ")} exited with code ${result.status}`);
}

function powershellJson(command) {
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
    cwd: root,
    encoding: "utf8",
    shell: false
  });
  if (result.status !== 0) fail(String(result.stderr || result.stdout || "PowerShell command failed.").trim());
  try {
    return JSON.parse(String(result.stdout).trim());
  } catch {
    fail(`PowerShell returned invalid JSON: ${String(result.stdout).trim()}`);
  }
}

function sha512(file) {
  return createHash("sha512").update(fs.readFileSync(file)).digest("hex").toUpperCase();
}

function latestFile(dir, predicate) {
  return fs.readdirSync(dir)
    .filter(predicate)
    .map((name) => ({ name, fullPath: path.join(dir, name), mtime: fs.statSync(path.join(dir, name)).mtimeMs }))
    .sort((left, right) => right.mtime - left.mtime)[0];
}

function assertSigningCertificateReady() {
  if (process.platform !== "win32") fail("Windows releases must be built and Authenticode-signed on Windows.");
  if (!/^[A-F0-9]{40}$/.test(expectedThumbprint)) fail("A SHA-1 Windows certificate thumbprint is required.");
  const certificate = powershellJson([
    `$certificate = Get-Item -LiteralPath 'Cert:\\CurrentUser\\My\\${expectedThumbprint}' -ErrorAction Stop`,
    "$codeSigningOid = '1.3.6.1.5.5.7.3.3'",
    "$hasCodeSigningEku = @($certificate.Extensions | Where-Object { $_ -is [System.Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension] } | ForEach-Object { $_.EnhancedKeyUsages } | Where-Object { $_.Value -eq $codeSigningOid }).Count -gt 0",
    "[ordered]@{ HasPrivateKey = $certificate.HasPrivateKey; HasCodeSigningEku = $hasCodeSigningEku; NotAfter = $certificate.NotAfter.ToUniversalTime().ToString('o'); Subject = $certificate.Subject; Thumbprint = $certificate.Thumbprint; PublicKeyOid = $certificate.PublicKey.Oid.Value; KeySize = $certificate.PublicKey.Key.KeySize } | ConvertTo-Json -Compress"
  ].join("; "));
  if (!certificate.HasPrivateKey) fail(`Signing certificate ${expectedThumbprint} does not have its private key.`);
  if (new Date(certificate.NotAfter) <= new Date()) fail(`Signing certificate expired at ${certificate.NotAfter}.`);
  if (String(certificate.Thumbprint).toUpperCase() !== expectedThumbprint) fail("Unexpected signing certificate thumbprint.");
  if (!certificate.HasCodeSigningEku) fail("The selected certificate is not restricted to code signing.");
  if (certificate.PublicKeyOid !== "1.2.840.113549.1.1.1" || Number(certificate.KeySize) < 2048) fail("Windows releases require an RSA code-signing certificate with at least a 2048-bit key.");
  return certificate;
}

function assertValidAuthenticode(file) {
  const escapedPath = file.replaceAll("'", "''");
  const signature = powershellJson([
    `$signature = Get-AuthenticodeSignature -LiteralPath '${escapedPath}'`,
    "[ordered]@{ Status = $signature.Status.ToString(); Subject = $signature.SignerCertificate.Subject; Thumbprint = $signature.SignerCertificate.Thumbprint; TimestampSubject = $signature.TimeStamperCertificate.Subject } | ConvertTo-Json -Compress"
  ].join("; "));
  if (signature.Status !== "Valid") fail(`Authenticode signature is not valid for ${file} (status: ${signature.Status}).`);
  if (String(signature.Thumbprint).toUpperCase() !== expectedThumbprint) fail(`Unexpected Authenticode signer for ${file}.`);
  if (!signature.TimestampSubject) fail(`Authenticode signature is not timestamped: ${file}`);
  return signature;
}

function findSevenZip() {
  const candidates = [
    process.env.VISIONPOS_7ZIP_PATH,
    path.join(process.env.ProgramFiles || "C:\\Program Files", "7-Zip", "7z.exe"),
    path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "7-Zip", "7z.exe")
  ].filter(Boolean);
  for (const candidate of candidates) if (fs.existsSync(candidate)) return candidate;
  fail("7z.exe is required to inspect the signed executable inside the NSIS installer. Set VISIONPOS_7ZIP_PATH.");
}

function assertEmbeddedAppAuthenticode(installerPath) {
  const extractDir = fs.mkdtempSync(path.join(os.tmpdir(), "visionpos-nsis-"));
  try {
    run(findSevenZip(), ["e", "-y", `-o${extractDir}`, installerPath, "visionpos_cashier.exe"]);
    const embeddedApp = path.join(extractDir, "visionpos_cashier.exe");
    if (!fs.existsSync(embeddedApp)) fail(`The installer does not contain visionpos_cashier.exe: ${installerPath}`);
    assertValidAuthenticode(embeddedApp);
  } finally {
    fs.rmSync(extractDir, { recursive: true, force: true });
  }
}

if (!version) fail("src-tauri/tauri.conf.json does not contain a version.");
const certificate = assertSigningCertificateReady();
console.log(`Building VISIONPOS Cashier ${version} as a local release candidate...`);
const npmCli = process.env.npm_execpath;
if (!npmCli || !fs.existsSync(npmCli)) fail("Run this script through npm run release.");
run(process.execPath, [npmCli, "run", "build"]);
run(process.execPath, [npmCli, "exec", "--", "tauri", "build"]);

const installer = latestFile(nsisDir, (name) => name.endsWith(".exe"));
if (!installer) fail(`No NSIS installer .exe found in ${nsisDir}`);
const signature = assertValidAuthenticode(installer.fullPath);
assertEmbeddedAppAuthenticode(installer.fullPath);

fs.mkdirSync(outDir, { recursive: true });
const candidateName = `VISIONPOS-Cashier_${version.replace(/[^\w.-]/g, "_")}_x64-setup.exe`;
const candidatePath = path.join(outDir, candidateName);
fs.copyFileSync(installer.fullPath, candidatePath);
assertValidAuthenticode(candidatePath);
assertEmbeddedAppAuthenticode(candidatePath);

const manifestPath = path.join(outDir, "release-candidate.json");
fs.writeFileSync(manifestPath, `${JSON.stringify({
  version,
  installer: candidateName,
  sha512: sha512(candidatePath),
  signer: signature.Subject || certificate.Subject,
  thumbprint: expectedThumbprint,
  timestamped: true,
  distribution: "manual-admin-approved-only",
  automaticUpdates: "disabled"
}, null, 2)}\n`);

console.log("\nCandidate release created locally. It has NOT been copied to the public website.");
console.log(`- ${candidatePath}`);
console.log(`- ${manifestPath}`);
