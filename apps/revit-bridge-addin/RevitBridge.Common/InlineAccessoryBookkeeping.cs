using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text;
using System.Text.Json;

namespace RevitBridge.Common
{
    /// <summary>Route-specific public semantic projection. This permits declared
    /// platform bookkeeping effects, not hidden-state equality or arbitrary owners.</summary>
    public static class InlineAccessoryBookkeeping
    {
        public const string Schema = "operator.inline_accessory_bookkeeping.v1";
        // Legacy manual-split transition capacity; not the whole-document inventory.
        public const int EligibleInternalLimit = 64;
        // Negative observations grant no effect coverage. Bound their complete
        // inventory by the existing document scan and serialized-byte budgets,
        // independently of the much smaller legacy transition cohort.
        public const int CandidateScanLimit = 50000;
        public const int ObservationByteLimit = 1048576;
        public static readonly long[] InternalParameterIds = { -1140363, -1140362, -1013201, -1002002, -1002001 };
        // Do not invoke native getters for profiles already excluded by known
        // metadata or parameter layout. A native layout access violation remains
        // explicitly unavailable, with no values, dependencies or effect coverage.
        // Other required getter failures still propagate.
        public static JsonElement? ObserveInternalCandidate(JsonElement metadata,
            Func<JsonElement> readLayout, Func<JsonElement> readValues, Func<long[]> readDependencies,
            bool retainUnavailableLayout = false)
        {
            if (readLayout == null || readValues == null || readDependencies == null) throw new ArgumentNullException();
            if (!IsInternalMetadataProfile(metadata)) return null;
            JsonElement layout;
            try { layout = readLayout(); }
            catch (AccessViolationException) when (retainUnavailableLayout)
            {
                var unavailable = metadata.EnumerateObject().ToDictionary(p => p.Name, p => (object)p.Value.Clone());
                unavailable.Add("parameterObservation", new { status = "unavailable", reason = "parameter_layout_read_failed", error = "AccessViolationException" });
                return JsonSerializer.SerializeToElement(unavailable);
            }
            if (!IsInternalParameterLayout(layout)) return null;
            var rows = metadata.EnumerateObject().ToDictionary(p => p.Name, p => (object)p.Value.Clone());
            rows.Add("parameters", readValues());
            return ObserveInternalCandidate(JsonSerializer.SerializeToElement(rows), readDependencies);
        }
        private static bool IsInternalMetadataProfile(JsonElement row)
        {
            try
            {
                return row.GetProperty("className").GetString() == "Autodesk.Revit.DB.Element"
                    && row.GetProperty("categoryId").ValueKind == JsonValueKind.Null && row.GetProperty("typeId").GetInt64() == -1
                    && !row.GetProperty("hasLocation").GetBoolean() && !row.GetProperty("hasBounds").GetBoolean()
                    && row.GetProperty("schemaGuids").GetArrayLength() == 0;
            }
            catch { return false; }
        }
        private static bool IsInternalParameterLayout(JsonElement layout)
        {
            try
            {
                var ps = layout.EnumerateArray().ToArray();
                return ps.Length == 5 && ps.Select((p, i) => p.GetProperty("id").GetInt64() == InternalParameterIds[i]
                    && p.GetProperty("readOnly").GetBoolean()
                    && p.GetProperty("storage").GetString() == (i >= 3 ? "String" : "ElementId")).All(x => x);
            }
            catch { return false; }
        }
        /// <summary>Dependencies belong to the qualified profile, not every
        /// category-less platform element. Native profile reads must finish
        /// before this call; their failures must propagate to the caller.</summary>
        public static JsonElement? ObserveInternalCandidate(JsonElement profile, Func<long[]> readDependencies)
        {
            if (readDependencies == null) throw new ArgumentNullException(nameof(readDependencies));
            if (!IsInternalProfile(profile)) return null;
            var dependencies = readDependencies(); // Native failures still propagate; 65 is an explicit bounded sentinel.
            var rows = profile.EnumerateObject().ToDictionary(p => p.Name, p => (object)p.Value.Clone());
            var bounded = Ids(JsonSerializer.SerializeToElement(dependencies), 65);
            if (bounded.Length == 65)
                rows.Add("dependencyObservation", new { status = "unavailable", reason = "dependency_limit_exceeded", limit = 64, observedAtLeast = 65 });
            else rows.Add("dependentIds", bounded);
            return JsonSerializer.SerializeToElement(rows);
        }
        public static bool IsInternalProfile(JsonElement row)
        {
            try
            {
                if (!IsInternalMetadataProfile(row)) return false;
                var ps = row.GetProperty("parameters").EnumerateArray().ToArray();
                if (ps.Length != 5) return false;
                for (int i = 0; i < ps.Length; i++)
                {
                    var p = ps[i]; var text = i >= 3;
                    if (p.GetProperty("id").GetInt64() != InternalParameterIds[i] || !p.GetProperty("readOnly").GetBoolean()
                        || p.GetProperty("storage").GetString() != (text ? "String" : "ElementId")
                        || (text ? p.GetProperty("value").ValueKind != JsonValueKind.Null && p.GetProperty("value").GetString() != ""
                            : p.GetProperty("value").GetString() != "-1")) return false;
                }
                return true;
            }
            catch { return false; }
        }
        private static long Id(JsonElement row) => row.GetProperty("elementId").GetInt64();
        private static long[] Ids(JsonElement array, int cap)
        {
            var ids = array.EnumerateArray().Select(x => x.GetInt64()).ToArray();
            if (ids.Length > cap || ids.Any(x => x <= 0) || ids.Distinct().Count() != ids.Length) throw new ArgumentException("Invalid bounded IDs.");
            return ids;
        }
        private static JsonElement[] Rows(JsonElement array, int cap)
        {
            var rows = array.EnumerateArray().ToArray();
            if (rows.Length > cap || rows.Any(r => Id(r) <= 0 || string.IsNullOrWhiteSpace(r.GetProperty("uniqueId").GetString()))
                || rows.Select(Id).Distinct().Count() != rows.Length
                || rows.Select(r => r.GetProperty("uniqueId").GetString()).Distinct().Count() != rows.Length)
                throw new ArgumentException("Invalid bounded identities.");
            return rows;
        }
        private static bool Same(JsonElement a, JsonElement b) => a.GetRawText() == b.GetRawText();
        private static void Require(bool value) { if (!value) throw new InvalidOperationException("Inline bookkeeping projection changed or is incomplete; rollback required."); }
        // Failure location only; the same predicate and exception still reject.
        private static void RequireInventory(bool value, string stage, long? id, Action<string, long?>? diagnosticFailure)
        {
            if (!value) diagnosticFailure?.Invoke(stage, id);
            Require(value);
        }
        // These records explicitly confer NO changed-owner coverage. Old complete
        // observations may omit the field; null/malformed observations are invalid.
        private static JsonElement[] Unavailable(JsonElement state, Action<string, long?>? diagnosticFailure = null)
        {
            if (!state.TryGetProperty("unavailableInternals", out var value)) return Array.Empty<JsonElement>();
            var rows = Rows(value, CandidateScanLimit);
            var eligibleIds = new HashSet<long>(Rows(state.GetProperty("internals"), CandidateScanLimit).Select(Id));
            foreach (var r in rows)
            {
                if (r.TryGetProperty("parameterObservation", out var p))
                {
                    RequireInventory(IsInternalMetadataProfile(r) && !r.TryGetProperty("parameters", out _)
                        && !r.TryGetProperty("dependentIds", out _) && !r.TryGetProperty("dependencyObservation", out _)
                        && p.ValueKind == JsonValueKind.Object && p.EnumerateObject().Count() == 3
                        && p.GetProperty("status").GetString() == "unavailable"
                        && p.GetProperty("reason").GetString() == "parameter_layout_read_failed"
                        && p.GetProperty("error").GetString() == "AccessViolationException", "bookkeeping_unavailable_profile", Id(r), diagnosticFailure);
                    continue;
                }
                var d = r.GetProperty("dependencyObservation");
                if (d.GetProperty("reason").GetString() == "dependency_closure_not_eligible")
                {
                    var observed = Ids(d.GetProperty("observedDependentIds"), 64);
                    RequireInventory(IsInternalProfile(r) && !r.TryGetProperty("dependentIds", out _)
                        && d.EnumerateObject().Count() == 3 && d.GetProperty("status").GetString() == "unavailable"
                        && (!observed.Contains(Id(r)) || observed.Any(id => id != Id(r) && !eligibleIds.Contains(id))),
                        "bookkeeping_unavailable_profile", Id(r), diagnosticFailure);
                    continue;
                }
                RequireInventory(IsInternalProfile(r) && !r.TryGetProperty("dependentIds", out _)
                    && d.GetProperty("status").GetString() == "unavailable"
                    && d.GetProperty("reason").GetString() == "dependency_limit_exceeded"
                    && d.GetProperty("limit").GetInt32() == 64 && d.GetProperty("observedAtLeast").GetInt32() == 65,
                    "bookkeeping_unavailable_profile", Id(r), diagnosticFailure);
            }
            return rows;
        }
        /// <summary>Keep the largest dependency-closed qualified subset. Other
        /// completely observed candidates remain explicit, non-covering records.
        /// This classifies observations; it never supplies changed-owner coverage.</summary>
        public static JsonElement ClassifyInternalCandidates(JsonElement state)
        {
            Require(Encoding.UTF8.GetByteCount(state.GetRawText()) <= ObservationByteLimit);
            Require(state.GetProperty("schema").GetString() == Schema && state.GetProperty("complete").GetBoolean()
                && state.GetProperty("scope").GetString() == "public_semantic_projection_not_hidden_state"
                && state.GetProperty("candidateScanComplete").GetBoolean());
            var candidates = Rows(state.GetProperty("internals"), CandidateScanLimit);
            var unavailable = Unavailable(state);
            Rows(JsonSerializer.SerializeToElement(candidates.Concat(unavailable).ToArray()), CandidateScanLimit);
            var eligible = new HashSet<long>(candidates.Select(Id));
            var dependencies = new Dictionary<long, long[]>();
            var parents = new Dictionary<long, List<long>>();
            var rejected = new Queue<long>();
            foreach (var row in candidates)
            {
                Require(IsInternalProfile(row) && !row.TryGetProperty("dependencyObservation", out _)
                    && !row.TryGetProperty("parameterObservation", out _));
                var owner = Id(row); var deps = Ids(row.GetProperty("dependentIds"), 64);
                dependencies.Add(owner, deps);
                if (!deps.Contains(owner) || deps.Any(id => !eligible.Contains(id))) rejected.Enqueue(owner);
                foreach (var id in deps)
                {
                    if (!parents.TryGetValue(id, out var list)) parents.Add(id, list = new List<long>());
                    list.Add(owner);
                }
            }
            // Linear dependency propagation; no repeated whole-inventory scans.
            while (rejected.Count > 0)
            {
                var id = rejected.Dequeue(); if (!eligible.Remove(id)) continue;
                if (parents.TryGetValue(id, out var list)) foreach (var parent in list) rejected.Enqueue(parent);
            }
            var excluded = candidates.Where(row => !eligible.Contains(Id(row))).Select(row => {
                var values = row.EnumerateObject().Where(p => p.Name != "dependentIds")
                    .ToDictionary(p => p.Name, p => (object)p.Value.Clone());
                values.Add("dependencyObservation", new { status = "unavailable", reason = "dependency_closure_not_eligible",
                    observedDependentIds = dependencies[Id(row)] });
                return JsonSerializer.SerializeToElement(values);
            });
            var result = state.EnumerateObject().ToDictionary(p => p.Name, p => (object)p.Value.Clone());
            result["internals"] = candidates.Where(row => eligible.Contains(Id(row))).OrderBy(Id).ToArray();
            result["unavailableInternals"] = unavailable.Concat(excluded).OrderBy(Id).ToArray();
            var projection = JsonSerializer.SerializeToElement(result);
            ValidateInternalCandidates(projection);
            return projection;
        }
        public static void ValidateInternalCandidates(JsonElement state, Action<string, long?>? diagnosticFailure = null)
        {
            RequireInventory(Encoding.UTF8.GetByteCount(state.GetRawText()) <= ObservationByteLimit, "bookkeeping_size", null, diagnosticFailure);
            RequireInventory(state.GetProperty("schema").GetString() == Schema && state.GetProperty("complete").GetBoolean()
                && state.GetProperty("scope").GetString() == "public_semantic_projection_not_hidden_state"
                && state.GetProperty("candidateScanComplete").GetBoolean(), "bookkeeping_header", null, diagnosticFailure);
            var internals = Rows(state.GetProperty("internals"), CandidateScanLimit);
            var unavailable = Unavailable(state, diagnosticFailure);
            RequireInventory(internals.Length + unavailable.Length <= CandidateScanLimit, "bookkeeping_inventory_bound", null, diagnosticFailure);
            var internalIds = new HashSet<long>(internals.Select(Id));
            foreach (var row in internals)
            {
                var deps = Ids(row.GetProperty("dependentIds"), 64);
                RequireInventory(!row.TryGetProperty("dependencyObservation", out _) && !row.TryGetProperty("parameterObservation", out _)
                    && IsInternalProfile(row), "bookkeeping_profile", Id(row), diagnosticFailure);
                RequireInventory(deps.Contains(Id(row)), "bookkeeping_self_dependency", Id(row), diagnosticFailure);
                RequireInventory(deps.All(internalIds.Contains), "bookkeeping_dependency_closure", Id(row), diagnosticFailure);
            }
            var candidates = internals.Concat(unavailable).ToArray();
            RequireInventory(candidates.Select(Id).Distinct().Count() == candidates.Length
                && candidates.Select(r => r.GetProperty("uniqueId").GetString()).Distinct().Count() == candidates.Length,
                "bookkeeping_candidate_identity", null, diagnosticFailure);
        }
        public static void Validate(JsonElement state)
        {
            ValidateInternalCandidates(state);
            var internals = Rows(state.GetProperty("internals"), EligibleInternalLimit);
            var unavailable = Unavailable(state);
            ValidateCenterlines(state.GetProperty("centerlines"));
            var system = state.GetProperty("system");
            var identities = internals.Concat(unavailable).Concat(Rows(state.GetProperty("centerlines"), 10)).Concat(new[] { system }).ToArray();
            Require(identities.Select(Id).Distinct().Count() == identities.Length
                && identities.Select(r => r.GetProperty("uniqueId").GetString()).Distinct().Count() == identities.Length);
            Require(Id(system) > 0 && !string.IsNullOrWhiteSpace(system.GetProperty("uniqueId").GetString())
                && system.GetProperty("typeId").GetInt64() > 0 && !string.IsNullOrWhiteSpace(system.GetProperty("typeUniqueId").GetString())
                && system.GetProperty("className").GetString() == "Autodesk.Revit.DB.Mechanical.MechanicalSystem");
            Rows(system.GetProperty("members"), 5000); Rows(system.GetProperty("network"), 5000);
            Require(system.GetProperty("parameters").GetString()!.Length <= 128000 && system.GetProperty("typeParameters").GetString()!.Length <= 128000);
        }
        // Shared shape validation only. The native reader must establish each
        // parent dependency; a caller-supplied category/name is not authority.
        public static bool IsCenterlineCategory(long category) => category == -2008001 || category == -2008066 || category == -2008021 || category == -2008045;
        public static void ValidateCenterlines(JsonElement value)
        {
            var centers = Rows(value, 10);
            foreach (var c in centers)
            {
                var category = c.GetProperty("categoryId").GetInt64();
                Require(c.GetProperty("className").GetString() == "Autodesk.Revit.DB.Element"
                    && IsCenterlineCategory(category) && c.GetProperty("parentId").GetInt64() > 0
                    && !string.IsNullOrWhiteSpace(c.GetProperty("parentUniqueId").GetString())
                    && c.GetProperty("schemaGuids").GetArrayLength() == 0);
                CenterlineInputs(c);
            }
        }
        /// <summary>Checks every permitted ancillary owner; returned IDs are only
        /// eligible for the separate exhaustive footprint and physical checks.</summary>
        public static (long[] Added, long[] Modified) RequireTransition(JsonElement before, JsonElement after,
            long hostId, long ductId, long accessoryId, IReadOnlyCollection<long> physicalIds)
        {
            Validate(before); Validate(after);
            Require(Same(before.GetProperty("internals"), after.GetProperty("internals")));
            var unavailableBefore = Unavailable(before); var unavailableAfter = Unavailable(after);
            Require(unavailableBefore.Length == unavailableAfter.Length
                && unavailableBefore.Zip(unavailableAfter, Same).All(x => x)
                && !unavailableAfter.Any(r => physicalIds.Contains(Id(r))));
            var bs = before.GetProperty("system"); var s = after.GetProperty("system");
            foreach (var key in new[] { "elementId", "uniqueId", "className", "typeId", "typeUniqueId", "parameters", "typeParameters", "members" })
                Require(Same(bs.GetProperty(key), s.GetProperty(key)));
            var networkBefore = Rows(bs.GetProperty("network"), 5000); var networkAfter = Rows(s.GetProperty("network"), 5000);
            Require(networkBefore.Any(r => Id(r) == hostId) && networkBefore.All(r => Id(r) != ductId && Id(r) != accessoryId)
                && networkAfter.Length == networkBefore.Length + 2 && networkBefore.All(r => networkAfter.Any(n => Same(r, n)))
                && networkAfter.Where(r => !networkBefore.Any(b => Id(b) == Id(r))).Select(Id).OrderBy(x => x)
                    .SequenceEqual(new[] { ductId, accessoryId }.OrderBy(x => x)));
            var oldCenters = Rows(before.GetProperty("centerlines"), 10); var centers = Rows(after.GetProperty("centerlines"), 10);
            Require(oldCenters.All(r => centers.Any(n => Id(n) == Id(r) && SameCenterline(r, n, false)))
                && centers.All(r => physicalIds.Contains(r.GetProperty("parentId").GetInt64())));
            var added = centers.Where(r => !oldCenters.Any(b => Id(b) == Id(r))).ToArray();
            Require(added.Length <= 1 && added.All(r => r.GetProperty("parentId").GetInt64() == ductId && r.GetProperty("categoryId").GetInt64() == -2008001));
            foreach (var c in added)
                Require(oldCenters.Any(r => r.GetProperty("parentId").GetInt64() == hostId
                    && r.GetProperty("categoryId").GetInt64() == c.GetProperty("categoryId").GetInt64()
                    && SameCenterline(r, c, true)));
            var eligible = Rows(after.GetProperty("internals"), EligibleInternalLimit).Select(Id).Concat(centers.Select(Id)).Concat(new[] { Id(s) }).ToArray();
            Require(eligible.Distinct().Count() == eligible.Length && !eligible.Intersect(physicalIds).Any());
            return (added.Select(Id).ToArray(), eligible);
        }
        // Centerline elements expose proxy parameters, including fields writable
        // on the proxy but read-only/calculated on its actual native parent.
        // Compare the editable input intersection. Derived values may recalculate;
        // their parent's physical/parameter result is verified separately.
        private static JsonElement[] Parameters(JsonElement array)
        {
            var rows = array.EnumerateArray().ToArray(); long previous = long.MinValue;
            Require(rows.Length <= 128);
            foreach (var p in rows)
            {
                var id = p.GetProperty("id").GetInt64();
                Require(id != 0 && id > previous && new[] { "String", "Double", "Integer", "ElementId", "None" }.Contains(p.GetProperty("storage").GetString())
                    && (p.GetProperty("value").ValueKind == JsonValueKind.Null || p.GetProperty("value").ValueKind == JsonValueKind.String));
                if (p.GetProperty("storage").GetString() == "Double")
                    Require(double.TryParse(p.GetProperty("value").GetString(), NumberStyles.Float, CultureInfo.InvariantCulture, out var scalar)
                        && !double.IsNaN(scalar) && !double.IsInfinity(scalar));
                p.GetProperty("readOnly").GetBoolean(); previous = id;
            }
            return rows;
        }
        private static string CenterlineInputs(JsonElement c)
        {
            var ps = Parameters(c.GetProperty("parameters")); var parent = Parameters(c.GetProperty("parentParameters"));
            Require(ps.All(p => parent.Any(q => q.GetProperty("id").GetInt64() == p.GetProperty("id").GetInt64()
                && q.GetProperty("storage").GetString() == p.GetProperty("storage").GetString())));
            return JsonSerializer.Serialize(ps.Where(p => !p.GetProperty("readOnly").GetBoolean()
                && !parent.Single(q => q.GetProperty("id").GetInt64() == p.GetProperty("id").GetInt64()).GetProperty("readOnly").GetBoolean())
                .Select(p => new { id = p.GetProperty("id").GetInt64(), storage = p.GetProperty("storage").GetString(), value = p.GetProperty("value").GetString() }).ToArray());
        }
        private static string ParameterShape(JsonElement c, string key) => JsonSerializer.Serialize(Parameters(c.GetProperty(key))
            .Select(p => new { id = p.GetProperty("id").GetInt64(), storage = p.GetProperty("storage").GetString(), readOnly = p.GetProperty("readOnly").GetBoolean() }).ToArray());
        public static bool SameCenterline(JsonElement b, JsonElement a, bool isNew)
        {
            foreach (var key in new[] { "className", "categoryId", "schemaGuids" }) if (!Same(b.GetProperty(key), a.GetProperty(key))) return false;
            if (!isNew) foreach (var key in new[] { "elementId", "uniqueId", "parentId", "parentUniqueId" }) if (!Same(b.GetProperty(key), a.GetProperty(key))) return false;
            return ParameterShape(b, "parameters") == ParameterShape(a, "parameters")
                && ParameterShape(b, "parentParameters") == ParameterShape(a, "parentParameters")
                && InlineAccessoryParameterPreservation.Matches(CenterlineInputs(b), CenterlineInputs(a), isNew);
        }
    }
}
