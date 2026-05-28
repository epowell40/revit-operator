using System.IO;
using System.Text.Json;
using RevitBridge.Common.LowVoltage.Core.Normalization;

namespace RevitBridge.Common.LowVoltage.Core.Profiles
{
    public static class NormalizationProfileLoader
    {
        public static NormalizationProfile Load(string path)
        {
            var json = File.ReadAllText(path);
            var opts = new JsonSerializerOptions { PropertyNameCaseInsensitive = true };
            return JsonSerializer.Deserialize<NormalizationProfile>(json, opts) ?? new NormalizationProfile();
        }
    }
}
