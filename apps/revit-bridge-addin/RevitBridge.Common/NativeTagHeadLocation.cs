using System;
using System.Linq;
using Autodesk.Revit.DB;

namespace RevitBridge.Common
{
    // A tag head is a view-owned annotation anchor, not a model LocationPoint
    // or a bounding-box center. Both committed snapshots and separate reads
    // use the native head plus stable tag/view identity.
    public sealed class NativeTagHeadLocation
    {
        private readonly double[] point;
        public string kind => "TagHead";
        public double[] pointXyz => point.ToArray();
        public long ownerViewId { get; }
        public string ownerViewUniqueId { get; }
        public string elementUniqueId { get; }

        private NativeTagHeadLocation(string element, long owner, string ownerUniqueId, double[] coordinates)
        { elementUniqueId=element; ownerViewId=owner; ownerViewUniqueId=ownerUniqueId; point=coordinates.ToArray(); }

        public static NativeTagHeadLocation Read(IndependentTag tag)
        {
            var owner = tag.Document.GetElement(tag.OwnerViewId) as View;
            var head = tag.TagHeadPosition;
            if (owner == null || !owner.IsValidObject || head == null)
                throw new InvalidOperationException("Native tag-head anchor or owning view is unavailable.");
            return Create(tag.UniqueId, ElementIdCompat.GetValue(owner.Id), owner.UniqueId, new[] {head.X,head.Y,head.Z});
        }

        public static NativeTagHeadLocation Create(string element, long owner, string ownerUniqueId, double[] coordinates)
        {
            if (string.IsNullOrWhiteSpace(element) || owner <= 0 || string.IsNullOrWhiteSpace(ownerUniqueId)
                || coordinates == null || coordinates.Length != 3 || coordinates.Any(n=>double.IsNaN(n)||double.IsInfinity(n)))
                throw new ArgumentException("A tag head requires stable tag/view identity and three finite native coordinates.");
            return new NativeTagHeadLocation(element,owner,ownerUniqueId,coordinates);
        }

        public object SummaryLocation() => new {type="tagHead",x=point[0],y=point[1],z=point[2],ownerViewId,ownerViewUniqueId};
    }
}
