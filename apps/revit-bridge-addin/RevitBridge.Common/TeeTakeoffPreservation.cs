using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;

namespace RevitBridge.Common
{
    /// <summary>Bounded public-state transition, separate from physical geometry
    /// and reciprocal-connection checks. No owner is exempt by category alone.</summary>
    public static class TeeTakeoffPreservation
    {
        private static void Require(bool value)
        { if (!value) throw new InvalidOperationException("Tee replacement preservation or effect coverage failed; atomic rollback required."); }
        private static long Id(JsonElement r) => r.GetProperty("elementId").GetInt64();
        private static bool Same(JsonElement a, JsonElement b) => a.GetRawText() == b.GetRawText();
        private static long[] Ids(IEnumerable<long> values, int max)
        { var ids = values.ToArray(); Require(ids.Length <= max && ids.All(x => x > 0) && ids.Distinct().Count() == ids.Length); return ids; }
        private static JsonElement[] Rows(JsonElement a, int max)
        {
            var rows = a.EnumerateArray().ToArray(); Ids(rows.Select(Id), max);
            Require(rows.All(r => !string.IsNullOrWhiteSpace(r.GetProperty("uniqueId").GetString()))
                && rows.Select(r => r.GetProperty("uniqueId").GetString()).Distinct().Count() == rows.Length);
            return rows;
        }
        private static void State(JsonElement state)
        {
            Require(state.GetProperty("schema").GetString() == "operator.tee_takeoff_replacement_state.v1"
                && state.GetProperty("complete").GetBoolean()
                && state.GetProperty("scope").GetString() == "active_document_public_semantic_projection");
            var owners = Rows(state.GetProperty("owners"), 8);
            Require(owners.Length > 0 && owners.Select(Id).OrderBy(x => x).SequenceEqual(
                Ids(state.GetProperty("requestedElementIds").EnumerateArray().Select(x => x.GetInt64()), 8).OrderBy(x => x)));
            Rows(state.GetProperty("types"), 16);
            InlineAccessoryBookkeeping.ValidateCenterlines(state.GetProperty("centerlines"));
            foreach (var c in state.GetProperty("centerlines").EnumerateArray())
                Require(owners.Any(o => Id(o) == c.GetProperty("parentId").GetInt64()
                    && Same(o.GetProperty("uniqueId"), c.GetProperty("parentUniqueId"))));
            var system = state.GetProperty("system");
            Require(Id(system) > 0 && !string.IsNullOrWhiteSpace(system.GetProperty("uniqueId").GetString())
                && system.GetProperty("typeId").GetInt64() > 0 && !string.IsNullOrWhiteSpace(system.GetProperty("typeUniqueId").GetString())
                && system.GetProperty("className").GetString() == "Autodesk.Revit.DB.Mechanical.MechanicalSystem");
            Rows(system.GetProperty("members"), 5000);
            var network = Rows(system.GetProperty("network"), 5000);
            Require(owners.All(o => network.Any(n => Id(n) == Id(o) && Same(n.GetProperty("uniqueId"), o.GetProperty("uniqueId")))));
            var schedules = state.GetProperty("schedulePreservation");
            Require(schedules.GetProperty("schema").GetString() == "operator.annotation_schedule_read.v1" && schedules.GetProperty("complete").GetBoolean());
            var scheduleIds = Ids(schedules.GetProperty("requestedElementIds").EnumerateArray().Select(x => x.GetInt64()), 32);
            var items = schedules.GetProperty("items").EnumerateArray().ToArray();
            Require(items.Length == scheduleIds.Length && items.All(r => r.GetProperty("complete").GetBoolean())
                && Ids(items.Select(Id), 32).OrderBy(x => x).SequenceEqual(scheduleIds.OrderBy(x => x)));
        }
        public static long[] RequireTransition(JsonElement before, JsonElement after,
            long tee, long bridge, long fitting, IReadOnlyCollection<long> retained)
        {
            Ids(retained.Concat(new[] { tee, bridge, fitting }), 6); Require(retained.Count == 3);
            State(before); State(after);
            var old = Rows(before.GetProperty("owners"), 8); var current = Rows(after.GetProperty("owners"), 8);
            Require(old.Select(Id).OrderBy(x => x).SequenceEqual(retained.Concat(new[] { tee }).OrderBy(x => x))
                && current.Select(Id).OrderBy(x => x).SequenceEqual(retained.Concat(new[] { bridge, fitting }).OrderBy(x => x)));
            foreach (var id in retained)
            {
                var b = old.Single(r => Id(r) == id); var a = current.Single(r => Id(r) == id);
                foreach (var key in new[] { "uniqueId", "typeId" }) Require(Same(b.GetProperty(key), a.GetProperty(key)));
                var bs = b.GetProperty("state"); var s = a.GetProperty("state");
                Require(Same(bs.GetProperty("UniqueId"), s.GetProperty("UniqueId")) && Same(bs.GetProperty("metadata"), s.GetProperty("metadata"))
                    && Same(bs.GetProperty("geometryKind"), s.GetProperty("geometryKind"))
                    && InlineAccessoryParameterPreservation.Matches(bs.GetProperty("parameters").GetString()!, s.GetProperty("parameters").GetString()!, false));
            }
            var mainMetadata=old.Single(r=>Id(r)==retained.First()).GetProperty("state").GetProperty("metadata");
            Require(Same(mainMetadata,current.Single(r=>Id(r)==bridge).GetProperty("state").GetProperty("metadata")));
            var fittingMetadata=current.Single(r=>Id(r)==fitting).GetProperty("state").GetProperty("metadata");
            foreach(var key in new[]{"phase","demolished","workset","level"})Require(Same(mainMetadata.GetProperty(key),fittingMetadata.GetProperty(key)));
            // Include the old tee type and expected takeoff type in both reads.
            Require(Same(before.GetProperty("types"), after.GetProperty("types"))
                && Same(before.GetProperty("schedulePreservation"), after.GetProperty("schedulePreservation")));
            var bsyst = before.GetProperty("system"); var syst = after.GetProperty("system");
            foreach (var key in new[] { "elementId", "uniqueId", "className", "typeId", "typeUniqueId", "parameters", "typeParameters", "members" })
                Require(Same(bsyst.GetProperty(key), syst.GetProperty(key)));
            var bn = Rows(bsyst.GetProperty("network"), 5000); var an = Rows(syst.GetProperty("network"), 5000);
            Require(bn.Any(r => Id(r) == tee) && !bn.Any(r => Id(r) == bridge || Id(r) == fitting)
                && !an.Any(r => Id(r) == tee) && an.Length == bn.Length + 1
                && bn.Where(r => Id(r) != tee).All(r => an.Any(n => Same(r, n)))
                && an.Where(r => !bn.Any(n => Id(n) == Id(r))).Select(Id).OrderBy(x => x).SequenceEqual(new[] { bridge, fitting }.OrderBy(x => x)));
            var bc = Rows(before.GetProperty("centerlines"), 10); var ac = Rows(after.GetProperty("centerlines"), 10);
            var deleted = TeeTakeoffDependentClosure.RequireDeletion(tee, old.Single(r => Id(r) == tee).GetProperty("uniqueId").GetString()!,
                before.GetProperty("centerlines"), new[] { tee }.Concat(bc.Where(r => r.GetProperty("parentId").GetInt64() == tee).Select(Id)));
            var added = TeeTakeoffDependentClosure.RequireAdded(bridge, current.Single(r => Id(r) == bridge).GetProperty("uniqueId").GetString()!,
                fitting, current.Single(r => Id(r) == fitting).GetProperty("uniqueId").GetString()!, after.GetProperty("centerlines"),
                new[] { bridge, fitting }.Concat(ac.Where(r => new[] { bridge, fitting }.Contains(r.GetProperty("parentId").GetInt64())).Select(Id)));
            Require(bc.Where(r => !deleted.Contains(Id(r))).All(b => ac.Any(a => Id(a) == Id(b) && InlineAccessoryBookkeeping.SameCenterline(b, a, false)))
                && ac.Where(r => !added.Contains(Id(r))).All(a => bc.Any(b => Id(a) == Id(b)))
                && !ac.Any(r => deleted.Contains(Id(r))));
            var absent = after.GetProperty("removed").EnumerateArray().ToArray();
            Require(Ids(absent.Select(Id), 12).OrderBy(x => x).SequenceEqual(deleted.OrderBy(x => x))
                && after.GetProperty("requestedRemovedIds").EnumerateArray().Select(x => x.GetInt64()).SequenceEqual(deleted.OrderBy(x => x))
                && absent.All(r => !r.GetProperty("exists").GetBoolean() && r.GetProperty("uniqueId").ValueKind == JsonValueKind.Null));
            return Ids(retained.Concat(added).Concat(ac.Where(r => !added.Contains(Id(r))).Select(Id))
                .Concat(new[] { Id(syst) }).Concat(after.GetProperty("schedulePreservation").GetProperty("requestedElementIds").EnumerateArray().Select(x => x.GetInt64())), 64);
        }
        public static void RequireFootprint(IEnumerable<long> expectedAdded, IEnumerable<long> expectedDeleted, IEnumerable<long> allowedModified,
            IEnumerable<long> added, IEnumerable<long> deleted, IEnumerable<long> modified)
        {
            var a = Ids(expectedAdded, 12); var d = Ids(expectedDeleted, 12); var allowed = Ids(allowedModified, 64);
            Require(!a.Intersect(d).Any() && !allowed.Intersect(d).Any()
                && Ids(added, 12).OrderBy(x => x).SequenceEqual(a.OrderBy(x => x))
                && Ids(deleted, 12).OrderBy(x => x).SequenceEqual(d.OrderBy(x => x))
                && Ids(modified, 64).All(allowed.Contains));
        }
    }
}
