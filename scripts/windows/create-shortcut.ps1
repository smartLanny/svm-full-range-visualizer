# Creates the desktop shortcut "SVM <Chinese app name>.lnk" that opens the offline build
# (release\SVM-Visualizer.html) as an app window in Microsoft Edge or Google Chrome.
# Called by create-desktop-shortcut.bat. This file is ASCII-only on purpose (Windows
# PowerShell 5.1 reads BOM-less scripts in the ANSI code page); non-ASCII text is built from
# code points.
#
# Exit codes: 0 = app-window shortcut created, 2 = created but opens in the default browser
# (no Edge / Chrome found), 3 = created with an ASCII file name, 1 = failed.

$ErrorActionPreference = 'Stop'

# Join-Path that tolerates an unset base folder (e.g. ProgramFiles(x86) on 32-bit Windows).
function Under($base, $rel) {
    if ($base) { return (Join-Path $base $rel) }
    return $null
}

function Find-Browser {
    $candidates = @(
        (Under ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'),
        (Under $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe'),
        (Under $env:LOCALAPPDATA 'Microsoft\Edge\Application\msedge.exe')
    )
    foreach ($exe in @('msedge.exe', 'chrome.exe')) {
        foreach ($hive in @('HKCU:', 'HKLM:')) {
            try {
                $p = (Get-ItemProperty -LiteralPath "$hive\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\$exe" -ErrorAction Stop).'(default)'
                if ($p) { $candidates += $p.Trim('"') }
            } catch { }
        }
        if ($exe -eq 'msedge.exe') {
            $candidates += @(
                (Under $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'),
                (Under ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe'),
                (Under $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe')
            )
        }
    }
    foreach ($c in $candidates) {
        if ($c -and (Test-Path -LiteralPath $c -PathType Leaf)) { return $c }
    }
    return $null
}

try {
    $root = $env:SVM_ROOT
    if (-not $root) { $root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot) }
    $root = $root.TrimEnd('\')
    $html = Join-Path $root 'release\SVM-Visualizer.html'
    $ico = Join-Path $root 'release\icon.ico'
    if (-not (Test-Path -LiteralPath $html -PathType Leaf)) { exit 1 }

    # file:/// URL, spaces and non-ASCII characters percent-encoded (Chromium requires ASCII).
    $url = ([System.Uri]$html).AbsoluteUri
    $browser = Find-Browser

    # "SVM " + U+5168 U+8303 U+56F4 U+53EF U+89C6 U+5316 (the app's Chinese name).
    $cjk = -join ([char[]](0x5168, 0x8303, 0x56F4, 0x53EF, 0x89C6, 0x5316))
    $desktop = [Environment]::GetFolderPath('Desktop')
    if (-not $desktop) { $desktop = Join-Path $env:USERPROFILE 'Desktop' }

    $shell = New-Object -ComObject WScript.Shell
    $code = 0
    $names = @("SVM $cjk.lnk", 'SVM Visualizer.lnk')
    foreach ($name in $names) {
        try {
            $lnk = $shell.CreateShortcut((Join-Path $desktop $name))
            if ($browser) {
                $lnk.TargetPath = $browser
                $lnk.Arguments = '--app="' + $url + '" --start-maximized'
            } else {
                $lnk.TargetPath = $html
                $lnk.Arguments = ''
                $code = 2
            }
            $lnk.WorkingDirectory = $root
            if (Test-Path -LiteralPath $ico -PathType Leaf) { $lnk.IconLocation = "$ico,0" }
            $lnk.Description = "SVM $cjk"
            $lnk.WindowStyle = 3
            $lnk.Save()
            if ($name -ne $names[0] -and $code -eq 0) { $code = 3 }
            exit $code
        } catch {
            # Retry with the ASCII name (some systems cannot save non-ASCII shortcut names).
        }
    }
    exit 1
} catch {
    Write-Host $_.Exception.Message
    exit 1
}
