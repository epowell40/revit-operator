using System.ComponentModel;
using System.Diagnostics;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using Microsoft.Win32.SafeHandles;

namespace RevitOperator.DynamicRevitSandboxSupervisor;

internal sealed class WindowsSandboxProfile : IDisposable
{
    private const int ErrorAlreadyExistsHResult = unchecked((int)0x800700B7);
    private readonly string _moniker;
    private IntPtr _sid;

    private WindowsSandboxProfile(string moniker, IntPtr sid, bool lessPrivileged)
    {
        _moniker = moniker;
        _sid = sid;
        LessPrivileged = lessPrivileged;
        Sid = new SecurityIdentifier(sid);
    }

    public SecurityIdentifier Sid { get; }
    public bool LessPrivileged { get; }
    public string ProfileName => LessPrivileged ? "windows-lpac-v1-zero-capabilities" : "windows-appcontainer-v1-zero-capabilities";

    public static WindowsSandboxProfile Create(bool lessPrivileged)
    {
        var moniker = "RevitOperator.DynamicRuntime." + Guid.NewGuid().ToString("N");
        var hr = Native.CreateAppContainerProfile(moniker, "RevitOperator Dynamic Runtime", "Disposable generated-code worker", IntPtr.Zero, 0, out var sid);
        if (hr < 0 && hr != ErrorAlreadyExistsHResult) Marshal.ThrowExceptionForHR(hr);
        if (hr == ErrorAlreadyExistsHResult)
        {
            hr = Native.DeriveAppContainerSidFromAppContainerName(moniker, out sid);
            if (hr < 0) Marshal.ThrowExceptionForHR(hr);
        }
        return new WindowsSandboxProfile(moniker, sid, lessPrivileged);
    }

    public void GrantTaskLayout(string taskRoot, string runtimeDirectory, string scratchDirectory)
    {
        ReparsePointGuard.EnsureExistingPathIsDirect(taskRoot);
        ReparsePointGuard.EnsureExistingPathIsDirect(runtimeDirectory);
        ReparsePointGuard.EnsureExistingPathIsDirect(scratchDirectory);
        var owner = WindowsIdentity.GetCurrent().User ?? throw new InvalidOperationException("Current Windows identity has no SID.");
        RunIcacls(taskRoot, "/grant", "*" + Sid.Value + ":(RX)", "/C", "/Q");
        RunIcacls(runtimeDirectory, "/inheritance:r", "/T", "/C", "/Q");
        RunIcacls(runtimeDirectory, "/grant:r", "*" + Sid.Value + ":RX", "*" + owner.Value + ":F", "*S-1-5-18:F", "*S-1-5-32-544:F", "/T", "/C", "/Q");
        RunIcacls(runtimeDirectory, "/setintegritylevel", "(OI)(CI)L", "/T", "/C", "/Q");
        RunIcacls(scratchDirectory, "/grant", "*" + Sid.Value + ":(OI)(CI)F", "/T", "/C", "/Q");
        RunIcacls(scratchDirectory, "/setintegritylevel", "(OI)(CI)L", "/T", "/C", "/Q");
    }

    public NamedPipeServerStream CreateAuthenticatedPipe(string pipeName)
    {
        var security = new PipeSecurity();
        var owner = WindowsIdentity.GetCurrent().User ?? throw new InvalidOperationException("Current Windows identity has no SID.");
        security.SetOwner(owner);
        security.AddAccessRule(new PipeAccessRule(owner, PipeAccessRights.FullControl, AccessControlType.Allow));
        security.AddAccessRule(new PipeAccessRule(Sid, PipeAccessRights.FullControl, AccessControlType.Allow));
        var pipe = NamedPipeServerStreamAcl.Create(pipeName, PipeDirection.In, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous, 64 * 1024, 64 * 1024, security);
        Native.SetLowIntegrityLabel(pipe.SafePipeHandle);
        return pipe;
    }

    public SandboxedProcess Launch(string executable, string arguments, string workingDirectory, int memoryMb, TimeSpan cpuTimeLimit, IReadOnlyList<IntPtr> inheritedHandles)
    {
        if (inheritedHandles == null || inheritedHandles.Count < 1 || inheritedHandles.Count > 4) throw new ArgumentOutOfRangeException(nameof(inheritedHandles));
        if (memoryMb < 64 || memoryMb > 4_096) throw new ArgumentOutOfRangeException(nameof(memoryMb));
        if (cpuTimeLimit <= TimeSpan.Zero || cpuTimeLimit > TimeSpan.FromMinutes(10)) throw new ArgumentOutOfRangeException(nameof(cpuTimeLimit));
        ReparsePointGuard.EnsureExistingPathIsDirect(executable);
        ReparsePointGuard.EnsureExistingPathIsDirect(workingDirectory);
        var attributeCount = LessPrivileged ? 3 : 2;
        var attributeSize = IntPtr.Zero;
        Native.InitializeProcThreadAttributeList(IntPtr.Zero, attributeCount, 0, ref attributeSize);
        var attributeList = Marshal.AllocHGlobal(attributeSize);
        if (!Native.InitializeProcThreadAttributeList(attributeList, attributeCount, 0, ref attributeSize)) throw new Win32Exception();

        var capabilities = new Native.SecurityCapabilities { AppContainerSid = _sid, Capabilities = IntPtr.Zero, CapabilityCount = 0, Reserved = 0 };
        var capabilitiesPtr = Marshal.AllocHGlobal(Marshal.SizeOf<Native.SecurityCapabilities>());
        Marshal.StructureToPtr(capabilities, capabilitiesPtr, false);
        if (!Native.UpdateProcThreadAttribute(attributeList, 0, Native.ProcThreadAttributeSecurityCapabilities, capabilitiesPtr, (IntPtr)Marshal.SizeOf<Native.SecurityCapabilities>(), IntPtr.Zero, IntPtr.Zero)) throw new Win32Exception();

        var handleListPtr = Marshal.AllocHGlobal(IntPtr.Size * inheritedHandles.Count);
        for (var i = 0; i < inheritedHandles.Count; i++) Marshal.WriteIntPtr(handleListPtr, i * IntPtr.Size, inheritedHandles[i]);
        if (!Native.UpdateProcThreadAttribute(attributeList, 0, Native.ProcThreadAttributeHandleList, handleListPtr, (IntPtr)(IntPtr.Size * inheritedHandles.Count), IntPtr.Zero, IntPtr.Zero)) throw new Win32Exception();

        IntPtr allPackagesPolicyPtr = IntPtr.Zero;
        if (LessPrivileged)
        {
            allPackagesPolicyPtr = Marshal.AllocHGlobal(sizeof(int));
            Marshal.WriteInt32(allPackagesPolicyPtr, 1);
            if (!Native.UpdateProcThreadAttribute(attributeList, 0, Native.ProcThreadAttributeAllApplicationPackagesPolicy, allPackagesPolicyPtr, (IntPtr)sizeof(int), IntPtr.Zero, IntPtr.Zero)) throw new Win32Exception();
        }

        var startup = new Native.StartupInfoEx();
        startup.StartupInfo.cb = Marshal.SizeOf<Native.StartupInfoEx>();
        startup.AttributeList = attributeList;
        var commandLine = "\"" + executable + "\" " + arguments;
        var environment = BuildEnvironmentBlock(workingDirectory);
        var flags = Native.ExtendedStartupInfoPresent | Native.CreateUnicodeEnvironment | Native.CreateSuspended | Native.CreateNoWindow;
        if (!Native.CreateProcess(executable, commandLine, IntPtr.Zero, IntPtr.Zero, true, flags, environment, workingDirectory, ref startup, out var processInfo)) throw new Win32Exception();

        var job = Native.CreateJobObject(IntPtr.Zero, null);
        if (job.IsInvalid) throw new Win32Exception();
        var limits = new Native.JobObjectExtendedLimitInformation();
        limits.BasicLimitInformation.LimitFlags = Native.JobObjectLimitKillOnJobClose | Native.JobObjectLimitActiveProcess | Native.JobObjectLimitProcessMemory | Native.JobObjectLimitJobMemory | Native.JobObjectLimitProcessTime | Native.JobObjectLimitDieOnUnhandledException;
        limits.BasicLimitInformation.PerProcessUserTimeLimit = checked(cpuTimeLimit.Ticks);
        limits.BasicLimitInformation.ActiveProcessLimit = 1;
        limits.ProcessMemoryLimit = (UIntPtr)((ulong)memoryMb * 1024UL * 1024UL);
        limits.JobMemoryLimit = limits.ProcessMemoryLimit;
        var limitsSize = Marshal.SizeOf<Native.JobObjectExtendedLimitInformation>();
        var limitsPtr = Marshal.AllocHGlobal(limitsSize);
        Marshal.StructureToPtr(limits, limitsPtr, false);
        if (!Native.SetInformationJobObject(job, 9, limitsPtr, (uint)limitsSize)) throw new Win32Exception();
        var uiRestrictionsPtr = Marshal.AllocHGlobal(sizeof(uint));
        Marshal.WriteInt32(uiRestrictionsPtr, unchecked((int)Native.JobObjectUiLimitAll));
        if (!Native.SetInformationJobObject(job, 4, uiRestrictionsPtr, sizeof(uint))) throw new Win32Exception();
        if (!Native.AssignProcessToJobObject(job, processInfo.Process)) throw new Win32Exception();
        if (Native.ResumeThread(processInfo.Thread) == uint.MaxValue) throw new Win32Exception();

        Marshal.FreeHGlobal(uiRestrictionsPtr);
        Marshal.FreeHGlobal(limitsPtr);
        Marshal.FreeHGlobal(environment);
        Marshal.FreeHGlobal(capabilitiesPtr);
        Marshal.FreeHGlobal(handleListPtr);
        if (allPackagesPolicyPtr != IntPtr.Zero) Marshal.FreeHGlobal(allPackagesPolicyPtr);
        Native.DeleteProcThreadAttributeList(attributeList);
        Marshal.FreeHGlobal(attributeList);
        Native.CloseHandle(processInfo.Thread);
        return new SandboxedProcess(processInfo.Process, processInfo.ProcessId, job);
    }

    private static IntPtr BuildEnvironmentBlock(string scratch)
    {
        var systemRoot = Environment.GetFolderPath(Environment.SpecialFolder.Windows);
        var entries = new SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            ["COMPlus_EnableDiagnostics"] = "0",
            ["DOTNET_EnableDiagnostics"] = "0",
            ["LOCALAPPDATA"] = scratch,
            ["PATH"] = Path.Combine(systemRoot, "System32"),
            ["SystemRoot"] = systemRoot,
            ["TEMP"] = scratch,
            ["TMP"] = scratch,
            ["WINDIR"] = systemRoot
        };
        var block = string.Join("\0", entries.Select(pair => pair.Key + "=" + pair.Value)) + "\0\0";
        return Marshal.StringToHGlobalUni(block);
    }

    private static void RunIcacls(string directory, params string[] arguments)
    {
        var info = new ProcessStartInfo(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "icacls.exe")) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardError = true, RedirectStandardOutput = true };
        info.ArgumentList.Add(directory);
        foreach (var argument in arguments) info.ArgumentList.Add(argument);
        using var process = Process.Start(info) ?? throw new InvalidOperationException("Unable to start icacls.");
        process.WaitForExit();
        if (process.ExitCode != 0) throw new InvalidOperationException("icacls failed: " + process.StandardError.ReadToEnd());
    }

    public void Dispose()
    {
        if (_sid != IntPtr.Zero) { Native.FreeSid(_sid); _sid = IntPtr.Zero; }
        Native.DeleteAppContainerProfile(_moniker);
    }
}

internal sealed class SandboxedProcess : IDisposable
{
    private IntPtr _process;
    private SafeFileHandle _job;
    public SandboxedProcess(IntPtr process, uint processId, SafeFileHandle job) { _process = process; ProcessId = processId; _job = job; }
    public uint ProcessId { get; }
    public bool Wait(TimeSpan timeout) => Native.WaitForSingleObject(_process, checked((uint)timeout.TotalMilliseconds)) == 0;
    public int ExitCode { get { if (!Native.GetExitCodeProcess(_process, out var code)) throw new Win32Exception(); return unchecked((int)code); } }
    public void Kill() { if (!_job.IsInvalid) Native.TerminateJobObject(_job, 0xDEAD); }
    public void Dispose() { _job.Dispose(); if (_process != IntPtr.Zero) { Native.CloseHandle(_process); _process = IntPtr.Zero; } }
}

internal static class Native
{
    internal const int ProcThreadAttributeSecurityCapabilities = 0x00020009;
    internal const int ProcThreadAttributeAllApplicationPackagesPolicy = 0x0002000F;
    internal const int ProcThreadAttributeHandleList = 0x00020002;
    internal const uint ExtendedStartupInfoPresent = 0x00080000;
    internal const uint CreateUnicodeEnvironment = 0x00000400;
    internal const uint CreateSuspended = 0x00000004;
    internal const uint CreateNoWindow = 0x08000000;
    internal const uint JobObjectLimitActiveProcess = 0x00000008;
    internal const uint JobObjectLimitProcessTime = 0x00000002;
    internal const uint JobObjectLimitProcessMemory = 0x00000100;
    internal const uint JobObjectLimitJobMemory = 0x00000200;
    internal const uint JobObjectLimitDieOnUnhandledException = 0x00000400;
    internal const uint JobObjectLimitKillOnJobClose = 0x00002000;
    internal const uint JobObjectUiLimitAll = 0x000000FF;

    [StructLayout(LayoutKind.Sequential)] internal struct SecurityCapabilities { public IntPtr AppContainerSid; public IntPtr Capabilities; public uint CapabilityCount; public uint Reserved; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] internal struct StartupInfo { public int cb; public string? reserved; public string? desktop; public string? title; public uint x, y, xSize, ySize, xCountChars, yCountChars, fillAttribute, flags; public short showWindow, reserved2; public IntPtr reserved2Ptr, stdInput, stdOutput, stdError; }
    [StructLayout(LayoutKind.Sequential)] internal struct StartupInfoEx { public StartupInfo StartupInfo; public IntPtr AttributeList; }
    [StructLayout(LayoutKind.Sequential)] internal struct ProcessInformation { public IntPtr Process; public IntPtr Thread; public uint ProcessId; public uint ThreadId; }
    [StructLayout(LayoutKind.Sequential)] internal struct JobObjectBasicLimitInformation { public long PerProcessUserTimeLimit, PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass, SchedulingClass; }
    [StructLayout(LayoutKind.Sequential)] internal struct IoCounters { public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount; }
    [StructLayout(LayoutKind.Sequential)] internal struct JobObjectExtendedLimitInformation { public JobObjectBasicLimitInformation BasicLimitInformation; public IoCounters IoInfo; public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed; }

    [DllImport("userenv.dll", CharSet = CharSet.Unicode)] internal static extern int CreateAppContainerProfile(string appContainerName, string displayName, string description, IntPtr capabilities, uint capabilityCount, out IntPtr appContainerSid);
    [DllImport("userenv.dll", CharSet = CharSet.Unicode)] internal static extern int DeriveAppContainerSidFromAppContainerName(string appContainerName, out IntPtr appContainerSid);
    [DllImport("userenv.dll", CharSet = CharSet.Unicode)] internal static extern int DeleteAppContainerProfile(string appContainerName);
    [DllImport("advapi32.dll")] internal static extern IntPtr FreeSid(IntPtr sid);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(string descriptor, uint revision, out IntPtr securityDescriptor, out uint size);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool GetSecurityDescriptorSacl(IntPtr securityDescriptor, out bool present, out IntPtr sacl, out bool defaulted);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern uint SetSecurityInfo(IntPtr handle, int objectType, uint securityInformation, IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl);
    [DllImport("kernel32.dll")] private static extern IntPtr LocalFree(IntPtr memory);
    internal static void SetLowIntegrityLabel(SafePipeHandle pipe)
    {
        if (!ConvertStringSecurityDescriptorToSecurityDescriptor("S:(ML;;NW;;;LW)", 1, out var descriptor, out _)) throw new Win32Exception();
        try
        {
            if (!GetSecurityDescriptorSacl(descriptor, out var present, out var sacl, out _) || !present) throw new Win32Exception();
            var error = SetSecurityInfo(pipe.DangerousGetHandle(), 6, 0x00000010, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, sacl);
            if (error != 0) throw new Win32Exception(unchecked((int)error));
        }
        finally { LocalFree(descriptor); }
    }
    [DllImport("kernel32.dll", SetLastError = true)] internal static extern bool InitializeProcThreadAttributeList(IntPtr attributeList, int attributeCount, int flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)] internal static extern bool UpdateProcThreadAttribute(IntPtr attributeList, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previousValue, IntPtr returnSize);
    internal static bool UpdateProcThreadAttribute(IntPtr list, uint flags, int attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned) => UpdateProcThreadAttribute(list, flags, (IntPtr)attribute, value, size, previous, returned);
    [DllImport("kernel32.dll")] internal static extern void DeleteProcThreadAttributeList(IntPtr attributeList);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "CreateProcessW")]
    internal static extern bool CreateProcess(string applicationName, string commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint creationFlags, IntPtr environment, string currentDirectory, ref StartupInfoEx startupInfo, out ProcessInformation processInformation);
    [DllImport("kernel32.dll", SetLastError = true)] internal static extern SafeFileHandle CreateJobObject(IntPtr attributes, string? name);
    [DllImport("kernel32.dll", SetLastError = true)] internal static extern bool SetInformationJobObject(SafeFileHandle job, int infoClass, IntPtr info, uint length);
    [DllImport("kernel32.dll", SetLastError = true)] internal static extern bool AssignProcessToJobObject(SafeFileHandle job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)] internal static extern bool TerminateJobObject(SafeFileHandle job, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)] internal static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)] internal static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)] internal static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)] internal static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true)] internal static extern bool GetNamedPipeClientProcessId(SafePipeHandle pipe, out uint clientProcessId);
    [DllImport("kernel32.dll", SetLastError = true)] internal static extern bool GetNamedPipeServerProcessId(SafePipeHandle pipe, out uint serverProcessId);
}
