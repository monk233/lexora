# Lexora — download the llama.cpp engine used for local mode.
#
# The app expects the *contents* of the archive (llama-server.exe and its DLLs)
# flattened into the engine directory, i.e.:
#     <data>/engine/llama-server.exe
#     <data>/engine/ggml-*.dll ...
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/fetch-llama.ps1
#   powershell ... -File scripts/fetch-llama.ps1 -Dest D:\somewhere\engine
#   powershell ... -File scripts/fetch-llama.ps1 -FromDir ..\enterprise-ai-translator\vendor\llama
#   powershell ... -File scripts/fetch-llama.ps1 -Url https://.../llama-xxx.zip
#
# Parameters:
#   -Dest     Target engine directory (default: <repo>/data/engine).
#   -Url      Archive URL (default: pinned llama.cpp Windows CPU x64 release,
#             overridable with the LEXORA_LLAMA_URL environment variable).
#   -FromDir  Copy a local llama.cpp directory instead of downloading.
#
# Exit code 0 on success, 1 on failure (with manual placement instructions).

[CmdletBinding()]
param(
    [string]$Dest,
    [string]$Url,
    [string]$FromDir
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$RepoRoot = Split-Path -Parent $PSScriptRoot

if (-not $Dest) {
    $Dest = Join-Path $RepoRoot 'data\engine'
}
if (-not $Url) {
    if ($env:LEXORA_LLAMA_URL) {
        $Url = $env:LEXORA_LLAMA_URL
    } else {
        $Url = 'https://github.com/ggml-org/llama.cpp/releases/download/b11851/llama-b11851-bin-win-cpu-x64.zip'
    }
}
if ($FromDir) {
    $FromDir = [System.IO.Path]::GetFullPath($FromDir)
}

function Write-Step([string]$Message) {
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Write-Ok([string]$Message) {
    Write-Host "[OK] $Message" -ForegroundColor Green
}

function Fail([string]$Message) {
    Write-Host "[FAIL] $Message" -ForegroundColor Red
    Write-Host ''
    Write-Host '手动放置方法：' -ForegroundColor Yellow
    Write-Host '  1. 从 https://github.com/ggml-org/llama.cpp/releases 下载 Windows CPU x64 的 zip；'
    Write-Host '  2. 解压后找到包含 llama-server.exe 的目录；'
    Write-Host "  3. 把该目录内的全部文件（含 DLL）复制到：$Dest"
    Write-Host '  4. 确认存在 llama-server.exe 后重新启动 Lexora。'
    exit 1
}

function Test-EngineDir([string]$Directory) {
    return (Test-Path (Join-Path $Directory 'llama-server.exe') -PathType Leaf)
}

function Find-ServerDirectory([string]$Root) {
    $server = Get-ChildItem -Path $Root -Recurse -File -Filter 'llama-server.exe' -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($server) {
        return $server.Directory
    }
    return $null
}

function Install-FromDirectory([string]$SourceDirectory) {
    $SourceDirectory = [System.IO.Path]::GetFullPath($SourceDirectory)
    if (-not (Test-EngineDir $SourceDirectory)) {
        $nested = Find-ServerDirectory $SourceDirectory
        if (-not $nested) {
            Fail "目录中没有找到 llama-server.exe：$SourceDirectory"
        }
        $SourceDirectory = $nested.FullName
    }

    New-Item -ItemType Directory -Force -Path $Dest | Out-Null
    Write-Step "复制引擎文件：$SourceDirectory -> $Dest"
    Copy-Item -Path (Join-Path $SourceDirectory '*') -Destination $Dest -Recurse -Force
}

Write-Host "Lexora fetch-llama: dest=$Dest" -ForegroundColor DarkGray

if (Test-EngineDir $Dest) {
    Write-Ok "引擎已存在，跳过：$Dest"
    exit 0
}

if ($FromDir) {
    Write-Step "使用本地目录：$FromDir"
    if (-not (Test-Path $FromDir)) {
        Fail "指定的 -FromDir 不存在：$FromDir"
    }
    Install-FromDirectory $FromDir
} else {
    Write-Step "下载 llama.cpp 引擎：$Url"
    $TempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("lexora-engine-" + [guid]::NewGuid().ToString('N'))
    $ZipPath = Join-Path $TempRoot 'llama.zip'
    $ExtractDir = Join-Path $TempRoot 'extract'
    New-Item -ItemType Directory -Force -Path $TempRoot | Out-Null

    try {
        try {
            [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
        } catch {
            # .NET (Core) based PowerShell: TLS 1.2 is enabled by default.
        }

        $downloaded = $false
        for ($attempt = 1; $attempt -le 3 -and -not $downloaded; $attempt++) {
            try {
                Write-Step "下载（第 $attempt/3 次尝试）…"
                Invoke-WebRequest -Uri $Url -OutFile $ZipPath -UseBasicParsing
                $downloaded = $true
            } catch {
                Write-Warning "Invoke-WebRequest 失败：$($_.Exception.Message)"
                if (Get-Command curl.exe -ErrorAction SilentlyContinue) {
                    try {
                        & curl.exe -L --fail --retry 2 -o $ZipPath $Url
                        if ($LASTEXITCODE -eq 0) {
                            $downloaded = $true
                        }
                    } catch {
                        Write-Warning "curl 下载失败：$($_.Exception.Message)"
                    }
                }
                if (-not $downloaded) {
                    Start-Sleep -Seconds (2 * $attempt)
                }
            }
        }
        if (-not $downloaded -or -not (Test-Path $ZipPath)) {
            Fail '下载失败：请检查网络或代理，然后重试；也可以使用 -FromDir 指定本机现成的 llama.cpp 目录。'
        }

        $zipSize = (Get-Item $ZipPath).Length
        if ($zipSize -lt 1MB) {
            Fail "下载的文件过小（$zipSize 字节），可能不是有效的 zip。"
        }
        Write-Ok ("下载完成：{0:N1} MB" -f ($zipSize / 1MB))

        Write-Step '解压到临时目录…'
        Expand-Archive -Path $ZipPath -DestinationPath $ExtractDir -Force

        $serverDir = Find-ServerDirectory $ExtractDir
        if (-not $serverDir) {
            Fail '解压后没有找到 llama-server.exe，压缩包结构可能已变化。'
        }
        Install-FromDirectory $serverDir.FullName
    } finally {
        if (Test-Path $TempRoot) {
            Remove-Item -Path $TempRoot -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}

if (-not (Test-EngineDir $Dest)) {
    Fail "安装后仍未找到 $Dest\llama-server.exe"
}

$files = Get-ChildItem -Path $Dest -File | Measure-Object
Write-Ok "引擎已就绪：$Dest（$($files.Count) 个文件）"
exit 0
