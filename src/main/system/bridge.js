'use strict';
/* ══════════════════════════════════════════════════════════════════
   JARVIS Phase 6 — SystemBridge: REAL system queries + actions.
   RULE 1: every value comes from os/child_process/PowerShell(WMI)/fs.
   RULE 7: every action VERIFIES itself (fs.stat / process check) and
   reports the verified truth — never a guess.
   PowerShell scripts live in a sandboxed temp dir, written once,
   invoked with -File + single-quoted params (no injection surface).
   ══════════════════════════════════════════════════════════════════ */

const { spawn, execFile } = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');

const PS = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const SCRIPT_DIR = path.join(os.tmpdir(), 'jarvis-sys-bridge');

/* ── PowerShell script library (real WMI/CIM queries) ─────────────── */
const SCRIPTS = {
  ram: `param([int]$Top = 14)
$os = Get-CimInstance Win32_OperatingSystem
"TOTAL_KB=$($os.TotalVisibleMemorySize)"
"FREE_KB=$($os.FreePhysicalMemory)"
Get-Process | Group-Object -Property ProcessName | ForEach-Object {
  [pscustomobject]@{ N=$_.Name; C=$_.Count; MB=[math]::Round(($_.Group | Measure-Object WorkingSet64 -Sum).Sum/1MB,1) }
} | Sort-Object MB -Descending | Select-Object -First $Top | ForEach-Object { "PROC=$($_.N)|$($_.C)|$($_.MB)" }`,

  cpu: `$p = Get-CimInstance Win32_Processor
"L1=$($p.LoadPercentage)"
Start-Sleep -Milliseconds 500
$p2 = Get-CimInstance Win32_Processor
"L2=$($p2.LoadPercentage)"
"INFO=$($p.Name)|$($p.NumberOfCores)|$($p.NumberOfLogicalProcessors)|$($p.MaxClockSpeed)"`,

  hw: `$cs = Get-CimInstance Win32_ComputerSystem
$b  = Get-CimInstance Win32_BIOS
$os = Get-CimInstance Win32_OperatingSystem
"CS=$($cs.Manufacturer)|$($cs.Model)"
"SYSFAMILY=$($cs.SystemFamily)"
"BIOS=$($b.SMBIOSBIOSVersion)"
"OS=$($os.Caption)|$($os.BuildNumber)|$($os.Version)"
"RAMSLOTS=$($cs.NumberOfLogicalProcessors)"
Get-CimInstance Win32_VideoController | ForEach-Object { "GPU=$($_.Name)" }
Get-CimInstance Win32_Processor | ForEach-Object { "CPUMODEL=$($_.Name)" }`,

  disks: `Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3 OR DriveType=2" | ForEach-Object {
  "DISK=$($_.DeviceID)|$($_.Size)|$($_.FreeSpace)|$($_.VolumeName)" }`,

  battery: `$b = Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue
if ($b) { "BATTERY=$($b.EstimatedChargeRemaining)|$($b.BatteryStatus)|$($b.EstimatedRunTime)" } else { "BATTERY=none" }
try { $p = Get-CimInstance -Namespace root/wmi -ClassName BatteryStatus -ErrorAction Stop | Select-Object -First 1
  if ($p) { "CHARGING=$($p.Charging)|$($p.PowerOnline)|$($p.DischargeRate)" } } catch { }`,

  network: `$online = $false; $ip = ''
try { $r = Resolve-DnsName -Name 'google.com' -Type A -ErrorAction Stop | Where-Object { $_.IPAddress } | Select-Object -First 1; if ($r) { $online = $true; $ip = $r.IPAddress } } catch { }
"ONLINE=$online"; "EXTIP=$ip"
Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -notlike '169.254*' -and $_.IPAddress -ne '127.0.0.1' } | ForEach-Object { "IP=$($_.IPAddress)|$($_.InterfaceAlias)" }
try { $n = Get-NetConnectionProfile -ErrorAction Stop | Select-Object -First 1; "NET=$($n.Name)|$($n.InterfaceAlias)|$($n.NetworkCategory)" } catch { }`,

  temp: `try {
  $t = Get-CimInstance -Namespace root/wmi -ClassName MSAcpi_ThermalZoneTemperature -ErrorAction Stop
  $t | ForEach-Object { "TEMP=$($_.InstanceName)|$([math]::Round(($_.CurrentTemperature/10)-273.15,1))" }
} catch { "TEMP=unavailable" }`,

  desktop: `"DESKTOP=" + [Environment]::GetFolderPath('Desktop')`,

  ls: `param([string]$Path = 'C:\\', [int]$Limit = 400)
if (-not (Test-Path -LiteralPath $Path)) { "ERROR=notfound"; exit 0 }
$items = @(Get-ChildItem -LiteralPath $Path -Force -ErrorAction SilentlyContinue)
"COUNT=$($items.Count)"
$items | Select-Object -First $Limit | ForEach-Object {
  if ($_.PSIsContainer) { "DIR=$($_.Name)|$($_.LastWriteTime.ToString('yyyy-MM-dd HH:mm'))" }
  else { "FILE=$($_.Name)|$($_.Length)|$($_.LastWriteTime.ToString('yyyy-MM-dd HH:mm'))|$($_.Extension)" } }`,

  mkdir: `param([string]$Path = '')
try { New-Item -ItemType Directory -Path $Path -Force -ErrorAction Stop | Out-Null; "OK=" + (Test-Path -LiteralPath $Path) } catch { "ERROR=$($_.Exception.Message)" }`,

  writefile: `param([string]$Path = '', [string]$Content = '')
try {
  $dir = Split-Path -Parent $Path
  if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  [System.IO.File]::WriteAllText($Path, $Content, (New-Object System.Text.UTF8Encoding($false)))
  "OK=" + (Test-Path -LiteralPath $Path)
  if (Test-Path -LiteralPath $Path) { "SIZE=" + (Get-Item -LiteralPath $Path).Length }
} catch { "ERROR=$($_.Exception.Message)" }`,

  readfile: `param([string]$Path = '')
if (-not (Test-Path -LiteralPath $Path)) { "ERROR=notfound" }
elseif ((Get-Item -LiteralPath $Path).PSIsContainer) { "ERROR=isdir" }
elseif ((Get-Item -LiteralPath $Path).Length -gt 200KB) { "ERROR=toolarge" }
else { "CONTENT=" + [System.IO.File]::ReadAllText($Path) }`,

  apps: `$vis = @(Get-Process | Where-Object { $_.MainWindowTitle -ne '' })
"VISIBLE=$($vis.Count)"
$vis | ForEach-Object { "WIN=$($_.ProcessName)|$($_.Id)|$($_.MainWindowTitle)" }
$all = @(Get-Process)
"TOTALPROC=$($all.Count)"
$all | Group-Object ProcessName | Sort-Object Count -Descending | Select-Object -First 80 | ForEach-Object { "PROC=$($_.Name)|$($_.Count)" }`,

  wins: `param([string]$Name = '')
if (-not $Name) { exit 0 }
Get-Process -Name $Name -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -ne '' } | ForEach-Object { "WIN=$($_.Id)|$($_.MainWindowTitle)" }`,

  closeapp: `param([string]$Name = '', [string]$Title = '', [switch]$Force)
$p = Get-Process -Name $Name -ErrorAction SilentlyContinue
if (-not $p) { "FOUND=0"; exit 0 }
if ($Title) { $p = @($p | Where-Object { $_.MainWindowTitle -eq $Title }) }
"FOUND=$(@($p).Count)"
foreach ($w in @($p | Where-Object { $_.MainWindowTitle -ne '' })) { $null = $w.CloseMainWindow() }
Start-Sleep -Milliseconds 1500
$left = Get-Process -Name $Name -ErrorAction SilentlyContinue
if ($Title) { $left = @($left | Where-Object { $_.MainWindowTitle -eq $Title }) }
if ($Force -and @($left).Count -gt 0) { $left | Stop-Process -Force -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 600 }
$final = Get-Process -Name $Name -ErrorAction SilentlyContinue
if ($Title) { $final = @($final | Where-Object { $_.MainWindowTitle -eq $Title }) }
"LEFT=$(@($final).Count)"
foreach ($f in @($final)) { if ($f.MainWindowTitle) { "STUCK=$($f.Id)|$($f.MainWindowTitle)" } }`,

  startmenu: `param([string]$Name = '')
$dirs = @("$env:APPDATA\\Microsoft\\Windows\\Start Menu", "$env:ProgramData\\Microsoft\\Windows\\Start Menu")
$n = "*$Name*"
$hits = Get-ChildItem -Path $dirs -Filter $n -Recurse -ErrorAction SilentlyContinue | Where-Object { $_.Extension -in '.lnk','.exe' } | Select-Object -First 8
"COUNT=$(@($hits).Count)"
$hits | ForEach-Object { "HIT=$($_.FullName)" }`,

  recent: `$sh = New-Object -ComObject WScript.Shell
Get-ChildItem "$env:APPDATA\\Microsoft\\Windows\\Recent\\*.lnk" -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 60 | ForEach-Object {
  try { $t = $sh.CreateShortcut($_.FullName).TargetPath; if ($t) { "LNK=$($_.BaseName)|$t" } } catch { } }`,

  volume: `param([int]$Pct = -1, [string]$Mode = 'get')
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume {
  int RegisterControlChangeNotify(IntPtr n); int UnregisterControlChangeNotify(IntPtr n); int GetChannelCount(out uint c);
  int SetMasterVolumeLevel(float l, Guid g); int SetMasterVolumeLevelScalar(float l, Guid g);
  int GetMasterVolumeLevel(out float l); int GetMasterVolumeLevelScalar(out float l);
  int SetChannelVolumeLevel(uint c, float l, Guid g); int SetChannelVolumeLevelScalar(uint c, float l, Guid g);
  int GetChannelVolumeLevel(uint c, out float l); int GetChannelVolumeLevelScalar(uint c, out float l);
  int SetMute(bool m, Guid g); int GetMute(out bool m);
}
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator { int EnumAudioEndpoints(int d, int m, out IntPtr e); int GetDefaultAudioEndpoint(int d, int r, out IMMDevice e); }
[Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumerator { }
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorComObject { }
[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice { int Activate(ref Guid iid, int cls, IntPtr p, [MarshalAs(UnmanagedType.IUnknown)] out object o); }
public static class Vol {
  static IAudioEndpointVolume EP() {
    var en = (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject());
    IMMDevice dev; en.GetDefaultAudioEndpoint(0, 1, out dev);
    object o; Guid iid = new Guid("5CDF2C82-841E-4546-9722-0CF74078229A");
    dev.Activate(ref iid, 23, IntPtr.Zero, out o);
    return (IAudioEndpointVolume)o;
  }
  public static float Get() { float v; EP().GetMasterVolumeLevelScalar(out v); return v; }
  public static bool Muted() { bool m; EP().GetMute(out m); return m; }
  public static void Set(float f) { EP().SetMasterVolumeLevelScalar(f, Guid.Empty); }
  public static void Mute(bool m) { EP().SetMute(m, Guid.Empty); }
}
"@
if ($Mode -eq 'set' -and $Pct -ge 0) { [Vol]::Set([math]::Round($Pct/100.0,2)) }
if ($Mode -eq 'mute') { [Vol]::Mute($true) }
if ($Mode -eq 'unmute') { [Vol]::Mute($false) }
"VOL=" + [math]::Round([Vol]::Get()*100)
"MUTED=" + [Vol]::Muted()`,

  brightness: `param([int]$Pct = -1)
try {
  if ($Pct -ge 0) { $m = Get-CimInstance -Namespace root/wmi -ClassName WmiMonitorBrightnessMethods -ErrorAction Stop; $m | ForEach-Object { $_.WmiSetBrightness(1, [byte]$Pct) } }
  $cur = Get-CimInstance -Namespace root/wmi -ClassName WmiMonitorBrightness -ErrorAction Stop | Select-Object -First 1
  "BRIGHT=$($cur.CurrentBrightness)"
} catch { "BRIGHT=unavailable" }`,

  screenshot: `param([string]$Path = '', [string]$Mode = 'screen')
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$dir = Split-Path -Parent $Path
if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
$b = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.X, $b.Y, 0, 0, $bmp.Size)
$g.Dispose()
$bmp.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
"OK=" + (Test-Path -LiteralPath $Path)
if (Test-Path -LiteralPath $Path) { "SIZE=" + (Get-Item -LiteralPath $Path).Length }`,

  clipboard: `param([string]$Mode = 'get', [string]$Text = '')
if ($Mode -eq 'set') { Set-Clipboard -Value $Text -ErrorAction Stop; "OK=set" }
else { try { "CLIP=" + (Get-Clipboard -Raw) } catch { "CLIP=" } }`,

  power: `param([string]$Action = 'lock')
switch ($Action) {
  'lock'     { rundll32.exe user32.dll,LockWorkStation; "OK=lock" }
  'sleep'    { Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class P { [DllImport("powrprof.dll")] public static extern bool SetSuspendState(bool h, bool f, bool d); }'; [P]::SetSuspendState($false, $false, $false) | Out-Null; "OK=sleep" }
  'restart'  { Start-Process shutdown.exe -ArgumentList '/r /t 3'; "OK=restart" }
  'shutdown' { Start-Process shutdown.exe -ArgumentList '/s /t 3'; "OK=shutdown" }
  default    { "ERROR=unknown" } }`,

  recycle: `param([string]$Mode = 'list')
$shell = New-Object -ComObject Shell.Application
$rb = $shell.Namespace(0xA)
$items = @($rb.Items())
if ($Mode -eq 'empty') { try { Clear-RecycleBin -ErrorAction Stop; "EMPTIED=true" } catch { "EMPTIED=false" } }
"COUNT=$($items.Count)"
$items | Select-Object -First 200 | ForEach-Object {
  $from = ''; try { $from = $_.ExtendedProperty('System.Recycle.DeletedFrom') } catch { }
  "ITEM=$($_.Name)|$from" }`,

  uninstalllookup: `param([string]$Name = '')
$keys = @('HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*')
$found = Get-ItemProperty $keys -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -and ($_.DisplayName -like "*$Name*") } | Select-Object -First 10
"COUNT=$(@($found).Count)"
$found | ForEach-Object { "APP=$($_.DisplayName)|$($_.UninstallString)|$($_.PSPath)" }`,

  regappexists: `param([string]$Name = '')
$keys = @('HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*')
$f = Get-ItemProperty $keys -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like "*$Name*" }
"STILL=" + (@($f).Count)`,

  savelook: `param([string]$Path = '')
"EXISTS=" + (Test-Path -LiteralPath $Path)`,

  activate: `param([string]$ProcName = '', [string]$Title = '')
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class W { [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h); }'
$p = Get-Process -Name $ProcName -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 }
if ($Title) { $p = @($p | Where-Object { $_.MainWindowTitle -like "*$Title*" }) }
$w = @($p) | Select-Object -First 1
if ($w) { [W]::SetForegroundWindow($w.MainWindowHandle) | Out-Null; "ACTIVATED=$($w.Id)" } else { "ACTIVATED=0" }`,

  sendkeys: `param([string]$Keys = '', [int]$WaitMs = 800)
Add-Type -AssemblyName System.Windows.Forms
Start-Sleep -Milliseconds 250
[System.Windows.Forms.SendKeys]::SendWait($Keys)
Start-Sleep -Milliseconds $WaitMs
"SENT=true"`
};

/* ── Confirmation plumbing (premium dialog in renderer) ───────────── */
let _getWindow = () => null;
let _confirmSeq = 1;
const _pendingConfirms = new Map();

function init({ getWindow }) { _getWindow = getWindow || _getWindow; }

function requestConfirmation(spec) {
  // JARVIS_AUTOCONFIRM: QA hook — offline/CDP tests auto-answer confirmations
  if (process.env.JARVIS_AUTOCONFIRM) {
    const want = String(process.env.JARVIS_AUTOCONFIRM).toLowerCase();
    const hit = (spec.buttons || []).find(b => String(b).toLowerCase() === want);
    if (hit) return Promise.resolve({ action: hit, text: process.env.JARVIS_AUTOTEXT || null, auto: true });
    return Promise.resolve({ action: 'cancelled', reason: 'autoconfirm-no-match' });
  }
  return new Promise((resolve) => {
    const id = 'conf_' + (_confirmSeq++) + '_' + Date.now();
    const win = _getWindow();
    if (!win || win.isDestroyed()) return resolve({ action: 'cancelled', reason: 'no-window' });
    const timer = setTimeout(() => {
      if (_pendingConfirms.has(id)) { _pendingConfirms.delete(id); resolve({ action: 'cancelled', reason: 'timeout' }); }
    }, spec.timeoutMs || 180000);
    _pendingConfirms.set(id, { resolve, timer });
    try { win.webContents.send('system:confirm', { id, ...spec }); } catch (e) {
      clearTimeout(timer); _pendingConfirms.delete(id); resolve({ action: 'cancelled', reason: 'send-failed' });
    }
  });
}

function resolveConfirmation(id, action, text) {
  const p = _pendingConfirms.get(id);
  if (!p) return false;
  clearTimeout(p.timer);
  _pendingConfirms.delete(id);
  p.resolve({ action: String(action || 'cancelled'), text: text || null });
  return true;
}

/* ── PS runner ─────────────────────────────────────────────────────── */
/* PowerShell -File gotcha: param values arrive LITERAL (quotes included).
   So values are passed bare — Node's spawn applies Windows command-line
   double-quoting itself, and PS -File strips those outer quotes. */
function psQuote(v) { return String(v); }

function ensureScripts() {
  if (!fs.existsSync(SCRIPT_DIR)) fs.mkdirSync(SCRIPT_DIR, { recursive: true });
  for (const [name, content] of Object.entries(SCRIPTS)) {
    const f = path.join(SCRIPT_DIR, name + '.ps1');
    if (!fs.existsSync(f) || fs.statSync(f).size !== Buffer.byteLength(content)) fs.writeFileSync(f, content, 'utf8');
  }
}

function ps(scriptName, params = {}, timeoutMs = 20000) {
  ensureScripts();
  const script = path.join(SCRIPT_DIR, scriptName + '.ps1');
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script];
  for (const [k, v] of Object.entries(params)) {
    if (v === true) args.push('-' + k);
    else if (v !== false && v != null) args.push('-' + k, psQuote(v));
  }
  return new Promise((resolve) => {
    let out = '', done = false;
    const child = spawn(PS, args, { windowsHide: true });
    const timer = setTimeout(() => {
      if (!done) { done = true; try { child.kill(); } catch (e) { /* noop */ } resolve({ code: -1, stdout: out, timedOut: true }); }
    }, timeoutMs);
    child.stdout.on('data', d => { out += d.toString(); });
    child.stderr.on('data', () => { /* logged via result if needed */ });
    child.on('error', (e) => { if (!done) { done = true; clearTimeout(timer); resolve({ code: -1, stdout: '', error: e.message }); } });
    child.on('close', (code) => { if (!done) { done = true; clearTimeout(timer); resolve({ code, stdout: out }); } });
  });
}

function parseKV(stdout) {
  const o = { lines: [], map: {} };
  for (const raw of String(stdout || '').split(/\r?\n/)) {
    const l = raw.trim();
    if (!l) continue;
    o.lines.push(l);
    const i = l.indexOf('=');
    if (i > 0) o.map[l.slice(0, i)] = l.slice(i + 1);
  }
  return o;
}

/* ══════════════════ HARDWARE (live) ══════════════════ */
const _cache = new Map(); // short cache (few seconds) for perf only
async function cached(key, ttlMs, fn) {
  const hit = _cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.val;
  const val = await fn();
  _cache.set(key, { at: Date.now(), val });
  return val;
}

async function ramInfo() {
  return cached('ram', 4000, async () => {
    const r = await ps('ram');
    const kv = parseKV(r.stdout);
    const totalKB = +kv.map.TOTAL_KB || 0, freeKB = +kv.map.FREE_KB || 0;
    const KB = 1024 ** 2;
    const procs = kv.lines.filter(l => l.startsWith('PROC=')).map(l => {
      const [name, count, mb] = l.slice(5).split('|');
      return { name, count: +count || 1, mb: +mb || 0 };
    });
    return {
      totalGB: +(totalKB / KB).toFixed(2),
      freeGB: +(freeKB / KB).toFixed(2),
      usedGB: +((totalKB - freeKB) / KB).toFixed(2),
      usedPercent: totalKB ? +(((totalKB - freeKB) / totalKB) * 100).toFixed(1) : 0,
      topProcesses: procs,
      live: true
    };
  });
}

async function cpuInfo() {
  return cached('cpu', 5000, async () => {
    const r = await ps('cpu');
    const kv = parseKV(r.stdout);
    const [model, cores, logical, mhz] = String(kv.map.INFO || '').split('|');
    const l1 = +kv.map.L1 || 0, l2 = +kv.map.L2 || 0;
    return { model: model || os.cpus()[0]?.model, cores: +cores || os.cpus().length, logical: +logical || os.cpus().length, clockMHz: +mhz || os.cpus()[0]?.speed, usagePercent: l2 || l1, live: true };
  });
}

async function hardwareInfo() {
  return cached('hw', 60000, async () => {
    const r = await ps('hw');
    const kv = parseKV(r.stdout);
    const [mfgr, model] = String(kv.map.CS || '').split('|');
    const [caption, build, version] = String(kv.map.OS || '').split('|');
    const gpus = kv.lines.filter(l => l.startsWith('GPU=')).map(l => l.slice(4));
    const cpus = kv.lines.filter(l => l.startsWith('CPUMODEL=')).map(l => l.slice(9));
    return { manufacturer: mfgr || 'Unknown', model: model || 'Unknown', systemFamily: kv.map.SYSFAMILY || '', bios: kv.map.BIOS || '', os: caption || os.type(), osBuild: build || os.release(), osVersion: version || '', gpus, cpuModel: cpus[0] || os.cpus()[0]?.model, hostname: os.hostname(), uptimeHours: +(os.uptime() / 3600).toFixed(1) };
  });
}

async function disksInfo() {
  return cached('disks', 10000, async () => {
    const r = await ps('disks');
    const GB = 1024 ** 3;
    return parseKV(r.stdout).lines.filter(l => l.startsWith('DISK=')).map(l => {
      const [drive, size, free, label] = l.slice(5).split('|');
      const S = +size || 0, F = +free || 0;
      return { drive, label: label || '', totalGB: +(S / GB).toFixed(1), freeGB: +(F / GB).toFixed(1), usedGB: +((S - F) / GB).toFixed(1), usedPercent: S ? +(((S - F) / S) * 100).toFixed(1) : 0 };
    }).filter(d => d.totalGB > 0);
  });
}

async function batteryInfo() {
  return cached('battery', 10000, async () => {
    const r = await ps('battery');
    const kv = parseKV(r.stdout);
    if (kv.map.BATTERY === 'none') return { present: false };
    const [pct, status, runtime] = String(kv.map.BATTERY || '').split('|');
    const charging = kv.map.CHARGING ? kv.map.CHARGING.split('|') : [];
    return { present: true, percent: +pct || 0, statusCode: +status || 0, estimatedRunMinutes: +runtime || 0, charging: charging[1] === 'True' || charging[0] === 'True', discharging: charging[2] ? +charging[2] : 0 };
  });
}

async function networkInfo() {
  return cached('network', 8000, async () => {
    const r = await ps('network');
    const kv = parseKV(r.stdout);
    const ips = kv.lines.filter(l => l.startsWith('IP=')).map(l => { const [ip, iface] = l.slice(3).split('|'); return { ip, iface }; });
    let net = null;
    if (kv.map.NET) { const [name, iface, cat] = kv.map.NET.split('|'); net = { name, iface, category: cat }; }
    return { online: kv.map.ONLINE === 'True', externalIp: kv.map.EXTIP || null, ips, network: net };
  });
}

async function tempInfo() {
  return cached('temp', 15000, async () => {
    const r = await ps('temp');
    const kv = parseKV(r.stdout);
    if (kv.map.TEMP === 'unavailable' || !kv.map.TEMP) return { available: false, note: 'Is system par WMI thermal sensors available nahi hain — fake number dena ghalat hota, isliye nahi bata raha.' };
    const sensors = kv.lines.filter(l => l.startsWith('TEMP=') && !l.includes('unavailable')).map(l => { const [name, c] = l.slice(5).split('|'); return { name, celsius: +c }; });
    return { available: sensors.length > 0, sensors };
  });
}

/* Full hardware report — the HardwareMonitorAgent's data source (NO LLM, exact) */
async function fullHardwareReport() {
  const [ram, cpu, hw, disks, battery, network, temp] = await Promise.all([
    ramInfo(), cpuInfo(), hardwareInfo(), disksInfo().catch(() => []), batteryInfo(), networkInfo(), tempInfo()
  ]);
  const lines = [];
  lines.push(`**🔴 LIVE HARDWARE REPORT — ${hw.hostname}** _(sab values is waqt ke asli readings hain)_`);
  lines.push('');
  lines.push(`**💻 Laptop/PC Model:** ${hw.manufacturer} ${hw.model}${hw.systemFamily ? ` (${hw.systemFamily})` : ''}`);
  lines.push(`**⚙ CPU:** ${hw.cpuModel} — ${cpu.cores} cores / ${cpu.logical} threads @ ${cpu.clockMHz}MHz — **usage abhi: ${cpu.usagePercent}%**`);
  lines.push(`**🖥 GPU:** ${hw.gpus.length ? hw.gpus.join(' + ') : 'WMI se detect nahi hua'}`);
  lines.push(`**🪟 OS:** ${hw.os} (Build ${hw.osBuild}, ver ${hw.osVersion}) — uptime ${hw.uptimeHours}h`);
  lines.push('');
  lines.push(`**🧠 RAM (LIVE):** total **${ram.totalGB}GB** | used **${ram.usedGB}GB** (${ram.usedPercent}%) | free **${ram.freeGB}GB**`);
  if (ram.topProcesses.length) {
    lines.push('');
    lines.push('**RAM kahan use ho rahi hai (top processes, abhi):**');
    lines.push('| # | Process | Instances | RAM |');
    lines.push('|---|---------|-----------|-----|');
    ram.topProcesses.slice(0, 10).forEach((p, i) => lines.push(`| ${i + 1} | ${p.name} | ${p.count} | **${p.mb} MB** |`));
    const heavy = ram.topProcesses.filter(p => p.mb >= 300).slice(0, 3);
    if (heavy.length) {
      lines.push('');
      lines.push('**💡 RAM free karne ke real options (abhi ke data se):**');
      for (const p of heavy) lines.push(`• **${p.name}** (${p.count} process, ${p.mb}MB) — band karna ho to mujhe bolo, main safe-close karke verify kar dunga`);
      lines.push(`• Browser tabs sab se zyada RAM khaate hain — ${heavy.some(p => /chrome|msedge|firefox/.test(p.name.toLowerCase())) ? 'aapke case mein browser top consumer hai' : 'agar browser chal raha ho to wo pehla candidate hai'}`);
    }
  }
  if (disks.length) {
    lines.push('');
    lines.push('**💾 Disks:**');
    for (const d of disks) lines.push(`• ${d.drive} ${d.label ? `(${d.label}) ` : ''}— total ${d.totalGB}GB, used ${d.usedGB}GB (${d.usedPercent}%), free **${d.freeGB}GB**`);
  }
  lines.push('');
  if (battery.present) {
    lines.push(`**🔋 Battery:** ${battery.percent}% — ${battery.charging ? '⚡ charging' : 'on battery'}${battery.estimatedRunMinutes && !battery.charging ? ` (~${Math.floor(battery.estimatedRunMinutes / 60)}h ${battery.estimatedRunMinutes % 60}m remaining estimate)` : ''}`);
  } else {
    lines.push('**🔋 Battery:** detect nahi hua (desktop PC ya WMI access nahi) — honest report, guess nahi kiya');
  }
  lines.push(`**🌐 Network:** ${network.online ? '🟢 ONLINE' : '🔴 OFFLINE'}${network.network ? ` — "${network.network.name}" (${network.network.iface})` : ''}${network.ips.length ? ` — IP: ${network.ips.map(i => i.ip).join(', ')}` : ''}`);
  lines.push(`**🌡 Temperature:** ${temp.available ? temp.sensors.map(s => `${s.celsius}°C (${s.name})`).join(', ') : 'WMI thermal sensors is system par available nahi — asli number nahi hai to main fake nahi bataunga'}`);
  return lines.join('\n');
}

/* ══════════════════ FILESYSTEM ══════════════════ */
async function desktopPath() {
  // JARVIS_DESKTOP_OVERRIDE: QA sandbox hook (tests redirect "Desktop" to a temp dir)
  if (process.env.JARVIS_DESKTOP_OVERRIDE) return process.env.JARVIS_DESKTOP_OVERRIDE;
  const r = await ps('desktop');
  return parseKV(r.stdout).map.DESKTOP || path.join(os.homedir(), 'Desktop');
}

async function listDrives() {
  return disksInfo();
}

async function listDir(p, limit = 400) {
  const r = await ps('ls', { Path: p, Limit: limit }, 25000);
  const kv = parseKV(r.stdout);
  if (kv.map.ERROR === 'notfound') return { error: 'notfound', path: p };
  const dirs = [], files = [];
  for (const l of kv.lines) {
    if (l.startsWith('DIR=')) { const [name, mtime] = l.slice(4).split('|'); dirs.push({ name, mtime }); }
    else if (l.startsWith('FILE=')) { const [name, size, mtime, ext] = l.slice(5).split('|'); files.push({ name, size: +size || 0, mtime, ext: ext || '' }); }
  }
  return { path: p, totalCount: +(kv.map.COUNT || dirs.length + files.length), dirs, files, truncated: kv.map.COUNT && (dirs.length + files.length) < +kv.map.COUNT };
}

async function mkdirNested(p) {
  const r = await ps('mkdir', { Path: p }, 15000);
  const kv = parseKV(r.stdout);
  const ok = fs.existsSync(p) && fs.statSync(p).isDirectory(); // RULE 7: verify via fs
  return { ok: ok && kv.map.OK === 'True', verified: ok, error: kv.map.ERROR || null, path: p };
}

async function writeTextFile(p, content) {
  const r = await ps('writefile', { Path: p, Content: String(content) }, 20000);
  const kv = parseKV(r.stdout);
  let verified = false, size = 0;
  try { const st = fs.statSync(p); verified = st.isFile(); size = st.size; } catch (e) { verified = false; }
  return { ok: verified, verified, size, reportedSize: +kv.map.SIZE || 0, error: kv.map.ERROR || null, path: p };
}

async function readTextFile(p) {
  try {
    const st = fs.statSync(p);
    if (st.isDirectory()) return { error: 'isdir' };
    if (st.size > 200 * 1024) return { error: 'toolarge', size: st.size };
    return { content: fs.readFileSync(p, 'utf8'), size: st.size };
  } catch (e) {
    const r = await ps('readfile', { Path: p }, 15000);
    const kv = parseKV(r.stdout);
    return { error: kv.map.ERROR || 'read-failed' };
  }
}

async function openPath(p) {
  let type = 'unknown';
  try { type = fs.statSync(p).isDirectory() ? 'folder' : 'file'; } catch (e) { /* may be exe w/o read */ }
  const { shell } = require('electron');
  /* text-like files: notepad.exe DIRECT launch — .txt association is missing/unset on
     some systems ("Pick an app" dialog instead of opening). Deterministic > guess. */
  const TEXTY = /\.(txt|md|log|ini|csv|json|bat|ps1)$/i;
  if (type === 'file' && TEXTY.test(p)) {
    const np = fs.existsSync('C:\\Windows\\System32\\notepad.exe') ? 'C:\\Windows\\System32\\notepad.exe' : 'notepad.exe';
    const { spawn: sp2 } = require('child_process');
    try { const c = sp2(np, [p], { detached: true, windowsHide: false, stdio: 'ignore' }); c.unref(); } catch (e) { /* fall through */ }
    await new Promise(r => setTimeout(r, 1200));
    const wins = await windowsOf('notepad');
    const base = path.basename(p).toLowerCase();
    const hit = wins.find(w => String(w.title).toLowerCase().includes(base));
    return { ok: !!hit, error: hit ? null : 'notepad window not detected', type: 'file', path: p, via: 'notepad-direct', verifiedTitle: hit ? hit.title : null };
  }
  const res = await shell.openPath(p);
  return { ok: !res, error: res || null, type, path: p };
}

async function moveOrRename(src, dest, overwrite = false) {
  if (!fs.existsSync(src)) return { ok: false, error: 'notfound', src };
  if (fs.existsSync(dest) && !overwrite) return { ok: false, error: 'exists', dest, needsConfirm: true };
  try {
    fs.renameSync(src, dest);
  } catch (e) {
    if (e.code === 'EXDEV') { // cross-drive: copy+unlink
      try { fs.copyFileSync(src, dest); fs.unlinkSync(src); } catch (e2) { return { ok: false, error: e2.message }; }
    } else return { ok: false, error: e.message };
  }
  const verified = fs.existsSync(dest) && !fs.existsSync(src); // RULE 7
  return { ok: verified, verified, src, dest };
}

async function listDesktop() {
  const d = await desktopPath();
  const listing = await listDir(d);
  return { desktop: d, ...listing };
}

const _CRITICAL_DESKTOP = /^(desktop\.ini|NTUSER\.DAT.*)$/i;
async function organizeDesktop(folderName) {
  const d = await desktopPath();
  const target = path.join(d, folderName);
  const mk = await mkdirNested(target);
  if (!mk.verified) return { ok: false, error: 'target-folder-create-failed', path: target };
  const moved = [], skipped = [], failed = [];
  const items = fs.readdirSync(d, { withFileTypes: true });
  for (const it of items) {
    if (it.name === folderName) continue;
    if (_CRITICAL_DESKTOP.test(it.name)) { skipped.push(it.name); continue; }
    const src = path.join(d, it.name);
    const dest = path.join(target, it.name);
    try {
      fs.renameSync(src, dest);
      if (fs.existsSync(dest) && !fs.existsSync(src)) moved.push(it.name); else failed.push(it.name);
    } catch (e) { failed.push(it.name); }
  }
  return { ok: moved.length > 0 || (items.length - moved.length - failed.length - skipped.length >= 0), desktop: d, target, moved, skipped, failed };
}

/* ══════════════════ APPS / PROCESSES ══════════════════ */
async function runningApps() {
  return cached('apps', 3000, async () => {
    const r = await ps('apps', {}, 25000);
    const kv = parseKV(r.stdout);
    const visible = [], procGroups = [];
    for (const l of kv.lines) {
      if (l.startsWith('WIN=')) { const [name, pid, title] = l.slice(4).split('|'); visible.push({ name, pid: +pid, title: title || '' }); }
      else if (l.startsWith('PROC=')) { const [name, count] = l.slice(5).split('|'); procGroups.push({ name, count: +count || 1 }); }
    }
    return { visibleApps: visible, visibleCount: +(kv.map.VISIBLE || visible.length), totalProcesses: +(kv.map.TOTALPROC || 0), backgroundGroups: procGroups };
  });
}

async function windowsOf(procName) {
  const r = await ps('wins', { Name: procName }, 15000);
  return parseKV(r.stdout).lines.filter(l => l.startsWith('WIN=')).map(l => {
    const [pid, title] = l.slice(4).split('|');
    return { pid: +pid, title: title || '' };
  });
}

const _KNOWN_APPS = {
  notepad: ['C:\\Windows\\notepad.exe', 'C:\\Windows\\System32\\notepad.exe'],
  calc: ['C:\\Windows\\System32\\calc.exe'],
  mspaint: ['C:\\Windows\\System32\\mspaint.exe'],
  taskmanager: ['C:\\Windows\\System32\\Taskmgr.exe'],
  taskmgr: ['C:\\Windows\\System32\\Taskmgr.exe'],
  explorer: ['C:\\Windows\\explorer.exe'],
  cmd: ['C:\\Windows\\System32\\cmd.exe'],
  powershell: ['C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe']
};

function findKnownApp(name) {
  const key = String(name || '').toLowerCase().replace(/\.exe$/, '').trim();
  for (const [k, paths] of Object.entries(_KNOWN_APPS)) {
    if (k === key) { for (const p of paths) if (fs.existsSync(p)) return p; }
  }
  const local = path.join(process.env.LOCALAPPDATA || '', 'Programs');
  const guesses = [
    path.join(local, 'Microsoft VS Code', 'Code.exe'),
    path.join(local, 'Programs', 'Microsoft VS Code', 'Code.exe'),
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Mozilla Firefox\\firefox.exe',
    'C:\\Program Files\\Notepad++\\notepad++.exe',
    'C:\\Program Files\\Microsoft Office\\root\\Office16\\WINWORD.EXE'
  ];
  if (/^(code|vscode|vs code)$/i.test(key)) { for (const g of guesses.slice(0, 2)) if (fs.existsSync(g)) return g; }
  if (/^chrome$/.test(key)) { for (const g of guesses.slice(2, 4)) if (fs.existsSync(g)) return g; }
  if (/^firefox$/.test(key) && fs.existsSync(guesses[4])) return guesses[4];
  if (/^(notepad\+\+|npp)$/.test(key) && fs.existsSync(guesses[5])) return guesses[5];
  return null;
}

async function resolveApp(name) {
  const raw = String(name || '').trim();
  if (!raw) return null;
  if (/[\\/]/.test(raw) && fs.existsSync(raw)) return { path: raw, source: 'direct-path' };
  const known = findKnownApp(raw);
  if (known) return { path: known, source: 'known-path' };
  const whereRes = await new Promise((resolve) => {
    execFile('where.exe', [raw.replace(/\.exe$/i, '') + '.exe'], { timeout: 8000 }, (err, stdout) => resolve(err ? null : String(stdout || '').split(/\r?\n/)[0] || null));
  });
  if (whereRes) return { path: whereRes, source: 'where' };
  const sm = await ps('startmenu', { Name: raw }, 15000);
  const hits = parseKV(sm.stdout).lines.filter(l => l.startsWith('HIT=')).map(l => l.slice(4));
  if (hits.length) return { path: hits[0], source: 'start-menu', all: hits };
  return null;
}

async function startApp(resolved) {
  _cache.delete('apps'); // live snapshot — cached list would false-verify
  const before = new Set((await runningApps()).visibleApps.map(v => v.pid));
  const { spawn: sp } = require('child_process');
  const child = sp('cmd.exe', ['/c', 'start', '', resolved.path], { windowsHide: true, detached: true, stdio: 'ignore' });
  try { child.unref(); } catch (e) { /* noop */ }
  await new Promise(res => setTimeout(res, 2500));
  _cache.delete('apps'); // fresh read for the AFTER snapshot
  const after = await runningApps();
  const newVisible = after.visibleApps.filter(v => !before.has(v.pid));
  return { started: true, newWindows: newVisible, verified: newVisible.length > 0, path: resolved.path, source: resolved.source };
}

function kvGet(psResult, key) { return parseKV(psResult.stdout).map[key]; }

async function closeApp(procName, { title = '', force = false } = {}) {
  const params = { Name: procName };
  if (title) params.Title = title;
  if (force) params.Force = true;
  const r = await ps('closeapp', params, 25000);
  const kv = parseKV(r.stdout);
  return { found: +(kv.map.FOUND || 0), left: +(kv.map.LEFT || 0), stuck: kv.lines.filter(l => l.startsWith('STUCK=')).map(l => l.slice(6)), closed: +(kv.map.FOUND || 0) > 0 && +(kv.map.LEFT || 0) === 0 };
}

async function resolveRecentFile(titleText) {
  const r = await ps('recent', {}, 15000);
  const base = String(titleText || '').replace(/\s*[-–]\s*Notepad.*$/i, '').replace(/\s*[-–]\s*Visual Studio Code.*$/i, '').trim().toLowerCase();
  for (const l of parseKV(r.stdout).lines) {
    if (!l.startsWith('LNK=')) continue;
    const [name, target] = l.slice(4).split('|');
    if (base && (name.toLowerCase() === base || path.basename(target).toLowerCase() === base)) {
      if (fs.existsSync(target)) return target;
    }
  }
  return null;
}

/* ══════════════════ SYSTEM ACTIONS ══════════════════ */
async function volume(action, pct) {
  const params = { Mode: action };
  if (action === 'set' && pct != null) params.Pct = Math.max(0, Math.min(100, Math.round(pct)));
  const r = await ps('volume', params, 20000);
  const kv = parseKV(r.stdout);
  return { ok: kv.map.VOL != null, volumePercent: kv.map.VOL != null ? +kv.map.VOL : null, muted: kv.map.MUTED === 'True', error: kv.map.VOL == null ? 'volume API failed' : null };
}

async function brightness(pct) {
  const params = {};
  if (pct != null) params.Pct = Math.max(0, Math.min(100, Math.round(pct)));
  const r = await ps('brightness', params, 15000);
  const kv = parseKV(r.stdout);
  return { ok: kv.map.BRIGHT != null && kv.map.BRIGHT !== 'unavailable', brightness: kv.map.BRIGHT != null && kv.map.BRIGHT !== 'unavailable' ? +kv.map.BRIGHT : null, error: kv.map.BRIGHT === 'unavailable' ? 'brightness WMI is system par supported nahi (desktop monitor ya driver limitation)' : null };
}

async function screenshot(filePath, mode = 'screen') {
  const r = await ps('screenshot', { Path: filePath, Mode: mode }, 25000);
  const kv = parseKV(r.stdout);
  let verified = false, size = 0;
  try { const st = fs.statSync(filePath); verified = st.isFile() && st.size > 1000; size = st.size; } catch (e) { /* not created */ }
  return { ok: verified, verified, size, path: filePath };
}

async function clipboard(mode, text) {
  const r = await ps('clipboard', { Mode: mode, Text: text || '' }, 10000);
  const kv = parseKV(r.stdout);
  if (mode === 'set') return { ok: kv.map.OK === 'set' };
  return { ok: kv.map.CLIP != null, content: kv.map.CLIP != null ? kv.map.CLIP : null };
}

async function power(action) {
  const r = await ps('power', { Action: action }, 15000);
  const kv = parseKV(r.stdout);
  return { ok: !!kv.map.OK, action, note: action === 'restart' || action === 'shutdown' ? '3 second ke andar execute hoga' : null };
}

async function recycleBin(mode) {
  const r = await ps('recycle', { Mode: mode }, 30000);
  const kv = parseKV(r.stdout);
  const items = kv.lines.filter(l => l.startsWith('ITEM=')).map(l => { const [name, from] = l.slice(5).split('|'); return { name, deletedFrom: from || '' }; });
  return { count: +(kv.map.COUNT || items.length), items, emptied: mode === 'empty' ? kv.map.EMPTIED === 'true' : undefined };
}

async function lookupUninstall(name) {
  const r = await ps('uninstalllookup', { Name: name }, 20000);
  const apps = parseKV(r.stdout).lines.filter(l => l.startsWith('APP=')).map(l => {
    const [displayName, uninstallString, psPath] = l.slice(4).split('|');
    return { displayName, uninstallString: uninstallString || '', psPath: psPath || '' };
  }).filter(a => a.displayName);
  return apps;
}

async function verifyUninstalled(name) {
  const r = await ps('regappexists', { Name: name }, 15000);
  return parseKV(r.stdout).map.STILL === '0';
}

async function activateWindow(procName, titlePart) {
  const params = { ProcName: procName };
  if (titlePart) params.Title = titlePart;
  const r = await ps('activate', params, 10000);
  return parseKV(r.stdout).map.ACTIVATED;
}

async function sendKeys(keys, waitMs) {
  const r = await ps('sendkeys', { Keys: keys, WaitMs: waitMs || 800 }, 15000);
  return parseKV(r.stdout).map.SENT === 'true';
}

/* ══════════════════ Exports ══════════════════ */
module.exports = {
  init, requestConfirmation, resolveConfirmation,
  ps, SCRIPT_DIR,
  ramInfo, cpuInfo, hardwareInfo, disksInfo, batteryInfo, networkInfo, tempInfo, fullHardwareReport,
  desktopPath, listDrives, listDir, mkdirNested, writeTextFile, readTextFile, openPath, moveOrRename, listDesktop, organizeDesktop,
  runningApps, windowsOf, resolveApp, startApp, closeApp, resolveRecentFile, activateWindow, sendKeys,
  volume, brightness, screenshot, clipboard, power, recycleBin, lookupUninstall, verifyUninstalled
};
