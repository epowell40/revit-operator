using System.IO;
using System.Text.Json;

namespace RevitBridge.Common.LowVoltage.Core.Export
{
    public static class SnapshotWriter
    {
        public static void Write<T>(string directory, string fileName, T payload)
        {
            Directory.CreateDirectory(directory);
            var json = JsonSerializer.Serialize(payload, new JsonSerializerOptions { WriteIndented = true });
            File.WriteAllText(Path.Combine(directory, fileName), json);
        }
    }
}
