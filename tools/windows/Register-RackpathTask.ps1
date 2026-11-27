<#
.SYNOPSIS
    Installs Push-RackpathDhcp.ps1 as a scheduled task (default: hourly) and
    stores the Rackpath import token protected on this machine.

.DESCRIPTION
    Run once, as an administrator, on the DHCP server (or a domain
    controller running DHCP):
      1. copies Push-RackpathDhcp.ps1 to $InstallPath;
      2. stores the token in $env:ProgramData\Rackpath\token.bin, encrypted
         with DPAPI (machine scope) and readable only by the task's account,
         SYSTEM and Administrators;
      3. registers the scheduled task "Rackpath DHCP push".

    Recommended: run the task as a group managed service account (gMSA),
    e.g. CORP\svc-rackpath$, so there's no password to manage. Give it
    membership of "DHCP Users" and read access to the DNS zones. Without
    -RunAs the task runs as SYSTEM.

.EXAMPLE
    .\Register-RackpathTask.ps1 -RackpathUrl https://rackpath.example.com `
        -RunAs 'CORP\svc-rackpath$' -DnsZones corp.example.com,30.20.10.in-addr.arpa -RunNow
#>
#Requires -RunAsAdministrator
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string] $RackpathUrl,

    # The import token Rackpath showed when the integration was created.
    # Prompted for (hidden) when not given.
    [SecureString] $Token,

    # gMSA (ending in $) or other account to run as; default SYSTEM.
    [string] $RunAs,

    [string[]] $DnsZones = @(),

    [switch] $IncludeLeases,

    [ValidateRange(5, 1440)]
    [int] $EveryMinutes = 60,

    [string] $InstallPath = (Join-Path $env:ProgramFiles 'Rackpath'),

    [switch] $AllowHttp,

    [switch] $RunNow
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$source = Join-Path $PSScriptRoot 'Push-RackpathDhcp.ps1'
if (-not (Test-Path -LiteralPath $source)) { throw "Push-RackpathDhcp.ps1 must be next to this script." }
if ($RackpathUrl -notmatch '^https://' -and -not ($AllowHttp -and $RackpathUrl -match '^http://')) {
    throw "RackpathUrl must start with https:// (use -AllowHttp only on a lab network)."
}
if (-not $Token) { $Token = Read-Host -AsSecureString -Prompt 'Rackpath import token' }

# 1. The script.
New-Item -ItemType Directory -Force -Path $InstallPath | Out-Null
$script = Join-Path $InstallPath 'Push-RackpathDhcp.ps1'
Copy-Item -LiteralPath $source -Destination $script -Force

# 2. The token, DPAPI-protected and locked down.
$dataDir = Join-Path $env:ProgramData 'Rackpath'
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
$tokenPath = Join-Path $dataDir 'token.bin'
Add-Type -AssemblyName System.Security
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Token)
try {
    $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
} finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
}
$bytes = [System.Text.Encoding]::UTF8.GetBytes($plain.Trim())
$protected = [System.Security.Cryptography.ProtectedData]::Protect(
    $bytes, $null, [System.Security.Cryptography.DataProtectionScope]::LocalMachine)
[System.IO.File]::WriteAllBytes($tokenPath, $protected)
$plain = $null

$acl = New-Object System.Security.AccessControl.FileSecurity
$acl.SetAccessRuleProtection($true, $false)
$principals = @('NT AUTHORITY\SYSTEM', 'BUILTIN\Administrators')
if ($RunAs) { $principals += $RunAs }
foreach ($p in $principals) {
    $rights = if ($p -eq $RunAs) { 'Read' } else { 'FullControl' }
    $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($p, $rights, 'Allow')))
}
Set-Acl -LiteralPath $tokenPath -AclObject $acl

# 3. The scheduled task.
$arguments = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', "`"$script`"",
    '-RackpathUrl', "`"$RackpathUrl`"")
if ($DnsZones.Count -gt 0) { $arguments += @('-DnsZones', ($DnsZones -join ',')) }
if ($IncludeLeases) { $arguments += '-IncludeLeases' }
if ($AllowHttp) { $arguments += '-AllowHttp' }
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ($arguments -join ' ')
$trigger = New-ScheduledTaskTrigger -Once -At ((Get-Date).AddMinutes(1)) `
    -RepetitionInterval (New-TimeSpan -Minutes $EveryMinutes)
if ($RunAs) {
    # gMSAs log on with "Password": Windows fetches it from Active Directory.
    $principal = New-ScheduledTaskPrincipal -UserId $RunAs -LogonType Password
} else {
    $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
}
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -MultipleInstances IgnoreNew -StartWhenAvailable
Register-ScheduledTask -TaskName 'Rackpath DHCP push' -Description 'Sends DHCP scopes and static DNS records to Rackpath (read-only).' `
    -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null

Write-Output "Installed. The task 'Rackpath DHCP push' runs every $EveryMinutes minute(s)."
if ($RunNow) {
    Start-ScheduledTask -TaskName 'Rackpath DHCP push'
    Write-Output "Started a first run; check the integration's sync history in Rackpath."
}
