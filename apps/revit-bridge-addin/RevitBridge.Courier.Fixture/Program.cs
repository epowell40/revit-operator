using System.Text.Json;
// Test-only transport fixture. Never contacts Revit or executes supplied code.
using var config = JsonDocument.Parse(File.ReadAllText(args[1]));
var mode = Environment.GetEnvironmentVariable("COURIER_LIFECYCLE_FIXTURE_MODE");
var path = config.RootElement.GetProperty("evidencePath").GetString()!;
if (mode == "stderr-failure") { Console.Error.Write(new string('E', 20_000)); return 3; }
if (mode == "valid-noisy") { Console.Write(new string('O', 200_000)); Console.Error.Write("fixture-only diagnostic"); }
if (mode == "large") File.WriteAllText(path, JsonSerializer.Serialize(new {
    schema = "fixture-only-no-native-authority", ok = false,
    nativeExecutionReceipt = JsonSerializer.Serialize(new { observed = new string('x', 900_000), marker = "exact Ω receipt" })
}));
else if (mode == "malformed") File.WriteAllText(path, "{");
else if (mode != "missing") File.WriteAllText(path, "{\"schema\":\"fixture-only-no-native-authority\",\"ok\":false}");
return 0;
