namespace RevitBridge.Common
{
    public static class OperatorAuthRetryPolicy
    {
        public static bool ShouldRetryOnUnauthorized(OperatorClientAuthMode mode, int attemptNumber)
        {
            return false;
        }
    }
}
