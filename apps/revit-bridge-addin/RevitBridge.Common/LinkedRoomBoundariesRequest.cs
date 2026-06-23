namespace RevitBridge.Common
{
    public sealed class LinkedRoomBoundariesRequest
    {
        public string? levelName { get; set; }
        public string? linkedModelNameContains { get; set; }
        public string? roomNumber { get; set; }
        public string? roomNameContains { get; set; }
        public int? maxRooms { get; set; }
        public bool includeBoundarySegmentMetadata { get; set; } = true;
    }
}
