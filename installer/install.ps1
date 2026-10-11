<#
Installs OpenFill into Photoshop without the Creative Cloud app (per user, no admin needed).

  1. Copies the plugin to   %APPDATA%\Adobe\UXP\Plugins\External\<plugin id>
  2. Adds an entry to       %APPDATA%\Adobe\UXP\PluginsInfo\v1\PS.json  (backed up first, other plugins kept)

Usage:  powershell -ExecutionPolicy Bypass -File install.ps1 [-Source <plugin folder>] [-AppDataRoot <path>]
#>
param(
  [string]$Source = (Join-Path $PSScriptRoot "..\plugin"),
  [string]$AppDataRoot = $env:APPDATA
)

$ErrorActionPreference = "Stop"

function Write-Utf8NoBom([string]$Path, [string]$Text) {
  [System.IO.File]::WriteAllText($Path, $Text, (New-Object System.Text.UTF8Encoding($false)))
}

$Source = (Resolve-Path $Source).Path
$manifestPath = Join-Path $Source "manifest.json"
if (-not (Test-Path $manifestPath)) { throw "No manifest.json in $Source. Point -Source at the OpenFill plugin folder." }
$manifest = Get-Content $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$id = $manifest.id
$version = $manifest.version
$minPs = $manifest.host.minVersion

if (Get-Process -Name "Photoshop" -ErrorAction SilentlyContinue) {
  Write-Host "Photoshop is running. Close it before installing, then run this again." -ForegroundColor Yellow
  exit 2
}

$uxp = Join-Path $AppDataRoot "Adobe\UXP"
$dest = Join-Path $uxp "Plugins\External\$id"
$infoDir = Join-Path $uxp "PluginsInfo\v1"
$infoPath = Join-Path $infoDir "PS.json"

# 1. Copy plugin files (replace any older copy).
if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
New-Item -ItemType Directory -Force -Path $dest | Out-Null
Copy-Item -Path (Join-Path $Source "*") -Destination $dest -Recurse -Force

# 2. Register with Photoshop: merge into PS.json, never overwrite other plugins.
New-Item -ItemType Directory -Force -Path $infoDir | Out-Null
$plugins = New-Object System.Collections.ArrayList
$info = $null
if (Test-Path $infoPath) {
  $stamp = Get-Date -Format "yyyyMMdd-HHmmss-fff"
  Copy-Item $infoPath "$infoPath.openfill-backup-$stamp"
  $raw = Get-Content $infoPath -Raw -Encoding UTF8
  if ($raw -and $raw.Trim()) {
    $info = $raw | ConvertFrom-Json
    foreach ($p in @($info.plugins)) {
      if ($p -and $p.pluginId -ne $id) { [void]$plugins.Add($p) }
    }
  }
}
if (-not $info) { $info = New-Object PSObject }

$entry = [ordered]@{
  hostMinVersion = $minPs
  name           = $manifest.name
  # Backslashes: Photoshop 27.10 fails to load the plugin with "$localPlugins/External/..." (verified 2026-10-12).
  path           = "`$localPlugins\External\$id"
  pluginId       = $id
  status         = "enabled"
  type           = "uxp"
  versionString  = $version
}
[void]$plugins.Add([PSCustomObject]$entry)

if ($info.PSObject.Properties.Name -contains "plugins") { $info.plugins = $plugins.ToArray() }
else { $info | Add-Member -NotePropertyName plugins -NotePropertyValue $plugins.ToArray() }

Write-Utf8NoBom $infoPath (ConvertTo-Json -InputObject $info -Depth 20)

Write-Host "OpenFill $version installed to $dest" -ForegroundColor Green
Write-Host "Start Photoshop and open Plugins > OpenFill."
