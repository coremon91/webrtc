param(
  [string]$Domain = "kbcwebrtctest.gleeze.com",
  [string]$CaddyDataDir = "$env:APPDATA\Caddy"
)

$ErrorActionPreference = "Stop"
$certificateRoot = Join-Path $CaddyDataDir "certificates"
$certificate = Get-ChildItem -LiteralPath $certificateRoot -Recurse -File -Filter "$Domain.crt" |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1

if (-not $certificate) {
  throw "Caddy certificate not found for $Domain under $certificateRoot"
}

$privateKey = Join-Path $certificate.DirectoryName "$Domain.key"
if (-not (Test-Path -LiteralPath $privateKey)) {
  throw "Caddy private key not found: $privateKey"
}

$targetDir = Join-Path $PSScriptRoot "certs"
New-Item -ItemType Directory -Force -Path $targetDir | Out-Null
Copy-Item -LiteralPath $certificate.FullName -Destination (Join-Path $targetDir "fullchain.pem") -Force
Copy-Item -LiteralPath $privateKey -Destination (Join-Path $targetDir "privkey.pem") -Force

Write-Host "Coturn TLS files updated for $Domain"
