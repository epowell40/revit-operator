using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Mechanical;
using RevitBridge.Common;
using RevitBridge.Logic.Handlers.MEP;

namespace RevitBridge.Logic
{
    // Prospective before/after/current observations for the existing tee route.
    // No after-only baseline, arbitrary owner exemption or new mutation route.
    public static class TeeCollateralObservation
    {
        private static long Id(Element e)=>ElementIdCompat.GetValue(e.Id);
        private static double[] Point(XYZ p)=>new[]{p.X,p.Y,p.Z};
        private static Connector[] Ports(Element e)
        {
            var manager=(e as MEPCurve)?.ConnectorManager??(e as FamilyInstance)?.MEPModel?.ConnectorManager;
            return manager==null?Array.Empty<Connector>():manager.Connectors.Cast<Connector>().Where(c=>c.ConnectorType!=ConnectorType.Logical).ToArray();
        }
        private static long Cid(Connector c)=>MepSystemUtil.TryGetNativeConnectorId(c,out var id)?id:throw new InvalidOperationException("Native connector identity missing.");
        private static object Connections(Element e)
        {
            var ports=Ports(e);if(ports.Length==0||ports.Length>512)throw new InvalidOperationException("Collateral connector inventory unavailable.");
            return ports.OrderBy(Cid).Select(c=>{
                var refs=c.AllRefs.Cast<Connector>().ToArray();if(refs.Length>512)throw new InvalidOperationException("Collateral references exceed bound.");
                var peers=refs.Where(p=>p.Owner.Id!=e.Id&&(p.ConnectorType==ConnectorType.End||p.ConnectorType==ConnectorType.Curve)&&c.IsConnectedTo(p))
                    .OrderBy(p=>Id(p.Owner)).ThenBy(Cid).Select(p=>new{ownerId=Id(p.Owner),ownerUniqueId=p.Owner.UniqueId,connectorId=Cid(p)}).ToArray();
                var axes=c.CoordinateSystem;
                return new{connectorId=Cid(c),connectorType=c.ConnectorType.ToString(),domain=c.Domain.ToString(),shape=c.Shape.ToString(),
                    origin=Point(c.Origin),basisX=Point(axes.BasisX),basisY=Point(axes.BasisY),basisZ=Point(axes.BasisZ),
                    radius=c.Shape==ConnectorProfileType.Round?(double?)c.Radius:null,
                    width=c.Shape==ConnectorProfileType.Rectangular||c.Shape==ConnectorProfileType.Oval?(double?)c.Width:null,
                    height=c.Shape==ConnectorProfileType.Rectangular||c.Shape==ConnectorProfileType.Oval?(double?)c.Height:null,peers};
            }).ToArray();
        }
        private static object TagState(Document doc,IndependentTag tag)
        {
            var refs=tag.GetTaggedReferences();if(refs.Count==0||refs.Count>64)throw new InvalidOperationException("Tag reference scope unavailable.");
            var view=doc.GetElement(tag.OwnerViewId) as View??throw new InvalidOperationException("Tag owner view unavailable.");
            var bounds=tag.get_BoundingBox(view)??throw new InvalidOperationException("Tag bounds unavailable.");
            var leaders=refs.Select(r=>new{reference=r.ConvertToStableRepresentation(doc),visible=tag.HasLeader&&tag.IsLeaderVisible(r),
                elbow=tag.HasLeader&&tag.HasLeaderElbow(r)?Point(tag.GetLeaderElbow(r)):null,
                end=tag.HasLeader&&tag.IsLeaderVisible(r)&&tag.LeaderEndCondition==LeaderEndCondition.Free?Point(tag.GetLeaderEnd(r)):null})
                .OrderBy(r=>r.reference).ToArray();
            return new{complete=true,metadata=InlineAccessoryBookkeepingObservation.ReadPlacementMetadata(doc,Id(tag)),
                text=tag.TagText,head=Point(tag.TagHeadPosition),orientation=tag.TagOrientation.ToString(),hasLeader=tag.HasLeader,
                leaderEndCondition=tag.HasLeader?tag.LeaderEndCondition.ToString():null,
                references=refs.Select(r=>r.ConvertToStableRepresentation(doc)).OrderBy(x=>x).ToArray(),leaders,
                bounds=new{min=Point(bounds.Min),max=Point(bounds.Max),origin=Point(bounds.Transform.Origin),
                    basisX=Point(bounds.Transform.BasisX),basisY=Point(bounds.Transform.BasisY),basisZ=Point(bounds.Transform.BasisZ)}};
        }
        public static JsonElement Read(Document doc,Element[] junction)
        {
            var primary=junction.Select(Id).ToArray();
            var system=junction.OfType<MEPCurve>().Select(e=>e.MEPSystem).OfType<MechanicalSystem>().FirstOrDefault()
                ??throw new InvalidOperationException("Tee connected system unavailable.");
            var network=system.DuctNetwork.Cast<Element>().Concat(system.Elements.Cast<Element>()).GroupBy(Id).Select(g=>g.First()).OrderBy(Id).ToArray();
            if(network.Length>5000)throw new InvalidOperationException("Tee connected cohort exceeds existing bound.");
            var rows=new Dictionary<long,object>();
            void Add(Element e,string role,long[] parents,object state)
            { if(rows.ContainsKey(Id(e)))throw new InvalidOperationException("Ambiguous collateral role.");rows.Add(Id(e),new{elementId=Id(e),uniqueId=e.UniqueId,role,parentIds=parents,state}); }
            foreach(var e in network.Where(e=>!primary.Contains(Id(e))&&Ports(e).Length>0))
            {
                Add(e,"physical",Array.Empty<long>(),new{metadata=InlineAccessoryBookkeepingObservation.ReadPlacementMetadata(doc,Id(e)),
                    geometry=InlineAccessoryObservation.State(e),parameters=InlineAccessoryBookkeepingObservation.ReadPlacementParameters(e),connections=Connections(e)});
                foreach(var center in InlineAccessoryBookkeepingObservation.ReadCenterlines(doc,new[]{e}).EnumerateArray())
                { var native=doc.GetElement(ElementIdCompat.Create(center.GetProperty("elementId").GetInt64()));Add(native,"centerline",new[]{Id(e)},center.Clone()); }
            }
            var networkIds=new HashSet<long>(network.Select(Id));
            var tags=new FilteredElementCollector(doc).OfClass(typeof(IndependentTag)).Cast<IndependentTag>().Take(10001).ToArray();
            if(tags.Length>10000)throw new InvalidOperationException("Tee tag inventory exceeds existing bound.");
            foreach(var tag in tags.OrderBy(Id))
            { var parents=tag.GetTaggedLocalElementIds().Select(ElementIdCompat.GetValue).Where(networkIds.Contains).OrderBy(x=>x).ToArray();
                if(parents.Length>0)Add(tag,"tag",parents,TagState(doc,tag)); }
            var browsers=new FilteredElementCollector(doc).OfClass(typeof(View)).Cast<View>().Where(v=>v.ViewType==ViewType.SystemBrowser).Take(9).ToArray();
            if(browsers.Length>8)throw new InvalidOperationException("System Browser scope exceeds bound.");
            foreach(var v in browsers.OrderBy(Id))Add(v,"system_browser",Array.Empty<long>(),new{viewType=v.ViewType.ToString(),name=v.Name,isTemplate=v.IsTemplate,
                metadata=InlineAccessoryBookkeepingObservation.ReadPlacementMetadata(doc,Id(v))});
            var internals=InlineAccessoryBookkeepingObservation.ReadInternalCandidates(doc,retainUnavailableParameterLayout:true,classifyUnqualifiedDependencies:true);
            foreach(var row in internals.GetProperty("internals").EnumerateArray())
            { var native=doc.GetElement(ElementIdCompat.Create(row.GetProperty("elementId").GetInt64()));Add(native,"internal",Array.Empty<long>(),row.Clone()); }
            var result=JsonSerializer.SerializeToElement(new{schema="operator.tee_collateral.v1",complete=true,
                scope="unchanged_connected_system_public_state",rows=rows.OrderBy(p=>p.Key).Select(p=>p.Value).ToArray()});
            // Validate the actual producer, including dependency-closed internal
            // identities. Unavailable observations receive no collateral coverage.
            TeeCollateralPreservation.RequireUnchanged(result,result,Array.Empty<long>(),primary);
            TeeCollateralPreservation.RequireScope(result,JsonSerializer.SerializeToElement(network.Select(e=>new{elementId=Id(e),uniqueId=e.UniqueId}).ToArray()),primary);
            return result;
        }
    }
}
