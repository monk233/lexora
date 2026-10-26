param(
  [string]$AppExe = "E:\document\workspace\AIProjects\lingopick\src-tauri\target\debug\lexora.exe",
  [int]$CdpPort = 9341
)

# End-to-end check for the manual-scroll long screenshot (contract §11.14.1):
#   screenshot -> large selection over Notepad -> 长截图 -> control bar appears
#   below the selection, the preview grows while the page scrolls, direction
#   switch works, finish pins the WHOLE stitched image (no scrollbar).
$ErrorActionPreference = "Continue"
$root = "E:\document\workspace\AIProjects\lingopick"
$dataDir = Join-Path $root ".e2e-longshot-data"
$shotDir = Join-Path $root ".tmp-ui"

Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class Win32LS {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int nIndex);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, IntPtr pid);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  public static void MoveAbs(int x, int y) {
    int sw = GetSystemMetrics(0);
    int sh = GetSystemMetrics(1);
    mouse_event(0x8001, (uint)(x * 65535 / sw), (uint)(y * 65535 / sh), 0, UIntPtr.Zero);
  }
  public static void WheelDown(int notches) {
    for (int i = 0; i < notches; i++) {
      mouse_event(0x0800, 0, 0, unchecked((uint)(-120)), UIntPtr.Zero);
      System.Threading.Thread.Sleep(40);
    }
  }
  public static void Activate(IntPtr hwnd) {
    ShowWindow(hwnd, 9);
    IntPtr fg = GetForegroundWindow();
    uint fgThread = GetWindowThreadProcessId(fg, IntPtr.Zero);
    uint myThread = GetCurrentThreadId();
    AttachThreadInput(myThread, fgThread, true);
    BringWindowToTop(hwnd);
    SetForegroundWindow(hwnd);
    AttachThreadInput(myThread, fgThread, false);
  }
  public static void ClickAt(int x, int y) {
    MoveAbs(x, y);
    System.Threading.Thread.Sleep(120);
    mouse_event(0x0002, 0, 0, 0, UIntPtr.Zero);
    System.Threading.Thread.Sleep(80);
    mouse_event(0x0004, 0, 0, 0, UIntPtr.Zero);
  }
}
"@

function Cdp($targetMatch, $expression) {
  $output = & node (Join-Path $root "tests\cdp-eval.mjs") $CdpPort $targetMatch $expression 2>&1
  return ($output | Select-Object -Last 1)
}

function Get-Targets() {
  try {
    return Invoke-RestMethod -Uri "http://127.0.0.1:$CdpPort/json/list" -TimeoutSec 2
  } catch {
    return @()
  }
}

function Wait-Target([string]$pattern, [int]$tries = 60) {
  for ($i = 0; $i -lt $tries; $i++) {
    $list = Get-Targets
    $hit = $list | Where-Object { $_.url -match $pattern -and $_.webSocketDebuggerUrl } | Select-Object -First 1
    if ($hit) { return $hit }
    Start-Sleep -Milliseconds 250
  }
  return $null
}

Get-Process lexora -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 400
if (Test-Path $dataDir) { Remove-Item $dataDir -Recurse -Force }
New-Item -ItemType Directory -Path (Join-Path $dataDir "logs"), (Join-Path $dataDir "models") -Force | Out-Null
$settings = @'
{"version":1,"picker":{"enabled":true,"skills":["translate","summarize","explain","read","copy"],"compact":false,"defaultTargetLang":"auto","blacklist":[],"maxChars":5000},"provider":{"mode":"online","online":{"preset":"custom","baseUrl":"http://127.0.0.1:8770/v1","apiKey":"test-key","model":"mock-qwen","timeoutMs":20000,"temperature":0.2,"maxTokens":512},"local":{"contextSize":4096,"threads":0,"gpuLayers":0,"autoStart":false}},"app":{"closeToTray":true,"startAtLogin":false,"theme":"light"}}
'@
[System.IO.File]::WriteAllText((Join-Path $dataDir "settings.json"), $settings, [System.Text.UTF8Encoding]::new($false))
New-Item -ItemType Directory -Force -Path $shotDir | Out-Null

# A long text document with a unique marker on every line, so a stitching error
# (duplicated / skipped rows) is visible instead of looking like repeated text.
$words = @("apple","bridge","canyon","dolphin","ember","falcon","glacier","harbor","island","jungle","kettle","lantern","meadow","nectar","orbit","pebble","quartz","ripple","summit","tundra","umber","valley","whisk","xenon","yonder","zephyr")
$lines = 1..400 | ForEach-Object {
  $w = $words[($_ - 1) % $words.Count]
  "Line $_ : $w-$_ Lexora long screenshot scrolling test content for stitching."
}
$txtFile = Join-Path $root "test-text.txt"
[System.IO.File]::WriteAllLines($txtFile, $lines, [System.Text.UTF8Encoding]::new($false))
Get-Process notepad -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -like "*test-text*" } | Stop-Process -Force -ErrorAction SilentlyContinue

$env:LEXORA_DATA_DIR = $dataDir
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$CdpPort"
$app = Start-Process -FilePath $AppExe -PassThru -WorkingDirectory $root
Start-Sleep -Seconds 3

$results = [ordered]@{}
$notepad = $null
try {
  $notepad = Start-Process "notepad.exe" -ArgumentList $txtFile -PassThru
  $npTarget = $null
  for ($i = 0; $i -lt 60; $i++) {
    $npTarget = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like "*test-text*" -and $_.ProcessName -eq "notepad" } | Select-Object -First 1
    if ($npTarget) { break }
    Start-Sleep -Milliseconds 250
  }
  if (-not $npTarget) { throw "notepad not found" }
  [Win32LS]::Activate($npTarget.MainWindowHandle)
  Start-Sleep -Milliseconds 600
  $nr = New-Object Win32LS+RECT
  [Win32LS]::GetWindowRect($npTarget.MainWindowHandle, [ref]$nr) | Out-Null
  "NOTEPAD_RECT=$($nr.Left),$($nr.Top),$($nr.Right),$($nr.Bottom)"

  # --- screenshot + selection over the Notepad body -----------------------
  $captureStart = Cdp 'tauri\.localhost/$' "window.__TAURI__.core.invoke('start_capture',{}).then(r => r).catch(e => ({error: String(e)}))"
  "CAPTURE_START=$captureStart"
  if (-not (Wait-Target 'capture\.html')) { throw "capture overlay missing" }
  $ready = $false
  for ($i = 0; $i -lt 60; $i++) {
    $raw = Cdp 'capture\.html' "(() => { const s = window.__captureState || {}; return {ready: s.shotReady === true}; })()"
    try { $obj = $raw | ConvertFrom-Json } catch { $obj = $null }
    if ($obj -and $obj.ready -eq $true) { $ready = $true; break }
    Start-Sleep -Milliseconds 250
  }
  "CAPTURE_READY=$ready"
  if (-not $ready) { throw "capture overlay not ready" }
  Start-Sleep -Milliseconds 500

  # Drag-select the middle of the Notepad body (logical coords).
  $selLeft = $nr.Left + 80
  $selTop = $nr.Top + 120
  $selRight = $nr.Left + 560
  $selBottom = $nr.Top + 500
  [Win32LS]::SetCursorPos($selLeft, $selTop) | Out-Null
  [Win32LS]::MoveAbs($selLeft, $selTop)
  Start-Sleep -Milliseconds 200
  [Win32LS]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 100
  for ($step = 1; $step -le 10; $step++) {
    $x = $selLeft + [int](($selRight - $selLeft) * $step / 10)
    $y = $selTop + [int](($selBottom - $selTop) * $step / 10)
    [Win32LS]::MoveAbs($x, $y)
    Start-Sleep -Milliseconds 30
  }
  [Win32LS]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Seconds 1
  "SELECTION=$selLeft,$selTop,$selRight,$selBottom"
  $phase = Cdp 'capture\.html' "(() => { const s = window.__captureState || {}; return {phase: s.phase, sel: !!s.selection}; })()"
  "CAPTURE_PHASE=$phase"

  # --- start the manual long screenshot -----------------------------------
  $lsClick = Cdp 'capture\.html' "(() => { const b = document.querySelector('#capture-bar [data-action=longshot]'); if (!b) return {error: 'no longshot button'}; b.click(); return {clicked: true}; })()"
  "LONGSHOT_CLICK=$lsClick"
  $barTarget = Wait-Target 'longshot-bar\.html'
  $previewTarget = Wait-Target 'longshot\.html'
  "LONGSHOT_TARGETS=bar:$([bool]$barTarget) preview:$([bool]$previewTarget)"
  if (-not $barTarget -or -not $previewTarget) {
    "TARGETS_NOW=" + (($(Get-Targets) | ForEach-Object { $_.url }) -join ' | ')
    $logPathNow = Join-Path $dataDir "logs\main.log"
    if (Test-Path $logPathNow) { "LOG_TAIL=" + ((Get-Content $logPathNow -Encoding UTF8 | Select-Object -Last 20) -join ' // ') }
    throw "longshot windows missing"
  }
  Start-Sleep -Milliseconds 800

  # Control bar must sit right below the selection (same place as the toolbar).
  $barState = Cdp 'longshot-bar\.html' "(() => { const dirs = Array.from(document.querySelectorAll('[data-direction]')).map(b => ({d: b.dataset.direction, active: b.classList.contains('is-active'), disabled: b.disabled})); return {screenX: window.screenX, screenY: window.screenY, winW: window.innerWidth, winH: window.innerHeight, status: document.getElementById('ls-status').textContent, dirs: dirs, finishDisabled: document.getElementById('ls-finish').disabled, cancelDisabled: document.getElementById('ls-cancel').disabled}; })()"
  "BAR_STATE=$barState"
  $barObj = $barState | ConvertFrom-Json
  "BAR_BELOW_SELECTION_X=$([Math]::Abs($barObj.screenX - $selLeft) -le 2) BAR_BELOW_SELECTION_Y=$($barObj.screenY -ge ($selBottom + 3) -and $barObj.screenY -le ($selBottom + 10))"

  # Preview window: narrow strip, modest height while only the first frame exists.
  $pre0 = Cdp 'longshot\.html' "(() => ({winW: window.innerWidth, winH: window.innerHeight, screenX: window.screenX, screenY: window.screenY, imgHidden: document.getElementById('longshot-image').hidden, promptNodes: document.querySelectorAll('.longshot-meta, .longshot-error, .longshot-toast').length, state: window.__longshotState ? {w: window.__longshotState.width, h: window.__longshotState.height, frames: window.__longshotState.frames} : null}))()"
  "PREVIEW_BEFORE=$pre0"
  $pre0Obj = $pre0 | ConvertFrom-Json
  "PREVIEW_WIDTH_DOUBLED=$([Math]::Abs($pre0Obj.winW - 472) -le 2) PREVIEW_NO_PROMPTS=$($pre0Obj.promptNodes -eq 0)"

  # --- auto-scroll mode: the shell scrolls the target app and stitches -------
  $autoOn = Cdp 'longshot-bar\.html' "(() => { const b = document.getElementById('ls-autoscroll'); if (!b) return {error: 'no autoscroll button'}; b.click(); return {clicked: true}; })()"
  "AUTOSCROLL_CLICK=$autoOn"
  Start-Sleep -Seconds 4
  $autoState = Cdp 'longshot-bar\.html' "window.__TAURI__.core.invoke('longshot_state')"
  "AUTOSCROLL_STATE=$autoState"
  $autoStateObj = $autoState | ConvertFrom-Json
  "AUTOSCROLL_WORKED=$($autoStateObj.frames -gt 1 -and $autoStateObj.autoscroll -eq $true)"
  $autoOff = Cdp 'longshot-bar\.html' "(() => { const b = document.getElementById('ls-autoscroll'); b.click(); return {clicked: true}; })()"
  Start-Sleep -Milliseconds 700
  $autoOffState = Cdp 'longshot-bar\.html' "window.__TAURI__.core.invoke('longshot_state')"
  "AUTOSCROLL_OFF_STATE=$autoOffState"

  # --- scroll the Notepad page manually: the preview must grow ---------------
  [Win32LS]::MoveAbs([int](($selLeft + $selRight) / 2), [int](($selTop + $selBottom) / 2))
  Start-Sleep -Milliseconds 200
  for ($batch = 0; $batch -lt 6; $batch++) {
    [Win32LS]::WheelDown(3)
    Start-Sleep -Milliseconds 260
  }
  Start-Sleep -Milliseconds 1200
  $state1 = Cdp 'longshot-bar\.html' "window.__TAURI__.core.invoke('longshot_state')"
  "LONGSHOT_STATE_AFTER_SCROLL=$state1"
  $pre1 = Cdp 'longshot\.html' "(() => ({winW: window.innerWidth, winH: window.innerHeight, state: window.__longshotState ? {w: window.__longshotState.width, h: window.__longshotState.height, frames: window.__longshotState.frames, renders: window.__longshotState.renders, src: window.__longshotState.imageSrcLength} : null}))()"
  "PREVIEW_AFTER=$pre1"

  # --- direction switch resets and keeps working ---------------------------
  $dirClick = Cdp 'longshot-bar\.html' "(() => { document.querySelector('[data-direction=horizontal]').click(); return {clicked: true}; })()"
  Start-Sleep -Milliseconds 800
  $dirState = Cdp 'longshot-bar\.html' "window.__TAURI__.core.invoke('longshot_state')"
  "DIRECTION_HORIZONTAL=$dirState"
  $dirBack = Cdp 'longshot-bar\.html' "(() => { document.querySelector('[data-direction=vertical]').click(); return {clicked: true}; })()"
  Start-Sleep -Milliseconds 800
  "DIRECTION_BACK=$dirBack"
  # scroll again after the reset so the stitched image is non-trivial
  [Win32LS]::MoveAbs([int](($selLeft + $selRight) / 2), [int](($selTop + $selBottom) / 2))
  for ($batch = 0; $batch -lt 5; $batch++) {
    [Win32LS]::WheelDown(3)
    Start-Sleep -Milliseconds 260
  }
  Start-Sleep -Milliseconds 1200

  & node (Join-Path $root "tests\cdp-screenshot.mjs") $CdpPort 'longshot-bar\.html' (Join-Path $shotDir "longshot-bar.png") "light" 2>&1 | Out-Null
  & node (Join-Path $root "tests\cdp-screenshot.mjs") $CdpPort 'longshot\.html' (Join-Path $shotDir "longshot-preview.png") "light" 2>&1 | Out-Null

  # --- finish: the pin must show the WHOLE stitched image -----------------
  $finishClick = Cdp 'longshot-bar\.html' "(() => { const b = document.getElementById('ls-finish'); if (!b) return {error: 'missing'}; b.click(); return {clicked: true}; })()"
  "FINISH_CLICK=$finishClick"
  $pinTarget = Wait-Target 'pin\.html'
  if (-not $pinTarget) { throw "pin window missing after finish" }
  Start-Sleep -Milliseconds 1500
  $pinState = Cdp 'pin\.html' "(() => { const img = document.getElementById('pin-image'); const r = img.getBoundingClientRect(); return {winW: window.innerWidth, winH: window.innerHeight, screenX: window.screenX, screenY: window.screenY, imgW: r.width, imgH: r.height, scrollable: document.body.classList.contains('is-scrollable'), zoom: window.__pinState ? window.__pinState.zoom : null, imageLoaded: !!(window.__pinState && window.__pinState.loaded)}; })()"
  "PIN_STATE=$pinState"
  $pinObj = $pinState | ConvertFrom-Json
  "PIN_WHOLE_VISIBLE=$([Math]::Abs($pinObj.imgH - $pinObj.winH) -le 2) PIN_NO_SCROLLBAR=$(-not $pinObj.scrollable)"
  & node (Join-Path $root "tests\cdp-screenshot.mjs") $CdpPort 'pin\.html' (Join-Path $shotDir "longshot-pin.png") "light" 2>&1 | Out-Null

  $results.CaptureReady = $ready
  $results.BarState = $barState
  $results.PreviewBefore = $pre0
  $results.PreviewAfter = $pre1
  $results.StateAfterScroll = $state1
  $results.PinState = $pinState
} catch {
  "ERROR: $($_.Exception.Message)"
  $results.Error = $_.Exception.Message
  $logPath = Join-Path $dataDir "logs\main.log"
  if (Test-Path $logPath) { "LOG_TAIL=" + ((Get-Content $logPath -Encoding UTF8 | Select-Object -Last 25) -join ' // ') }
} finally {
  & taskkill /PID $app.Id /T /F 2>$null | Out-Null
  if ($notepad) { Stop-Process -Id $notepad.Id -Force -ErrorAction SilentlyContinue }
  Get-Process notepad -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -like "*test-text*" } | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 500
  Remove-Item $dataDir -Recurse -Force -ErrorAction SilentlyContinue
}

$results | ConvertTo-Json -Depth 6
