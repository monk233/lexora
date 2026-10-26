param(
  [string]$AppExe = "E:\document\workspace\AIProjects\lingopick\src-tauri\target\debug\lexora.exe",
  [int]$CdpPort = 9353,
  [int]$MockPort = 8799
)

# Verifies the OpenCode Go provider preset end to end:
#  * UI offers the preset (label/baseUrl/modelsBaseUrl present);
#  * requests carry the required x-opencode-session header and an own User-Agent;
#  * the model list is fetched from the separate /go/v1 models base.
$ErrorActionPreference = "Continue"
$root = "E:\document\workspace\AIProjects\lingopick"
$dataDir = Join-Path $root ".e2e-oc-data"
$logFile = Join-Path $root ".e2e-oc-requests.json"
$results = [ordered]@{}

function Cdp($targetMatch, $expression) {
  $output = & node (Join-Path $root "tests\cdp-eval.mjs") $CdpPort $targetMatch $expression 2>&1
  return ($output | Select-Object -Last 1)
}

Get-Process lexora -ErrorAction SilentlyContinue | Stop-Process -Force
Remove-Item $dataDir -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item $logFile -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path (Join-Path $dataDir "logs"), (Join-Path $dataDir "models") -Force | Out-Null
$settings = @'
{"version":1,"picker":{"enabled":true,"skills":["translate","summarize","explain","read","copy","screenshot"],"compact":false,"defaultTargetLang":"auto","blacklist":[],"maxChars":5000},"provider":{"mode":"online","online":{"preset":"opencode-go","baseUrl":"http://127.0.0.1:8799/v1","modelsBaseUrl":"http://127.0.0.1:8799/mbase","apiKey":"mock-key","model":"kimi-k3","timeoutMs":8000,"temperature":0.2,"maxTokens":512},"local":{"contextSize":4096,"threads":0,"gpuLayers":0,"autoStart":false}},"app":{"closeToTray":true,"startAtLogin":false,"theme":"light"}}
'@
[System.IO.File]::WriteAllText((Join-Path $dataDir "settings.json"), $settings, [System.Text.UTF8Encoding]::new($false))

$mock = Start-Process -FilePath "node" -ArgumentList @(
  (Join-Path $root "tests\oc-mock-server.mjs"), "$MockPort", $logFile
) -PassThru -WindowStyle Hidden
Start-Sleep -Milliseconds 800

$env:LEXORA_DATA_DIR = $dataDir
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$CdpPort"
$app = Start-Process -FilePath $AppExe -PassThru -WorkingDirectory $root
Start-Sleep -Seconds 4

$presets = Cdp "tauri\.localhost/$" "(() => { const p = window.LP && window.LP.presetFor ? window.LP.presetFor('opencode-go') : null; return p ? {id:p.id,label:p.label,baseUrl:p.baseUrl,modelsBaseUrl:p.modelsBaseUrl} : null; })()"
"PRESET=$presets"
$presetObj = $null
try { $presetObj = $presets | ConvertFrom-Json } catch { }
$results.PresetPresent = ($presetObj -and $presetObj.id -eq "opencode-go" -and $presetObj.modelsBaseUrl -eq "https://opencode.ai/inference/go/v1")

$test = Cdp "tauri\.localhost/$" "window.__TAURI__.core.invoke('test_online', {baseUrl: 'http://127.0.0.1:$MockPort/v1', apiKey: 'mock-key', model: 'kimi-k3', timeoutMs: 8000}).then(r => JSON.stringify(r))"
"TEST_ONLINE=$test"
Start-Sleep -Milliseconds 800

$requests = @()
if (Test-Path $logFile) {
  $requests = Get-Content $logFile -Raw -Encoding UTF8 | ConvertFrom-Json
}
"REQUESTS=" + (($requests | ForEach-Object { "$($_.method) $($_.url)" }) -join " | ")
$chat = $requests | Where-Object { $_.url -like "*/chat/completions" } | Select-Object -First 1
$models = $requests | Where-Object { $_.url -like "*/models" } | Select-Object -First 1
$sessionOk = $chat -and $chat.headers.'x-opencode-session' -like "lexora-*"
$uaOk = $chat -and $chat.headers.'user-agent' -like "Lexora/*"
$authOk = $chat -and $chat.headers.authorization -eq "Bearer mock-key"
$modelsPathOk = $models -and ($models.url -eq "/mbase/models")
$results.SessionHeader = [bool]$sessionOk
$results.UserAgent = [bool]$uaOk
$results.Authorization = [bool]$authOk
$results.ModelsBaseUrl = [bool]$modelsPathOk
$results.Ok = ($results.PresetPresent -and $sessionOk -and $uaOk -and $authOk -and $modelsPathOk)
"OPENCODE_GO_HEADERS_OK=$($results.Ok)"
$results | ConvertTo-Json -Depth 4

& taskkill /PID $app.Id /T /F 2>$null | Out-Null
Get-Process lexora -ErrorAction SilentlyContinue | Stop-Process -Force
Stop-Process -Id $mock.Id -Force -ErrorAction SilentlyContinue
Remove-Item $dataDir -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item $logFile -Force -ErrorAction SilentlyContinue
