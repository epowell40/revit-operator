import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

export const SAFE_READ_PROXY_SECRET_BYTES = 32;
export const SAFE_READ_PROXY_SECRET_FILE = "authorization_secret.v1.bin";

const WINDOWS_REPARSE_POINT = 0x400;
const WRITE_PRIVATE_SECRET_FUNCTION = `
function Write-PrivateSecret(
  [string]$value,
  [scriptblock]$rngFactory = $null,
  [scriptblock]$streamFactory = $null,
  [scriptblock]$clearedProbe = $null
) {
  $bytes = $null
  $generator = $null
  $stream = $null
  try {
    $bytes = New-Object byte[] 32
    $generator = if ($rngFactory) { & $rngFactory } else { [Security.Cryptography.RandomNumberGenerator]::Create() }
    if ($null -eq $generator) { throw 'SafeRead proxy secret RNG is unavailable.' }
    $generator.GetBytes($bytes)
    $stream = if ($streamFactory) { & $streamFactory $value } else { New-Object IO.FileStream($value, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None, 4096, [IO.FileOptions]::WriteThrough) }
    if ($null -eq $stream) { throw 'SafeRead proxy secret stream is unavailable.' }
    $stream.Write($bytes, 0, $bytes.Length)
    $stream.Flush($true)
  } finally {
    try {
      if ($stream) { $stream.Dispose() }
    } finally {
      try {
        if ($generator) { $generator.Dispose() }
      } finally {
        if ($bytes) {
          [Array]::Clear($bytes, 0, $bytes.Length)
          if ($clearedProbe) { & $clearedProbe $bytes }
        }
      }
    }
  }
  Set-PrivateFile $value
  Assert-Private $value $false
}
`;
const PROVISION_SCRIPT = `
$ErrorActionPreference = 'Stop'
$target = [IO.Path]::GetFullPath($env:OPERATOR_SAFE_READ_PROXY_SECRET_PATH)
$root = [IO.Path]::GetFullPath($env:OPERATOR_SAFE_READ_PROXY_LOCALAPPDATA).TrimEnd('\\')
$prefix = $root + '\\'
if (!$target.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'SafeRead proxy secret escaped LOCALAPPDATA.' }
$directory = [IO.Path]::GetDirectoryName($target)
$forceRotate = $env:OPERATOR_SAFE_READ_PROXY_ROTATE -eq '1'
$mutex = New-Object Threading.Mutex($false, 'Local\\RevitOperator.SafeRead.ProxyAuthorizationSecret.v1')
if (!$mutex.WaitOne([TimeSpan]::FromSeconds(15))) { throw 'SafeRead proxy secret creation lock timed out.' }
try {
  $cursor = $root
  foreach ($component in $directory.Substring($root.Length).TrimStart('\\').Split('\\', [StringSplitOptions]::RemoveEmptyEntries)) {
    $cursor = [IO.Path]::Combine($cursor, $component)
    if (Test-Path -LiteralPath $cursor) {
      $item = Get-Item -LiteralPath $cursor -Force
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'SafeRead proxy storage traversed a reparse point.' }
    }
  }
  [IO.Directory]::CreateDirectory($directory) | Out-Null
  $owner = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $system = New-Object Security.Principal.SecurityIdentifier('S-1-5-18')
  $administrators = New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')
  function Set-PrivateDirectory([string]$value) {
    $security = New-Object Security.AccessControl.DirectorySecurity
    $security.SetAccessRuleProtection($true, $false)
    $security.SetOwner($owner)
    $inheritance = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
    foreach ($sid in @($owner, $system, $administrators)) {
      $rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, [Security.AccessControl.FileSystemRights]::FullControl, $inheritance, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)
      [void]$security.AddAccessRule($rule)
    }
    [IO.DirectoryInfo]::new($value).SetAccessControl($security)
  }
  function Set-PrivateFile([string]$value) {
    $security = New-Object Security.AccessControl.FileSecurity
    $security.SetAccessRuleProtection($true, $false)
    $security.SetOwner($owner)
    foreach ($sid in @($owner, $system, $administrators)) {
      $rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, [Security.AccessControl.FileSystemRights]::FullControl, [Security.AccessControl.AccessControlType]::Allow)
      [void]$security.AddAccessRule($rule)
    }
    [IO.FileInfo]::new($value).SetAccessControl($security)
  }
  function Test-PrivateAcl([string]$value, [bool]$isDirectory) {
    try {
      $security = if ($isDirectory) { [IO.DirectoryInfo]::new($value).GetAccessControl([Security.AccessControl.AccessControlSections]'Owner, Access') } else { [IO.FileInfo]::new($value).GetAccessControl([Security.AccessControl.AccessControlSections]'Owner, Access') }
      $actualOwner = [Security.Principal.SecurityIdentifier]$security.GetOwner([Security.Principal.SecurityIdentifier])
      if (!$actualOwner.Equals($owner) -or !$security.AreAccessRulesProtected) { return $false }
      $seen = @{}
      foreach ($rawRule in $security.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
        $rule = [Security.AccessControl.FileSystemAccessRule]$rawRule
        $sid = [string]$rule.IdentityReference.Value
        if ($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or $rule.IsInherited -or $sid -notin @([string]$owner.Value, 'S-1-5-18', 'S-1-5-32-544')) { return $false }
        $seen[$sid] = $true
      }
      foreach ($required in @([string]$owner.Value, 'S-1-5-18', 'S-1-5-32-544')) { if (!$seen[$required]) { return $false } }
      return $true
    } catch { return $false }
  }
  function Assert-Private([string]$value, [bool]$isDirectory) {
    $item = Get-Item -LiteralPath $value -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'SafeRead proxy storage is a reparse point.' }
    if (!(Test-PrivateAcl $value $isDirectory)) { throw 'SafeRead proxy storage ACL is unsafe.' }
  }
  ${WRITE_PRIVATE_SECRET_FUNCTION}
  if (-not ('RevitOperator.SafeRead.NativeMethods' -as [type])) {
    Add-Type -Namespace RevitOperator.SafeRead -Name NativeMethods -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("kernel32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode, SetLastError = true)]
public static extern bool MoveFileEx(string existingFileName, string newFileName, int flags);
'@
  }

  $directoryExists = Test-Path -LiteralPath $directory -PathType Container
  if (!$directoryExists -and (Test-Path -LiteralPath $directory)) { throw 'SafeRead proxy storage path is not a directory.' }
  $targetExists = Test-Path -LiteralPath $target -PathType Leaf
  if (!$targetExists -and (Test-Path -LiteralPath $target)) { throw 'SafeRead proxy secret path is not a file.' }
  $rotate = $forceRotate
  if ($directoryExists) {
    $directoryItem = Get-Item -LiteralPath $directory -Force
    if (($directoryItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'SafeRead proxy storage is a reparse point.' }
    if (!(Test-PrivateAcl $directory $true) -and $targetExists) { $rotate = $true }
  }
  if ($targetExists) {
    $targetItem = Get-Item -LiteralPath $target -Force
    if (($targetItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'SafeRead proxy secret is a reparse point.' }
    if ($targetItem.Length -ne 32 -or !(Test-PrivateAcl $target $false)) { $rotate = $true }
  }

  [IO.Directory]::CreateDirectory($directory) | Out-Null
  Set-PrivateDirectory $directory
  Assert-Private $directory $true
  if (!$targetExists -or $rotate) {
    $pending = $target + '.' + [Guid]::NewGuid().ToString('N') + '.pending'
    try {
      Write-PrivateSecret $pending
      if ($targetExists) {
        # Replace the directory entry with the new file and its private DACL.
        # Never repair and reuse bytes whose prior ACL may have disclosed them.
        if (![RevitOperator.SafeRead.NativeMethods]::MoveFileEx($pending, $target, 9)) {
          throw [ComponentModel.Win32Exception]::new([Runtime.InteropServices.Marshal]::GetLastWin32Error())
        }
      } else {
        [IO.File]::Move($pending, $target)
      }
      $pending = $null
    } finally {
      if ($pending -and (Test-Path -LiteralPath $pending)) { [IO.File]::Delete($pending) }
    }
  }
  $targetItem = Get-Item -LiteralPath $target -Force
  if (($targetItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $targetItem.Length -ne 32) { throw 'SafeRead proxy secret is unsafe.' }
  Assert-Private $target $false
} finally {
  try { $mutex.ReleaseMutex() } catch {}
  $mutex.Dispose()
}
`;

const VERIFY_SCRIPT = `
$ErrorActionPreference = 'Stop'
$target = [IO.Path]::GetFullPath($env:OPERATOR_SAFE_READ_PROXY_SECRET_PATH)
$directory = [IO.Path]::GetDirectoryName($target)
$owner = [Security.Principal.WindowsIdentity]::GetCurrent().User
$allowed = @([string]$owner.Value, 'S-1-5-18', 'S-1-5-32-544')
foreach ($value in @($directory, $target)) {
  $item = Get-Item -LiteralPath $value -Force
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'SafeRead proxy storage is a reparse point.' }
  $security = if ($item.PSIsContainer) { [IO.DirectoryInfo]::new($value).GetAccessControl([Security.AccessControl.AccessControlSections]'Owner, Access') } else { [IO.FileInfo]::new($value).GetAccessControl([Security.AccessControl.AccessControlSections]'Owner, Access') }
  $actualOwner = [Security.Principal.SecurityIdentifier]$security.GetOwner([Security.Principal.SecurityIdentifier])
  if (!$actualOwner.Equals($owner) -or !$security.AreAccessRulesProtected) { throw 'SafeRead proxy storage owner or inheritance is unsafe.' }
  $seen = @{}
  foreach ($rawRule in $security.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
    $rule = [Security.AccessControl.FileSystemAccessRule]$rawRule
    $sid = [string]$rule.IdentityReference.Value
    if ($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or $rule.IsInherited -or $sid -notin $allowed) { throw 'SafeRead proxy storage contains an unsafe access rule.' }
    $seen[$sid] = $true
  }
  foreach ($required in $allowed) { if (!$seen[$required]) { throw 'SafeRead proxy storage ACL is incomplete.' } }
}
if ((Get-Item -LiteralPath $target -Force).Length -ne 32) { throw 'SafeRead proxy secret length is invalid.' }
`;

export const __testOnlySafeReadProxySecretPowerShell = Object.freeze({
  provision: PROVISION_SCRIPT,
  verify: VERIFY_SCRIPT,
  writePrivateSecret: WRITE_PRIVATE_SECRET_FUNCTION
});

export class SafeReadProxySecretError extends Error {
  constructor(message) {
    super(message);
    this.name = "SafeReadProxySecretError";
    this.code = "SAFE_READ_PROXY_SECRET_UNAVAILABLE";
  }
}

export function safeReadProxySecretPath(env = process.env) {
  const localAppData = env.LOCALAPPDATA;
  if (typeof localAppData !== "string" || localAppData.length === 0 || localAppData !== localAppData.trim()) {
    throw new SafeReadProxySecretError("SafeRead proxy secret storage requires an exact LOCALAPPDATA path.");
  }
  return path.join(path.resolve(localAppData), "RevitOperator", "SafeRead", "proxy", SAFE_READ_PROXY_SECRET_FILE);
}

export function loadOrCreateSafeReadProxySecret({
  env = process.env,
  fsApi = fs,
  platform = process.platform,
  provision = provisionWindowsProxySecret,
  verifyAcl = verifyWindowsProxySecretAcl
} = {}) {
  const secretPath = safeReadProxySecretPath(env);
  if (platform !== "win32" && provision === provisionWindowsProxySecret) {
    throw new SafeReadProxySecretError("SafeRead proxy secret storage is supported only on Windows.");
  }
  try {
    let rotate = false;
    try {
      // This is deliberately before provisioning: an existing broad ACL means
      // the old bytes must be rotated, never silently rehabilitated and reused.
      verifyAcl({ secretPath, localAppData: env.LOCALAPPDATA, env });
    } catch {
      rotate = true;
    }
    provision({ secretPath, localAppData: env.LOCALAPPDATA, env, rotate });
    verifyAcl({ secretPath, localAppData: env.LOCALAPPDATA, env });
    assertNoReparseChain(env.LOCALAPPDATA, secretPath, fsApi);
    const before = fsApi.lstatSync(secretPath, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || Number(before.size) !== SAFE_READ_PROXY_SECRET_BYTES || hasReparseAttribute(before)) {
      throw new Error("unsafe secret file facts");
    }
    const descriptor = fsApi.openSync(secretPath, fsApi.constants.O_RDONLY | (fsApi.constants.O_NOFOLLOW ?? 0));
    let rawSecret;
    let secret;
    let validatedForReturn = false;
    try {
      const descriptorBefore = fsApi.fstatSync(descriptor, { bigint: true });
      rawSecret = fsApi.readFileSync(descriptor);
      if (!Buffer.isBuffer(rawSecret) || rawSecret.length !== SAFE_READ_PROXY_SECRET_BYTES) {
        throw new Error("secret read did not return an exact owned buffer");
      }
      secret = Buffer.from(rawSecret);
      const descriptorAfter = fsApi.fstatSync(descriptor, { bigint: true });
      const after = fsApi.lstatSync(secretPath, { bigint: true });
      if (!sameFile(before, descriptorBefore) || !sameFile(descriptorBefore, descriptorAfter) || !sameFile(descriptorAfter, after)
        || secret.length !== SAFE_READ_PROXY_SECRET_BYTES) {
        clearSafeReadProxySecret(secret);
        throw new Error("secret changed while read");
      }
      verifyAcl({ secretPath, localAppData: env.LOCALAPPDATA, env });
      assertNoReparseChain(env.LOCALAPPDATA, secretPath, fsApi);
      const descriptorFinal = fsApi.fstatSync(descriptor, { bigint: true });
      const finalPath = fsApi.lstatSync(secretPath, { bigint: true });
      if (!finalPath.isFile() || finalPath.isSymbolicLink() || hasReparseAttribute(finalPath)
        || Number(finalPath.size) !== SAFE_READ_PROXY_SECRET_BYTES
        || !sameFile(descriptorAfter, descriptorFinal)
        || !sameFile(descriptorFinal, finalPath)) {
        throw new Error("secret changed after ACL verification");
      }
      validatedForReturn = true;
      return secret;
    } catch (error) {
      clearSafeReadProxySecret(secret);
      throw error;
    } finally {
      clearSafeReadProxySecret(rawSecret);
      try {
        fsApi.closeSync(descriptor);
      } catch (error) {
        if (validatedForReturn) clearSafeReadProxySecret(secret);
        throw error;
      }
    }
  } catch (error) {
    if (error instanceof SafeReadProxySecretError) throw error;
    throw new SafeReadProxySecretError("SafeRead proxy authorization secret is unavailable or unsafe.");
  }
}

export function safeReadProxySecretHeaderValue(secret) {
  if (!Buffer.isBuffer(secret) || secret.length !== SAFE_READ_PROXY_SECRET_BYTES) {
    throw new SafeReadProxySecretError("SafeRead proxy authorization secret length is invalid.");
  }
  return secret.toString("base64url");
}

export function verifySafeReadProxySecretHeader(presented, secret) {
  if (!Buffer.isBuffer(secret) || secret.length !== SAFE_READ_PROXY_SECRET_BYTES
    || typeof presented !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(presented)) return false;
  let decoded;
  try {
    decoded = Buffer.from(presented, "base64url");
    if (decoded.length !== SAFE_READ_PROXY_SECRET_BYTES || decoded.toString("base64url") !== presented) return false;
    return crypto.timingSafeEqual(decoded, secret);
  } catch {
    return false;
  } finally {
    clearSafeReadProxySecret(decoded);
  }
}

export function clearSafeReadProxySecret(secret) {
  try {
    if (Buffer.isBuffer(secret)) Buffer.prototype.fill.call(secret, 0);
    else if (secret instanceof Uint8Array) Uint8Array.prototype.fill.call(secret, 0);
  } catch {}
}

function provisionWindowsProxySecret({ secretPath, localAppData, env, rotate }) {
  runPowerShell(PROVISION_SCRIPT, secretPath, localAppData, env, rotate);
}

function verifyWindowsProxySecretAcl({ secretPath, localAppData, env }) {
  runPowerShell(VERIFY_SCRIPT, secretPath, localAppData, env);
}

function runPowerShell(script, secretPath, localAppData, env, rotate = false) {
  const shell = env.OPERATOR_DESKTOP_POWERSHELL || "powershell";
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  execFileSync(shell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], {
    env: {
      ...env,
      OPERATOR_SAFE_READ_PROXY_SECRET_PATH: secretPath,
      OPERATOR_SAFE_READ_PROXY_LOCALAPPDATA: localAppData,
      OPERATOR_SAFE_READ_PROXY_ROTATE: rotate ? "1" : "0"
    },
    windowsHide: true,
    timeout: 20_000,
    stdio: ["ignore", "ignore", "pipe"],
    maxBuffer: 64 * 1024
  });
}

function assertNoReparseChain(root, target, fsApi) {
  const fullRoot = path.resolve(root);
  const fullTarget = path.resolve(target);
  const relative = path.relative(fullRoot, fullTarget);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("secret path escaped LOCALAPPDATA");
  let cursor = fullRoot;
  const rootStat = fsApi.lstatSync(cursor, { bigint: true });
  if (rootStat.isSymbolicLink() || hasReparseAttribute(rootStat)) throw new Error("LOCALAPPDATA is a reparse point");
  for (const segment of relative.split(path.sep)) {
    cursor = path.join(cursor, segment);
    const stat = fsApi.lstatSync(cursor, { bigint: true });
    if (stat.isSymbolicLink() || hasReparseAttribute(stat)) throw new Error("secret path traversed a reparse point");
  }
}

function hasReparseAttribute(stat) {
  return (Number(stat.fileAttributes ?? 0) & WINDOWS_REPARSE_POINT) !== 0;
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}
