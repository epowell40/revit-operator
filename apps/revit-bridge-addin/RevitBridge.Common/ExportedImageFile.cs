using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace RevitBridge.Common
{
    // Shared by exact-target export hashing and the existing image metadata
    // reader. Callers retain responsibility for workspace containment.
    public static class ExportedImageFile
    {
        [DllImport("kernel32.dll", EntryPoint = "CreateFileW", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern SafeFileHandle OpenImageFile(string filename, uint access, uint share,
            IntPtr security, uint creation, uint attributes, IntPtr template);

        public static Stream OpenRead(string path)
        {
            if (string.IsNullOrWhiteSpace(path)) throw new ArgumentException("An exported image path is required.", nameof(path));
            if (path.Length < 248) return File.OpenRead(path);
            // Preserve the existing absolute artifact; never change host-wide
            // .NET switches. Legacy Revit rejects long FileStream(string) names.
            var readPath = path;
            if (!path.StartsWith(@"\\?\", StringComparison.Ordinal))
            {
                if (path.StartsWith(@"\\", StringComparison.Ordinal)) readPath = @"\\?\UNC\" + path.Substring(2);
                else if (path.Length > 2 && char.IsLetter(path[0]) && path[1] == ':' && path[2] == '\\') readPath = @"\\?\" + path;
                else throw new ArgumentException("Long exported image paths must be absolute.", nameof(path));
            }
            var handle = OpenImageFile(readPath, 0x80000000, 1, IntPtr.Zero, 3, 0x80, IntPtr.Zero);
            if (handle.IsInvalid)
            {
                var error = Marshal.GetLastWin32Error();
                handle.Dispose();
                throw new IOException("Could not read the exported image.", new Win32Exception(error));
            }
            try { return new FileStream(handle, FileAccess.Read); }
            catch { handle.Dispose(); throw; }
        }
    }
}
