using System.IO;
using System.Text.Json;

namespace RevitBridge.Logic.LowVoltage.Skills.NurseCall
{
    public static class NurseCallProfileLoader
    {
        public static NurseCallProfile Load(string path)
        {
            if (!File.Exists(path)) return NurseCallProfile.CreateDefault();
            var json = File.ReadAllText(path);
            var options = new JsonSerializerOptions { PropertyNameCaseInsensitive = true };
            return JsonSerializer.Deserialize<NurseCallProfile>(json, options) ?? NurseCallProfile.CreateDefault();
        }
    }
}
