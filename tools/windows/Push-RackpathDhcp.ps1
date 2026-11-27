<#
.SYNOPSIS
    Sends this server's DHCP scopes, reservations and static DNS records to
    Rackpath. Read-only on the Windows side.

.DESCRIPTION
    Collects, with Microsoft's own DhcpServer and DnsServer modules:
      - IPv4 and IPv6 scopes with options 3 (router), 6 (DNS servers) and
        15 (domain name), exclusion ranges and reservations;
      - static A, AAAA and PTR records from the zones you list (records that
        DHCP clients registered dynamically carry a timestamp and are
        skipped, so laptops and phones never flood the documentation);
      - optionally, the current leases (for Rackpath's lease layer).
    Then posts one gzip-compressed JSON document to
    <RackpathUrl>/api/imports/windows-dhcp with the import token.

    Rights needed: membership of the local "DHCP Users" group on the DHCP
    server, and read access to the DNS zones you list. Nothing is changed.

    The token is read from a file protected with DPAPI (machine scope) and
    an access list limited to the task's account and administrators. Use
    Register-RackpathTask.ps1 to create it and the scheduled task.

.EXAMPLE
    .\Push-RackpathDhcp.ps1 -RackpathUrl https://rackpath.example.com -DnsZones corp.example.com,30.20.10.in-addr.arpa

.NOTES
    Works with Windows PowerShell 5.1 (Windows Server 2016 and later).
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string] $RackpathUrl,

    [string] $TokenPath = (Join-Path $env:ProgramData 'Rackpath\token.bin'),

    [string] $DhcpServer = $env:COMPUTERNAME,

    [string] $DnsServer = $env:COMPUTERNAME,

    # Forward and reverse zones to read static records from. Empty: no DNS.
    [string[]] $DnsZones = @(),

    [switch] $IncludeLeases,

    # Only for testing on a lab network: plain HTTP sends the token unencrypted.
    [switch] $AllowHttp
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

function Fail([string] $message) {
    Write-Error $message -ErrorAction Continue
    exit 1
}

$RackpathUrl = $RackpathUrl.TrimEnd('/')
if ($RackpathUrl -notmatch '^https://' -and -not ($AllowHttp -and $RackpathUrl -match '^http://')) {
    Fail "RackpathUrl must start with https:// (use -AllowHttp only on a lab network)."
}

# --- the token -------------------------------------------------------------
if (-not (Test-Path -LiteralPath $TokenPath)) {
    Fail "No token file at $TokenPath. Run Register-RackpathTask.ps1 first."
}
Add-Type -AssemblyName System.Security
try {
    $protected = [System.IO.File]::ReadAllBytes($TokenPath)
    $plain = [System.Security.Cryptography.ProtectedData]::Unprotect(
        $protected, $null, [System.Security.Cryptography.DataProtectionScope]::LocalMachine)
    $token = [System.Text.Encoding]::UTF8.GetString($plain)
} catch {
    Fail "Couldn't read the token file (is this the account the task runs as?): $($_.Exception.Message)"
}

Import-Module DhcpServer
if ($DnsZones.Count -gt 0) { Import-Module DnsServer }

function OptionMap($values) {
    $map = @{}
    foreach ($o in @($values)) {
        if ($null -ne $o -and @(3, 6, 15, 23, 24) -contains [int]$o.OptionId) {
            $map[[string]$o.OptionId] = @($o.Value | ForEach-Object { [string]$_ })
        }
    }
    return $map
}

# --- DHCP ------------------------------------------------------------------
$serverOptions = OptionMap (Get-DhcpServerv4OptionValue -ComputerName $DhcpServer -ErrorAction SilentlyContinue)

$scopesV4 = @()
foreach ($s in @(Get-DhcpServerv4Scope -ComputerName $DhcpServer)) {
    $id = $s.ScopeId.IPAddressToString
    $exclusions = @(Get-DhcpServerv4ExclusionRange -ComputerName $DhcpServer -ScopeId $id -ErrorAction SilentlyContinue |
        ForEach-Object { @{ start = $_.StartRange.IPAddressToString; end = $_.EndRange.IPAddressToString } })
    $reservations = @(Get-DhcpServerv4Reservation -ComputerName $DhcpServer -ScopeId $id -ErrorAction SilentlyContinue |
        ForEach-Object { @{ ip = $_.IPAddress.IPAddressToString; client_id = [string]$_.ClientId; name = [string]$_.Name; description = [string]$_.Description } })
    $scopesV4 += @{
        scope_id     = $id
        subnet_mask  = $s.SubnetMask.IPAddressToString
        name         = [string]$s.Name
        description  = [string]$s.Description
        start_range  = $s.StartRange.IPAddressToString
        end_range    = $s.EndRange.IPAddressToString
        state        = [string]$s.State
        options      = OptionMap (Get-DhcpServerv4OptionValue -ComputerName $DhcpServer -ScopeId $id -ErrorAction SilentlyContinue)
        exclusions   = $exclusions
        reservations = $reservations
    }
}

$scopesV6 = @()
foreach ($s in @(Get-DhcpServerv6Scope -ComputerName $DhcpServer -ErrorAction SilentlyContinue)) {
    $prefix = $s.Prefix.IPAddressToString
    $exclusions = @(Get-DhcpServerv6ExclusionRange -ComputerName $DhcpServer -Prefix $prefix -ErrorAction SilentlyContinue |
        ForEach-Object { @{ start = $_.StartRange.IPAddressToString; end = $_.EndRange.IPAddressToString } })
    $reservations = @(Get-DhcpServerv6Reservation -ComputerName $DhcpServer -Prefix $prefix -ErrorAction SilentlyContinue |
        ForEach-Object { @{ ip = $_.IPAddress.IPAddressToString; client_id = [string]$_.ClientDuid; name = [string]$_.Name; description = [string]$_.Description } })
    $scopesV6 += @{
        prefix        = $prefix
        prefix_length = 64
        name          = [string]$s.Name
        description   = [string]$s.Description
        options       = OptionMap (Get-DhcpServerv6OptionValue -ComputerName $DhcpServer -Prefix $prefix -ErrorAction SilentlyContinue)
        exclusions    = $exclusions
        reservations  = $reservations
    }
}

$leases = $null
if ($IncludeLeases) {
    $leases = @()
    foreach ($s in $scopesV4) {
        $leases += @(Get-DhcpServerv4Lease -ComputerName $DhcpServer -ScopeId $s.scope_id -ErrorAction SilentlyContinue |
            Where-Object { [string]$_.AddressState -like 'Active*' } |
            ForEach-Object {
                $expires = $null
                if ($_.LeaseExpiryTime) { $expires = $_.LeaseExpiryTime.ToUniversalTime().ToString('o') }
                @{ ip = $_.IPAddress.IPAddressToString; client_id = [string]$_.ClientId; hostname = [string]$_.HostName; expires = $expires; state = [string]$_.AddressState }
            })
    }
}

# --- DNS -------------------------------------------------------------------
$dns = $null
if ($DnsZones.Count -gt 0) {
    $dns = @()
    foreach ($zone in $DnsZones) {
        $records = Get-DnsServerResourceRecord -ComputerName $DnsServer -ZoneName $zone |
            Where-Object { $null -eq $_.Timestamp -and @('A', 'AAAA', 'PTR') -contains $_.RecordType }
        foreach ($r in @($records)) {
            $data = switch ($r.RecordType) {
                'A' { $r.RecordData.IPv4Address.IPAddressToString }
                'AAAA' { $r.RecordData.IPv6Address.IPAddressToString }
                'PTR' { $r.RecordData.PtrDomainName }
            }
            $dns += @{ zone = $zone; name = $r.HostName; type = [string]$r.RecordType; data = [string]$data }
        }
    }
}

# --- send ------------------------------------------------------------------
$doc = [ordered]@{
    version        = 1
    server         = $DhcpServer
    generated_at   = (Get-Date).ToUniversalTime().ToString('o')
    server_options = $serverOptions
    scopes_v4      = $scopesV4
    scopes_v6      = $scopesV6
    dns            = $dns
    leases         = $leases
}
$json = ConvertTo-Json -InputObject $doc -Depth 8 -Compress

$raw = [System.Text.Encoding]::UTF8.GetBytes($json)
$buffer = New-Object System.IO.MemoryStream
$gzip = New-Object System.IO.Compression.GZipStream($buffer, [System.IO.Compression.CompressionMode]::Compress)
$gzip.Write($raw, 0, $raw.Length)
$gzip.Close()
$body = $buffer.ToArray()

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
try {
    $response = Invoke-WebRequest -UseBasicParsing -Method Post -Uri "$RackpathUrl/api/imports/windows-dhcp" `
        -Headers @{ Authorization = "Bearer $token"; 'Content-Encoding' = 'gzip' } `
        -ContentType 'application/json' -Body $body
    $result = $response.Content | ConvertFrom-Json
    if ($result.held) {
        Write-Output "Rackpath held this import for an administrator to approve (it changes a lot at once)."
    } else {
        Write-Output "Sent $($scopesV4.Count) IPv4 and $($scopesV6.Count) IPv6 scope(s) to Rackpath."
    }
    exit 0
} catch {
    $status = $null
    if ($_.Exception.Response) { $status = [int]$_.Exception.Response.StatusCode }
    switch ($status) {
        401 { Fail "Rackpath refused the token (was it rotated or the integration deleted?)." }
        429 { Fail "Rackpath accepts one import per minute; try again shortly." }
        default { Fail "Sending to Rackpath failed: $($_.Exception.Message)" }
    }
}
