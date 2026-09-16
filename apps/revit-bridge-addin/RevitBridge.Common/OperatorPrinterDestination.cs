using System;
using System.ComponentModel;
using System.Linq;
using System.Runtime.InteropServices;

namespace RevitBridge.Common
{
    /// <summary>Read spooler destination metadata without selecting a driver or starting a job.</summary>
    public static class OperatorPrinterDestination
    {
        public static string? BlockingReason(string? ports)
        {
            if (string.IsNullOrWhiteSpace(ports)) return "printer_capability_unavailable";
            return ports!.Split(',').Any(p => string.Equals(p.Trim(), "PORTPROMPT:", StringComparison.OrdinalIgnoreCase))
                ? "interactive_printer_destination" : null;
        }

        public static string ReadPorts(string printerName)
        {
            if (string.IsNullOrWhiteSpace(printerName)) throw new ArgumentException("Printer name is required.");
            if (!OpenPrinter(printerName, out var printer, IntPtr.Zero)) throw new Win32Exception(Marshal.GetLastWin32Error());
            try
            {
                GetPrinter(printer, 5, IntPtr.Zero, 0, out var needed);
                if (needed < Marshal.SizeOf<PrinterInfo5>() || needed > 1024 * 1024)
                    throw new InvalidOperationException("Printer destination metadata is unavailable or exceeds its bound.");
                var buffer = Marshal.AllocHGlobal((int)needed);
                try
                {
                    if (!GetPrinter(printer, 5, buffer, needed, out _)) throw new Win32Exception(Marshal.GetLastWin32Error());
                    return Marshal.PtrToStringUni(Marshal.PtrToStructure<PrinterInfo5>(buffer).PortName) ?? "";
                }
                finally { Marshal.FreeHGlobal(buffer); }
            }
            finally { ClosePrinter(printer); }
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct PrinterInfo5
        {
            public IntPtr PrinterName;
            public IntPtr PortName;
            public uint Attributes;
            public uint DeviceNotSelectedTimeout;
            public uint TransmissionRetryTimeout;
        }

        [DllImport("winspool.drv", EntryPoint = "OpenPrinterW", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool OpenPrinter(string name, out IntPtr printer, IntPtr defaults);
        [DllImport("winspool.drv", EntryPoint = "GetPrinterW", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetPrinter(IntPtr printer, uint level, IntPtr buffer, uint size, out uint needed);
        [DllImport("winspool.drv", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool ClosePrinter(IntPtr printer);
    }
}
