# Lexora — build the portable single-file Windows executable.
#
# Steps:
#   1. npm install / npm ci when node_modules is missing;
#   2. npx tauri build --no-bundle  (release, single exe, no installer);
#   3. copy src-tauri\target\release\lexora.exe to
#      dist\Lexora-<version>-win-x64.exe.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-portable.ps1
#   powershell ... -File scripts/build-portable.ps1 -SkipBuild   # reuse target\release
#
# Notes:
#   * The release asset is a single exe; nothing is zipped.
#   * WebView2 Runtime is a system dependency, it is NOT bundled.
#   * The portable data directory is <exe dir>\data (models/engine/logs/cache);
#     it is created on first launch.
#   * The llama.cpp engine and GGUF models are downloaded from inside the app,
#     so they cannot be embedded into the single exe.

[CmdletBinding()]
param(
    [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$RepoRoot = [System.IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$TauriDir = Join-Path $RepoRoot 'src-tauri'
$DistDir = Join-Path $RepoRoot 'dist'

function Write-Step([string]$Message) {
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Write-Ok([string]$Message) {
    Write-Host "[OK] $Message" -ForegroundColor Green
}

function Fail([string]$Message) {
    Write-Host "[FAIL] $Message" -ForegroundColor Red
    exit 1
}

Set-Location $RepoRoot

# --- version ----------------------------------------------------------------
$confPath = Join-Path $TauriDir 'tauri.conf.json'
if (-not (Test-Path $confPath)) {
    Fail "找不到 $confPath"
}
$conf = Get-Content -Path $confPath -Raw -Encoding UTF8 | ConvertFrom-Json
$Version = [string]$conf.version
if (-not $Version) {
    Fail 'tauri.conf.json 中没有 version 字段'
}
Write-Host "Lexora portable exe $Version (repo: $RepoRoot)" -ForegroundColor DarkGray

# --- node dependencies ------------------------------------------------------
$cliPath = Join-Path $RepoRoot 'node_modules\@tauri-apps\cli'
if (-not (Test-Path $cliPath)) {
    Write-Step '安装前端构建依赖（@tauri-apps/cli）…'
    if (Get-Command npm -ErrorAction SilentlyContinue) {
        if (Test-Path (Join-Path $RepoRoot 'package-lock.json')) {
            & npm ci
        } else {
            & npm install
        }
        if ($LASTEXITCODE -ne 0) {
            Fail "npm 安装失败（exit code $LASTEXITCODE）"
        }
    } else {
        Fail '未找到 npm，请先安装 Node.js 20+。'
    }
} else {
    Write-Ok 'node_modules 已存在，跳过 npm install'
}

# --- release build ----------------------------------------------------------
if (-not $SkipBuild) {
    Write-Step '构建 release 可执行文件（npx tauri build --no-bundle）…'
    & npx tauri build --no-bundle
    if ($LASTEXITCODE -ne 0) {
        Fail "tauri build 失败（exit code $LASTEXITCODE）"
    }
} else {
    Write-Step '跳过构建（-SkipBuild），复用已有的 target\release 产物'
}

$sourceExe = Join-Path $TauriDir 'target\release\lexora.exe'
if (-not (Test-Path $sourceExe)) {
    # Be tolerant of an exe renamed after the product name.
    $alt = Join-Path $TauriDir 'target\release\Lexora.exe'
    if (Test-Path $alt) {
        $sourceExe = $alt
    } else {
        Fail "找不到 release 产物：$sourceExe"
    }
}
Write-Ok ("release exe: {0} ({1:N1} MB)" -f $sourceExe, ((Get-Item $sourceExe).Length / 1MB))

# --- publish the exe --------------------------------------------------------
New-Item -ItemType Directory -Force -Path $DistDir | Out-Null
$assetName = "Lexora-$Version-win-x64.exe"
$targetExe = Join-Path $DistDir $assetName
if (Test-Path $targetExe) {
    Remove-Item -Path $targetExe -Force
}
Copy-Item -Path $sourceExe -Destination $targetExe -Force
if (-not (Test-Path $targetExe)) {
    Fail '复制 exe 到 dist 失败'
}

# Drop leftovers of the old zip-based pipeline so dist\*.exe stays the only asset.
Get-ChildItem -Path $DistDir -Filter 'Lexora-*-win-x64.zip' -ErrorAction SilentlyContinue |
    Remove-Item -Force
$legacyStage = Join-Path $DistDir "Lexora-$Version-win-x64"
if (Test-Path $legacyStage -PathType Container) {
    Remove-Item -Path $legacyStage -Recurse -Force
}

$exeMb = (Get-Item $targetExe).Length / 1MB
Write-Ok ("已生成：{0} ({1:N1} MB)" -f $targetExe, $exeMb)
Write-Host ''
Write-Host '完成。发布这个单文件 exe 即可，用户双击运行，数据保存在 exe 同级的 data 目录。' -ForegroundColor Green
