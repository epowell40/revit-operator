using System.IO;
using System.Text.Json;

namespace RevitBridge.Logic.LowVoltage.Skills.DataOutlets
{
    public static class DataOutletsProfileLoader
    {
        public static DataOutletsProfile Load(string path)
        {
            if (!File.Exists(path)) return DataOutletsProfile.CreateDefault();
            var json = File.ReadAllText(path);
            var options = new JsonSerializerOptions { PropertyNameCaseInsensitive = true };
            return JsonSerializer.Deserialize<DataOutletsProfile>(json, options) ?? DataOutletsProfile.CreateDefault();
        }
    }
}
