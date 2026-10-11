namespace RevitBridge.Common
{
    public static class ConnectorReadState
    {
        // Positive native peers prove a connection; absence requires a complete scan.
        public static string Classify(bool physicalPort, bool logicalPort, bool scanComplete, bool? nativeConnected, int physicalPeers)
        {
            if (logicalPort) return "not_physical";
            if (!physicalPort) return "unknown";
            if (physicalPeers > 0) return "connected";
            return scanComplete && nativeConnected == false ? "open" : "unknown";
        }
    }
}
