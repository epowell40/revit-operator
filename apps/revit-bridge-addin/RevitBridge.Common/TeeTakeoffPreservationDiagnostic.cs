using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;

namespace RevitBridge.Common
{
    /// <summary>Bounded explanation of a rejected transient state. Never called
    /// as a validator, preservation receipt or permission to accept collateral.</summary>
    public static class TeeTakeoffPreservationDiagnostic
    {
        public static string Describe(string stage, JsonElement before, JsonElement after, JsonElement footprint)
        {
            string Unavailable(string reason) => JsonSerializer.Serialize(new { diagnosticOnly=true, transientBeforeRollback=true, reason });
            try
            {
                if(stage!="transition"&&stage!="footprint")return Unavailable("unsupported_stage");
                if(before.GetRawText().Length+after.GetRawText().Length>1500000||footprint.GetRawText().Length>12000)return Unavailable("input_bound");
                foreach(var state in new[]{before,after})
                    if(state.GetProperty("schema").GetString()!="operator.tee_takeoff_replacement_state.v1"||!state.GetProperty("complete").GetBoolean()
                        ||state.GetProperty("scope").GetString()!="active_document_public_semantic_projection")return Unavailable("unavailable_state");
                long[] Ids(JsonElement value,int cap=64)
                {
                    var ids=value.EnumerateArray().Select(x=>x.GetInt64()).ToArray();
                    if(ids.Length>cap||ids.Any(x=>x<=0)||ids.Distinct().Count()!=ids.Length)throw new ArgumentException();return ids;
                }
                long Id(JsonElement row)=>row.GetProperty("elementId").GetInt64();
                Dictionary<long,JsonElement> Rows(JsonElement rows,int cap=5000)
                {
                    var values=rows.EnumerateArray().ToArray();if(values.Length>cap)throw new ArgumentException();
                    var map=values.ToDictionary(Id);if(map.Keys.Any(x=>x<=0))throw new ArgumentException();return map;
                }
                var tee=footprint.GetProperty("teeId").GetInt64();var bridge=footprint.GetProperty("bridgeId").GetInt64();var fitting=footprint.GetProperty("fittingId").GetInt64();
                var retained=Ids(footprint.GetProperty("retainedIds"),3);if(retained.Length!=3||new[]{tee,bridge,fitting}.Any(x=>x<=0))return Unavailable("invalid_scope");
                var prior=Rows(before.GetProperty("owners"),8);var current=Rows(after.GetProperty("owners"),8);
                var differences=new List<object>();var truncated=false;var visited=0;
                string Small(JsonElement? value)
                {if(value==null)return "<missing>";var text=value.Value.GetRawText();return text.Length<=128?text:text.Substring(0,128)+"...";}
                void Add(string field,JsonElement? b,JsonElement? a)
                {if(differences.Count>=16){truncated=true;return;}differences.Add(new{field,before=Small(b),after=Small(a)});}
                void Diff(string field,JsonElement? b,JsonElement? a,int depth=0)
                {
                    if(b?.GetRawText()==a?.GetRawText())return;
                    if(++visited>10000||depth>8||differences.Count>=16){truncated=true;return;}
                    if(b?.ValueKind==JsonValueKind.Object&&a?.ValueKind==JsonValueKind.Object)
                    {
                        var left=b.Value.EnumerateObject().ToDictionary(x=>x.Name,x=>x.Value);var right=a.Value.EnumerateObject().ToDictionary(x=>x.Name,x=>x.Value);
                        foreach(var name in left.Keys.Union(right.Keys).OrderBy(x=>x,StringComparer.Ordinal))Diff(field+"."+(name.Length>64?name.Substring(0,64):name),left.TryGetValue(name,out var l)?l:(JsonElement?)null,right.TryGetValue(name,out var r)?r:(JsonElement?)null,depth+1);
                    }
                    else if(b?.ValueKind==JsonValueKind.Array&&a?.ValueKind==JsonValueKind.Array)
                    {
                        var left=b.Value.EnumerateArray().ToArray();var right=a.Value.EnumerateArray().ToArray();
                        for(var i=0;i<Math.Max(left.Length,right.Length)&&visited<=10000;i++)Diff(field+"["+i+"]",i<left.Length?left[i]:(JsonElement?)null,i<right.Length?right[i]:(JsonElement?)null,depth+1);
                    }
                    else Add(field,b,a);
                }
                void Parameters(string field,JsonElement b,JsonElement a,bool applyParameterRule)
                {
                    if(b.GetRawText()==a.GetRawText())return;
                    var bs=b.GetString()!;var ats=a.GetString()!;
                    if(applyParameterRule&&InlineAccessoryParameterPreservation.Matches(bs,ats,false))return;
                    if(bs.Length>128000||ats.Length>128000){Add(field,b,a);return;}
                    using var bp=JsonDocument.Parse(bs);using var ap=JsonDocument.Parse(ats);
                    if(bp.RootElement.GetArrayLength()>2048||ap.RootElement.GetArrayLength()>2048)throw new ArgumentException();
                    var left=bp.RootElement.EnumerateArray().ToDictionary(x=>x.GetProperty("id").GetInt64());
                    var right=ap.RootElement.EnumerateArray().ToDictionary(x=>x.GetProperty("id").GetInt64());
                    foreach(var id in left.Keys.Union(right.Keys).OrderBy(x=>x))Diff(field+"."+id,left.TryGetValue(id,out var l)?l:(JsonElement?)null,right.TryGetValue(id,out var r)?r:(JsonElement?)null);
                }
                foreach(var id in retained)
                {
                    if(!prior.TryGetValue(id,out var b)||!current.TryGetValue(id,out var a)){Add("retained."+id,null,null);continue;}
                    foreach(var key in new[]{"uniqueId","typeId"})Diff("retained."+id+"."+key,b.GetProperty(key),a.GetProperty(key));
                    var bs=b.GetProperty("state");var ats=a.GetProperty("state");
                    foreach(var key in new[]{"UniqueId","metadata","geometryKind"})Diff("retained."+id+"."+key,bs.GetProperty(key),ats.GetProperty(key));
                    Parameters("retained."+id+".parameters",bs.GetProperty("parameters"),ats.GetProperty("parameters"),true);
                }
                var mainMetadata=prior[retained[0]].GetProperty("state").GetProperty("metadata");
                if(current.TryGetValue(bridge,out var newBridge))Diff("bridge.metadata",mainMetadata,newBridge.GetProperty("state").GetProperty("metadata"));
                if(current.TryGetValue(fitting,out var newFitting))foreach(var key in new[]{"phase","demolished","workset","level"})Diff("fitting.metadata."+key,mainMetadata.GetProperty(key),newFitting.GetProperty("state").GetProperty("metadata").GetProperty(key));
                Diff("types",before.GetProperty("types"),after.GetProperty("types"));
                Diff("schedulePreservation",before.GetProperty("schedulePreservation"),after.GetProperty("schedulePreservation"));
                var oldSystem=before.GetProperty("system");var system=after.GetProperty("system");
                foreach(var key in new[]{"elementId","uniqueId","className","typeId","typeUniqueId","members"})Diff("system."+key,oldSystem.GetProperty(key),system.GetProperty(key));
                foreach(var key in new[]{"parameters","typeParameters"})Parameters("system."+key,oldSystem.GetProperty(key),system.GetProperty(key),false);
                var oldNetwork=Rows(oldSystem.GetProperty("network"));var network=Rows(system.GetProperty("network"));
                foreach(var row in oldNetwork.Where(x=>x.Key!=tee))Diff("system.network."+row.Key,row.Value,network.TryGetValue(row.Key,out var n)?n:(JsonElement?)null);
                var oldCenterlines=Rows(before.GetProperty("centerlines"),10);var centerlines=Rows(after.GetProperty("centerlines"),10);
                var expectedAdded=Ids(footprint.GetProperty("expectedAddedIds"),12);var expectedDeleted=Ids(footprint.GetProperty("expectedDeletedIds"),12);
                foreach(var row in oldCenterlines.Where(x=>!expectedDeleted.Contains(x.Key)))Diff("centerlines."+row.Key,row.Value,centerlines.TryGetValue(row.Key,out var n)?n:(JsonElement?)null);
                var added=Ids(footprint.GetProperty("addedIds"),12);var deleted=Ids(footprint.GetProperty("deletedIds"),12);var modified=Ids(footprint.GetProperty("modifiedIds"));
                var hasAllowed=footprint.TryGetProperty("allowedModifiedIds",out var value)&&value.ValueKind==JsonValueKind.Array;
                var allowed=hasAllowed?Ids(value):retained.Concat(expectedAdded).Concat(centerlines.Keys).Concat(new[]{Id(system)})
                    .Concat(Ids(after.GetProperty("schedulePreservation").GetProperty("requestedElementIds"),32)).Distinct().ToArray();
                var result=JsonSerializer.Serialize(new{diagnosticOnly=true,transientBeforeRollback=true,stage,differences,differencesTruncated=truncated,
                    footprint=new{coverageBasis=hasAllowed?"validated_transition":"unvalidated_projection",modifiedCount=modified.Length,
                        unexpectedModifiedIds=modified.Except(allowed).OrderBy(x=>x),unexpectedAddedIds=added.Except(expectedAdded).OrderBy(x=>x),missingAddedIds=expectedAdded.Except(added).OrderBy(x=>x),
                        unexpectedDeletedIds=deleted.Except(expectedDeleted).OrderBy(x=>x),missingDeletedIds=expectedDeleted.Except(deleted).OrderBy(x=>x)},
                    network=new{unexpectedAddedIds=network.Keys.Except(oldNetwork.Keys).Except(new[]{bridge,fitting}).OrderBy(x=>x),unexpectedRemovedIds=oldNetwork.Keys.Except(network.Keys).Except(new[]{tee}).OrderBy(x=>x)}});
                return result.Length<=8000?result:Unavailable("output_bound");
            }
            catch{return Unavailable("diagnostic_unavailable");}
        }
    }
}
