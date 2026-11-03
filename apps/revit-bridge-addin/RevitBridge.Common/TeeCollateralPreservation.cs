using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Text.Json;

namespace RevitBridge.Common
{
    // Additional coverage only. Junction topology, deletion closure, native
    // receipt, independent read and the existing footprint checks still apply.
    public static class TeeCollateralPreservation
    {
        private static void Require(bool value) { if(!value) throw new InvalidOperationException("Tee collateral state is missing, changed or outside the observed scope; rollback required."); }
        private static long[] Ids(IEnumerable<long> values,int max)
        { var rows=values.ToArray();Require(rows.Length<=max&&rows.All(x=>x>0)&&rows.Distinct().Count()==rows.Length);return rows; }
        private static bool Point(JsonElement p)=>p.ValueKind==JsonValueKind.Array&&p.GetArrayLength()==3&&p.EnumerateArray().All(v=>v.TryGetDouble(out var n)&&!double.IsNaN(n)&&!double.IsInfinity(n));
        private static void Identity(JsonElement value,JsonElement row)
        { Require(value.GetProperty("elementId").GetInt64()==row.GetProperty("elementId").GetInt64()
            &&value.GetProperty("uniqueId").GetString()==row.GetProperty("uniqueId").GetString()); }
        private static Dictionary<long,JsonElement> Rows(JsonElement state,long[] protectedIds)
        {
            Require(Encoding.UTF8.GetByteCount(state.GetRawText())<=1048576
                &&state.GetProperty("schema").GetString()=="operator.tee_collateral.v1"
                &&state.GetProperty("complete").GetBoolean()
                &&state.GetProperty("scope").GetString()=="unchanged_connected_system_public_state");
            var rows=state.GetProperty("rows").EnumerateArray().ToArray();
            var ids=Ids(rows.Select(r=>r.GetProperty("elementId").GetInt64()),10000);
            Require(!ids.Intersect(protectedIds).Any());
            var uids=rows.Select(r=>r.GetProperty("uniqueId").GetString()).ToArray();
            Require(uids.All(u=>!string.IsNullOrWhiteSpace(u)&&u!.Length<=256)&&uids.Distinct().Count()==rows.Length);
            foreach(var r in rows)
            {
                Require(r.EnumerateObject().Count()==5);
                var role=r.GetProperty("role").GetString();var s=r.GetProperty("state");
                Require(s.ValueKind==JsonValueKind.Object);
                var parents=Ids(r.GetProperty("parentIds").EnumerateArray().Select(v=>v.GetInt64()),64);
                switch(role)
                {
                    case "physical":
                        Require(parents.Length==0&&s.EnumerateObject().Count()==4
                            &&s.GetProperty("metadata").ValueKind==JsonValueKind.Object
                            &&s.GetProperty("geometry").ValueKind==JsonValueKind.Object
                            &&s.GetProperty("parameters").ValueKind==JsonValueKind.Array
                            &&s.GetProperty("connections").ValueKind==JsonValueKind.Array);
                        Identity(s.GetProperty("metadata"),r);
                        Require(new[]{"Autodesk.Revit.DB.Mechanical.Duct","Autodesk.Revit.DB.Mechanical.FlexDuct","Autodesk.Revit.DB.FamilyInstance"}
                            .Contains(s.GetProperty("metadata").GetProperty("className").GetString()));
                        var g=s.GetProperty("geometry");var connections=s.GetProperty("connections").EnumerateArray().ToArray();
                        Require(g.GetProperty("UniqueId").GetString()==r.GetProperty("uniqueId").GetString()
                            &&new[]{"Line","Point","FlexDuct"}.Contains(g.GetProperty("geometryKind").GetString())
                            &&g.GetProperty("points").GetArrayLength()>0&&g.GetProperty("points").EnumerateArray().All(Point)
                            &&g.GetProperty("ports").GetArrayLength()==connections.Length&&connections.Length>0&&connections.Length<=512);
                        foreach(var port in connections)Require(Point(port.GetProperty("origin"))&&Point(port.GetProperty("basisX"))
                            &&Point(port.GetProperty("basisY"))&&Point(port.GetProperty("basisZ"))&&port.GetProperty("peers").ValueKind==JsonValueKind.Array);
                        break;
                    case "centerline":
                        Require(parents.Length==1);InlineAccessoryBookkeeping.ValidateCenterlines(JsonSerializer.SerializeToElement(new[]{s}));
                        Identity(s,r);Require(s.GetProperty("parentId").GetInt64()==parents[0]);break;
                    case "tag":
                        Require(parents.Length>0&&s.GetProperty("complete").GetBoolean()
                            &&s.GetProperty("head").GetArrayLength()==3&&s.GetProperty("references").GetArrayLength()>0
                            &&s.GetProperty("leaders").ValueKind==JsonValueKind.Array&&s.GetProperty("bounds").ValueKind==JsonValueKind.Object
                            &&s.GetProperty("metadata").ValueKind==JsonValueKind.Object&&s.GetProperty("text").ValueKind==JsonValueKind.String&&Point(s.GetProperty("head")));
                        Identity(s.GetProperty("metadata"),r);
                        Require(s.GetProperty("metadata").GetProperty("className").GetString()=="Autodesk.Revit.DB.IndependentTag");
                        break;
                    case "system_browser":
                        Require(parents.Length==0&&s.GetProperty("viewType").GetString()=="SystemBrowser"
                            &&s.GetProperty("metadata").GetProperty("className").GetString()=="Autodesk.Revit.DB.View");Identity(s.GetProperty("metadata"),r);break;
                    case "internal":
                        Require(parents.Length==0&&InlineAccessoryBookkeeping.IsInternalProfile(s)
                            &&!s.TryGetProperty("dependencyObservation",out _)&&!s.TryGetProperty("parameterObservation",out _));
                        Identity(s,r);
                        break;
                    default:Require(false);break;
                }
            }
            var internalIds=rows.Where(r=>r.GetProperty("role").GetString()=="internal").Select(r=>r.GetProperty("elementId").GetInt64()).ToArray();
            foreach(var r in rows.Where(r=>r.GetProperty("role").GetString()=="internal"))
            { var ds=Ids(r.GetProperty("state").GetProperty("dependentIds").EnumerateArray().Select(v=>v.GetInt64()),64);
                Require(ds.Contains(r.GetProperty("elementId").GetInt64())&&ds.All(internalIds.Contains)); }
            return rows.ToDictionary(r=>r.GetProperty("elementId").GetInt64());
        }
        public static long[] RequireUnchanged(JsonElement before,JsonElement after,long[] requestedCoverage,long[] protectedIds)
        {
            Ids(requestedCoverage,64);Ids(protectedIds,128);
            var b=Rows(before,protectedIds);var a=Rows(after,protectedIds);
            Require(b.Count==a.Count&&b.All(p=>a.TryGetValue(p.Key,out var r)&&p.Value.GetRawText()==r.GetRawText()));
            Require(requestedCoverage.All(a.ContainsKey));return requestedCoverage;
        }
        public static void RequireScope(JsonElement collateral,JsonElement network,long[] junction)
        {
            var rows=Rows(collateral,junction);var known=network.EnumerateArray().ToArray();
            foreach(var r in rows.Values)
            {
                var role=r.GetProperty("role").GetString();
                if(role=="physical")Require(known.Any(n=>n.GetProperty("elementId").GetInt64()==r.GetProperty("elementId").GetInt64()
                    &&n.GetProperty("uniqueId").GetString()==r.GetProperty("uniqueId").GetString()));
                if(role=="tag")Require(r.GetProperty("parentIds").EnumerateArray().All(p=>known.Any(n=>n.GetProperty("elementId").GetInt64()==p.GetInt64())));
                if(role=="centerline")
                { var s=r.GetProperty("state");Require(rows.TryGetValue(s.GetProperty("parentId").GetInt64(),out var parent)
                    &&parent.GetProperty("role").GetString()=="physical"&&parent.GetProperty("uniqueId").GetString()==s.GetProperty("parentUniqueId").GetString()); }
            }
        }
    }
}
