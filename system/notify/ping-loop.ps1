param(
    [Parameter(Mandatory=$true)][string]$LockFile,
    [int]$MaxPings = 5,
    [int]$IntervalSeconds = 30
)

$ErrorActionPreference = "SilentlyContinue"

$muteFile = Join-Path $env:USERPROFILE ".claude\ping-muted"
if (Test-Path $muteFile) { return }

Add-Type -Namespace ClaudePing -Name User32 -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern System.IntPtr GetForegroundWindow();
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern uint GetWindowThreadProcessId(System.IntPtr hWnd, out uint lpdwProcessId);
'@

$terminalProcs = @(
    'WindowsTerminal','conhost','powershell','pwsh','cmd',
    'bash','sh','wsl','wt','mintty','git-bash','alacritty',
    'Code','Cursor','devenv','node'
)

function Test-UserAtTerminal {
    $hwnd = [ClaudePing.User32]::GetForegroundWindow()
    if ($hwnd -eq [IntPtr]::Zero) { return $false }
    $procId = 0
    [void][ClaudePing.User32]::GetWindowThreadProcessId($hwnd, [ref]$procId)
    if ($procId -eq 0) { return $false }
    $p = Get-Process -Id $procId -ErrorAction SilentlyContinue
    if (-not $p) { return $false }
    return $terminalProcs -contains $p.ProcessName
}

$myToken = [guid]::NewGuid().ToString()
Set-Content -Path $LockFile -Value $myToken -Force

for ($i = 1; $i -le $MaxPings; $i++) {
    if (-not (Test-Path $LockFile)) { return }
    $current = Get-Content $LockFile -ErrorAction SilentlyContinue
    if ($current -ne $myToken) { return }

    if (-not (Test-UserAtTerminal)) {
        [System.Media.SystemSounds]::Asterisk.Play()
    }

    if ($i -lt $MaxPings) {
        Start-Sleep -Seconds $IntervalSeconds
    }
}

if ((Test-Path $LockFile) -and ((Get-Content $LockFile -ErrorAction SilentlyContinue) -eq $myToken)) {
    Remove-Item $LockFile -Force -ErrorAction SilentlyContinue
}
