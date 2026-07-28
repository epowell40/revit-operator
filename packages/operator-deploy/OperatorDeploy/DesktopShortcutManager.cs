using System.Runtime.InteropServices;

namespace RevitOperator.Deployment;

public sealed record DesktopShortcutInfo(string TargetPath, string Arguments, string WorkingDirectory);

public interface IDesktopShortcutManager
{
    bool IsSupported { get; }
    void CreateOrUpdate(string shortcutPath, DesktopShortcutInfo shortcut);
    DesktopShortcutInfo? Read(string shortcutPath);
}

public static class DesktopShortcutManager
{
    public static IDesktopShortcutManager CreateDefault()
        => OperatingSystem.IsWindows()
            ? new WindowsDesktopShortcutManager()
            : new UnsupportedDesktopShortcutManager();
}

internal sealed class UnsupportedDesktopShortcutManager : IDesktopShortcutManager
{
    public bool IsSupported => false;
    public void CreateOrUpdate(string shortcutPath, DesktopShortcutInfo shortcut) { }
    public DesktopShortcutInfo? Read(string shortcutPath) => null;
}

internal sealed class WindowsDesktopShortcutManager : IDesktopShortcutManager
{
    private static Type? ShellType => Type.GetTypeFromProgID("WScript.Shell", throwOnError: false);

    public bool IsSupported => ShellType != null;

    public void CreateOrUpdate(string shortcutPath, DesktopShortcutInfo shortcut)
    {
        var shellType = ShellType ?? throw new PlatformNotSupportedException("Windows Script Host is unavailable; Operator Desktop.lnk cannot be managed.");
        Directory.CreateDirectory(Path.GetDirectoryName(shortcutPath)!);
        var temporaryPath = shortcutPath + $".tmp-{Guid.NewGuid():N}.lnk";
        object? shell = null;
        object? link = null;
        try
        {
            shell = Activator.CreateInstance(shellType) ?? throw new InvalidOperationException("Windows Script Host could not be created.");
            dynamic dynamicShell = shell;
            link = dynamicShell.CreateShortcut(temporaryPath);
            dynamic dynamicLink = link;
            dynamicLink.TargetPath = shortcut.TargetPath;
            dynamicLink.Arguments = shortcut.Arguments;
            dynamicLink.WorkingDirectory = shortcut.WorkingDirectory;
            dynamicLink.Description = "Launch Revit Operator Desktop";
            dynamicLink.Save();
            File.Move(temporaryPath, shortcutPath, overwrite: true);
        }
        finally
        {
            ReleaseComObject(link);
            ReleaseComObject(shell);
            if (File.Exists(temporaryPath)) File.Delete(temporaryPath);
        }
    }

    public DesktopShortcutInfo? Read(string shortcutPath)
    {
        if (!File.Exists(shortcutPath)) return null;
        var shellType = ShellType ?? throw new PlatformNotSupportedException("Windows Script Host is unavailable; Operator Desktop.lnk cannot be inspected.");
        object? shell = null;
        object? link = null;
        try
        {
            shell = Activator.CreateInstance(shellType) ?? throw new InvalidOperationException("Windows Script Host could not be created.");
            dynamic dynamicShell = shell;
            link = dynamicShell.CreateShortcut(shortcutPath);
            dynamic dynamicLink = link;
            return new DesktopShortcutInfo(
                (string)dynamicLink.TargetPath,
                (string)dynamicLink.Arguments,
                (string)dynamicLink.WorkingDirectory);
        }
        finally
        {
            ReleaseComObject(link);
            ReleaseComObject(shell);
        }
    }

    private static void ReleaseComObject(object? value)
    {
        if (value != null && Marshal.IsComObject(value)) Marshal.FinalReleaseComObject(value);
    }
}
