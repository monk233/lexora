param(
  [string]$AppExe = "E:\document\workspace\AIProjects\lingopick\src-tauri\target\debug\lingopick.exe",
  [int]$CdpPort = 9335
)

$ErrorActionPreference = "Continue"
$root = "E:\document\workspace\AIProjects\lingopick"
$dataDir = Join-Path $root ".e2e-picker-data"
$shotDir = Join-Path $root ".tmp-ui"
$results = [ordered]@{}

Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class Win32Picker {
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
  public static string ForegroundTitle() {
    IntPtr hwnd = GetForegroundWindow();
    StringBuilder sb = new StringBuilder(512);
    GetWindowText(hwnd, sb, 512);
    return sb.ToString();
  }
  public static void CloseWindow(IntPtr hwnd) { PostMessage(hwnd, 0x0010, IntPtr.Zero, IntPtr.Zero); }
}
"@

function Close-StaleWindows {
  Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like "*test-text*" } | ForEach-Object {
    [Win32Picker]::CloseWindow($_.MainWindowHandle)
  }
  Start-Sleep -Milliseconds 400
}

function Activate-Window($target) {
  [Win32Picker]::ShowWindow($target.MainWindowHandle, 9) | Out-Null
  $fg = [Win32Picker]::GetForegroundWindow()
  $fgThread = [Win32Picker]::GetWindowThreadProcessId($fg, [IntPtr]::Zero)
  $myThread = [Win32Picker]::GetCurrentThreadId()
  [Win32Picker]::AttachThreadInput($myThread, $fgThread, $true) | Out-Null
  [Win32Picker]::BringWindowToTop($target.MainWindowHandle) | Out-Null
  [Win32Picker]::SetForegroundWindow($target.MainWindowHandle) | Out-Null
  [Win32Picker]::AttachThreadInput($myThread, $fgThread, $false) | Out-Null
  Start-Sleep -Milliseconds 500
}

function Cdp($targetMatch, $expression) {
  $output = & node (Join-Path $root "tests\cdp-eval.mjs") $CdpPort $targetMatch $expression 2>&1
  return ($output | Select-Object -Last 1)
}

function Capture-Screen([string]$path) {
  $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.CopyFromScreen($bounds.X, $bounds.Y, 0, 0, $bounds.Size)
  $graphics.Dispose()
  $bitmap.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $bitmap.Dispose()
}

function Capture-Region([string]$path, [int]$left, [int]$top, [int]$width, [int]$height) {
  $bitmap = New-Object System.Drawing.Bitmap $width, $height
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.CopyFromScreen($left, $top, 0, 0, (New-Object System.Drawing.Size $width, $height))
  $graphics.Dispose()
  $bitmap.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $bitmap.Dispose()
}

# --- prepare data dir -------------------------------------------------------
Get-Process lingopick -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 500
if (Test-Path $dataDir) { Remove-Item $dataDir -Recurse -Force }
New-Item -ItemType Directory -Path (Join-Path $dataDir "logs"), (Join-Path $dataDir "models") -Force | Out-Null
$settings = @'
{"version":1,"picker":{"enabled":true,"shortcut":"Ctrl+Shift+D","skills":["translate","summarize","explain","read","copy"],"compact":false,"defaultTargetLang":"auto","blacklist":[],"maxChars":5000},"provider":{"mode":"online","online":{"preset":"custom","baseUrl":"http://127.0.0.1:8770/v1","apiKey":"test-key","model":"mock-qwen","timeoutMs":20000,"temperature":0.2,"maxTokens":512},"local":{"modelFile":"","contextSize":4096,"threads":0,"gpuLayers":0,"autoStart":false}},"app":{"closeToTray":true,"startAtLogin":false,"theme":"light"}}
'@
[System.IO.File]::WriteAllText((Join-Path $dataDir "settings.json"), $settings, [System.Text.UTF8Encoding]::new($false))
New-Item -ItemType Directory -Force -Path $shotDir | Out-Null

$env:LINGOPICK_DATA_DIR = $dataDir
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$CdpPort"
$sample = "LingoPick selection capture live test.`r`nThis sentence lives in another application.`r`nThe catheter shall be inserted under sterile conditions.`r`n"
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
$rect = New-Object Win32Picker+RECT
[Win32Picker]::GetWindowRect($target.MainWindowHandle, [ref]$rect) | Out-Null
"NOTEPAD_RECT=$($rect.Left),$($rect.Top),$($rect.Right),$($rect.Bottom)"

# Drag-select the first line.
$startX = $rect.Left + 90
$startY = $rect.Top + 95
$endX = $rect.Left + 430
$endY = $startY
[Win32Picker]::SetCursorPos($startX, $startY) | Out-Null
[Win32Picker]::MoveAbs($startX, $startY)
Start-Sleep -Milliseconds 150
[Win32Picker]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 80
for ($step = 1; $step -le 12; $step++) {
  $x = $startX + [int](($endX - $startX) * $step / 12)
  [Win32Picker]::MoveAbs($x, $endY)
  Start-Sleep -Milliseconds 25
}
[Win32Picker]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
$results.DragSelect = $true
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
if (-not $pickLine) {
  "ERROR: picker did not show"
  Capture-Screen (Join-Path $shotDir "picker-live-failed.png")
  & taskkill /PID $app.Id /T /F 2>$null | Out-Null
  Get-Process notepad -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -like "*test-text*" } | Stop-Process -Force -ErrorAction SilentlyContinue
  exit 1
}
$results.PickerLog = "$($pickLine.Line)"
"PICKER_LOG=$($pickLine.Line)"
$matches = [regex]::Match($pickLine.Line, "picker shown at physical=\((-?\d+),(-?\d+)\) size=(\d+)x(\d+) scale=([\d.]+) anchor=\((-?\d+),(-?\d+)\) placement=(\w+) text_chars=(\d+)")
if (-not $matches.Success) { "ERROR: cannot parse picker log"; exit 1 }
$px = [int]$matches.Groups[1].Value
$py = [int]$matches.Groups[2].Value
$scale = [double]$matches.Groups[5].Value
$results.Anchor = @($matches.Groups[6].Value, $matches.Groups[7].Value)
$results.Placement = $matches.Groups[8].Value
$results.TextChars = [int]$matches.Groups[9].Value
"PICKER_POS_PHYSICAL=$px,$py SCALE=$scale TEXT_CHARS=$($results.TextChars)"

# Capture the toolbar-only state before interacting with it.
$toolbarW = [int](($matches.Groups[3].Value) / $scale) + 8
$toolbarH = [int](($matches.Groups[4].Value) / $scale) + 8
Capture-Region (Join-Path $shotDir "picker-live-toolbar.png") ([int]($px / $scale) - 4) ([int]($py / $scale) - 4) $toolbarW $toolbarH
Start-Sleep -Milliseconds 300

# Wait for renderer and query the translate button position (CSS pixels).
$rectJson = $null
for ($i = 0; $i -lt 20; $i++) {
  $raw = Cdp "picker.html" "(() => { const el = document.querySelector('[data-skill=translate]'); if (!el) return null; const r = el.getBoundingClientRect(); return {x:r.x,y:r.y,w:r.width,h:r.height}; })()"
  if ($raw -and $raw.Trim() -ne "null") { $rectJson = $raw | ConvertFrom-Json; break }
  Start-Sleep -Milliseconds 250
}
if (-not $rectJson) { "ERROR: translate button not found"; exit 1 }
# Pin the panel first so blur/outside clicks cannot hide it during the test.
Cdp "picker.html" "window.__TAURI__.core.invoke('picker_pin', {pinned:true}).then(r => r)" | Out-Null
"TRANSLATE_BUTTON_CSS=$($rectJson.x),$($rectJson.y),$($rectJson.w),$($rectJson.h)"
$clickCssX = $rectJson.x + $rectJson.w / 2
$clickCssY = $rectJson.y + $rectJson.h / 2
$clickLogicalX = [int](($px / $scale) + $clickCssX)
$clickLogicalY = [int](($py / $scale) + $clickCssY)
"CLICK_LOGICAL=$clickLogicalX,$clickLogicalY"
[Win32Picker]::ClickAt($clickLogicalX, $clickLogicalY)
Start-Sleep -Milliseconds 1600

$resultText = Cdp "picker.html" "(() => { const el = document.querySelector('.result-text'); return el ? el.textContent : null; })()"
$results.TranslatedText = "$resultText"
"TRANSLATED_TEXT=$resultText"
if ($resultText -and $resultText -match "MOCK") {
  $results.PanelTranslate = $true
} else {
  $results.PanelTranslate = $false
}

# Screenshot the toolbar+panel region (logical coords).
$winLogicalX = [int]($px / $scale) - 10
$winLogicalY = [int]($py / $scale) - 10
$shotW = [int](600)
$shotH = [int](520)
Capture-Region (Join-Path $shotDir "picker-live-panel.png") $winLogicalX $winLogicalY $shotW $shotH
& node (Join-Path $root "tests\cdp-screenshot.mjs") $CdpPort "picker.html" (Join-Path $shotDir "picker-cdp.png") "light" 2>&1 | Out-Null
$results.PanelScreenshot = (Join-Path $shotDir "picker-live-panel.png")

# Open settings via the picker command and capture a clean screenshot through CDP.
Cdp "picker.html" "window.__TAURI__.core.invoke('picker_open_settings').then(r => ({ok:true}))" | Out-Null
Start-Sleep -Milliseconds 1200
$settingsShotBase64 = Cdp 'tauri\.localhost/$' "(() => { return document.title; })()"
"SETTINGS_TITLE=$settingsShotBase64"
$screenshot = & node (Join-Path $root "tests\cdp-screenshot.mjs") $CdpPort 'tauri\.localhost/$' (Join-Path $shotDir "settings-live.png") "light" 2>&1
"CDP_SCREENSHOT=$screenshot"

# Cleanup
& taskkill /PID $app.Id /T /F 2>$null | Out-Null
Get-Process notepad -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -like "*test-text*" } | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 500
$results | ConvertTo-Json -Depth 5
if ($results.PickerLog -and $results.PanelTranslate -eq $true) { exit 0 } else { exit 1 }
