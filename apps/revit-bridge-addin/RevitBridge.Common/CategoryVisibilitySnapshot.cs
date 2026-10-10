using System;
using System.Collections.Generic;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace RevitBridge.Common
{
    public sealed class CategoryVisibilityState
    {
        public long id { get; set; }
        public long? parentId { get; set; }
        public string name { get; set; } = string.Empty;
        public bool canHide { get; set; }
        public bool? hidden { get; set; }
        public bool overridable { get; set; }
        public SortedDictionary<string, object?>? graphics { get; set; }
    }

    /// <summary>Digests only complete native category states, in stable identity order.</summary>
    public static class CategoryVisibilitySnapshot
    {
        public const int Limit = 4096;
        public static string Digest(object value)
        {
            using (var sha = SHA256.Create())
                return "sha256:" + BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(value)))).Replace("-", "").ToLowerInvariant();
        }

        public static object Build(IEnumerable<CategoryVisibilityState> source, long? targetId)
        {
            var rows = source.Take(Limit + 1).OrderBy(x => x.id).ToArray();
            if (rows.Length > Limit || rows.Select(x => x.id).Distinct().Count() != rows.Length)
                throw new InvalidOperationException("category_inventory_incomplete");
            if (rows.Any(x => string.IsNullOrEmpty(x.name) || x.canHide != x.hidden.HasValue || x.overridable != (x.graphics != null)))
                throw new InvalidOperationException("category_state_incomplete");
            var target = targetId.HasValue ? rows.SingleOrDefault(x => x.id == targetId.Value) : null;
            if (targetId.HasValue && target == null) throw new InvalidOperationException("target_category_missing");
            return new
            {
                schema = "revit.category-visibility-snapshot.v1", complete = true,
                scope = "Document categories and subcategories; direct category hidden flags and graphic overrides, not effective element visibility or filter results",
                count = rows.Length, targetCategoryId = targetId, target,
                categoryIdsSha256 = Digest(rows.Select(x => x.id).ToArray()),
                allCategoriesSha256 = Digest(rows),
                otherCategoriesSha256 = targetId.HasValue ? Digest(rows.Where(x => x.id != targetId.Value).ToArray()) : null
            };
        }
    }
}
