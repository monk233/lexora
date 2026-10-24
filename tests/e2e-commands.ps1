param(
  [int]$CdpPort = 9337
)

$ErrorActionPreference = "Continue"
$root = "E:\document\workspace\AIProjects\lingopick"
$exe = Join-Path $root "src-tauri\target\debug\lingopick.exe"
$dataDir = Join-Path $root ".e2e-commands-data"
$results = [ordered]@{}

Get-Process lingopick -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 400
if (Test-Path $dataDir) { Remove-Item $dataDir -Recurse -Force }
New-Item -ItemType Directory -Path (Join-Path $dataDir "logs"), (Join-Path $dataDir "models") -Force | Out-Null
$settings = @'
{"version":1,"picker":{"enabled":true,"shortcut":"Ctrl+Shift+D","skills":["translate","summarize","explain","read","copy"],"compact":false,"defaultTargetLang":"auto","blacklist":[],"maxChars":5000},"provider":{"mode":"online","online":{"preset":"custom","baseUrl":"http://127.0.0.1:8770/v1","apiKey":"test-key","model":"mock-qwen","timeoutMs":20000,"temperature":0.2,"maxTokens":512},"local":{"modelFile":"","contextSize":4096,"threads":0,"gpuLayers":0,"autoStart":false}},"app":{"closeToTray":true,"startAtLogin":false,"theme":"light","firstRunDone":true}}
'@
[System.IO.File]::WriteAllText((Join-Path $dataDir "settings.json"), $settings, [System.Text.UTF8Encoding]::new($false))

$env:LINGOPICK_DATA_DIR = $dataDir
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$CdpPort"
$app = Start-Process -FilePath $exe -PassThru -WorkingDirectory $root
Start-Sleep -Seconds 4

function Eval([string]$target, [string]$expression) {
  $output = & node (Join-Path $root "tests\cdp-eval.mjs") $CdpPort $target $expression 2>&1
  return ($output | Select-Object -Last 1)
}

$models = Eval 'tauri\.localhost/$' "window.__TAURI__.core.invoke('list_online_models',{baseUrl:'http://127.0.0.1:8770/v1',apiKey:'test-key'})"
"MODELS=$models"
$results.ListModels = $models -match "mock-qwen"

$copy = Eval 'picker.html' "window.__TAURI__.core.invoke('picker_copy',{text:'LingoPick clipboard smoke test'})"
"COPY=$copy"
$clipboard = (Get-Clipboard -Raw -ErrorAction SilentlyContinue)
"CLIPBOARD=$clipboard"
$results.Copy = $clipboard -match "LingoPick clipboard smoke test"

$disabled = Eval 'picker.html' "window.__TAURI__.core.invoke('picker_disable_in_app',{programName:'Notepad'})"
"DISABLE_IN_APP=$disabled"
Start-Sleep -Milliseconds 700
$state = Eval 'tauri\.localhost/$' "window.__TAURI__.core.invoke('get_state')"
$stateObj = $state | ConvertFrom-Json
$blacklist = $stateObj.settings.picker.blacklist -join ","
"BLACKLIST=$blacklist"
$results.DisableInApp = $blacklist -match "Notepad"

$toolOff = Eval 'picker.html' "window.__TAURI__.core.invoke('picker_disable_tool')"
"DISABLE_TOOL=$toolOff"
Start-Sleep -Milliseconds 700
$state2 = Eval 'tauri\.localhost/$' "window.__TAURI__.core.invoke('get_state')"
$stateObj2 = $state2 | ConvertFrom-Json
"PICKER_ENABLED=$($stateObj2.settings.picker.enabled)"
$results.DisableTool = ($stateObj2.settings.picker.enabled -eq $false)

$restore = Eval 'tauri\.localhost/$' "window.__TAURI__.core.invoke('update_settings',{patch:{picker:{enabled:true,blacklist:[]}}}).then(r => (r.state ? r.state.settings.picker : r.settings.picker))"
"RESTORED=$restore"

& taskkill /PID $app.Id /T /F 2>$null | Out-Null
Start-Sleep -Milliseconds 500
Remove-Item $dataDir -Recurse -Force -ErrorAction SilentlyContinue

$results | ConvertTo-Json
$passed = ($results.Values | Where-Object { $_ -eq $true }).Count
Write-Output "SMOKE_PASSED=$passed/$($results.Count)"
if ($passed -eq $results.Count) { exit 0 } else { exit 1 }
