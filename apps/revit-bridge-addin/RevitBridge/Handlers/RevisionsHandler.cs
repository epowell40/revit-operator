using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Reflection;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;

namespace RevitBridge.Handlers
{
    public sealed class RevisionsHandler : IRequestHandler
    {
        public sealed class Params
        {
            public int? max { get; set; }
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrWhiteSpace(jsonData)
                ? new Params()
                : (JsonSerializer.Deserialize<Params>(jsonData) ?? new Params());

            var doc = app.ActiveUIDocument?.Document;
            if (doc == null)
            {
                return Task.FromResult<object>(new
                {
                    status = "NoDocument",
                    message = "No active Revit document."
                });
            }

            var max = p.max.HasValue && p.max.Value > 0 ? Math.Min(p.max.Value, 1000) : 500;
            var revisions = new FilteredElementCollector(doc)
                .OfClass(typeof(Revision))
                .Cast<Revision>()
                .ToList();

            var items = revisions
                .Select(r => new
                {
                    id = RevitBridge.Common.ElementIdCompat.GetValue(r.Id),
                    sequence = ReadInt(r, "SequenceNumber"),
                    number = ReadString(r, "RevisionNumber"),
                    description = ReadString(r, "Description"),
                    revisionDate = ReadString(r, "RevisionDate"),
                    issued = ReadBool(r, "Issued"),
                    issuedBy = ReadString(r, "IssuedBy"),
                    issuedTo = ReadString(r, "IssuedTo")
                })
                .OrderBy(x => x.sequence ?? int.MaxValue)
                .ThenBy(x => x.id)
                .Take(max)
                .ToList();

            return Task.FromResult<object>(new
            {
                status = "Ok",
                returned = items.Count,
                items
            });
        }

        internal static string? ReadString(object obj, string propName)
        {
            try
            {
                var p = obj.GetType().GetProperty(propName, BindingFlags.Instance | BindingFlags.Public);
                var raw = p?.GetValue(obj, null);
                var s = raw?.ToString();
                return string.IsNullOrWhiteSpace(s) ? null : s;
            }
            catch
            {
                return null;
            }
        }

        internal static int? ReadInt(object obj, string propName)
        {
            try
            {
                var p = obj.GetType().GetProperty(propName, BindingFlags.Instance | BindingFlags.Public);
                var raw = p?.GetValue(obj, null);
                if (raw == null) return null;
                if (raw is int i) return i;
                if (int.TryParse(raw.ToString(), NumberStyles.Integer, CultureInfo.InvariantCulture, out var parsed))
                {
                    return parsed;
                }
            }
            catch
            {
                // ignore
            }
            return null;
        }

        internal static bool? ReadBool(object obj, string propName)
        {
            try
            {
                var p = obj.GetType().GetProperty(propName, BindingFlags.Instance | BindingFlags.Public);
                var raw = p?.GetValue(obj, null);
                if (raw == null) return null;
                if (raw is bool b) return b;
                if (bool.TryParse(raw.ToString(), out var parsed)) return parsed;
            }
            catch
            {
                // ignore
            }
            return null;
        }

        internal static void TrySetProperty(object obj, string propName, object value)
        {
            if (obj == null || value == null) return;
            try
            {
                var p = obj.GetType().GetProperty(propName, BindingFlags.Instance | BindingFlags.Public);
                if (p == null || !p.CanWrite) return;

                if (p.PropertyType == typeof(string))
                {
                    p.SetValue(obj, value.ToString(), null);
                    return;
                }

                if (p.PropertyType == typeof(bool))
                {
                    if (value is bool b) p.SetValue(obj, b, null);
                    else if (bool.TryParse(value.ToString(), out var parsed)) p.SetValue(obj, parsed, null);
                    return;
                }

                p.SetValue(obj, value, null);
            }
            catch
            {
                // best effort
            }
        }
    }
}
