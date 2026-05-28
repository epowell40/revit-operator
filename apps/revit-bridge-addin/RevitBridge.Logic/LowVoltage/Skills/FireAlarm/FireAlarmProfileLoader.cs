using System.IO;
using System.Text.Json;

namespace RevitBridge.Logic.LowVoltage.Skills.FireAlarm
{
    public static class FireAlarmProfileLoader
    {
        public static FireAlarmProfile Load(string path)
        {
            if (!File.Exists(path)) return FireAlarmProfile.CreateDefault();
            var json = File.ReadAllText(path);
            var options = new JsonSerializerOptions { PropertyNameCaseInsensitive = true };
            return JsonSerializer.Deserialize<FireAlarmProfile>(json, options) ?? FireAlarmProfile.CreateDefault();
        }
    }
}
