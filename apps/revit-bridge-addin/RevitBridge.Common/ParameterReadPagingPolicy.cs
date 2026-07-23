using System;

namespace RevitBridge.Common
{
    public sealed class ParameterReadPage
    {
        public int Offset { get; set; }
        public int RequestedLimit { get; set; }
        public int Limit { get; set; }
        public bool LimitWasClamped { get; set; }
    }

    public static class ParameterReadPagingPolicy
    {
        public const int DefaultLimit = 250;
        public const int MaxLimit = 500;

        public static ParameterReadPage Normalize(int? offset, int? limit)
        {
            var normalizedOffset = Math.Max(0, offset ?? 0);
            var requestedLimit = limit ?? DefaultLimit;
            if (requestedLimit < 1) requestedLimit = DefaultLimit;
            var normalizedLimit = Math.Min(requestedLimit, MaxLimit);

            return new ParameterReadPage
            {
                Offset = normalizedOffset,
                RequestedLimit = requestedLimit,
                Limit = normalizedLimit,
                LimitWasClamped = requestedLimit > MaxLimit
            };
        }

        public static int? NextOffset(int totalMatched, int offset, int returnedCount)
        {
            var next = Math.Max(0, offset) + Math.Max(0, returnedCount);
            return next < Math.Max(0, totalMatched) ? next : (int?)null;
        }
    }
}
