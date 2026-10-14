namespace RevitBridge.Common
{
    public sealed class PanelScheduleReadWindow
    {
        public int RowOffset { get; private set; }
        public int ColumnOffset { get; private set; }
        public int MaxRows { get; private set; }
        public int MaxColumns { get; private set; }
        // Panel sections can report NumberOfColumns=15 for valid indices1..14.
        // Counts must come from inclusive native bounds, not a zero-index assumption.
        public static int Extent(int first, int last)
        {
            if (last < first) return 0;
            var extent = (long)last - first + 1;
            if (first < 0 || extent > 10000) throw new System.ArgumentException("Panel section bounds exceed the bounded reader.");
            return (int)extent;
        }
        public static bool TryCreate(int? rowOffset, int? columnOffset, int? maxRows, int? maxColumns,
            out PanelScheduleReadWindow? window, out string error)
        {
            window = null; error = "";
            var r = rowOffset ?? 0; var c = columnOffset ?? 0;
            var nr = maxRows ?? 50; var nc = maxColumns ?? 20;
            if (r < 0 || c < 0 || r > 10000 || c > 1000 || nr < 1 || nr > 200 || nc < 1 || nc > 40 || nr * nc > 2000)
            { error = "Panel schedule detail requires nonnegative bounded offsets, 1..200 rows, 1..40 columns, and at most 2000 cells per section."; return false; }
            window = new PanelScheduleReadWindow { RowOffset = r, ColumnOffset = c, MaxRows = nr, MaxColumns = nc };
            return true;
        }
    }
}
