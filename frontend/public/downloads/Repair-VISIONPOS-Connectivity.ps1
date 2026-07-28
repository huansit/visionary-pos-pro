#Requires -Version 5.1
#Requires -RunAsAdministrator

[CmdletBinding()]
param(
    [switch]$Repair,
    [switch]$Restart
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$targetHostName = 'visionarypos.cloud'
$targetIpAddress = '187.124.43.10'
$runId = Get-Date -Format 'yyyyMMdd-HHmmss'
$stateDirectory = Join-Path $env:ProgramData "VISIONPOS\ConnectivityRepair\$runId"
$hostsPath = Join-Path $env:SystemRoot 'System32\drivers\etc\hosts'
$internetSettingsPath = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'
$internetSettingsRegistryPath = 'HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings'

New-Item -ItemType Directory -Force -Path $stateDirectory | Out-Null
$transcriptPath = Join-Path $stateDirectory 'repair.log'
Start-Transcript -Path $transcriptPath -Force | Out-Null

function Write-Section {
    param([string]$Title)
    Write-Host "`n=== $Title ===" -ForegroundColor Cyan
}

function Invoke-Diagnostic {
    param(
        [string]$Title,
        [scriptblock]$Action
    )

    Write-Section $Title
    try {
        & $Action 2>&1 | Out-Host
    } catch {
        Write-Warning $_.Exception.Message
    }
}

function Test-VisionPosConnectivity {
    param([string]$Stage)

    Invoke-Diagnostic "$Stage DNS" {
        Resolve-DnsName $targetHostName -ErrorAction Stop |
            Select-Object Name, Type, IPAddress |
            Format-Table -AutoSize
    }
    Invoke-Diagnostic "$Stage TCP 443" {
        Test-NetConnection $targetIpAddress -Port 443 -InformationLevel Detailed |
            Format-List ComputerName, RemoteAddress, RemotePort, SourceAddress, InterfaceAlias, TcpTestSucceeded
    }
    Invoke-Diagnostic "$Stage HTTPS with fixed IPv4" {
        & curl.exe -vkI --connect-timeout 15 --max-time 25 `
            --resolve "${targetHostName}:443:${targetIpAddress}" `
            "https://${targetHostName}/"
    }
}

try {
    Write-Host 'VISIONPOS connectivity diagnostics started.' -ForegroundColor Green
    Write-Host "State backup and log: $stateDirectory"

    Invoke-Diagnostic 'Windows' {
        Get-ComputerInfo |
            Select-Object WindowsProductName, WindowsVersion, OsBuildNumber |
            Format-List
    }
    Invoke-Diagnostic 'Active network adapters' {
        Get-NetIPConfiguration |
            Select-Object InterfaceAlias, InterfaceDescription, IPv4Address, IPv4DefaultGateway, DNSServer |
            Format-List
    }
    Invoke-Diagnostic 'DNS servers' {
        Get-DnsClientServerAddress -AddressFamily IPv4 |
            Where-Object { $_.ServerAddresses.Count -gt 0 } |
            Select-Object InterfaceAlias, ServerAddresses |
            Format-Table -AutoSize
    }
    Invoke-Diagnostic 'WinHTTP proxy' {
        & netsh.exe winhttp show proxy
    }
    Invoke-Diagnostic 'User proxy settings' {
        Get-ItemProperty -LiteralPath $internetSettingsPath -ErrorAction SilentlyContinue |
            Select-Object ProxyEnable, ProxyServer, AutoConfigURL, AutoDetect |
            Format-List
    }
    Invoke-Diagnostic 'Configured outbound firewall blocks' {
        Get-NetFirewallRule -Enabled True -Direction Outbound -Action Block -ErrorAction SilentlyContinue |
            Select-Object DisplayName, Profile, PolicyStoreSourceType |
            Format-Table -AutoSize
    }
    Invoke-Diagnostic 'VISIONPOS hosts entries' {
        if (Test-Path -LiteralPath $hostsPath) {
            Get-Content -LiteralPath $hostsPath |
                Select-String -Pattern 'visionarypos\.cloud'
        }
    }

    if (Test-Path -LiteralPath $hostsPath) {
        Copy-Item -LiteralPath $hostsPath -Destination (Join-Path $stateDirectory 'hosts.backup') -Force
    }
    & reg.exe export $internetSettingsRegistryPath (Join-Path $stateDirectory 'internet-settings.reg') /y | Out-Host

    Test-VisionPosConnectivity 'Before repair'

    if (-not $Repair) {
        Write-Host "`nDiagnostic mode completed. No settings were changed." -ForegroundColor Yellow
        Write-Host 'Run again with -Repair -Restart to apply the controlled repair.'
        return
    }

    Write-Section 'Applying controlled repair'

    if (Test-Path -LiteralPath $hostsPath) {
        $hostPattern = '(?i)(^|\s)(www\.)?visionarypos\.cloud(\s|$)'
        $hostsLines = [System.IO.File]::ReadAllLines($hostsPath)
        $filteredHostsLines = @($hostsLines | Where-Object {
            $trimmed = $_.TrimStart()
            $trimmed.StartsWith('#') -or $_ -notmatch $hostPattern
        })
        if ($filteredHostsLines.Count -ne $hostsLines.Count) {
            [System.IO.File]::WriteAllLines(
                $hostsPath,
                $filteredHostsLines,
                [System.Text.UTF8Encoding]::new($false)
            )
            Write-Host 'Removed active VISIONPOS overrides from the Windows hosts file.'
        }
    }

    if (-not (Test-Path -LiteralPath $internetSettingsPath)) {
        New-Item -Path $internetSettingsPath -Force | Out-Null
    }
    New-ItemProperty -LiteralPath $internetSettingsPath -Name ProxyEnable -PropertyType DWord -Value 0 -Force | Out-Null
    Remove-ItemProperty -LiteralPath $internetSettingsPath -Name AutoConfigURL -ErrorAction SilentlyContinue
    & netsh.exe winhttp reset proxy | Out-Host
    & ipconfig.exe /flushdns | Out-Host
    & netsh.exe winsock reset | Out-Host

    Test-VisionPosConnectivity 'After repair'

    Write-Host "`nRepair completed. Backup and log: $stateDirectory" -ForegroundColor Green
    Write-Host 'A Windows restart is required to finish the Winsock reset.' -ForegroundColor Yellow
} finally {
    Stop-Transcript | Out-Null
}

if ($Repair -and $Restart) {
    Restart-Computer -Force
}

# SIG # Begin signature block
# MIIdpgYJKoZIhvcNAQcCoIIdlzCCHZMCAQExDzANBglghkgBZQMEAgEFADB5Bgor
# BgEEAYI3AgEEoGswaTA0BgorBgEEAYI3AgEeMCYCAwEAAAQQH8w7YFlLCE63JNLG
# KX7zUQIBAAIBAAIBAAIBAAIBADAxMA0GCWCGSAFlAwQCAQUABCC0fl83C73th+vu
# jkM2sV97tfL+fkM1yKDBX6bbDicEkaCCF2IwggQkMIICjKADAgECAhA7aHya5dJf
# oEBns8IqG+zYMA0GCSqGSIb3DQEBCwUAMCoxKDAmBgNVBAMMH1ZJU0lPTlBPUyBJ
# bnRlcm5hbCBDb2RlIFNpZ25pbmcwHhcNMjYwNzI4MTIzMDM3WhcNMzYwNzI4MTI0
# MDM4WjAqMSgwJgYDVQQDDB9WSVNJT05QT1MgSW50ZXJuYWwgQ29kZSBTaWduaW5n
# MIIBojANBgkqhkiG9w0BAQEFAAOCAY8AMIIBigKCAYEAwNaSO7Jn2MyZK4nHZPj+
# jSW76bXzVhbPH3i5IqD8ONYiWUWmGJud+Bn9XZ0UR0hJpHzWFUOhD1Aq3wKSt8Go
# BujFrtk+Ha5WwIKnfEqr8OpCM4jLvCVCHyqfoya925ClvpB4MZViCmKnFdtUDDOW
# I6iQKkJl6ggn7x2EO2l2y0t+X5b0MrlWMhmSyyXDvhdSHGJLBeJFkONek4JM4g5+
# DTeZWm5EqaZrp3buGUgA9l4iX4X4/iJECL3G/q5vn18jhjM+fkn7+6m+wtvwbjU7
# lM7ab0XMp91AHvh1oYvXecPdEicZWV9Xh8P9PrUWwVYGx4iwXUmnOfEecH4hhLyN
# 6bOELWmu34jK1b5nGTYFvd4Pd7xW6v1/EatV3X5d7BrYdVgMhdVSMgOHoZzWtYO4
# enAqZWBI2vndF+A7Lu1PFb4uSWmV1Am1EcBoWbnIVfMauD96eflTZzrzW3Dl750W
# UVmp8rBxuxG8Elayx92a/i5wGO/R/wWQjOW5jyIWLFUpAgMBAAGjRjBEMA4GA1Ud
# DwEB/wQEAwIHgDATBgNVHSUEDDAKBggrBgEFBQcDAzAdBgNVHQ4EFgQUdJqXwE7i
# i0Up/aHMNfXtRX2BFUEwDQYJKoZIhvcNAQELBQADggGBAKZVFzVOIut36YVfaRra
# aYwWh/ncvalsqhA9jUKERET9lNLCwyAIH6AibflDvJZ6pLLdVL96Gb0fossRX+Kx
# jBrCLqmimDkLjaYlGCMt8YEqL25Z4N75q1c94RoGYI/hOfeIr4nAoDC2vncfVs5+
# +ipGVQmbzjqHFapPVJuBFdUQ7JeM69TFo1tiv63FTuZup+DVzjXDEk0LDzIPOdwr
# Ey/k/sIAaEjkoX9Rx8Dbf1yexTxkoWQRrChAZyX1vs1HAA/ngNkBBsyIqzdEAksX
# EJs5PcvPLg53PRQ5YwQepovek1TgDap8tbxT2AZoKI1j5FUMeFwKDfDlKcNZQHGM
# oxxLE61ime+UcYozmdE8mrCYJqtcu7S2uQoxSWaFAfegjH7ITNJSV18ZwuQQkaU/
# F9oaY2S0+pj6gSK10ekl2sf1lJ7N/gOwdwnNLvVBApPryDdPXqnckCBZOzehrQvX
# +AmCX1u3TFdwPJbZrzyJmZsBs1f9SM0n/O3AQBN5azOXTjCCBY0wggR1oAMCAQIC
# EA6bGI750C3n79tQ4ghAGFowDQYJKoZIhvcNAQEMBQAwZTELMAkGA1UEBhMCVVMx
# FTATBgNVBAoTDERpZ2lDZXJ0IEluYzEZMBcGA1UECxMQd3d3LmRpZ2ljZXJ0LmNv
# bTEkMCIGA1UEAxMbRGlnaUNlcnQgQXNzdXJlZCBJRCBSb290IENBMB4XDTIyMDgw
# MTAwMDAwMFoXDTMxMTEwOTIzNTk1OVowYjELMAkGA1UEBhMCVVMxFTATBgNVBAoT
# DERpZ2lDZXJ0IEluYzEZMBcGA1UECxMQd3d3LmRpZ2ljZXJ0LmNvbTEhMB8GA1UE
# AxMYRGlnaUNlcnQgVHJ1c3RlZCBSb290IEc0MIICIjANBgkqhkiG9w0BAQEFAAOC
# Ag8AMIICCgKCAgEAv+aQc2jeu+RdSjwwIjBpM+zCpyUuySE98orYWcLhKac9WKt2
# ms2uexuEDcQwH/MbpDgW61bGl20dq7J58soR0uRf1gU8Ug9SH8aeFaV+vp+pVxZZ
# VXKvaJNwwrK6dZlqczKU0RBEEC7fgvMHhOZ0O21x4i0MG+4g1ckgHWMpLc7sXk7I
# k/ghYZs06wXGXuxbGrzryc/NrDRAX7F6Zu53yEioZldXn1RYjgwrt0+nMNlW7sp7
# XeOtyU9e5TXnMcvak17cjo+A2raRmECQecN4x7axxLVqGDgDEI3Y1DekLgV9iPWC
# PhCRcKtVgkEy19sEcypukQF8IUzUvK4bA3VdeGbZOjFEmjNAvwjXWkmkwuapoGfd
# pCe8oU85tRFYF/ckXEaPZPfBaYh2mHY9WV1CdoeJl2l6SPDgohIbZpp0yt5LHucO
# Y67m1O+SkjqePdwA5EUlibaaRBkrfsCUtNJhbesz2cXfSwQAzH0clcOP9yGyshG3
# u3/y1YxwLEFgqrFjGESVGnZifvaAsPvoZKYz0YkH4b235kOkGLimdwHhD5QMIR2y
# VCkliWzlDlJRR3S+Jqy2QXXeeqxfjT/JvNNBERJb5RBQ6zHFynIWIgnffEx1P2Ps
# IV/EIFFrb7GrhotPwtZFX50g/KEexcCPorF+CiaZ9eRpL5gdLfXZqbId5RsCAwEA
# AaOCATowggE2MA8GA1UdEwEB/wQFMAMBAf8wHQYDVR0OBBYEFOzX44LScV1kTN8u
# Zz/nupiuHA9PMB8GA1UdIwQYMBaAFEXroq/0ksuCMS1Ri6enIZ3zbcgPMA4GA1Ud
# DwEB/wQEAwIBhjB5BggrBgEFBQcBAQRtMGswJAYIKwYBBQUHMAGGGGh0dHA6Ly9v
# Y3NwLmRpZ2ljZXJ0LmNvbTBDBggrBgEFBQcwAoY3aHR0cDovL2NhY2VydHMuZGln
# aWNlcnQuY29tL0RpZ2lDZXJ0QXNzdXJlZElEUm9vdENBLmNydDBFBgNVHR8EPjA8
# MDqgOKA2hjRodHRwOi8vY3JsMy5kaWdpY2VydC5jb20vRGlnaUNlcnRBc3N1cmVk
# SURSb290Q0EuY3JsMBEGA1UdIAQKMAgwBgYEVR0gADANBgkqhkiG9w0BAQwFAAOC
# AQEAcKC/Q1xV5zhfoKN0Gz22Ftf3v1cHvZqsoYcs7IVeqRq7IviHGmlUIu2kiHdt
# vRoU9BNKei8ttzjv9P+Aufih9/Jy3iS8UgPITtAq3votVs/59PesMHqai7Je1M/R
# Q0SbQyHrlnKhSLSZy51PpwYDE3cnRNTnf+hZqPC/Lwum6fI0POz3A8eHqNJMQBk1
# RmppVLC4oVaO7KTVPeix3P0c2PR3WlxUjG/voVA9/HYJaISfb8rbII01YBwCA8sg
# sKxYoA5AY8WYIsGyWfVVa88nq2x2zm8jLfR+cWojayL/ErhULSd+2DrZ8LaHlv1b
# 0VysGMNNn3O3AamfV6peKOK5lDCCBrQwggScoAMCAQICEA3HrFcF/yGZLkBDIgw6
# SYYwDQYJKoZIhvcNAQELBQAwYjELMAkGA1UEBhMCVVMxFTATBgNVBAoTDERpZ2lD
# ZXJ0IEluYzEZMBcGA1UECxMQd3d3LmRpZ2ljZXJ0LmNvbTEhMB8GA1UEAxMYRGln
# aUNlcnQgVHJ1c3RlZCBSb290IEc0MB4XDTI1MDUwNzAwMDAwMFoXDTM4MDExNDIz
# NTk1OVowaTELMAkGA1UEBhMCVVMxFzAVBgNVBAoTDkRpZ2lDZXJ0LCBJbmMuMUEw
# PwYDVQQDEzhEaWdpQ2VydCBUcnVzdGVkIEc0IFRpbWVTdGFtcGluZyBSU0E0MDk2
# IFNIQTI1NiAyMDI1IENBMTCCAiIwDQYJKoZIhvcNAQEBBQADggIPADCCAgoCggIB
# ALR4MdMKmEFyvjxGwBysddujRmh0tFEXnU2tjQ2UtZmWgyxU7UNqEY81FzJsQqr5
# G7A6c+Gh/qm8Xi4aPCOo2N8S9SLrC6Kbltqn7SWCWgzbNfiR+2fkHUiljNOqnIVD
# /gG3SYDEAd4dg2dDGpeZGKe+42DFUF0mR/vtLa4+gKPsYfwEu7EEbkC9+0F2w4QJ
# LVSTEG8yAR2CQWIM1iI5PHg62IVwxKSpO0XaF9DPfNBKS7Zazch8NF5vp7eaZ2CV
# NxpqumzTCNSOxm+SAWSuIr21Qomb+zzQWKhxKTVVgtmUPAW35xUUFREmDrMxSNlr
# /NsJyUXzdtFUUt4aS4CEeIY8y9IaaGBpPNXKFifinT7zL2gdFpBP9qh8SdLnEut/
# GcalNeJQ55IuwnKCgs+nrpuQNfVmUB5KlCX3ZA4x5HHKS+rqBvKWxdCyQEEGcbLe
# 1b8Aw4wJkhU1JrPsFfxW1gaou30yZ46t4Y9F20HHfIY4/6vHespYMQmUiote8lad
# jS/nJ0+k6MvqzfpzPDOy5y6gqztiT96Fv/9bH7mQyogxG9QEPHrPV6/7umw052Ak
# yiLA6tQbZl1KhBtTasySkuJDpsZGKdlsjg4u70EwgWbVRSX1Wd4+zoFpp4Ra+MlK
# M2baoD6x0VR4RjSpWM8o5a6D8bpfm4CLKczsG7ZrIGNTAgMBAAGjggFdMIIBWTAS
# BgNVHRMBAf8ECDAGAQH/AgEAMB0GA1UdDgQWBBTvb1NK6eQGfHrK4pBW9i/USezL
# TjAfBgNVHSMEGDAWgBTs1+OC0nFdZEzfLmc/57qYrhwPTzAOBgNVHQ8BAf8EBAMC
# AYYwEwYDVR0lBAwwCgYIKwYBBQUHAwgwdwYIKwYBBQUHAQEEazBpMCQGCCsGAQUF
# BzABhhhodHRwOi8vb2NzcC5kaWdpY2VydC5jb20wQQYIKwYBBQUHMAKGNWh0dHA6
# Ly9jYWNlcnRzLmRpZ2ljZXJ0LmNvbS9EaWdpQ2VydFRydXN0ZWRSb290RzQuY3J0
# MEMGA1UdHwQ8MDowOKA2oDSGMmh0dHA6Ly9jcmwzLmRpZ2ljZXJ0LmNvbS9EaWdp
# Q2VydFRydXN0ZWRSb290RzQuY3JsMCAGA1UdIAQZMBcwCAYGZ4EMAQQCMAsGCWCG
# SAGG/WwHATANBgkqhkiG9w0BAQsFAAOCAgEAF877FoAc/gc9EXZxML2+C8i1NKZ/
# zdCHxYgaMH9Pw5tcBnPw6O6FTGNpoV2V4wzSUGvI9NAzaoQk97frPBtIj+ZLzdp+
# yXdhOP4hCFATuNT+ReOPK0mCefSG+tXqGpYZ3essBS3q8nL2UwM+NMvEuBd/2vmd
# YxDCvwzJv2sRUoKEfJ+nN57mQfQXwcAEGCvRR2qKtntujB71WPYAgwPyWLKu6Rna
# ID/B0ba2H3LUiwDRAXx1Neq9ydOal95CHfmTnM4I+ZI2rVQfjXQA1WSjjf4J2a7j
# LzWGNqNX+DF0SQzHU0pTi4dBwp9nEC8EAqoxW6q17r0z0noDjs6+BFo+z7bKSBwZ
# XTRNivYuve3L2oiKNqetRHdqfMTCW/NmKLJ9M+MtucVGyOxiDf06VXxyKkOirv6o
# 02OoXN4bFzK0vlNMsvhlqgF2puE6FndlENSmE+9JGYxOGLS/D284NHNboDGcmWXf
# wXRy4kbu4QFhOm0xJuF2EZAOk5eCkhSxZON3rGlHqhpB/8MluDezooIs8CVnrpHM
# iD2wL40mm53+/j7tFaxYKIqL0Q4ssd8xHZnIn/7GELH3IdvG2XlM9q7WP/UwgOkw
# /HQtyRN62JK4S1C8uw3PdBunvAZapsiI5YKdvlarEvf8EA+8hcpSM9LHJmyrxaFt
# oza2zNaQ9k+5t1wwggbtMIIE1aADAgECAhAKgO8YS43xBYLRxHanlXRoMA0GCSqG
# SIb3DQEBCwUAMGkxCzAJBgNVBAYTAlVTMRcwFQYDVQQKEw5EaWdpQ2VydCwgSW5j
# LjFBMD8GA1UEAxM4RGlnaUNlcnQgVHJ1c3RlZCBHNCBUaW1lU3RhbXBpbmcgUlNB
# NDA5NiBTSEEyNTYgMjAyNSBDQTEwHhcNMjUwNjA0MDAwMDAwWhcNMzYwOTAzMjM1
# OTU5WjBjMQswCQYDVQQGEwJVUzEXMBUGA1UEChMORGlnaUNlcnQsIEluYy4xOzA5
# BgNVBAMTMkRpZ2lDZXJ0IFNIQTI1NiBSU0E0MDk2IFRpbWVzdGFtcCBSZXNwb25k
# ZXIgMjAyNSAxMIICIjANBgkqhkiG9w0BAQEFAAOCAg8AMIICCgKCAgEA0EasLRLG
# ntDqrmBWsytXum9R/4ZwCgHfyjfMGUIwYzKomd8U1nH7C8Dr0cVMF3BsfAFI54um
# 8+dnxk36+jx0Tb+k+87H9WPxNyFPJIDZHhAqlUPt281mHrBbZHqRK71Em3/hCGC5
# KyyneqiZ7syvFXJ9A72wzHpkBaMUNg7MOLxI6E9RaUueHTQKWXymOtRwJXcrcTTP
# PT2V1D/+cFllESviH8YjoPFvZSjKs3SKO1QNUdFd2adw44wDcKgH+JRJE5Qg0NP3
# yiSyi5MxgU6cehGHr7zou1znOM8odbkqoK+lJ25LCHBSai25CFyD23DZgPfDrJJJ
# K77epTwMP6eKA0kWa3osAe8fcpK40uhktzUd/Yk0xUvhDU6lvJukx7jphx40DQt8
# 2yepyekl4i0r8OEps/FNO4ahfvAk12hE5FVs9HVVWcO5J4dVmVzix4A77p3awLbr
# 89A90/nWGjXMGn7FQhmSlIUDy9Z2hSgctaepZTd0ILIUbWuhKuAeNIeWrzHKYueM
# JtItnj2Q+aTyLLKLM0MheP/9w6CtjuuVHJOVoIJ/DtpJRE7Ce7vMRHoRon4CWIvu
# iNN1Lk9Y+xZ66lazs2kKFSTnnkrT3pXWETTJkhd76CIDBbTRofOsNyEhzZtCGmnQ
# igpFHti58CSmvEyJcAlDVcKacJ+A9/z7eacCAwEAAaOCAZUwggGRMAwGA1UdEwEB
# /wQCMAAwHQYDVR0OBBYEFOQ7/PIx7f391/ORcWMZUEPPYYzoMB8GA1UdIwQYMBaA
# FO9vU0rp5AZ8esrikFb2L9RJ7MtOMA4GA1UdDwEB/wQEAwIHgDAWBgNVHSUBAf8E
# DDAKBggrBgEFBQcDCDCBlQYIKwYBBQUHAQEEgYgwgYUwJAYIKwYBBQUHMAGGGGh0
# dHA6Ly9vY3NwLmRpZ2ljZXJ0LmNvbTBdBggrBgEFBQcwAoZRaHR0cDovL2NhY2Vy
# dHMuZGlnaWNlcnQuY29tL0RpZ2lDZXJ0VHJ1c3RlZEc0VGltZVN0YW1waW5nUlNB
# NDA5NlNIQTI1NjIwMjVDQTEuY3J0MF8GA1UdHwRYMFYwVKBSoFCGTmh0dHA6Ly9j
# cmwzLmRpZ2ljZXJ0LmNvbS9EaWdpQ2VydFRydXN0ZWRHNFRpbWVTdGFtcGluZ1JT
# QTQwOTZTSEEyNTYyMDI1Q0ExLmNybDAgBgNVHSAEGTAXMAgGBmeBDAEEAjALBglg
# hkgBhv1sBwEwDQYJKoZIhvcNAQELBQADggIBAGUqrfEcJwS5rmBB7NEIRJ5jQHIh
# +OT2Ik/bNYulCrVvhREafBYF0RkP2AGr181o2YWPoSHz9iZEN/FPsLSTwVQWo2H6
# 2yGBvg7ouCODwrx6ULj6hYKqdT8wv2UV+Kbz/3ImZlJ7YXwBD9R0oU62PtgxOao8
# 72bOySCILdBghQ/ZLcdC8cbUUO75ZSpbh1oipOhcUT8lD8QAGB9lctZTTOJM3pHf
# KBAEcxQFoHlt2s9sXoxFizTeHihsQyfFg5fxUFEp7W42fNBVN4ueLaceRf9Cq9ec
# 1v5iQMWTFQa0xNqItH3CPFTG7aEQJmmrJTV3Qhtfparz+BW60OiMEgV5GWoBy4RV
# PRwqxv7Mk0Sy4QHs7v9y69NBqycz0BZwhB9WOfOu/CIJnzkQTwtSSpGGhLdjnQ4e
# BpjtP+XB3pQCtv4E5UCSDag6+iX8MmB10nfldPF9SVD7weCC3yXZi/uuhqdwkgVx
# uiMFzGVFwYbQsiGnoa9F5AaAyBjFBtXVLcKtapnMG3VH3EmAp/jsJ3FVF3+d1SVD
# TmjFjLbNFZUWMXuZyvgLfgyPehwJVxwC+UpX2MSey2ueIu9THFVkT+um1vshETaW
# yQo8gmBto/m3acaP9QsuLj3FNwFlTxq25+T4QwX9xa6ILs84ZPvmpovq90K8eWyG
# 2N01c4IhSOxqt81nMYIFmjCCBZYCAQEwPjAqMSgwJgYDVQQDDB9WSVNJT05QT1Mg
# SW50ZXJuYWwgQ29kZSBTaWduaW5nAhA7aHya5dJfoEBns8IqG+zYMA0GCWCGSAFl
# AwQCAQUAoIGEMBgGCisGAQQBgjcCAQwxCjAIoAKAAKECgAAwGQYJKoZIhvcNAQkD
# MQwGCisGAQQBgjcCAQQwHAYKKwYBBAGCNwIBCzEOMAwGCisGAQQBgjcCARUwLwYJ
# KoZIhvcNAQkEMSIEIGPwlyIxIZCNjYUaM+vFxqzSblQOpmCIGeJ3/HfeiJ4KMA0G
# CSqGSIb3DQEBAQUABIIBgHuT6OrokKxRxTP5HTk3iEgb6VMS/jexObsqeVz4jOL8
# mN7Ph3x/lWL9y2TGPdirLSYplXcL2jfQFeTfwwHcwo3qYAEILZ+0DX7U6SKGp1nZ
# lwHrnSQG5PMy6zpFM28L25VWxeIlDFpjVNusPuXkNVqBSiQPLIF3a1fT1pYZ3Jgx
# C6Ar8ADXYwXlxkCU1hwORNypxWTWvIlOw5w7N9gzIjWVsn9dRk0nk5fnnCyessER
# dtxAe7OUi+Dkn+YbN0NDhZkrl5W0tt62VHm+1y4dR8cHd8nfsZK1FcKU0vxRTwWM
# P+NbgRhptLTDuvYg8rG7zGGwgtK0M7+BQhT1SvBemc4E1nFzuiyIF2OvJ94WVRGM
# EqqRd/S0x7SaWieCLhpK968xlY9wpuuv1JzfvRDTIiUfg0Rb8m1L4vLhvFM6llea
# 2hzltHodUplMYvS3A1iTIeYgruoy1VmYFiOgmVaBOpQ2mI9h+v8G+M5ZkNPpDgBx
# tvdJEW9TumKefb15+72QM6GCAyYwggMiBgkqhkiG9w0BCQYxggMTMIIDDwIBATB9
# MGkxCzAJBgNVBAYTAlVTMRcwFQYDVQQKEw5EaWdpQ2VydCwgSW5jLjFBMD8GA1UE
# AxM4RGlnaUNlcnQgVHJ1c3RlZCBHNCBUaW1lU3RhbXBpbmcgUlNBNDA5NiBTSEEy
# NTYgMjAyNSBDQTECEAqA7xhLjfEFgtHEdqeVdGgwDQYJYIZIAWUDBAIBBQCgaTAY
# BgkqhkiG9w0BCQMxCwYJKoZIhvcNAQcBMBwGCSqGSIb3DQEJBTEPFw0yNjA3Mjgx
# NDU5MjRaMC8GCSqGSIb3DQEJBDEiBCAYbUPRZmtbNxpWbFLDYBccSABh7stgly/F
# TD9WSwn8+jANBgkqhkiG9w0BAQEFAASCAgDGOM7Akksaj2fuwOhMRtlEb/VNclY1
# albRuxf9MQB0aRzCO4hsf/9J9JBzE4bUPEi2cQt9vg8wN9OX5L5gAkaFgjqEeGYW
# tahklD2+yk1XYREFu6ECjYIJldyruvX+Q5nWe7k0QVGGQ+rvV1faCwqnPwAF4VNU
# vaDMIo0ExYr4T2lWESsxxfR4Tu4dCdZp9ntTQmnQ5wlyXV/JgZ2rBSJEnPzzAVfV
# FH97FWryc4/Xhoehwh+A4Czv1DunofzbGQuGHKbhjcHlvQOJrE8+zX5gK5i7Cpnh
# tcqvM2YG+H5vxS/3BnIIn/x6LlbXuaq0VWt8Yr/C3WT49ce5EjVNTsCAhF/lCMyx
# J+ieq5p5ocMtduDtAMuFqwNbm1u4RgGeJYuu+DIiN4MIeQ/hb1Byb0Rt9Rq5zS53
# zLP+QcKxnw41Alj2xucJtUDsQ2RCVyXFFX3pZAfPCBpjtQHx8JNbp4/ncOxCLzHp
# Sr4eJdg0G2JpRteWtTJARAl4x4xPqgpQ50w1855u9Ba7k0kgNhjKln6f9nxSvODo
# Hew1vfa1Ck3h7vtjUYa3/RSoMiIWQ6MysMIK3bnRfNTr8uYnAkRXiUq/60AiPv+4
# pmrkl6e1ijhp+FDt0QrYgQRpzAfv7/ThSt07/Q0zqMYwUgD1mhqDKjMu004gTXwi
# h4UieX66AvNRsw==
# SIG # End signature block
