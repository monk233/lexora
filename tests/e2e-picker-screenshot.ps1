param(
  [string]$AppExe = "E:\document\workspace\AIProjects\lingopick\src-tauri\target\debug\lexora.exe",
  [int]$CdpPort = 9351
)

# Verifies that clicking the built-in screenshot skill in the text toolbar
# starts the capture overlay AND hides the picker toolbar (same as the copy
# skill), instead of leaving the toolbar floating over the screen.
$ErrorActionPreference = "Continue"
$root = "E:\document\workspace\AIProjects\lingopick"
$dataDir = Join-Path $root ".e2e-picker-screenshot-data"
$results = [ordered]@{}

Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class Win32PickerShot {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int nIndex);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, IntPtr pid);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
  public static void MoveAbs(int x, int y) {
    int sw = GetSystemMetrics(0);
    int sh = GetSystemMetrics(1);
    mouse_event(0x8001, (uint)(x * 65535 / sw), (uint)(y * 65535 / sh), 0, UIntPtr.Zero);
  }
  public static void ClickAt(int x, int y) {
    MoveAbs(x, y);
    System.Threading.Thread.Sleep(120);
    mouse_event(0x0002, 0, 0, 0, UIntPtr.Zero);
    System.Threading.Thread.Sleep(80);
    mouse_event(0x0004, 0, 0, 0, UIntPtr.Zero);
  }
  public static void CloseWindow(IntPtr hwnd) { PostMessage(hwnd, 0x0010, IntPtr.Zero, IntPtr.Zero); }
}
"@

function Close-StaleWindows {
  Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like "*test-text*" } | ForEach-Object {
    [Win32PickerShot]::CloseWindow($_.MainWindowHandle)
  }
  Start-Sleep -Milliseconds 400
}

function Activate-Window($target) {
  [Win32PickerShot]::ShowWindow($target.MainWindowHandle, 9) | Out-Null
  $fg = [Win32PickerShot]::GetForegroundWindow()
  $fgThread = [Win32PickerShot]::GetWindowThreadProcessId($fg, [IntPtr]::Zero)
  $myThread = [Win32PickerShot]::GetCurrentThreadId()
  [Win32PickerShot]::AttachThreadInput($myThread, $fgThread, $true) | Out-Null
  [Win32PickerShot]::BringWindowToTop($target.MainWindowHandle) | Out-Null
  [Win32PickerShot]::SetForegroundWindow($target.MainWindowHandle) | Out-Null
  [Win32PickerShot]::AttachThreadInput($myThread, $fgThread, $false) | Out-Null
  Start-Sleep -Milliseconds 500
}

function Cdp($targetMatch, $expression) {
  $output = & node (Join-Path $root "tests\cdp-eval.mjs") $CdpPort $targetMatch $expression 2>&1
  return ($output | Select-Object -Last 1)
}

Get-Process lexora -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 500
if (Test-Path $dataDir) { Remove-Item $dataDir -Recurse -Force }
New-Item -ItemType Directory -Path (Join-Path $dataDir "logs"), (Join-Path $dataDir "models") -Force | Out-Null
$settings = @'
{"version":1,"picker":{"enabled":true,"skills":["translate","summarize","explain","read","copy","screenshot"],"compact":false,"defaultTargetLang":"auto","blacklist":[],"maxChars":5000},"provider":{"mode":"online","online":{"preset":"custom","baseUrl":"http://127.0.0.1:8770/v1","apiKey":"test-key","model":"mock-qwen","timeoutMs":20000,"temperature":0.2,"maxTokens":512},"local":{"contextSize":4096,"threads":0,"gpuLayers":0,"autoStart":false}},"app":{"closeToTray":true,"startAtLogin":false,"theme":"light"}}
'@
[System.IO.File]::WriteAllText((Join-Path $dataDir "settings.json"), $settings, [System.Text.UTF8Encoding]::new($false))

$env:LEXORA_DATA_DIR = $dataDir
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$CdpPort"
$sample = "Lexora selection capture live test.`r`nThis sentence lives in another application.`r`n"
$txtFile = Join-Path $root "test-text.txt"
[System.IO.File]::WriteAllText($txtFile, $sample, [System.Text.UTF8Encoding]::new($false))

Close-StaleWindows
$app = Start-Process -FilePath $AppExe -PassThru -WorkingDirectory $root
Start-Sleep -Seconds 3
$notepad = Start-Process "notepad.exe" -ArgumentList $txtFile -PassThru
$target = $null
for ($i = 0; $i -lt 60; $i++) {
  $target = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like "*test-text*" -and $_.ProcessName -eq "notepad" } | Select-Object -First 1
  if ($target) { break }
  Start-Sleep -Milliseconds 250
}
if (-not $target) { "ERROR: notepad not found"; & taskkill /PID $app.Id /T /F | Out-Null; exit 1 }
Activate-Window $target
$rect = New-Object Win32PickerShot+RECT
[Win32PickerShot]::GetWindowRect($target.MainWindowHandle, [ref]$rect) | Out-Null

# Drag-select the first line to pop the picker toolbar.
$startX = $rect.Left + 90
$startY = $rect.Top + 95
$endX = $rect.Left + 430
[Win32PickerShot]::SetCursorPos($startX, $startY) | Out-Null
[Win32PickerShot]::MoveAbs($startX, $startY)
Start-Sleep -Milliseconds 150
[Win32PickerShot]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 80
for ($step = 1; $step -le 12; $step++) {
  $x = $startX + [int](($endX - $startX) * $step / 12)
  [Win32PickerShot]::MoveAbs($x, $startY)
  Start-Sleep -Milliseconds 25
}
[Win32PickerShot]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Seconds 2

$logPath = Join-Path $dataDir "logs\main.log"
$pickLine = $null
for ($i = 0; $i -lt 30; $i++) {
  if (Test-Path $logPath) {
    $pickLine = Get-Content $logPath -Encoding UTF8 | Select-String -Pattern "picker shown at physical" | Select-Object -Last 1
  }
  if ($pickLine) { break }
  Start-Sleep -Milliseconds 300
}
if (-not $pickLine) { "ERROR: picker did not show"; & taskkill /PID $app.Id /T /F | Out-Null; exit 1 }
$matches = [regex]::Match($pickLine.Line, "picker shown at physical=\((-?\d+),(-?\d+)\) size=(\d+)x(\d+) scale=([\d.]+)")
if (-not $matches.Success) { "ERROR: cannot parse picker log"; exit 1 }
$px = [int]$matches.Groups[1].Value
$py = [int]$matches.Groups[2].Value
$scale = [double]$matches.Groups[5].Value
"PICKER_POS=$px,$py SCALE=$scale"

$before = "n/a"
$logLines = 0
if (Test-Path $logPath) { $logLines = (Get-Content $logPath -Encoding UTF8 | Measure-Object -Line).Lines }
"PICKER_LOG_LINES_BEFORE=$logLines"

$rectJson = $null
for ($i = 0; $i -lt 20; $i++) {
  $raw = Cdp "picker.html" "(() => { const el = document.querySelector('[data-skill=screenshot]'); if (!el) return null; const r = el.getBoundingClientRect(); return {x:r.x,y:r.y,w:r.width,h:r.height}; })()"
  if ($raw -and $raw.Trim() -ne "null") { $rectJson = $raw | ConvertFrom-Json; break }
  Start-Sleep -Milliseconds 250
}
if (-not $rectJson) { "ERROR: screenshot skill button not found"; & taskkill /PID $app.Id /T /F | Out-Null; exit 1 }
"SCREENSHOT_BUTTON_CSS=$($rectJson.x),$($rectJson.y),$($rectJson.w),$($rectJson.h)"
$clickLogicalX = [int](($px / $scale) + $rectJson.x + $rectJson.w / 2)
$clickLogicalY = [int](($py / $scale) + $rectJson.y + $rectJson.h / 2)
"CLICK_LOGICAL=$clickLogicalX,$clickLogicalY"
[Win32PickerShot]::ClickAt($clickLogicalX, $clickLogicalY)
Start-Sleep -Milliseconds 1800

$captureTarget = & node (Join-Path $root "tests\cdp-eval.mjs") $CdpPort "capture\.html" "document.title" 2>&1
$captureSeen = -not ($captureTarget -match "not found")
"CAPTURE_OVERLAY_SEEN=$captureSeen"
$hiddenLogged = $false
if (Test-Path $logPath) {
  $newLines = @(Get-Content $logPath -Encoding UTF8 | Select-Object -Skip $logLines)
  $hiddenLogged = @($newLines | Where-Object { $_ -match "picker hidden" }).Count -gt 0
}
"PICKER_HIDDEN_LOGGED=$hiddenLogged"
"PICKER_SCREENSHOT_HIDDEN=$($hiddenLogged -and $captureSeen)"
$results.PickerHidden = ($hiddenLogged -and $captureSeen)
$results.CaptureSeen = $captureSeen
$results | ConvertTo-Json -Depth 4

& taskkill /PID $app.Id /T /F 2>$null | Out-Null
Get-Process notepad -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -like "*test-text*" } | Stop-Process -Force -ErrorAction SilentlyContinue
Remove-Item $dataDir -Recurse -Force -ErrorAction SilentlyContinue
Get-Process lexora -ErrorAction SilentlyContinue | Stop-Process -Force
