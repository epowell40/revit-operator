using System;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;

namespace RevitOperator.DynamicRevitSdk;

/// <summary>Fail-closed, cross-process one-use marker for an already validated admission replay key.</summary>
public static class DurableAdmissionReplayLedgerV1
{
    public static bool TryConsume(string directory, string replayKey, long expiresUnixSeconds)
    {
        if (string.IsNullOrWhiteSpace(directory) || !DynamicCanonical.Hash(replayKey) || expiresUnixSeconds <= 0)
            throw new ArgumentException("Dynamic admission replay marker input is invalid.");
        var root = Path.GetFullPath(directory); Directory.CreateDirectory(root); RequirePlainAncestors(root);
        var marker = Path.Combine(root, replayKey.Substring("sha256:".Length) + ".used");
        try
        {
            using var stream = new FileStream(marker, FileMode.CreateNew, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough);
            var payload = Encoding.UTF8.GetBytes(expiresUnixSeconds.ToString(CultureInfo.InvariantCulture));
            stream.Write(payload, 0, payload.Length); stream.Flush(true); return true;
        }
        catch (IOException) when (File.Exists(marker)) { return false; }
    }

    private static void RequirePlainAncestors(string target)
    {
        var chain = Enumerable.Repeat(new DirectoryInfo(target), 1).Concat(Ancestors(new DirectoryInfo(target))).Reverse();
        foreach (var directory in chain)
            if ((directory.Attributes & FileAttributes.ReparsePoint) != 0) throw new InvalidOperationException("Dynamic admission replay storage crosses a reparse point.");
    }
    private static System.Collections.Generic.IEnumerable<DirectoryInfo> Ancestors(DirectoryInfo directory)
    {
        for (var current = directory.Parent; current != null; current = current.Parent) yield return current;
    }
}
