#requires -Version 5.1
<#
.SYNOPSIS
Provision the pinned, signed VirtualDrivers 25.7.23 AMD64 fallback driver.
.EXAMPLE
.\windows-provision-display.ps1 -PackageDirectory C:\staging\VirtualDisplayDriver -DevconPath C:\staging\Dependencies\devcon.exe
.EXAMPLE
.\windows-provision-display.ps1 -Commit
.EXAMPLE
.\windows-provision-display.ps1 -EnableForValidation
.DESCRIPTION
Run in native 64-bit elevated Windows PowerShell. Download/extract and verify
the official archives beforehand; this script independently pins all installed
files and validates their Windows signatures. It downloads nothing and never
changes Secure Boot, testsigning, physical displays, or the Root certificate
store. Only the verified signer leaf may be added to LocalMachine TrustedPublisher.

An independent SYSTEM task is armed BEFORE staging/installing. It rolls back
after ten minutes or at next boot unless the parent explicitly calls -Commit
AFTER frame/physical-display validation. The task uses process-scoped
-ExecutionPolicy Bypass; no persistent execution policy is changed.

DevCon briefly activates the new adapter. Provisioning immediately disables
that exact instance and publishes state=installed for parent validation. The
plugin must re-read display-fallback.json before EVERY device operation and
accept only installed/committed. -Commit changes authorization state and removes
the watchdog; it never enables a device. Manual rollback requires stopping the
plugin or turning its policy off first, then windows-rollback-display.ps1
-PolicyStopped. Partial/aborted/foreign installations are never taken over.
Use a dedicated powershell.exe process: after the deadline the watchdog may
terminate that exact recorded process if it is stuck holding the lifecycle lock.
#>
[CmdletBinding(DefaultParameterSetName = 'Install')]
param(
    [Parameter(Mandatory = $true, ParameterSetName = 'Install')][string]$PackageDirectory,
    [Parameter(Mandatory = $true, ParameterSetName = 'Install')][string]$DevconPath,
    [Parameter(Mandatory = $true, ParameterSetName = 'Commit')][switch]$Commit,
    [Parameter(Mandatory = $true, ParameterSetName = 'Validate')][switch]$EnableForValidation
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'windows-rollback-display.ps1') -LibraryOnly

function Assert-VddPayload([string]$Package, [string]$Devcon) {
    $expected = Get-VddIdentity
    $files = @(
        @{ Path = (Join-Path $Package 'MttVDD.inf'); Hash = $expected.InfHash; Signed = $false },
        @{ Path = (Join-Path $Package 'MttVDD.dll'); Hash = $expected.DllHash; Signed = $true },
        @{ Path = (Join-Path $Package 'mttvdd.cat'); Hash = $expected.CatHash; Signed = $true },
        @{ Path = $Devcon; Hash = $expected.DevconHash; Signed = $true }
    )
    foreach ($file in $files) {
        Assert-VddNoReparsePath $file.Path
        if (-not (Test-Path -LiteralPath $file.Path -PathType Leaf) -or
            (Get-FileHash -LiteralPath $file.Path -Algorithm SHA256).Hash -ine $file.Hash) {
            throw "Pinned 25.7.23 payload hash mismatch: $($file.Path)"
        }
        if ($file.Signed) {
            $signature = Get-AuthenticodeSignature -LiteralPath $file.Path
            if ($signature.Status -ne 'Valid' -or $null -eq $signature.SignerCertificate) {
                throw "Windows does not accept the signature: $($file.Path)"
            }
            if ($file.Path -ieq $Devcon) {
                if ($signature.SignerCertificate.GetNameInfo('SimpleName', $false) -ne 'Microsoft Corporation') {
                    throw 'Unexpected DevCon publisher.'
                }
            } elseif ($signature.SignerCertificate.Thumbprint -ne $expected.Thumbprint) {
                throw 'Unexpected VDD signer; only the pinned SignPath leaf is allowed.'
            }
        }
    }
}

function Assert-VddUnownedStateAbsent {
    $paths = Get-VddPaths
    if (@(Get-VddNodes).Count -gt 0) { throw 'An existing VDD device is unowned. Refusing takeover or another devnode.' }
    foreach ($path in @($paths.Runtime, $paths.Manifest, $paths.Data,
        'C:\VirtualDisplayDriver\vdd_settings.xml', 'C:\VirtualDisplayDriver\option.txt',
        'C:\VirtualDisplayDriver\adapter.txt', 'C:\VirtualDisplayDriver\user_edid.bin')) {
        Assert-VddNoReparsePath $path
        if (Test-Path -LiteralPath $path) { throw "Existing display configuration/transaction is unowned: $path" }
    }
    if (Test-Path -LiteralPath (Get-VddIdentity).Registry) {
        throw 'Existing VirtualDisplayDriver registry configuration (including VDDPATH) will not be overwritten.'
    }
}

function Register-VddWatchdog($Manifest) {
    $paths = Get-VddPaths
    $exe = Join-Path $env:windir 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $arguments = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $paths.Rollback + '" -Watchdog'
    $action = New-ScheduledTaskAction -Execute $exe -Argument $arguments
    $once = New-ScheduledTaskTrigger -Once -At ([DateTime]::Parse($Manifest.deadlineUtc).ToLocalTime()) `
        -RepetitionInterval (New-TimeSpan -Minutes 2) -RepetitionDuration (New-TimeSpan -Days 1)
    $startup = New-ScheduledTaskTrigger -AtStartup
    $principal = New-ScheduledTaskPrincipal -UserId 'S-1-5-18' -LogonType ServiceAccount -RunLevel Highest
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 8) `
        -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
    Register-ScheduledTask -TaskName (Get-VddTaskName $Manifest) -TaskPath '\' -Action $action `
        -Trigger @($once, $startup) -Principal $principal -Settings $settings `
        -Description 'Rollback an uncommitted Paseo virtual display transaction; only its exact owned instance.' `
        -ErrorAction Stop | Out-Null
    $Manifest.watchdogArmed = $true
    Save-VddManifest $Manifest
}

function Complete-VddCommit {
    $paths = Get-VddPaths
    $manifest = Read-VddManifest
    if ($manifest.state -notin @('installed', 'committed')) { throw 'Only an installed transaction can be explicitly committed.' }
    if ($manifest.state -eq 'installed' -and [DateTime]::UtcNow -ge [DateTime]::Parse($manifest.deadlineUtc).ToUniversalTime()) {
        throw 'Validation deadline expired; do not race the rollback watchdog.'
    }
    Assert-VddProtectedPath $paths.Runtime
    $runtime = [IO.File]::ReadAllText($paths.Runtime) | ConvertFrom-Json
    if ($runtime.version -ne 1 -or $runtime.owner -ne (Get-VddIdentity).Owner -or
        $runtime.deviceInstance -ine $manifest.deviceInstance -or $runtime.driverInf -ine $manifest.driverInf -or
        $runtime.state -notin @('installed', 'committed')) { throw 'Runtime authorization no longer matches the transaction.' }
    Assert-VddDevice $manifest.deviceInstance $manifest
    $runtime.state = 'committed'
    Write-VddJson $paths.Runtime $runtime
    $manifest.state = 'committed'; $manifest.committedUtc = [DateTime]::UtcNow.ToString('o')
    Save-VddManifest $manifest
    Remove-VddWatchdog $manifest
    $manifest.watchdogArmed = $false; Save-VddManifest $manifest
    Write-Output "Explicitly committed. Watchdog disarmed; no device state was changed. $($paths.Runtime)"
}

function Enable-VddForValidation {
    $paths = Get-VddPaths
    $manifest = Read-VddManifest
    if ($manifest.state -ne 'installed' -or -not $manifest.watchdogArmed -or
        [DateTime]::UtcNow -ge [DateTime]::Parse($manifest.deadlineUtc).ToUniversalTime()) {
        throw 'Validation requires an installed, unexpired transaction with its watchdog armed.'
    }
    Assert-VddProtectedPath $paths.Runtime
    $runtime = [IO.File]::ReadAllText($paths.Runtime) | ConvertFrom-Json
    if ($runtime.version -ne 1 -or $runtime.owner -ne (Get-VddIdentity).Owner -or
        $runtime.state -ne 'installed' -or $runtime.deviceInstance -ine $manifest.deviceInstance -or
        $runtime.driverInf -ine $manifest.driverInf) { throw 'Runtime validation authorization changed.' }
    Assert-VddDevice $manifest.deviceInstance $manifest
    Invoke-VddNative (Join-Path $env:windir 'System32\pnputil.exe') @('/enable-device', $manifest.deviceInstance) $manifest
    Write-Output 'Only the transaction-owned VDD was enabled for administrator validation. The rollback watchdog remains armed.'
}

Assert-VddAdministrator
$provisionPaths = Get-VddPaths
Assert-VddNoReparsePath $provisionPaths.Root
if ($Commit -or $EnableForValidation) {
    Assert-VddProtectedPath $provisionPaths.Root
    $provisionLock = Enter-VddLock
    try {
        if ($Commit) { Complete-VddCommit } else { Enable-VddForValidation }
    } finally { $provisionLock.Dispose() }
    return
}

$PackageDirectory = (Resolve-Path -LiteralPath $PackageDirectory).ProviderPath
$DevconPath = (Resolve-Path -LiteralPath $DevconPath).ProviderPath
Assert-VddPayload $PackageDirectory $DevconPath
Assert-VddUnownedStateAbsent
if (Test-Path -LiteralPath $provisionPaths.Root) { Assert-VddProtectedPath $provisionPaths.Root }
else {
    New-Item -ItemType Directory -Path $provisionPaths.Root -ErrorAction Stop | Out-Null
    Set-VddDirectoryAcl $provisionPaths.Root -UsersRead
}
$provisionLock = Enter-VddLock
$provisionManifest = $null
try {
    # Recheck inside the lock before recording ownership or mutating any driver.
    Assert-VddUnownedStateAbsent
    # Record ALL instance IDs independently of hardware-property queries. An old
    # node whose hardware ID becomes readable later can never become our device.
    $beforeDevices = @(Get-PnpDevice -ErrorAction Stop | ForEach-Object { $_.InstanceId })
    if ($beforeDevices.Count -eq 0) { throw 'Cannot establish a complete PnP instance baseline.' }
    $beforePackages = @(Get-VddPackages)
    if (@($beforePackages | Where-Object { [IO.Path]::GetFileName($_.OriginalFileName) -ieq 'mttvdd.inf' }).Count -gt 0) {
        throw 'An unowned MttVDD driver-store package already exists. Refusing takeover.'
    }
    New-Item -ItemType Directory -Path $provisionPaths.Data -ErrorAction Stop | Out-Null
    Set-VddDirectoryAcl $provisionPaths.Data
    foreach ($directory in @($provisionPaths.Package, $provisionPaths.Config)) {
        New-Item -ItemType Directory -Path $directory -ErrorAction Stop | Out-Null
        Set-VddDirectoryAcl $directory
    }
    $identity = Get-VddIdentity
    $store = [Security.Cryptography.X509Certificates.X509Store]::new('TrustedPublisher', 'LocalMachine')
    $store.Open('ReadOnly')
    try { $publisherPresent = @($store.Certificates | Where-Object { $_.Thumbprint -eq $identity.Thumbprint }).Count -gt 0 }
    finally { $store.Close() }
    $provisionManifest = [pscustomobject]@{
        version = 1; owner = $identity.Owner; transactionId = [guid]::NewGuid().ToString('N')
        state = 'preparing'; createdUtc = [DateTime]::UtcNow.ToString('o'); updatedUtc = $null
        deadlineUtc = [DateTime]::UtcNow.AddMinutes(10).ToString('o'); committedUtc = $null
        beforeDevices = $beforeDevices; beforePackages = @($beforePackages | ForEach-Object { $_.Driver })
        baseline = [pscustomobject]@{ runtimeExisted = $false; configExisted = $false; registryKeyExisted = $false }
        deviceInstance = $null; driverInf = $null
        stageStarted = $false; installStarted = $false; watchdogArmed = $false
        trustedPublisherWasPresent = $publisherPresent; certificateIntent = $false; registryIntent = $false
        provisionerProcess = [pscustomobject]@{
            id = $PID; startedUtc = (Get-Process -Id $PID).StartTime.ToUniversalTime().ToString('o')
            file = (Get-Process -Id $PID).MainModule.FileName
        }
        activeProcess = $null; rollbackComplete = $false; rollbackErrors = @(); lastError = $null
    }
    Save-VddManifest $provisionManifest
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'windows-rollback-display.ps1') -Destination $provisionPaths.Rollback
    Set-VddFileOwner $provisionPaths.Rollback
    foreach ($name in @('MttVDD.inf', 'MttVDD.dll', 'mttvdd.cat')) {
        Copy-Item -LiteralPath (Join-Path $PackageDirectory $name) -Destination (Join-Path $provisionPaths.Package $name)
        Set-VddFileOwner (Join-Path $provisionPaths.Package $name)
    }
    Copy-Item -LiteralPath $DevconPath -Destination $provisionPaths.Devcon
    Set-VddFileOwner $provisionPaths.Devcon
    Assert-VddPayload $provisionPaths.Package $provisionPaths.Devcon
    $xml = @'
<?xml version="1.0" encoding="utf-8"?>
<vdd_settings>
  <monitors><count>1</count></monitors>
  <gpu><friendlyname>default</friendlyname></gpu>
  <resolutions>
    <resolution><width>1920</width><height>1080</height><refresh_rate>60</refresh_rate></resolution>
  </resolutions>
  <options>
    <CustomEdid>false</CustomEdid><PreventSpoof>false</PreventSpoof>
    <EdidCeaOverride>false</EdidCeaOverride><HardwareCursor>true</HardwareCursor>
    <SDR10bit>false</SDR10bit><HDRPlus>false</HDRPlus>
    <logging>false</logging><debuglogging>false</debuglogging>
  </options>
</vdd_settings>
'@
    [void][xml]$xml
    [IO.File]::WriteAllText((Join-Path $provisionPaths.Config 'vdd_settings.xml'), $xml, [Text.UTF8Encoding]::new($false))
    Set-VddFileOwner (Join-Path $provisionPaths.Config 'vdd_settings.xml')
    Register-VddWatchdog $provisionManifest

    if (-not $publisherPresent) {
        $provisionManifest.certificateIntent = $true; Save-VddManifest $provisionManifest
        $signature = Get-AuthenticodeSignature -LiteralPath (Join-Path $provisionPaths.Package 'mttvdd.cat')
        $store = [Security.Cryptography.X509Certificates.X509Store]::new('TrustedPublisher', 'LocalMachine')
        $store.Open('ReadWrite')
        try { $store.Add($signature.SignerCertificate) } finally { $store.Close() }
    }
    $provisionManifest.registryIntent = $true; Save-VddManifest $provisionManifest
    if (Test-Path -LiteralPath $identity.Registry) { throw 'VDD registry configuration appeared during preflight.' }
    New-Item -Path $identity.Registry -Force -ErrorAction Stop | Out-Null
    New-ItemProperty -LiteralPath $identity.Registry -Name VDDPATH -PropertyType String -Value $provisionPaths.Config | Out-Null

    $pnputil = Join-Path $env:windir 'System32\pnputil.exe'
    $inf = Join-Path $provisionPaths.Package 'MttVDD.inf'
    $provisionManifest.stageStarted = $true; Save-VddManifest $provisionManifest
    Invoke-VddNative $pnputil @('/add-driver', $inf) $provisionManifest
    $newPackages = @(Get-VddPackages | Where-Object {
        @($provisionManifest.beforePackages) -inotcontains $_.Driver -and (Test-VddPackage $_)
    })
    if ($newPackages.Count -ne 1 -or $newPackages[0].Driver -notmatch '^oem\d+\.inf$') {
        throw 'Could not uniquely identify the newly staged, pinned OEM package.'
    }
    $provisionManifest.driverInf = $newPackages[0].Driver; Save-VddManifest $provisionManifest
    if (@(Get-VddNodes).Count -ne 0) { throw 'Another VDD instance appeared before creation.' }
    $provisionManifest.installStarted = $true; Save-VddManifest $provisionManifest
    Invoke-VddNative $provisionPaths.Devcon @('install', $inf, $identity.HardwareId) $provisionManifest -ObserveInstall
    Update-VddObservedState $provisionManifest
    if (-not $provisionManifest.deviceInstance) { throw 'The new device instance was not observed.' }
    Assert-VddDevice $provisionManifest.deviceInstance $provisionManifest
    Invoke-VddNative $pnputil @('/disable-device', $provisionManifest.deviceInstance) $provisionManifest
    $problem = (Get-PnpDeviceProperty -InstanceId $provisionManifest.deviceInstance -KeyName 'DEVPKEY_Device_ProblemCode' -ErrorAction Stop).Data
    if ($problem -ne 22) { throw 'The newly installed virtual adapter did not become disabled (problem code 22).' }
    if ([DateTime]::UtcNow -ge [DateTime]::Parse($provisionManifest.deadlineUtc).ToUniversalTime()) {
        throw 'Provisioning exceeded the validation deadline.'
    }
    $provisionManifest.state = 'installed'; Save-VddManifest $provisionManifest
    Write-VddJson $provisionPaths.Runtime ([pscustomobject]@{
        version = 1; owner = $identity.Owner; deviceInstance = $provisionManifest.deviceInstance
        driverInf = $provisionManifest.driverInf; state = 'installed'
    })
    Write-Output "Installed and DISABLED: $($provisionManifest.deviceInstance), $($provisionManifest.driverInf)."
    Write-Output "Validate frames and physical-display behavior, then explicitly call -Commit before $($provisionManifest.deadlineUtc)."
    Write-Output "Runtime: $($provisionPaths.Runtime); rollback manifest: $($provisionPaths.Manifest)"
} catch {
    $installError = $_
    if ($null -ne $provisionManifest) {
        $provisionManifest.lastError = $installError.Exception.Message
        try { Save-VddManifest $provisionManifest; Invoke-VddRollback $provisionManifest }
        catch { Write-Warning ("Automatic rollback incomplete: " + $_.Exception.Message + '. Keep the watchdog and inspect the manifest.') }
    }
    throw $installError
} finally { $provisionLock.Dispose() }
