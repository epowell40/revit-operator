using System;

namespace RevitBridge.Common
{
    public sealed class TransactionDiffLimits
    {
        public const int DefaultMaxTrackedElementIds = 4000;
        public const int DefaultMaxCreated = 200;
        public const int DefaultMaxDeleted = 200;
        public const int DefaultMaxModified = 400;
        public const int DefaultMaxParameterDeltas = 600;
        public const int DefaultMaxGeometryDeltas = 300;
        public const int DefaultMaxViewSheetChanges = 200;
        public const int DefaultMaxWatchElementsPerScope = 400;

        public int MaxTrackedElementIds { get; }
        public int MaxCreated { get; }
        public int MaxDeleted { get; }
        public int MaxModified { get; }
        public int MaxParameterDeltas { get; }
        public int MaxGeometryDeltas { get; }
        public int MaxViewSheetChanges { get; }
        public int MaxWatchElementsPerScope { get; }

        private TransactionDiffLimits(
            int maxTrackedElementIds,
            int maxCreated,
            int maxDeleted,
            int maxModified,
            int maxParameterDeltas,
            int maxGeometryDeltas,
            int maxViewSheetChanges,
            int maxWatchElementsPerScope)
        {
            MaxTrackedElementIds = maxTrackedElementIds;
            MaxCreated = maxCreated;
            MaxDeleted = maxDeleted;
            MaxModified = maxModified;
            MaxParameterDeltas = maxParameterDeltas;
            MaxGeometryDeltas = maxGeometryDeltas;
            MaxViewSheetChanges = maxViewSheetChanges;
            MaxWatchElementsPerScope = maxWatchElementsPerScope;
        }

        public static TransactionDiffLimits Defaults { get; } = new TransactionDiffLimits(
            DefaultMaxTrackedElementIds,
            DefaultMaxCreated,
            DefaultMaxDeleted,
            DefaultMaxModified,
            DefaultMaxParameterDeltas,
            DefaultMaxGeometryDeltas,
            DefaultMaxViewSheetChanges,
            DefaultMaxWatchElementsPerScope);

        public static TransactionDiffLimits Create(
            int? maxTrackedElementIds = null,
            int? maxCreated = null,
            int? maxDeleted = null,
            int? maxModified = null,
            int? maxParameterDeltas = null,
            int? maxGeometryDeltas = null,
            int? maxViewSheetChanges = null,
            int? maxWatchElementsPerScope = null)
        {
            return new TransactionDiffLimits(
                NormalizePositive(maxTrackedElementIds, DefaultMaxTrackedElementIds, 128, 50000),
                NormalizePositive(maxCreated, DefaultMaxCreated, 10, 5000),
                NormalizePositive(maxDeleted, DefaultMaxDeleted, 10, 5000),
                NormalizePositive(maxModified, DefaultMaxModified, 10, 10000),
                NormalizePositive(maxParameterDeltas, DefaultMaxParameterDeltas, 10, 20000),
                NormalizePositive(maxGeometryDeltas, DefaultMaxGeometryDeltas, 10, 10000),
                NormalizePositive(maxViewSheetChanges, DefaultMaxViewSheetChanges, 10, 5000),
                NormalizePositive(maxWatchElementsPerScope, DefaultMaxWatchElementsPerScope, 32, 5000));
        }

        public static int NormalizePositive(int? value, int defaultValue, int minValue, int maxValue)
        {
            if (defaultValue < minValue) defaultValue = minValue;
            if (defaultValue > maxValue) defaultValue = maxValue;
            if (!value.HasValue) return defaultValue;
            if (value.Value < minValue) return minValue;
            if (value.Value > maxValue) return maxValue;
            return value.Value;
        }
    }

    public static class TransactionDiffPayloadCap
    {
        public static T[] Cap<T>(System.Collections.Generic.IReadOnlyList<T>? source, int maxItems, out int omittedCount)
        {
            omittedCount = 0;
            if (source == null || source.Count == 0 || maxItems <= 0) return Array.Empty<T>();
            if (source.Count <= maxItems) return source as T[] ?? new System.Collections.Generic.List<T>(source).ToArray();

            omittedCount = source.Count - maxItems;
            var arr = new T[maxItems];
            for (int i = 0; i < maxItems; i++) arr[i] = source[i];
            return arr;
        }
    }
}
