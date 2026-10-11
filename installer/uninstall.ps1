<#
Removes a manual OpenFill install: deletes the plugin folder and its PS.json entry (PS.json backed up first).

Usage:  powershell -ExecutionPolicy Bypass -File uninstall.ps1 [-Id <plugin id>] [-AppDataRoot <path>]
#>
param(
  [string]$Id = "io.github.damanjz.openfill",
  [string]$AppDataRoot = $env:APPDATA
)

$ErrorActionPreference = "Stop"

if (Get-Process -Name "Photoshop" -ErrorAction SilentlyContinue) {
  Write-Host "Photoshop is running. Close it first, then run this again." -ForegroundColor Yellow
  exit 2
}

$uxp = Join-Path $AppDataRoot "Adobe\UXP"
$dest = Join-Path $uxp "Plugins\External\$Id"
$infoPath = Join-Path $uxp "PluginsInfo\v1\PS.json"

if (Test-Path $dest) { Remove-Item $dest -Recurse -Force; Write-Host "Removed $dest" }

if (Test-Path $infoPath) {
  $info = Get-Content $infoPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $kept = @(@($info.plugins) | Where-Object { $_ -and $_.pluginId -ne $Id })
  if ($kept.Count -ne @($info.plugins).Count) {
    $stamp = Get-Date -Format "yyyyMMdd-HHmmss-fff"
    Copy-Item $infoPath "$infoPath.openfill-backup-$stamp"
    $info.plugins = $kept
    [System.IO.File]::WriteAllText($infoPath, (ConvertTo-Json -InputObject $info -Depth 20), (New-Object System.Text.UTF8Encoding($false)))
    Write-Host "Removed OpenFill from PS.json"
  }
}
Write-Host "OpenFill uninstalled." -ForegroundColor Green
