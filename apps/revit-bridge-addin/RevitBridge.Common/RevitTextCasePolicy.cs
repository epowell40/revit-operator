using System;
using System.Linq;
using Autodesk.Revit.DB;

namespace RevitBridge.Common
{
    public static class RevitTextCasePolicy
    {
        private static readonly string[] ProtectedParameterTerms =
        {
            "url",
            "uri",
            "email",
            "e-mail",
            "path",
            "file",
            "folder",
            "directory",
            "guid",
            "uuid",
            "token",
            "password",
            "secret",
            "key"
        };

        private static readonly string[] DraftingTextParameterTerms =
        {
            "name",
            "title",
            "description",
            "comment",
            "text",
            "note",
            "label",
            "abbreviation",
            "prefix",
            "suffix",
            "drawn",
            "checked",
            "approved",
            "issued"
        };

        public static string NormalizeDraftingText(string? value)
        {
            var text = value ?? "";
            return text.Length == 0 ? text : text.ToUpperInvariant();
        }

        public static string NormalizeSheetName(string? value)
        {
            return NormalizeDraftingText((value ?? "").Trim());
        }

        public static string NormalizeParameterValue(Element? element, Parameter? parameter, string? parameterName, string? value)
        {
            var text = value ?? "";
            if (!ShouldNormalizeParameter(element, parameter, parameterName, text)) return text;
            return NormalizeDraftingText(text);
        }

        public static bool ShouldNormalizeParameter(Element? element, Parameter? parameter, string? parameterName, string? value)
        {
            var text = value ?? "";
            if (text.Length == 0) return false;
            if (LooksCaseSensitive(text)) return false;
            if (parameter != null && parameter.StorageType != StorageType.String) return false;

            var name = NormalizeToken(parameterName);
            if (name.Length == 0 && parameter?.Definition != null)
            {
                try { name = NormalizeToken(parameter.Definition.Name); } catch { name = ""; }
            }
            if (name.Length == 0) return false;
            if (ProtectedParameterTerms.Any(term => name.Contains(NormalizeToken(term)))) return false;

            if (element is ViewSheet && (name == "sheetname" || name == "name")) return true;

            var categoryId = 0;
            try { categoryId = (int)ElementIdCompat.GetValue(element?.Category?.Id); } catch { categoryId = 0; }
            var isTitleBlock = categoryId == (int)BuiltInCategory.OST_TitleBlocks;
            if (isTitleBlock && IsDraftingTextParameterName(name)) return true;

            return IsDraftingTextParameterName(name);
        }

        public static bool ShouldNormalizeParameterName(string? parameterName, string? value)
        {
            var text = value ?? "";
            if (text.Length == 0) return false;
            if (LooksCaseSensitive(text)) return false;

            var name = NormalizeToken(parameterName);
            if (name.Length == 0) return false;
            if (ProtectedParameterTerms.Any(term => name.Contains(NormalizeToken(term)))) return false;
            return IsDraftingTextParameterName(name);
        }

        private static bool IsDraftingTextParameterName(string normalizedName)
        {
            return DraftingTextParameterTerms.Any(term => normalizedName.Contains(NormalizeToken(term)));
        }

        private static bool LooksCaseSensitive(string value)
        {
            var trimmed = value.Trim();
            if (trimmed.Length == 0) return false;
            if (trimmed.Contains("://")) return true;
            if (trimmed.Contains("@") && trimmed.Contains(".")) return true;
            if (trimmed.Contains("\\") || trimmed.StartsWith("/", StringComparison.Ordinal)) return true;
            return false;
        }

        private static string NormalizeToken(string? value)
        {
            var raw = value ?? "";
            if (string.IsNullOrWhiteSpace(raw)) return "";
            var chars = raw
                .Trim()
                .ToLowerInvariant()
                .Where(char.IsLetterOrDigit)
                .ToArray();
            return new string(chars);
        }
    }
}
