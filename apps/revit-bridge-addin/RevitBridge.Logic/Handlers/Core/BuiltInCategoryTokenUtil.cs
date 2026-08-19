using System;
using System.Collections.Generic;
using Autodesk.Revit.DB;
using RevitBridge.Common;

namespace RevitBridge.Logic.Handlers
{
    internal static class BuiltInCategoryTokenUtil
    {
        public static bool TryParse(string token, out BuiltInCategory category)
        {
            category = default;
            var raw = (token ?? "").Trim();
            if (raw.Length == 0) return false;

            if (TryParseAlias(raw, out var alias))
            {
                category = alias;
                return true;
            }

            // Accept BuiltInCategory enum names (OST_...)
            if (Enum.TryParse<BuiltInCategory>(raw, ignoreCase: true, out var bic))
            {
                category = bic;
                return true;
            }

            // Accept "Walls" -> OST_Walls, etc.
            if (ElementTypeResolver.TryResolveBuiltInCategory(raw, out var resolved, out _, out _))
            {
                category = resolved;
                return true;
            }

            return false;
        }

        public static bool TryParseAlias(string? token, out BuiltInCategory category)
        {
            category = default;
            var raw = (token ?? "").Trim();
            return raw.Length > 0
                && BuiltInCategoryAliasVocabulary.TryResolve(raw, out var canonical)
                && Enum.TryParse(canonical, true, out category);
        }

        public static void ParseMany(IEnumerable<string>? tokens, List<BuiltInCategory> into, List<string> unknown)
        {
            if (tokens == null) return;
            foreach (var t in tokens)
            {
                if (string.IsNullOrWhiteSpace(t)) continue;
                if (TryParse(t.Trim(), out var bic)) into.Add(bic);
                else unknown.Add(t.Trim());
            }
        }
    }
}
