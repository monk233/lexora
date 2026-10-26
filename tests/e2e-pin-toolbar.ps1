param(
  [string]$AppExe = "E:\document\workspace\AIProjects\lingopick\src-tauri\target\debug\lexora.exe",
  [int]$CdpPort = 9336,
  [switch]$RightSide,
  [switch]$Compact
)

# End-to-end check for the pinned-window edit toolbar (contract §11.5):
#   capture overlay -> drag a small selection -> pin it -> open edit mode and
#   assert the toolbar is a single row, left-aligned, and fully visible (the
#   shell widened the pin window for it).
$ErrorActionPreference = "Continue"
$root = "E:\document\workspace\AIProjects\lingopick"
$dataDir = Join-Path $root ".e2e-pin-data"
$shotDir = Join-Path $root ".tmp-ui"

Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32PinTest {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int nIndex);
  public static void MoveAbs(int x, int y) {
    int sw = GetSystemMetrics(0);
    int sh = GetSystemMetrics(1);
    mouse_event(0x8001, (uint)(x * 65535 / sw), (uint)(y * 65535 / sh), 0, UIntPtr.Zero);
  }
  public static void Down() { mouse_event(0x0002, 0, 0, 0, UIntPtr.Zero); }
  public static void Up() { mouse_event(0x0004, 0, 0, 0, UIntPtr.Zero); }
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
$compactValue = if ($Compact) { "true" } else { "false" }
$settings = @'
{"version":1,"picker":{"enabled":true,"skills":["translate","summarize","explain","read","copy"],"compact":__COMPACT__,"defaultTargetLang":"auto","blacklist":[],"maxChars":5000},"provider":{"mode":"online","online":{"preset":"custom","baseUrl":"http://127.0.0.1:8770/v1","apiKey":"test-key","model":"mock-qwen","timeoutMs":20000,"temperature":0.2,"maxTokens":512},"local":{"contextSize":4096,"threads":0,"gpuLayers":0,"autoStart":false}},"app":{"closeToTray":true,"startAtLogin":false,"theme":"light"}}
'@
$settings = $settings.Replace("__COMPACT__", $compactValue)
[System.IO.File]::WriteAllText((Join-Path $dataDir "settings.json"), $settings, [System.Text.UTF8Encoding]::new($false))
New-Item -ItemType Directory -Force -Path $shotDir | Out-Null

$env:LEXORA_DATA_DIR = $dataDir
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$CdpPort"
$app = Start-Process -FilePath $AppExe -PassThru -WorkingDirectory $root
Start-Sleep -Seconds 3

$results = [ordered]@{}
try {
  # --- capture overlay ------------------------------------------------------
  $captureStart = Cdp 'tauri\.localhost/$' "window.__TAURI__.core.invoke('start_capture',{}).then(r => r).catch(e => ({error: String(e)}))"
  "CAPTURE_START=$captureStart"
  $captureTarget = Wait-Target 'capture\.html'
  if (-not $captureTarget) { throw "capture overlay target not found" }
  $ready = $false
  $stateJson = ""
  for ($i = 0; $i -lt 60; $i++) {
    $stateRaw = Cdp 'capture\.html' "(() => { const s = window.__captureState || {}; return {ready: s.shotReady === true, phase: s.phase, gen: s.captureGeneration, err: s.error || '', errBar: !document.getElementById('capture-error').hidden, title: document.title}; })()"
    $stateJson = "$stateRaw"
    try {
      $stateObj = $stateRaw | ConvertFrom-Json
    } catch {
      $stateObj = $null
    }
    if ($stateObj -and $stateObj.ready -eq $true) { $ready = $true; break }
    Start-Sleep -Milliseconds 250
  }
  "CAPTURE_READY=$ready"
  if (-not $ready) {
    "CAPTURE_DEBUG=$stateJson"
    "TARGETS=" + (($(Get-Targets) | ForEach-Object { $_.url }) -join ' | ')
    $logPath = Join-Path $dataDir "logs\main.log"
    if (Test-Path $logPath) { "LOG_TAIL=" + ((Get-Content $logPath -Encoding UTF8 | Select-Object -Last 25) -join ' // ') }
    throw "capture overlay not ready"
  }
  Start-Sleep -Milliseconds 600

  # --- drag a small selection (320x220 near the top-left) -------------------
  $startX = 120; $startY = 140; $endX = 440; $endY = 360
  if ($RightSide) {
    $screenW = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Width
    $startX = $screenW - 440; $endX = $screenW - 120
    $startY = 200; $endY = 420
  }
  [Win32PinTest]::SetCursorPos($startX, $startY) | Out-Null
  [Win32PinTest]::MoveAbs($startX, $startY)
  Start-Sleep -Milliseconds 250
  [Win32PinTest]::Down()
  Start-Sleep -Milliseconds 120
  for ($step = 1; $step -le 10; $step++) {
    $x = $startX + [int](($endX - $startX) * $step / 10)
    $y = $startY + [int](($endY - $startY) * $step / 10)
    [Win32PinTest]::MoveAbs($x, $y)
    Start-Sleep -Milliseconds 35
  }
  [Win32PinTest]::Up()
  Start-Sleep -Seconds 1
  $phase = Cdp 'capture\.html' "JSON.stringify({phase: window.__captureState.phase, sel: !!window.__captureState.selection})"
  "CAPTURE_PHASE=$phase"

  # --- pin the selection (DOM click on the toolbar button) ------------------
  $pinClick = Cdp 'capture\.html' "(() => { const b = document.querySelector('#capture-bar [data-action=pin]'); if (!b) return 'missing'; b.click(); return 'clicked'; })()"
  "PIN_CLICK=$pinClick"
  $pinTarget = Wait-Target 'pin\.html'
  if (-not $pinTarget) { throw "pin target not found" }
  $loaded = $false
  for ($i = 0; $i -lt 40; $i++) {
    $pinStateRaw = Cdp 'pin\.html' "(() => { const s = window.__pinState || {}; return {loaded: s.loaded === true, error: s.error || ''}; })()"
    try {
      $pinStateObj = $pinStateRaw | ConvertFrom-Json
    } catch {
      $pinStateObj = $null
    }
    if ($pinStateObj -and $pinStateObj.loaded -eq $true) { $loaded = $true; break }
    Start-Sleep -Milliseconds 250
  }
  "PIN_LOADED=$loaded"
  if (-not $loaded) { throw "pin page not loaded" }
  Start-Sleep -Milliseconds 500

  $beforeJson = Cdp 'pin\.html' "JSON.stringify((() => { const img = document.getElementById('pin-image'); const r = img.getBoundingClientRect(); return {winW: window.innerWidth, winH: window.innerHeight, imgW: r.width, imgH: r.height, imgLeft: r.left, imgTop: r.top, barHidden: document.getElementById('pin-edit-bar').hidden}; })())"
  "PIN_BEFORE=$beforeJson"

  # --- enter edit mode ------------------------------------------------------
  $editClick = Cdp 'pin\.html' "(() => { const b = document.getElementById('pin-edit'); if (!b) return 'missing'; b.click(); return 'clicked'; })()"
  "EDIT_CLICK=$editClick"
  Start-Sleep -Seconds 2
  $editJson = Cdp 'pin\.html' "JSON.stringify((() => { const bar = document.getElementById('pin-edit-bar'); const img = document.getElementById('pin-image'); const r = bar.getBoundingClientRect(); const ir = img.getBoundingClientRect(); const cs = getComputedStyle(bar); const btns = Array.from(bar.querySelectorAll('button')).map(b => b.dataset.editTool || b.dataset.editSkill || b.dataset.editAction || '?'); return {editing: window.__pinState.editing, leftPad: window.__pinState.editLeftPad, topPad: window.__pinState.editTopPad, outside: window.__pinState.editOutside, winW: window.innerWidth, winH: window.innerHeight, dpr: window.devicePixelRatio, bar: {left: r.left, top: r.top, width: r.width, height: r.height, scrollW: bar.scrollWidth, clientW: bar.clientWidth, bottom: r.bottom}, image: {left: ir.left, top: ir.top, width: ir.width, height: ir.height}, flexWrap: cs.flexWrap, justify: cs.justifyContent, buttons: btns, oneRow: r.height < 60, fits: bar.scrollWidth <= bar.clientWidth + 1}; })())"
  "PIN_EDIT=$editJson"

  # --- shape button: click activates the tool + shows the annotation palette --
  $shapeJson = Cdp 'pin\.html' "(() => { const b = document.querySelector('#pin-edit-bar [data-edit-tool=shape]'); if (!b) return {error: 'no shape button'}; b.click(); return {clicked: true}; })()"
  "SHAPE_CLICK=$shapeJson"
  Start-Sleep -Milliseconds 1500
  $paletteJson = Cdp 'pin\.html' "(() => { const p = document.getElementById('capture-palette'); const bar = document.getElementById('pin-edit-bar'); const pr = p.getBoundingClientRect(); const br = bar.getBoundingClientRect(); const groups = Array.from(p.querySelectorAll('[data-tools]')).filter(g => !g.hidden).map(g => g.id || Array.from(g.classList).join('.')); return {paletteHidden: p.hidden, palette: {left: pr.left, top: pr.top, width: pr.width, height: pr.height, bottom: pr.bottom}, bar: {top: br.top, bottom: br.bottom, height: br.height, bottomStyle: bar.style.bottom}, winW: window.innerWidth, winH: window.innerHeight, visibleGroups: groups, shapeActive: document.querySelector('#pin-edit-bar [data-edit-tool=shape]').classList.contains('is-active'), tool: window.__pinEditor ? window.__pinEditor.getTool() : null, oneRow: pr.height < 60, belowBar: Math.abs(pr.top - (br.bottom + 8)) < 2}; })()"
  "PALETTE_STATE=$paletteJson"
  & node (Join-Path $root "tests\cdp-screenshot.mjs") $CdpPort 'pin\.html' (Join-Path $shotDir "pin-edit-palette-shape.png") "light" 2>&1 | Out-Null

  # --- palette controls: shape sub-mode, fill, width, colour popover ---------
  $paletteControls = Cdp 'pin\.html' "(() => { document.querySelector('#capture-palette [data-shape=circle]').click(); document.querySelector('#capture-palette [data-fill=fill]').click(); const w = document.getElementById('palette-width'); w.value = '10'; w.dispatchEvent(new Event('input', {bubbles: true})); document.getElementById('palette-color-button').click(); const pop = document.getElementById('palette-color-popover'); const popOpen = !pop.hidden; pop.querySelectorAll('.palette-color')[5].click(); const o = window.__pinEditor.getOptions(); return {shapeMode: o.shapeMode, fill: o.fill, width: o.width, color: o.color, popoverOpened: popOpen, popoverClosed: document.getElementById('palette-color-popover').hidden, widthLabel: document.getElementById('palette-width-value').textContent}; })()"
  "PALETTE_CONTROLS=$paletteControls"

  # --- custom colour panel + eyedropper (samples the pinned image) -----------
  $paletteCustom = Cdp 'pin\.html' "(() => { document.getElementById('palette-color-button').click(); document.querySelector('#palette-color-popover #palette-color-custom').click(); const panel = document.getElementById('palette-custom-color'); const open = !panel.hidden; const img = document.getElementById('pin-image'); const r = img.getBoundingClientRect(); document.getElementById('palette-eyedropper').click(); const picking = document.body.classList.contains('picking-color'); document.dispatchEvent(new PointerEvent('pointerdown', {clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0, bubbles: true})); const o = window.__pinEditor.getOptions(); return {customOpen: open, pickingStarted: picking, pickingStopped: !document.body.classList.contains('picking-color'), colorAfter: o.color}; })()"
  "PALETTE_CUSTOM=$paletteCustom"

  # --- text tool groups + a single-row palette screenshot --------------------
  $textGroups = Cdp 'pin\.html' "(() => { document.querySelector('#pin-edit-bar [data-edit-tool=text]').click(); const p = document.getElementById('capture-palette'); const groups = Array.from(p.querySelectorAll('[data-tools]')).filter(g => !g.hidden).map(g => g.id || Array.from(g.classList).join('.')); return {groups: groups, tool: window.__pinEditor ? window.__pinEditor.getTool() : null}; })()"
  "TEXT_GROUPS=$textGroups"
  Start-Sleep -Milliseconds 1200
  & node (Join-Path $root "tests\cdp-screenshot.mjs") $CdpPort 'pin\.html' (Join-Path $shotDir "pin-edit-palette.png") "light" 2>&1 | Out-Null

  # leave the tool again (Esc-like) and capture the plain edit bar
  $shapeOff = Cdp 'pin\.html' "(() => { const b = document.querySelector('#pin-edit-bar [data-edit-tool=text]'); b.click(); return JSON.stringify({paletteHidden: document.getElementById('capture-palette').hidden, tool: window.__pinEditor ? window.__pinEditor.getTool() : null}); })()"
  "TOOL_OFF=$shapeOff"
  Start-Sleep -Milliseconds 1200
  & node (Join-Path $root "tests\cdp-screenshot.mjs") $CdpPort 'pin\.html' (Join-Path $shotDir "pin-edit-toolbar.png") "light" 2>&1 | Out-Null

  $results.CaptureReady = $ready
  $results.PinLoaded = $loaded
  $results.EditState = $editJson
  $results.Palette = $paletteJson
  $results.PaletteControls = $paletteControls
  $results.PaletteCustom = $paletteCustom
  $results.TextGroups = $textGroups
} catch {
  "ERROR: $($_.Exception.Message)"
  $results.Error = $_.Exception.Message
} finally {
  & taskkill /PID $app.Id /T /F 2>$null | Out-Null
  Start-Sleep -Milliseconds 500
  Remove-Item $dataDir -Recurse -Force -ErrorAction SilentlyContinue
}

$results | ConvertTo-Json -Depth 6
