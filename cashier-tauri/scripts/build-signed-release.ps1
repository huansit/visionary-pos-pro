[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$expectedThumbprint = '49FE31D8D08CF9FEDC12454E64CC96FCF0BA2BFE'
$cashierRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$updaterKeyPath = Join-Path $cashierRoot 'src-tauri\gen\visionpos-updater.key'
$sevenZipPath = 'C:\Program Files\Lenovo\Lenovo AI Now\7Zip\7z.exe'
$certificatePath = "Cert:\CurrentUser\My\$expectedThumbprint"

$certificate = Get-Item -LiteralPath $certificatePath -ErrorAction Stop
if (-not $certificate.HasPrivateKey) {
    throw "Signing certificate $expectedThumbprint does not have its private key."
}
if ($certificate.NotAfter -le (Get-Date)) {
    throw "Signing certificate $expectedThumbprint expired on $($certificate.NotAfter.ToString('u'))."
}
if (-not (Test-Path -LiteralPath $updaterKeyPath -PathType Leaf)) {
    throw "Updater signing key is missing: $updaterKeyPath"
}

$environmentNames = @(
    'TAURI_SIGNING_PRIVATE_KEY',
    'TAURI_SIGNING_PRIVATE_KEY_PASSWORD',
    'VISIONPOS_7ZIP_PATH'
)
$previousEnvironment = @{}
foreach ($name in $environmentNames) {
    $previousEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}

$locationPushed = $false
try {
    $env:TAURI_SIGNING_PRIVATE_KEY = Get-Content -LiteralPath $updaterKeyPath -Raw
    $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ''
    if (Test-Path -LiteralPath $sevenZipPath -PathType Leaf) {
        $env:VISIONPOS_7ZIP_PATH = $sevenZipPath
    }

    Push-Location -LiteralPath $cashierRoot
    $locationPushed = $true
    & npm.cmd run release
    if ($LASTEXITCODE -ne 0) {
        throw "Signed release build failed with exit code $LASTEXITCODE."
    }
} finally {
    if ($locationPushed) {
        Pop-Location
    }
    foreach ($name in $environmentNames) {
        $previousValue = $previousEnvironment[$name]
        if ($null -eq $previousValue) {
            [Environment]::SetEnvironmentVariable($name, $null, 'Process')
        } else {
            [Environment]::SetEnvironmentVariable($name, $previousValue, 'Process')
        }
    }
}
