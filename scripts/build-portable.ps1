# LingoPick — build a portable Windows zip.
#
# Steps:
#   1. npm install / npm ci when node_modules is missing;
#   2. npx tauri build --no-bundle  (release, single exe, no installer);
#   3. collect src-tauri\target\release\lingopick.exe;
#   4. write LingoPick-PORTABLE.txt (Chinese usage notes);
#   5. optionally bundle the llama.cpp engine (-WithEngine) into data\engine;
#   6. produce dist\LingoPick-<version>-win-x64.zip.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-portable.ps1
#   powershell ... -File scripts/build-portable.ps1 -WithEngine
#   powershell ... -File scripts/build-portable.ps1 -SkipBuild   # reuse target\release
#
# Notes:
#   * WebView2 Runtime is a system dependency, it is NOT bundled.
#   * The portable data directory is <exe dir>\data (models/engine/logs/cache).

[CmdletBinding()]
param(
    [switch]$WithEngine,
    [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$RepoRoot = [System.IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$TauriDir = Join-Path $RepoRoot 'src-tauri'
$DistDir = Join-Path $RepoRoot 'dist'
$ExeName = 'lingopick.exe'

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
Write-Host "LingoPick portable build $Version (repo: $RepoRoot)" -ForegroundColor DarkGray

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

$sourceExe = Join-Path $TauriDir "target\release\$ExeName"
if (-not (Test-Path $sourceExe)) {
    # Be tolerant of an exe renamed after the product name.
    $alt = Join-Path $TauriDir 'target\release\LingoPick.exe'
    if (Test-Path $alt) {
        $sourceExe = $alt
    } else {
        Fail "找不到 release 产物：$sourceExe"
    }
}
Write-Ok ("release exe: {0} ({1:N1} MB)" -f $sourceExe, ((Get-Item $sourceExe).Length / 1MB))

# --- staging ----------------------------------------------------------------
$StageName = "LingoPick-$Version-win-x64"
$StageDir = Join-Path $DistDir $StageName
if (Test-Path $StageDir) {
    Remove-Item -Path $StageDir -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $StageDir | Out-Null

Copy-Item -Path $sourceExe -Destination (Join-Path $StageDir 'LingoPick.exe') -Force
Write-Ok '已复制 LingoPick.exe'

# Optional engine: the app resolves <exe dir>\data\engine at runtime.
if ($WithEngine) {
    Write-Step '打包 llama.cpp 引擎到 data\engine …'
    $engineDest = Join-Path $StageDir 'data\engine'
    $engineTemp = Join-Path ([System.IO.Path]::GetTempPath()) ("lingopick-stage-engine-" + [guid]::NewGuid().ToString('N'))
    try {
        & (Join-Path $PSScriptRoot 'fetch-llama.ps1') -Dest $engineTemp
        if (-not (Test-Path (Join-Path $engineTemp 'llama-server.exe'))) {
            Fail '获取 llama.cpp 引擎失败，请先单独运行 scripts\fetch-llama.ps1 检查。'
        }
        New-Item -ItemType Directory -Force -Path $engineDest | Out-Null
        Copy-Item -Path (Join-Path $engineTemp '*') -Destination $engineDest -Recurse -Force
        Write-Ok "引擎已打包：data\engine（$(Get-ChildItem $engineDest -File | Measure-Object | Select-Object -ExpandProperty Count) 个文件）"
    } finally {
        if (Test-Path $engineTemp) {
            Remove-Item -Path $engineTemp -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
} else {
    Write-Host '未打包引擎（可在应用内「设置 → 本地模型 → 下载引擎」，或重建时加 -WithEngine）' -ForegroundColor DarkGray
}

# --- portable readme --------------------------------------------------------
$engineLine = if ($WithEngine) {
    '本地离线翻译：本包已附带 llama.cpp 引擎（data\engine）。只需在设置页下载或导入 GGUF 模型即可离线使用。'
} else {
    '本地离线翻译：首次使用请在「设置 → 本地模型」中点击「下载引擎」（约 23 MB），再下载或导入 GGUF 模型。'
}

$readme = @"
LingoPick $Version — Windows 便携版
=====================================

解压即用
--------
1. 把整个 LingoPick-$Version-win-x64 文件夹解压到任意可写目录（建议不要放在 Program Files）。
2. 双击 LingoPick.exe 启动；首次运行会打开设置窗口，之后关闭窗口即驻留系统托盘。
3. 在需要翻译的任意应用中用鼠标拖选文字，或按 Ctrl+Shift+D，即可弹出划词工具栏。
4. 双击托盘图标可再次打开设置；右键托盘图标有「启用划词 / 本地模型 / 退出」菜单。

数据位置
--------
- 所有数据保存在 exe 同级的 data 目录：settings.json、models\、engine\、logs\、cache\。
- 想彻底卸载：先退出程序，然后删除整个文件夹即可，不会写入注册表（开机自启除外）。
- 移动到别的目录后，请到「设置 → 应用与启动」重新开启一次开机自启。

系统要求
--------
- Windows 10 1809 及以上 / Windows 11（64 位）。
- 需要 Microsoft Edge WebView2 Runtime。Windows 11 与较新的 Windows 10 通常已自带；
  若启动时提示缺少 WebView2，请安装 Evergreen Runtime：
  https://developer.microsoft.com/microsoft-edge/webview2/
- 在线翻译需要可访问你配置的 OpenAI 兼容服务地址；API Key 只保存在本地设置文件中。

在线 / 本地翻译
---------------
- 在线：设置 → 翻译服务 → 在线 API，填写服务地址、API Key、模型名后点「测试连接」。
- $engineLine
- 本地模型需要 GGUF 格式文件（推荐 Qwen2.5 1.5B Instruct Q4_K_M），可在设置页直接下载，
  也可以从「导入 GGUF」选择本地文件。模型目录：data\models\。

常见问题
--------
- 托盘里找不到图标：点击任务栏右下角向上箭头，把 LingoPick 图标拖到任务栏常驻。
- 划词没有反应：确认「设置 → 划词行为 → 启用划词」已打开；某些以管理员权限运行的程序
  无法被普通权限进程读取选区，请以相同权限运行本程序。
- 本地模型启动失败：查看 data\logs\llama.log 与 data\logs\main.log。

许可证：MIT。项目主页：https://github.com/monk233/lingopick
"@

$txtPath = Join-Path $StageDir 'LingoPick-PORTABLE.txt'
$utf8Bom = New-Object System.Text.UTF8Encoding($true)
[System.IO.File]::WriteAllText($txtPath, $readme, $utf8Bom)
Write-Ok '已生成 LingoPick-PORTABLE.txt'

# --- zip --------------------------------------------------------------------
New-Item -ItemType Directory -Force -Path $DistDir | Out-Null
$zipPath = Join-Path $DistDir "LingoPick-$Version-win-x64.zip"
if (Test-Path $zipPath) {
    Remove-Item -Path $zipPath -Force
}

Write-Step "压缩 dist\$StageName …"
Compress-Archive -Path $StageDir -DestinationPath $zipPath -Force -CompressionLevel Optimal
if (-not (Test-Path $zipPath)) {
    Fail '打包 zip 失败'
}

$zipMb = (Get-Item $zipPath).Length / 1MB
Write-Ok ("已生成：{0} ({1:N1} MB)" -f $zipPath, $zipMb)
Write-Host ''
Write-Host '完成。把 zip 发给用户，解压后双击 LingoPick.exe 即可运行。' -ForegroundColor Green
