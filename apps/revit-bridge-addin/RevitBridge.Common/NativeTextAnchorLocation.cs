using System;
using System.Linq;
using Autodesk.Revit.DB;

namespace RevitBridge.Common
{
    // Coord is the view-owned text anchor, not its box center or a LocationPoint.
    // Share the same native identity/units projection across commit and readback.
    public sealed class NativeTextAnchorLocation
    {
        private readonly double[] point;
        public string kind => "TextAnchor";
        public string coordinateSpace => "model_feet";
        public double[] pointXyz => point.ToArray();
        public string elementUniqueId { get; }
        public long ownerViewId { get; }
        public string ownerViewUniqueId { get; }

        private NativeTextAnchorLocation(string element, long owner, string ownerUid, double[] coordinates)
        { elementUniqueId=element; ownerViewId=owner; ownerViewUniqueId=ownerUid; point=coordinates.ToArray(); }

        public static NativeTextAnchorLocation Read(TextNote note)
        {
            var owner=note.Document.GetElement(note.OwnerViewId) as View;
            var anchor=note.Coord;
            if(owner==null || !owner.IsValidObject || anchor==null)
                throw new InvalidOperationException("Native text anchor or owning view is unavailable.");
            return Create(note.UniqueId,ElementIdCompat.GetValue(owner.Id),owner.UniqueId,new[]{anchor.X,anchor.Y,anchor.Z});
        }

        public static NativeTextAnchorLocation Create(string element,long owner,string ownerUid,double[] coordinates)
        {
            if(string.IsNullOrWhiteSpace(element)||owner<=0||string.IsNullOrWhiteSpace(ownerUid)
                ||coordinates==null||coordinates.Length!=3||coordinates.Any(n=>double.IsNaN(n)||double.IsInfinity(n)))
                throw new ArgumentException("A text anchor requires stable note/view identity and three finite native coordinates.");
            return new NativeTextAnchorLocation(element,owner,ownerUid,coordinates);
        }

        public object SummaryLocation() => new {type="textAnchor",coordinateSpace,x=point[0],y=point[1],z=point[2],ownerViewId,ownerViewUniqueId};
    }
}
