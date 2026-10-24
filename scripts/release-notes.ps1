# LingoPick — generate the GitHub Release body.
#
# The body comes from the matching version section of CHANGELOG.md (Keep a
# Changelog format). When that section is missing, commits since the previous
# tag are grouped by conventional-commit type instead, so a release never ends
# up as a bare "Full Changelog" link.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/release-notes.ps1 -Version 0.1.0
#   powershell ... -File scripts/release-notes.ps1 -Version 0.1.0 -OutputPath dist/RELEASE_NOTES.md
#
# Exit code is 0 when notes were generated. CHANGELOG.md takes precedence; git
# fallback only matters when the changelog was not prepared for this version.

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Version,
    [string]$OutputPath,
    [string]$ChangelogPath
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$RepoRoot = [System.IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
if (-not $ChangelogPath) {
    $ChangelogPath = Join-Path $RepoRoot 'CHANGELOG.md'
}

function Fail([string]$Message) {
    Write-Host "[FAIL] $Message" -ForegroundColor Red
    exit 1
}

function Write-Warn([string]$Message) {
    Write-Host "[warn] $Message" -ForegroundColor Yellow
}

# Runs git without letting expected failures (missing tag, no previous tag)
# become terminating errors under the script-wide Stop preference.
function Invoke-Git {
    param([string[]]$Arguments)
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $output = & git @Arguments 2>$null
        return [pscustomobject]@{
            Output   = @($output)
            ExitCode = $LASTEXITCODE
        }
    } finally {
        $ErrorActionPreference = $previous
    }
}

# Keep-a-Changelog headings are English by convention; releases are Chinese.
function Convert-Heading([string]$Heading) {
    $map = @{
        'added'      = '新增'
        'changed'    = '变更'
        'fixed'      = '修复'
        'removed'    = '移除'
        'deprecated' = '弃用'
        'security'   = '安全'
    }
    $key = $Heading.Trim().ToLowerInvariant()
    if ($map.ContainsKey($key)) {
        return $map[$key]
    }
    return $Heading.Trim()
}

function Get-ChangelogSection([string]$ChangelogText, [string]$ReleaseVersion) {
    $escaped = [regex]::Escape($ReleaseVersion)
    $pattern = "(?ms)^##\s+\[?$escaped\]?[^\r\n]*\r?\n(.*?)(?=^##\s+|\z)"
    $match = [regex]::Match($ChangelogText, $pattern)
    if (-not $match.Success) {
        return $null
    }
    $body = $match.Groups[1].Value.Trim()
    if ([string]::IsNullOrWhiteSpace($body)) {
        return $null
    }
    # Localize Keep-a-Changelog subsection headings while keeping bullets.
    $converted = foreach ($line in ($body -split "`r?`n")) {
        if ($line -match '^###\s+(.+?)\s*$') {
            '### ' + (Convert-Heading $Matches[1])
        } else {
            $line
        }
    }
    return (($converted -join "`n").Trim())
}

# Fallback for a version that has no CHANGELOG section yet: group commits by
# conventional-commit type. Never returns a link-only body.
function Get-GitReleaseNotes([string]$Root, [string]$ReleaseVersion) {
    Push-Location $Root
    try {
        $tag = "v$ReleaseVersion"
        $previous = $null
        $describe = Invoke-Git @('describe', '--tags', '--abbrev=0', '--match', 'v*', '--exclude', $tag)
        if ($describe.ExitCode -eq 0 -and $describe.Output.Count -gt 0) {
            $candidate = ([string]$describe.Output[0]).Trim()
            if (-not [string]::IsNullOrWhiteSpace($candidate)) {
                $previous = $candidate
            }
        }
        $range = 'HEAD'
        if ($previous) {
            $range = "$previous..HEAD"
        }
        $logResult = Invoke-Git @('log', $range, '--no-merges', '--pretty=format:%h%x09%s')
        if ($logResult.ExitCode -ne 0) {
            return $null
        }
        $log = $logResult.Output

        $order = @('feat', 'fix', 'perf', 'refactor', 'docs', 'build', 'ci', 'test', 'chore', 'style', 'revert')
        $labels = @{
            'feat'     = '新功能'
            'fix'      = '修复'
            'perf'     = '性能'
            'refactor' = '重构'
            'docs'     = '文档'
            'build'    = '构建与发布'
            'ci'       = '构建与发布'
            'test'     = '测试'
            'chore'    = '其他'
            'style'    = '其他'
            'revert'   = '回滚'
        }
        $groups = @{}
        foreach ($key in $order) {
            $groups[$key] = New-Object System.Collections.ArrayList
        }
        $other = New-Object System.Collections.ArrayList

        foreach ($line in $log) {
            if ([string]::IsNullOrWhiteSpace($line)) {
                continue
            }
            $parts = $line -split "`t", 2
            if ($parts.Count -lt 2) {
                continue
            }
            $commitSha = $parts[0]
            $subject = $parts[1]
            $type = 'other'
            $display = $subject
            if ($subject -match '^(?<type>[A-Za-z]+)(\([^)]*\))?!?:\s*(?<subject>.+)$') {
                $matchedType = $Matches['type'].ToLowerInvariant()
                if ($order -contains $matchedType) {
                    $type = $matchedType
                    $display = $Matches['subject']
                }
            }
            $bullet = '- ' + $display + ' (' + $commitSha + ')'
            if ($type -eq 'other') {
                [void]$other.Add($bullet)
            } else {
                [void]$groups[$type].Add($bullet)
            }
        }

        $lines = New-Object System.Collections.ArrayList
        foreach ($key in $order) {
            if ($groups[$key].Count -eq 0) {
                continue
            }
            [void]$lines.Add('')
            [void]$lines.Add('### ' + $labels[$key])
            [void]$lines.Add('')
            foreach ($item in $groups[$key]) {
                [void]$lines.Add($item)
            }
        }
        if ($other.Count -gt 0) {
            [void]$lines.Add('')
            [void]$lines.Add('### 其他')
            [void]$lines.Add('')
            foreach ($item in $other) {
                [void]$lines.Add($item)
            }
        }
        if ($lines.Count -eq 0) {
            return $null
        }
        return (($lines -join "`n").Trim())
    } finally {
        Pop-Location
    }
}

# --- resolve version / date --------------------------------------------------
$cleanVersion = $Version.Trim()
if ($cleanVersion -match '^[vV]') {
    $cleanVersion = $cleanVersion.Substring(1)
}
if ([string]::IsNullOrWhiteSpace($cleanVersion)) {
    Fail '版本号为空，无法生成 release notes'
}

$releaseDate = Get-Date -Format 'yyyy-MM-dd'
$tagRef = "refs/tags/v$cleanVersion"
$tagDate = Invoke-Git @('-C', $RepoRoot, 'log', '-1', '--format=%ad', '--date=short', $tagRef)
if ($tagDate.ExitCode -eq 0 -and $tagDate.Output.Count -gt 0) {
    $value = ([string]$tagDate.Output[0]).Trim()
    if (-not [string]::IsNullOrWhiteSpace($value)) {
        $releaseDate = $value
    }
}

# --- changelog section -------------------------------------------------------
$section = $null
$source = 'CHANGELOG.md'
if (Test-Path $ChangelogPath) {
    $changelogText = [System.IO.File]::ReadAllText($ChangelogPath, [System.Text.Encoding]::UTF8)
    $section = Get-ChangelogSection $changelogText $cleanVersion
}
if (-not $section) {
    Write-Warn "CHANGELOG.md 缺少 [$cleanVersion] 小节，改用上个 tag 以来的提交记录生成。"
    $source = 'git commits'
    $section = Get-GitReleaseNotes $RepoRoot $cleanVersion
}
if (-not $section) {
    Fail "无法为 $cleanVersion 生成 release notes：请先在 CHANGELOG.md 添加 [$cleanVersion] 小节（格式见 Keep a Changelog）。"
}

# --- body --------------------------------------------------------------------
$lines = New-Object System.Collections.ArrayList
[void]$lines.Add("# LingoPick $cleanVersion")
[void]$lines.Add('')
[void]$lines.Add("_发布日期：${releaseDate}_")
[void]$lines.Add('')
[void]$lines.Add('免安装单文件：下载 `LingoPick-' + $cleanVersion + '-win-x64.exe` 后双击即可使用。程序静默驻留系统托盘，通过托盘菜单打开设置。')
[void]$lines.Add('')
[void]$lines.Add('## 本次更新')
[void]$lines.Add('')
[void]$lines.Add($section)
[void]$lines.Add('')

$body = ($lines -join "`n").TrimEnd() + "`n"

if ($OutputPath) {
    if (-not [System.IO.Path]::IsPathRooted($OutputPath)) {
        $OutputPath = Join-Path $RepoRoot $OutputPath
    }
    $parent = Split-Path -Parent $OutputPath
    if ($parent -and -not (Test-Path $parent)) {
        New-Item -ItemType Directory -Force -Path $parent | Out-Null
    }
    [System.IO.File]::WriteAllText($OutputPath, $body, (New-Object System.Text.UTF8Encoding($false)))
    Write-Host "[OK] release notes ($source) -> $OutputPath" -ForegroundColor Green
} else {
    Write-Output $body
}
