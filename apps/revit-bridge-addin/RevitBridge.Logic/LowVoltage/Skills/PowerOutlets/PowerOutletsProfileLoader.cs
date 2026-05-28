using System.IO;
using System.Text.Json;

namespace RevitBridge.Logic.LowVoltage.Skills.PowerOutlets
{
    public static class PowerOutletsProfileLoader
    {
        public static PowerOutletsProfile Load(string path)
        {
            if (!File.Exists(path)) return PowerOutletsProfile.CreateDefault();
            var json = File.ReadAllText(path);
            var options = new JsonSerializerOptions { PropertyNameCaseInsensitive = true };
            return JsonSerializer.Deserialize<PowerOutletsProfile>(json, options) ?? PowerOutletsProfile.CreateDefault();
        }
    }
}
