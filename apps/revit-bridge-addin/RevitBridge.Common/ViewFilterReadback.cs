using System;
using System.Collections.Generic;
using System.Linq;
using Autodesk.Revit.DB;
using RevitBridge.Common.Semantic;

namespace RevitBridge.Common
{
    /// <summary>Reads persisted native filter state; never reconstructs rules from mutation inputs.</summary>
    public static class ViewFilterReadback
    {
        public static object Read(ParameterFilterElement? filter)
        {
            if (filter == null) return new { complete = false, reason = "not_parameter_filter" };
            try
            {
                var categories = filter.GetCategories().Select(ElementIdCompat.GetValue).OrderBy(x => x).Take(257).ToArray();
                if (categories.Length > 256) throw new NotSupportedException("category_limit");
                var remaining = 128;
                var rules = ReadFilter(filter.Document, filter.GetElementFilter(), 0, ref remaining);
                return new { complete = true, categoryIds = categories, categories = categories.Select(id => new { id, name = Category.GetCategory(filter.Document, ElementIdCompat.Create(id))?.Name, builtInCategory = StrictCategoryResolver.TryGetEnumName(typeof(BuiltInCategory), id) }).ToArray(), rules };
            }
            catch (Exception ex)
            {
                // A missing/unsupported value cannot be represented as an empty successful rule.
                return new { complete = false, reason = ex is NotSupportedException ? ex.Message : "native_filter_read_failed" };
            }
        }

        private static string? ParameterName(Document doc, ElementId id)
        {
            var value = ElementIdCompat.GetValue(id);
            // Revit 2024 widened built-in enums to Int64; boxed Int32 values throw.
            var builtInName = value < 0 ? StrictCategoryResolver.TryGetEnumName(typeof(BuiltInParameter), value) : null;
            if (builtInName != null)
                return LabelUtils.GetLabelFor((BuiltInParameter)Enum.Parse(typeof(BuiltInParameter), builtInName));
            return doc.GetElement(id)?.Name;
        }

        private static void Consume(int depth, ref int remaining)
        {
            if (depth > 8 || --remaining < 0) throw new NotSupportedException("rule_tree_limit");
        }

        private static object ReadFilter(Document doc, ElementFilter? filter, int depth, ref int remaining)
        {
            Consume(depth, ref remaining);
            if (filter == null) return new { kind = "all" };
            var result = new Dictionary<string, object?> { ["nativeType"] = filter.GetType().Name, ["inverted"] = filter.Inverted };
            var children = new List<object>();
            if (filter is ElementParameterFilter parameter)
            {
                result["kind"] = "and";
                foreach (var rule in parameter.GetRules()) children.Add(ReadRule(doc, rule, depth + 1, ref remaining));
            }
            else if (filter is LogicalAndFilter || filter is LogicalOrFilter)
            {
                result["kind"] = filter is LogicalAndFilter ? "and" : "or";
                foreach (var child in ((ElementLogicalFilter)filter).GetFilters()) children.Add(ReadFilter(doc, child, depth + 1, ref remaining));
            }
            else throw new NotSupportedException("unsupported_filter:" + filter.GetType().Name);
            result["children"] = children;
            return result;
        }

        private static object ReadRule(Document doc, FilterRule rule, int depth, ref int remaining)
        {
            Consume(depth, ref remaining);
            if (rule is FilterInverseRule inverse)
                return new { kind = "not", child = ReadRule(doc, inverse.GetInnerRule(), depth + 1, ref remaining) };
            var result = new Dictionary<string, object?>
            {
                ["kind"] = "rule", ["nativeType"] = rule.GetType().Name,
                ["parameterId"] = ElementIdCompat.GetValue(rule.GetRuleParameter()),
                ["parameterName"] = ParameterName(doc, rule.GetRuleParameter()),
                ["builtInParameter"] = StrictCategoryResolver.TryGetEnumName(typeof(BuiltInParameter), ElementIdCompat.GetValue(rule.GetRuleParameter()))
            };
            if (rule is FilterStringRule text)
            {
                if (text.RuleString.Length > 4096) throw new NotSupportedException("string_rule_limit");
                result["value"] = text.RuleString;
                result["valueType"] = "string";
                result["evaluator"] = text.GetEvaluator().GetType().Name;
            }
            else if (rule is FilterNumericValueRule numeric)
            {
                result["evaluator"] = numeric.GetEvaluator().GetType().Name;
                if (rule is FilterDoubleRule number)
                {
                    if (double.IsNaN(number.RuleValue) || double.IsInfinity(number.RuleValue) || double.IsNaN(number.Epsilon) || double.IsInfinity(number.Epsilon))
                        throw new NotSupportedException("nonfinite_rule");
                    result["value"] = number.RuleValue;
                    result["epsilon"] = number.Epsilon;
                    result["valueType"] = "double_internal_units";
                }
                else if (rule is FilterIntegerRule integer) { result["value"] = integer.RuleValue; result["valueType"] = "integer"; }
                else if (rule is FilterElementIdRule element) { result["value"] = ElementIdCompat.GetValue(element.RuleValue); result["valueType"] = "element_id"; }
                else throw new NotSupportedException("unsupported_rule:" + rule.GetType().Name);
            }
            else throw new NotSupportedException("unsupported_rule:" + rule.GetType().Name);
            return result;
        }
    }
}
