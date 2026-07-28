[CmdletBinding()]
param(
    [string]$DestinationPath = (Join-Path ([Environment]::GetFolderPath('Desktop')) 'VISIONPOS-Internal-Code-Signing-Backup.pfx')
)

$ErrorActionPreference = 'Stop'
$thumbprint = '49FE31D8D08CF9FEDC12454E64CC96FCF0BA2BFE'
$certificate = Get-Item -LiteralPath "Cert:\CurrentUser\My\$thumbprint" -ErrorAction Stop

if (-not $certificate.HasPrivateKey) {
    throw "Certificate $thumbprint does not have its private key."
}

$destinationDirectory = Split-Path -Parent $DestinationPath
if ($destinationDirectory) {
    New-Item -ItemType Directory -Path $destinationDirectory -Force | Out-Null
}

$password = Read-Host 'Enter a strong password for the private-key backup' -AsSecureString
$exportParameters = @{
    Cert = $certificate
    FilePath = $DestinationPath
    Password = $password
    ChainOption = 'EndEntityCertOnly'
    CryptoAlgorithmOption = 'AES256_SHA256'
}
Export-PfxCertificate @exportParameters | Out-Null

Write-Host "Encrypted signing-certificate backup created at $DestinationPath" -ForegroundColor Green
Write-Host 'Keep the PFX and its password outside the repository and in separate secure locations.'
