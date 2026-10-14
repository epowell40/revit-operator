using System;
using System.Collections.Generic;
using System.Text.Json;

namespace RevitBridge.Common
{
    public class ScheduleCellLocator
    {
        public string? section { get; set; }
        public int? row { get; set; }
        public int? column { get; set; }
    }

    public sealed class ScheduleCellBackgroundChange : ScheduleCellLocator
    {
        public string? expectedText { get; set; }
        public int[]? backgroundColorRgb { get; set; }
    }

    /// <summary>One bounded, exact-cell contract shared by native admission and execution.</summary>
    public static class ScheduleCellAppearanceContract
    {
        public const int MaxCells = 64;
        public static string NormalizeSection(string? section)
        {
            foreach (var name in new[] { "Header", "Body", "Summary", "Footer" })
                if (string.Equals(name, section?.Trim(), StringComparison.OrdinalIgnoreCase)) return name;
            throw new ArgumentException("Cell section must be Header, Body, Summary or Footer.");
        }

        public static string Key(ScheduleCellLocator cell)
            => NormalizeSection(cell.section) + ":" + cell.row + ":" + cell.column;

        public static bool Validate(JsonElement body, bool editing, out string error)
        {
            error = "";
            if (body.ValueKind != JsonValueKind.Object) { error = "Cell appearance body must be an object."; return false; }
            var allowed = editing ? new[] { "scheduleId", "cellStyles", "dryRun" } : new[] { "scheduleId", "cells", "action" };
            foreach (var p in body.EnumerateObject())
                if (Array.IndexOf(allowed, p.Name) < 0) { error = "Cell appearance cannot be mixed with other schedule operations: " + p.Name; return false; }
            if (!body.TryGetProperty("scheduleId", out var id) || id.ValueKind != JsonValueKind.Number || !id.TryGetInt64(out var n) || n <= 0)
            { error = "Cell appearance requires one positive scheduleId resolved from the model."; return false; }
            if (body.TryGetProperty("dryRun", out var dry) && dry.ValueKind != JsonValueKind.Null && dry.ValueKind != JsonValueKind.True && dry.ValueKind != JsonValueKind.False)
            { error = "dryRun must be Boolean."; return false; }
            if (!editing && (!body.TryGetProperty("action", out var action) || action.ValueKind != JsonValueKind.String || action.GetString() != "cell_styles"))
            { error = "Cell appearance reads require action=cell_styles."; return false; }
            var field = editing ? "cellStyles" : "cells";
            if (!body.TryGetProperty(field, out var cells) || cells.ValueKind != JsonValueKind.Array || cells.GetArrayLength() < 1 || cells.GetArrayLength() > MaxCells)
            { error = field + " must contain 1..64 exact cell locators."; return false; }
            var seen = new HashSet<string>(StringComparer.Ordinal);
            foreach (var cell in cells.EnumerateArray())
            {
                if (cell.ValueKind != JsonValueKind.Object) { error = "Cell locators must be objects."; return false; }
                var cellAllowed = editing ? new[] { "section", "row", "column", "expectedText", "backgroundColorRgb" } : new[] { "section", "row", "column" };
                foreach (var p in cell.EnumerateObject())
                    if (Array.IndexOf(cellAllowed, p.Name) < 0) { error = "Unsupported cell appearance property: " + p.Name; return false; }
                if (!cell.TryGetProperty("section", out var section) || section.ValueKind != JsonValueKind.String)
                { error = "Each cell needs its native section."; return false; }
                string canonical;
                try { canonical = NormalizeSection(section.GetString()); } catch (ArgumentException ex) { error = ex.Message; return false; }
                if (!cell.TryGetProperty("row", out var row) || row.ValueKind != JsonValueKind.Number || !row.TryGetInt32(out var r) || r < 0 || r > 100000
                    || !cell.TryGetProperty("column", out var column) || column.ValueKind != JsonValueKind.Number || !column.TryGetInt32(out var c) || c < 0 || c > 100000)
                { error = "Cell row/column must be native nonnegative integers, at most 100000."; return false; }
                if (!seen.Add(canonical + ":" + r + ":" + c)) { error = "Duplicate cell locators are not permitted."; return false; }
                if (!editing) continue;
                if (!cell.TryGetProperty("expectedText", out var text) || text.ValueKind != JsonValueKind.String || text.GetString()!.Length > 4000)
                { error = "Each edit needs expectedText from a native read (blank text is allowed)."; return false; }
                if (!cell.TryGetProperty("backgroundColorRgb", out var color) || color.ValueKind != JsonValueKind.Array || color.GetArrayLength() != 3)
                { error = "backgroundColorRgb must contain three integer bytes."; return false; }
                foreach (var channel in color.EnumerateArray())
                    if (channel.ValueKind != JsonValueKind.Number || !channel.TryGetInt32(out var channelValue) || channelValue < 0 || channelValue > 255)
                    { error = "RGB channels must be integers from 0 through 255."; return false; }
            }
            return true;
        }
    }
}
