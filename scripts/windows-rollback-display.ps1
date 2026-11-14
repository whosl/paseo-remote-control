#requires -Version 5.1
<#
.SYNOPSIS
Roll back only the Virtual Display Driver created by windows-provision-display.ps1.
.DESCRIPTION
Manual use: stop the plugin or turn automatic fallback OFF first, then run this
script from native 64-bit elevated Windows PowerShell with -PolicyStopped.
The independent SYSTEM task uses -Watchdog. Runtime authorization is revoked
before any PnP operation. No physical display, GPU, boot policy, or Root trust
store is changed. An incomplete rollback keeps its task for retry/next boot.
Files and the aborted manifest are retained for diagnosis; reinstall is not an
implicit takeover of an existing transaction. -LibraryOnly is for the companion
provisioner and only defines functions.
#>
[CmdletBinding()]
param([switch]$PolicyStopped, [switch]$Watchdog, [switch]$LibraryOnly)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-VddPaths {
    $root = Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) 'PaseoRemoteControl'
    $data = Join-Path $root 'display-fallback'
    [pscustomobject]@{
        Root = $root; Data = $data
        Runtime = (Join-Path $root 'display-fallback.json')
        Manifest = (Join-Path $root 'display-fallback-transaction.json')
        Lock = (Join-Path $root 'display-fallback.lock')
        Package = (Join-Path $data 'package')
        Config = (Join-Path $data 'config')
        Rollback = (Join-Path $data 'windows-rollback-display.ps1')
        Devcon = (Join-Path $data 'devcon.exe')
        Log = (Join-Path $data 'operations.log')
    }
}

function Get-VddIdentity {
    [pscustomobject]@{
        Owner = 'paseo-remote-control'; HardwareId = 'Root\MttVDD'
        ClassGuid = '{4D36E968-E325-11CE-BFC1-08002BE10318}'
        Registry = 'HKLM:\SOFTWARE\MikeTheTech\VirtualDisplayDriver'
        Thumbprint = '3CF8CF26D8BA266C3A483AB7D26D4A818E317D76'
        InfHash = '550d211fe481e74dfe3f9d724ed78be48b3a9113405965d683d9373e8d672f5d'
        DllHash = 'c9ca837f57a98fbd43bc416a7f535a95843626e7759eaf85cf0cd7ce334dbb05'
        CatHash = '08a0093fc9b2e32b287a6f8a77ca4de0a31830d29fc33d2b13a918dc859468f6'
        DevconHash = '77e87e7c4e23d6b9a4f5d86d15ed9ec61a16a242fb299c390af6f179225bfa05'
    }
}

function Assert-VddAdministrator {
    if ([Environment]::OSVersion.Platform -ne 'Win32NT' -or
        -not [Environment]::Is64BitOperatingSystem -or -not [Environment]::Is64BitProcess) {
        throw 'Native 64-bit Windows PowerShell on AMD64 Windows is required.'
    }
    if ($env:PROCESSOR_ARCHITECTURE -ne 'AMD64') { throw 'This pinned package is AMD64 only.' }
    $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Administrator or SYSTEM privileges are required.'
    }
}

function Assert-VddNoReparsePath([string]$Path) {
    $part = [IO.Path]::GetFullPath($Path)
    while ($part) {
        if (Test-Path -LiteralPath $part) {
            $item = Get-Item -LiteralPath $part -Force
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "Refusing reparse point: $part"
            }
        }
        $parent = [IO.Directory]::GetParent($part)
        if ($null -eq $parent) { break }
        $part = $parent.FullName
    }
}

function Set-VddDirectoryAcl([string]$Path, [switch]$UsersRead) {
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true, $false)
    $acl.SetOwner([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))
    foreach ($sid in @('S-1-5-18', 'S-1-5-32-544', 'S-1-5-19') + $(if ($UsersRead) { @('S-1-5-32-545') } else { @() })) {
        $rights = if ($sid -in @('S-1-5-18', 'S-1-5-32-544')) { 'FullControl' } else { 'ReadAndExecute' }
        $rule = [Security.AccessControl.FileSystemAccessRule]::new(
            [Security.Principal.SecurityIdentifier]::new($sid), $rights,
            'ContainerInherit, ObjectInherit', 'None', 'Allow')
        [void]$acl.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $Path -AclObject $acl
}

function Assert-VddProtectedPath([string]$Path) {
    Assert-VddNoReparsePath $Path
    $acl = Get-Acl -LiteralPath $Path
    $ownerSid = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
    if ($ownerSid -notin @('S-1-5-18', 'S-1-5-32-544')) { throw "Unexpected owner on $Path" }
    $writes = [Security.AccessControl.FileSystemRights]::Write -bor
        [Security.AccessControl.FileSystemRights]::Delete -bor
        [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
        [Security.AccessControl.FileSystemRights]::ChangePermissions -bor
        [Security.AccessControl.FileSystemRights]::TakeOwnership
    foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
        if ($rule.AccessControlType -eq 'Allow' -and ($rule.FileSystemRights -band $writes) -ne 0 -and
            $rule.IdentityReference.Value -notin @('S-1-5-18', 'S-1-5-32-544')) {
            throw "Non-administrator write access on $Path"
        }
    }
}

function Set-VddFileOwner([string]$Path) {
    $acl = Get-Acl -LiteralPath $Path
    $acl.SetOwner([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))
    Set-Acl -LiteralPath $Path -AclObject $acl
}

function Write-VddJson([string]$Path, $Value) {
    Assert-VddNoReparsePath $Path
    $temporary = $Path + '.' + [guid]::NewGuid().ToString('N') + '.tmp'
    try {
        [IO.File]::WriteAllText($temporary, ($Value | ConvertTo-Json -Depth 12), [Text.UTF8Encoding]::new($false))
        Set-VddFileOwner $temporary
        if (Test-Path -LiteralPath $Path) { [IO.File]::Replace($temporary, $Path, [System.Management.Automation.Language.NullString]::Value) }
        else { [IO.File]::Move($temporary, $Path) }
    } finally {
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
    }
}

function Save-VddManifest($Manifest) {
    $Manifest.updatedUtc = [DateTime]::UtcNow.ToString('o')
    Write-VddJson (Get-VddPaths).Manifest $Manifest
}

function Read-VddManifest {
    $paths = Get-VddPaths
    Assert-VddProtectedPath $paths.Root
    Assert-VddProtectedPath $paths.Manifest
    $manifest = [IO.File]::ReadAllText($paths.Manifest) | ConvertFrom-Json
    if ($manifest.version -ne 1 -or $manifest.owner -ne (Get-VddIdentity).Owner -or
        $manifest.transactionId -notmatch '^[0-9a-f]{32}$' -or
        $manifest.state -notin @('preparing', 'installed', 'committed', 'aborted')) {
        throw 'Unrecognized display transaction manifest.'
    }
    $manifest
}

function Enter-VddLock {
    $path = (Get-VddPaths).Lock
    Assert-VddNoReparsePath $path
    $deadline = [DateTime]::UtcNow.AddSeconds(45)
    do {
        try { return [IO.File]::Open($path, 'OpenOrCreate', 'ReadWrite', 'None') }
        catch [IO.IOException] {
            if ([DateTime]::UtcNow -ge $deadline) { throw 'Another display transaction still holds the lock.' }
            Start-Sleep -Milliseconds 500
        }
    } while ($true)
}

function Get-VddNodes {
    # Include nonpresent nodes, including a partial install with no Display class.
    $devices = @(Get-PnpDevice -ErrorAction Stop)
    if ($devices.Count -eq 0) { throw 'PnP enumeration returned no devices; refusing to assume VDD is absent.' }
    foreach ($device in $devices) {
        if ($device.Class -and $device.Class -notin @('Display', 'Unknown') -and $device.InstanceId -notmatch '^ROOT\\') { continue }
        try {
            $property = Get-PnpDeviceProperty -InstanceId $device.InstanceId `
                -KeyName 'DEVPKEY_Device_HardwareIds' -ErrorAction Stop
            # Type=Empty can omit Data without emitting an error. Keep this
            # validation inside the try so the same class-sensitive failure
            # policy applies to both missing properties and query exceptions.
            if ($null -eq $property -or $null -eq $property.PSObject.Properties['Data']) {
                throw 'Hardware ID property has no Data member.'
            }
            if (@($property.Data | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) }).Count -eq 0) {
                throw 'Hardware ID property contains no IDs.'
            }
        } catch {
            # Unrelated USB/software devices may have no IDs. This root-enumerated
            # driver can only hide among ROOT nodes or Display-class devices.
            if ($device.Class -eq 'Display' -or $device.InstanceId -match '^ROOT\\') {
                throw "Cannot verify hardware IDs for $($device.InstanceId): $($_.Exception.Message)"
            }
            continue
        }
        if (@($property.Data) -icontains 'Root\MttVDD' -or @($property.Data) -icontains 'MttVDD') {
            $device.InstanceId
        }
    }
}

function Assert-VddDevice([string]$Instance, $Manifest, [switch]$AllowUnbound) {
    if ($Instance -notmatch '^ROOT\\[A-Z0-9_&-]+\\[A-Z0-9_&-]+$' -or
        @($Manifest.beforeDevices) -icontains $Instance) { throw 'Unowned device instance.' }
    $hardware = @((Get-PnpDeviceProperty -InstanceId $Instance -KeyName 'DEVPKEY_Device_HardwareIds' -ErrorAction Stop).Data)
    if ($hardware -inotcontains 'Root\MttVDD') { throw "Hardware ID changed: $Instance" }
    if (-not $AllowUnbound) {
        $class = (Get-PnpDeviceProperty -InstanceId $Instance -KeyName 'DEVPKEY_Device_ClassGuid' -ErrorAction Stop).Data
        if ([guid]$class -ne [guid](Get-VddIdentity).ClassGuid) { throw 'Unexpected device class.' }
        $inf = (Get-PnpDeviceProperty -InstanceId $Instance -KeyName 'DEVPKEY_Device_DriverInfPath' -ErrorAction Stop).Data
        if ($inf -ine $Manifest.driverInf) { throw 'The owned device is bound to a different driver package.' }
    }
}

function Get-VddPackages {
    @(Get-WindowsDriver -Online -All -ErrorAction Stop)
}

function Test-VddPackage($Package) {
    if ([IO.Path]::GetFileName($Package.OriginalFileName) -ine 'mttvdd.inf' -or
        $Package.ProviderName -ine 'MikeTheTech' -or [string]$Package.Version -ne '11.30.4.434') { return $false }
    (Get-FileHash -LiteralPath $Package.OriginalFileName -Algorithm SHA256).Hash -ieq (Get-VddIdentity).InfHash
}

function Update-VddObservedState($Manifest) {
    if (-not $Manifest.installStarted) { return }
    $newNodes = @(Get-VddNodes | Where-Object { @($Manifest.beforeDevices) -inotcontains $_ })
    if (-not $Manifest.deviceInstance) {
        if ($newNodes.Count -gt 1) { throw 'Multiple new VDD instances: ownership is ambiguous.' }
        if ($newNodes.Count -eq 1) {
            Assert-VddDevice $newNodes[0] $Manifest -AllowUnbound
            $Manifest.deviceInstance = $newNodes[0]
            Save-VddManifest $Manifest
        }
    }
}

function Invoke-VddNative([string]$File, [string[]]$Arguments, $Manifest, [int]$TimeoutSeconds = 90, [switch]$ObserveInstall) {
    $quoted = foreach ($argument in $Arguments) {
        if ($argument -match '["\r\n\x00]') { throw 'Invalid native argument.' }
        '"' + ($argument -replace '(\\+)$', '$1$1') + '"'
    }
    $start = New-Object Diagnostics.ProcessStartInfo
    $start.FileName = $File; $start.Arguments = $quoted -join ' '
    $start.UseShellExecute = $false; $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true; $start.RedirectStandardError = $true
    $process = New-Object Diagnostics.Process
    $process.StartInfo = $start
    $started = $false
    try {
        if (-not $process.Start()) { throw 'Native process did not start.' }
        $started = $true
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        $nativeStartedUtc = $null
        try { $nativeStartedUtc = $process.StartTime.ToUniversalTime().ToString('o') }
        catch { if (-not $process.HasExited) { throw } }
        # A fast process may already have exited before its start time can be
        # queried. It needs no kill record, but its exit code still must be checked.
        $Manifest.activeProcess = $null
        if ($nativeStartedUtc) {
            $Manifest.activeProcess = [pscustomobject]@{
                id = $process.Id; startedUtc = $nativeStartedUtc; file = $File
            }
        }
        Save-VddManifest $Manifest
        $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
        do {
            if ($ObserveInstall) { Update-VddObservedState $Manifest }
            if ($process.WaitForExit(500)) { break }
            if ([DateTime]::UtcNow -ge $deadline) { throw "Native operation timed out: $File" }
        } while ($true)
        if ($ObserveInstall) { Update-VddObservedState $Manifest }
        if (-not $stdout.Wait(5000) -or -not $stderr.Wait(5000)) { throw 'Native output did not close.' }
        $log = "`r`n$([DateTime]::UtcNow.ToString('o')) $File $($start.Arguments) => $($process.ExitCode)`r`n$($stdout.Result)`r`n$($stderr.Result)"
        [IO.File]::AppendAllText((Get-VddPaths).Log, $log, [Text.UTF8Encoding]::new($false))
        Set-VddFileOwner (Get-VddPaths).Log
        if ($process.ExitCode -ne 0) {
            throw "Native operation returned $($process.ExitCode); reboot-required is not accepted as completion. See $((Get-VddPaths).Log)"
        }
    } finally {
        if ($started -and -not $process.HasExited) { $process.Kill(); [void]$process.WaitForExit(5000) }
        $process.Dispose()
        $Manifest.activeProcess = $null
        Save-VddManifest $Manifest
    }
}

function Stop-VddRecordedProcess($Manifest) {
    if ($null -eq $Manifest.activeProcess) { return }
    $record = $Manifest.activeProcess
    $process = Get-Process -Id $record.id -ErrorAction SilentlyContinue
    if ($null -eq $process) {
        $Manifest.activeProcess = $null
        Save-VddManifest $Manifest
        return
    }
    try {
        $paths = Get-VddPaths
        $allowed = @($paths.Devcon, (Join-Path $env:windir 'System32\pnputil.exe'))
        if ($allowed -inotcontains $record.file -or $process.MainModule.FileName -ine $record.file -or
            $process.StartTime.ToUniversalTime().ToString('o') -ne $record.startedUtc) {
            # PID reuse means the recorded child already exited. Never kill the
            # replacement, and do not let a stale PID prevent device rollback.
            $Manifest.activeProcess = $null
            Save-VddManifest $Manifest
            Write-Warning 'Recorded child PID was reused; leaving the unrelated process untouched.'
            return
        }
        $process.Kill(); [void]$process.WaitForExit(5000)
        $Manifest.activeProcess = $null
        Save-VddManifest $Manifest
    } finally { $process.Dispose() }
}

function Get-VddTaskName($Manifest) { 'PaseoRemoteControl-VddRollback-' + $Manifest.transactionId }

function Stop-VddExpiredProvisioner($Manifest) {
    # Called only if a watchdog could not acquire the lifecycle lock. A hung
    # installer must not hold that lock forever and defeat independent rollback.
    if ($Manifest.state -eq 'committed' -or
        [DateTime]::UtcNow -lt [DateTime]::Parse($Manifest.deadlineUtc).ToUniversalTime()) {
        throw 'A nonexpired or committed transaction still holds the lock.'
    }
    $record = $Manifest.provisionerProcess
    $process = Get-Process -Id $record.id -ErrorAction SilentlyContinue
    if ($null -eq $process) { return }
    try {
        $expectedExe = Join-Path $env:windir 'System32\WindowsPowerShell\v1.0\powershell.exe'
        if ($process.Id -eq $PID -or $record.file -ine $expectedExe -or
            $process.MainModule.FileName -ine $record.file -or
            $process.StartTime.ToUniversalTime().ToString('o') -ne $record.startedUtc) {
            throw 'Expired provisioner identity no longer matches; refusing to terminate another process.'
        }
        $process.Kill(); [void]$process.WaitForExit(5000)
    } finally { $process.Dispose() }
}

function Remove-VddWatchdog($Manifest) {
    $task = Get-ScheduledTask -TaskName (Get-VddTaskName $Manifest) -TaskPath '\' -ErrorAction SilentlyContinue
    if ($null -eq $task) { return }
    $script = (Get-VddPaths).Rollback
    if (@($task.Actions).Count -ne 1 -or $task.Actions[0].Execute -ine (Join-Path $env:windir 'System32\WindowsPowerShell\v1.0\powershell.exe') -or
        $task.Actions[0].Arguments -notlike ('*"' + $script + '" -Watchdog')) {
        throw 'Watchdog task definition changed; refusing to remove it.'
    }
    Unregister-ScheduledTask -TaskName $task.TaskName -TaskPath '\' -Confirm:$false -ErrorAction Stop
}

function Invoke-VddRollback($Manifest) {
    $paths = Get-VddPaths
    $identity = Get-VddIdentity
    # The runtime checks this file before EVERY toggle, even for a cached driver.
    if (Test-Path -LiteralPath $paths.Runtime) {
        Assert-VddProtectedPath $paths.Runtime
        [IO.File]::Move($paths.Runtime, $paths.Runtime + '.aborted.' + [guid]::NewGuid().ToString('N'))
    }
    $Manifest.state = 'aborted'; $Manifest.rollbackComplete = $false
    Save-VddManifest $Manifest
    Stop-VddRecordedProcess $Manifest
    Start-Sleep -Seconds 2
    Update-VddObservedState $Manifest
    $pnputil = Join-Path $env:windir 'System32\pnputil.exe'
    $errors = New-Object 'Collections.Generic.List[string]'
    try {
        if ($Manifest.deviceInstance -and @(Get-VddNodes) -icontains $Manifest.deviceInstance) {
            Assert-VddDevice $Manifest.deviceInstance $Manifest -AllowUnbound
            # A partial install may not be disableable; exact-instance removal is
            # still necessary. Never expand selection to all Display/Unknown nodes.
            try { Invoke-VddNative $pnputil @('/disable-device', $Manifest.deviceInstance) $Manifest }
            catch { Write-Warning $_.Exception.Message }
            Assert-VddDevice $Manifest.deviceInstance $Manifest -AllowUnbound
            Invoke-VddNative $pnputil @('/remove-device', $Manifest.deviceInstance) $Manifest
            if (@(Get-VddNodes) -icontains $Manifest.deviceInstance) { throw 'Owned VDD device still exists after removal.' }
        }
    } catch { $errors.Add($_.Exception.Message) }
    if ($errors.Count -eq 0) {
        try {
            if ($Manifest.stageStarted) {
                $newPackages = @(Get-VddPackages | Where-Object {
                    @($Manifest.beforePackages) -inotcontains $_.Driver -and (Test-VddPackage $_)
                })
                if ($newPackages.Count -gt 1) { throw 'Multiple new VDD packages: ownership is ambiguous.' }
                foreach ($package in $newPackages) {
                    if ($package.Driver -notmatch '^oem\d+\.inf$' -or
                        ($Manifest.driverInf -and $Manifest.driverInf -ine $package.Driver)) {
                        throw 'Ambiguous new driver-store package; leaving it untouched.'
                    }
                    if (-not $Manifest.driverInf) { $Manifest.driverInf = $package.Driver; Save-VddManifest $Manifest }
                    $users = @(Get-CimInstance Win32_PnPSignedDriver -ErrorAction Stop |
                        Where-Object { $_.InfName -ieq $package.Driver })
                    if ($users.Count -gt 0) { throw "Driver package still in use: $($package.Driver)" }
                    Invoke-VddNative $pnputil @('/delete-driver', $package.Driver) $Manifest
                }
            }
        } catch { $errors.Add($_.Exception.Message) }
    }
    if ($errors.Count -eq 0) {
        try {
            if ($Manifest.registryIntent -and (Test-Path -LiteralPath $identity.Registry)) {
                $key = Get-Item -LiteralPath $identity.Registry
                $value = $key.GetValue('VDDPATH', $null)
                if ($null -ne $value -and $value -ine $paths.Config) { throw 'VDDPATH was changed by another owner; leaving it untouched.' }
                if ($null -ne $value) { Remove-ItemProperty -LiteralPath $identity.Registry -Name VDDPATH }
                $key = Get-Item -LiteralPath $identity.Registry
                if ($key.ValueCount -eq 0 -and $key.SubKeyCount -eq 0) { Remove-Item -LiteralPath $identity.Registry }
            }
            if ($Manifest.certificateIntent -and -not $Manifest.trustedPublisherWasPresent) {
                $store = [Security.Cryptography.X509Certificates.X509Store]::new('TrustedPublisher', 'LocalMachine')
                $store.Open('ReadWrite')
                try {
                    foreach ($cert in @($store.Certificates | Where-Object { $_.Thumbprint -eq $identity.Thumbprint })) { $store.Remove($cert) }
                } finally { $store.Close() }
            }
        } catch { $errors.Add($_.Exception.Message) }
    }
    $Manifest.rollbackErrors = @($errors.ToArray())
    $Manifest.rollbackComplete = ($errors.Count -eq 0)
    Save-VddManifest $Manifest
    if ($errors.Count -gt 0) { throw ('Rollback incomplete; watchdog retained. ' + ($errors -join '; ')) }
    Remove-VddWatchdog $Manifest
    Write-Output "Rollback complete. Runtime authorization revoked; owned device/package removed. Evidence: $($paths.Manifest)"
}

if (-not $LibraryOnly) {
    Assert-VddAdministrator
    if (-not $Watchdog -and -not $PolicyStopped) {
        throw 'Stop the plugin or turn automatic fallback off, then invoke -PolicyStopped. The SYSTEM task uses -Watchdog.'
    }
    $rollbackPaths = Get-VddPaths
    Assert-VddProtectedPath $rollbackPaths.Root
    try { $rollbackLock = Enter-VddLock }
    catch {
        if (-not $Watchdog) { throw }
        Stop-VddExpiredProvisioner (Read-VddManifest)
        $rollbackLock = Enter-VddLock
    }
    try {
        $rollbackManifest = Read-VddManifest
        if ($Watchdog -and $rollbackManifest.state -eq 'committed') {
            Write-Output 'Explicitly committed; watchdog will not change devices.'
        } else { Invoke-VddRollback $rollbackManifest }
    } finally { $rollbackLock.Dispose() }
}
