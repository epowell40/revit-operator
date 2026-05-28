using System;
using System.Globalization;
using System.Text.Json;
using Autodesk.Revit.DB;

namespace RevitBridge.Common
{
    public static class ParameterValueUtil
    {
        public static object SnapshotForWire(Parameter param)
        {
            if (param == null) return new { storageType = "Unknown", value = (object?)null, valueString = (string?)null };

            object? raw = null;
            string? valueString = null;

            try { valueString = param.AsValueString(); } catch { valueString = null; }

            try
            {
                switch (param.StorageType)
                {
                    case StorageType.String:
                        raw = param.AsString();
                        break;
                    case StorageType.Integer:
                        raw = param.AsInteger();
                        break;
                    case StorageType.Double:
                        raw = param.AsDouble();
                        break;
                    case StorageType.ElementId:
                        raw = RevitBridge.Common.ElementIdCompat.GetValue(param.AsElementId());
                        break;
                }
            }
            catch
            {
                raw = null;
            }

            if (string.IsNullOrWhiteSpace(valueString))
            {
                try
                {
                    valueString = raw == null ? null : Convert.ToString(raw, CultureInfo.InvariantCulture);
                }
                catch
                {
                    valueString = null;
                }
            }

            return new
            {
                storageType = param.StorageType.ToString(),
                value = raw,
                valueString
            };
        }

        public static bool TrySetFromString(Parameter param, string? value, out bool changed, out string? message)
        {
            changed = false;
            message = null;
            if (param == null)
            {
                message = "Parameter is null.";
                return false;
            }

            if (param.IsReadOnly)
            {
                message = "Parameter is read-only.";
                return false;
            }

            try
            {
                switch (param.StorageType)
                {
                    case StorageType.String:
                    {
                        var current = param.AsString() ?? "";
                        var next = value ?? "";
                        if (string.Equals(current, next, StringComparison.Ordinal))
                        {
                            changed = false;
                            return true;
                        }
                        changed = param.Set(next);
                        if (!changed) message = "Set returned false.";
                        return changed;
                    }
                    case StorageType.Integer:
                    {
                        if (!TryParseInt(value, out var next))
                        {
                            message = $"Invalid integer '{value}'.";
                            return false;
                        }
                        var current = param.AsInteger();
                        if (current == next)
                        {
                            changed = false;
                            return true;
                        }
                        changed = param.Set(next);
                        if (!changed) message = "Set returned false.";
                        return changed;
                    }
                    case StorageType.Double:
                    {
                        if (!TryParseDouble(value, out var next))
                        {
                            message = $"Invalid number '{value}'.";
                            return false;
                        }
                        var current = param.AsDouble();
                        if (Math.Abs(current - next) < 1e-9)
                        {
                            changed = false;
                            return true;
                        }
                        changed = param.Set(next);
                        if (!changed) message = "Set returned false.";
                        return changed;
                    }
                    case StorageType.ElementId:
                    {
                        if (!TryParseLong(value, out var next))
                        {
                            message = $"Invalid element id '{value}'.";
                            return false;
                        }
                        var current = param.AsElementId();
                        var currentVal = RevitBridge.Common.ElementIdCompat.GetValue(current);
                        if (currentVal == next)
                        {
                            changed = false;
                            return true;
                        }
                        changed = param.Set(RevitBridge.Common.ElementIdCompat.Create(next));
                        if (!changed) message = "Set returned false.";
                        return changed;
                    }
                    default:
                        message = $"Unsupported storage type {param.StorageType}.";
                        return false;
                }
            }
            catch (Exception ex)
            {
                message = ex.Message;
                return false;
            }
        }

        public static bool SnapshotMatchesRequestedValue(object? snapshot, string? requestedValue)
        {
            if (snapshot == null) return false;

            try
            {
                using var doc = JsonDocument.Parse(JsonSerializer.Serialize(snapshot));
                var root = doc.RootElement;
                var storageType = root.TryGetProperty("storageType", out var storageTypeEl)
                    ? (storageTypeEl.GetString() ?? "").Trim()
                    : "";

                switch (storageType)
                {
                    case "String":
                    {
                        var current = root.TryGetProperty("value", out var valueEl) && valueEl.ValueKind == JsonValueKind.String
                            ? valueEl.GetString() ?? ""
                            : root.TryGetProperty("valueString", out var valueStringEl) && valueStringEl.ValueKind == JsonValueKind.String
                                ? valueStringEl.GetString() ?? ""
                                : "";
                        return string.Equals(current, requestedValue ?? "", StringComparison.Ordinal);
                    }
                    case "Integer":
                    {
                        if (!TryParseInt(requestedValue, out var expected)) return false;
                        if (!root.TryGetProperty("value", out var valueEl)) return false;
                        if (valueEl.ValueKind == JsonValueKind.Number && valueEl.TryGetInt32(out var actualInt)) return actualInt == expected;
                        return valueEl.ValueKind == JsonValueKind.String && int.TryParse(valueEl.GetString(), NumberStyles.Integer, CultureInfo.InvariantCulture, out var actualStringInt) && actualStringInt == expected;
                    }
                    case "Double":
                    {
                        if (!TryParseDouble(requestedValue, out var expected)) return false;
                        if (!root.TryGetProperty("value", out var valueEl)) return false;
                        if (valueEl.ValueKind == JsonValueKind.Number && valueEl.TryGetDouble(out var actualDouble)) return Math.Abs(actualDouble - expected) < 1e-9;
                        return valueEl.ValueKind == JsonValueKind.String && double.TryParse(valueEl.GetString(), NumberStyles.Float, CultureInfo.InvariantCulture, out var actualStringDouble) && Math.Abs(actualStringDouble - expected) < 1e-9;
                    }
                    case "ElementId":
                    {
                        if (!TryParseLong(requestedValue, out var expected)) return false;
                        if (!root.TryGetProperty("value", out var valueEl)) return false;
                        if (valueEl.ValueKind == JsonValueKind.Number && valueEl.TryGetInt64(out var actualLong)) return actualLong == expected;
                        return valueEl.ValueKind == JsonValueKind.String && long.TryParse(valueEl.GetString(), NumberStyles.Integer, CultureInfo.InvariantCulture, out var actualStringLong) && actualStringLong == expected;
                    }
                    default:
                    {
                        var current = root.TryGetProperty("valueString", out var valueStringEl) && valueStringEl.ValueKind == JsonValueKind.String
                            ? valueStringEl.GetString() ?? ""
                            : root.TryGetProperty("value", out var valueEl)
                                ? valueEl.GetRawText()
                                : "";
                        return string.Equals(current.Trim(), (requestedValue ?? "").Trim(), StringComparison.OrdinalIgnoreCase);
                    }
                }
            }
            catch
            {
                return false;
            }
        }

        private static bool TryParseInt(string? s, out int value)
        {
            value = 0;
            var t = (s ?? "").Trim();
            if (t.Length == 0) return false;
            return int.TryParse(t, NumberStyles.Integer, CultureInfo.InvariantCulture, out value) ||
                   int.TryParse(t, NumberStyles.Integer, CultureInfo.CurrentCulture, out value);
        }

        private static bool TryParseLong(string? s, out long value)
        {
            value = 0;
            var t = (s ?? "").Trim();
            if (t.Length == 0) return false;
            return long.TryParse(t, NumberStyles.Integer, CultureInfo.InvariantCulture, out value) ||
                   long.TryParse(t, NumberStyles.Integer, CultureInfo.CurrentCulture, out value);
        }

        private static bool TryParseDouble(string? s, out double value)
        {
            value = 0;
            var t = (s ?? "").Trim();
            if (t.Length == 0) return false;
            return double.TryParse(t, NumberStyles.Float, CultureInfo.InvariantCulture, out value) ||
                   double.TryParse(t, NumberStyles.Float, CultureInfo.CurrentCulture, out value);
        }
    }
}
