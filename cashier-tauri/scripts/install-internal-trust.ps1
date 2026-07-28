#Requires -RunAsAdministrator

[CmdletBinding()]
param(
    [string]$CertificatePath
)

$ErrorActionPreference = 'Stop'
$expectedThumbprint = '49FE31D8D08CF9FEDC12454E64CC96FCF0BA2BFE'

if (-not $CertificatePath) {
    $downloadCertificatePath = Join-Path $PSScriptRoot 'VISIONPOS-Cashier-Internal-Trust.cer'
    $repositoryCertificatePath = Join-Path $PSScriptRoot '..\signing\visionpos-internal-code-signing.cer'
    $CertificatePath = if (Test-Path -LiteralPath $downloadCertificatePath) {
        $downloadCertificatePath
    } else {
        $repositoryCertificatePath
    }
}

$resolvedCertificatePath = (Resolve-Path -LiteralPath $CertificatePath).Path
$certificate = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new($resolvedCertificatePath)
$actualThumbprint = $certificate.Thumbprint.Replace(' ', '').ToUpperInvariant()

if ($actualThumbprint -ne $expectedThumbprint) {
    throw "Refusing unexpected certificate $actualThumbprint; expected $expectedThumbprint."
}

$codeSigningOid = '1.3.6.1.5.5.7.3.3'
$hasCodeSigningEku = @(
    $certificate.Extensions |
        Where-Object { $_ -is [System.Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension] } |
        ForEach-Object { $_.EnhancedKeyUsages } |
        Where-Object { $_.Value -eq $codeSigningOid }
).Count -gt 0
if (-not $hasCodeSigningEku) {
    throw 'The VISIONPOS certificate is not restricted to code signing.'
}

if ($certificate.NotAfter -le (Get-Date)) {
    throw "The VISIONPOS signing certificate expired on $($certificate.NotAfter.ToString('u'))."
}

foreach ($storeName in @('Root', 'TrustedPublisher')) {
    $storePath = "Cert:\LocalMachine\$storeName"
    $installed = Get-ChildItem -LiteralPath $storePath | Where-Object {
        $_.Thumbprint -eq $expectedThumbprint
    }
    if (-not $installed) {
        Import-Certificate -FilePath $resolvedCertificatePath -CertStoreLocation $storePath | Out-Null
    }

    $verified = Get-ChildItem -LiteralPath $storePath | Where-Object {
        $_.Thumbprint -eq $expectedThumbprint
    }
    if (-not $verified) {
        throw "Certificate installation failed for $storePath."
    }
}

$smartAppControlParameters = @{
    LiteralPath = 'HKLM:\SYSTEM\CurrentControlSet\Control\CI\Policy'
    Name = 'VerifiedAndReputablePolicyState'
    ErrorAction = 'SilentlyContinue'
}
$smartAppControlState = (Get-ItemProperty @smartAppControlParameters).VerifiedAndReputablePolicyState

Write-Host 'VISIONPOS internal publisher trust installed successfully.' -ForegroundColor Green
Write-Host "Certificate: $($certificate.Subject)"
Write-Host "Thumbprint: $expectedThumbprint"
Write-Host "Smart App Control state: $smartAppControlState (1 means enforced)"
