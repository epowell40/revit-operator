using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Mechanical;
using Autodesk.Revit.UI;
using RevitBridge.Logic.Handlers.Core;
using RevitBridge.Common;

namespace RevitBridge.Logic.Handlers.MEP
{
    public class SyncConnectedSizesHandler : IRequestHandler
    {
        private sealed class Size
        {
            public string Kind { get; set; } = ""; // "round" | "rect"
            public double DiameterFt { get; set; }
            public double WidthFt { get; set; }
            public double HeightFt { get; set; }

            public override string ToString()
            {
                if (Kind == "round") return $"round:{DiameterFt.ToString("G", CultureInfo.InvariantCulture)}ft";
                if (Kind == "rect") return $"rect:{WidthFt.ToString("G", CultureInfo.InvariantCulture)}x{HeightFt.ToString("G", CultureInfo.InvariantCulture)}ft";
                return "unknown";
            }
        }

        private sealed class AdjacentSizeCandidate
        {
            public long DuctId { get; set; }
            public int Hops { get; set; }
            public Size Size { get; set; } = new Size();
        }

        private sealed class DiscoveredParam
        {
            public Parameter Param { get; set; } = null!;
            public string Name { get; set; } = "";
            public string Kind { get; set; } = ""; // diameter|radius|width|height|size
            public double TargetFt { get; set; }
        }

        private sealed class ApplyResult
        {
            public bool Ok { get; set; }
            public bool Changed { get; set; }
            public bool Verified { get; set; }
            public string? TypeDrivenReason { get; set; }
            public object Diff { get; set; } = new { };
        }

        private sealed class TypeDrivenCandidate
        {
            public long InstanceId { get; set; }
            public string Category { get; set; } = "";
            public string Name { get; set; } = "";
            public long TypeId { get; set; }
            public Size Desired { get; set; } = new Size();
            public string DesiredSource { get; set; } = "";
            public int DesiredHops { get; set; }
            public List<long> NearbyDuctIds { get; set; } = new List<long>();
        }

        public sealed class Params
        {
            public long? startElementId { get; set; }
            public List<long>? elementIds { get; set; }

            public string mode { get; set; } = "duct->fittings->terminals"; // reserved for future expansion
            public bool dryRun { get; set; } = true;
            public string resolveTypeDriven { get; set; } = "skip"; // auto | duplicate | skip

            public int maxElements { get; set; } = 5000;
            public int adjacencyMaxHops { get; set; } = 4;
            public string? confirm { get; set; }
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrWhiteSpace(jsonData) ? new Params() : (JsonSerializer.Deserialize<Params>(jsonData) ?? new Params());

            var seed = new List<long>();
            if (p.elementIds != null && p.elementIds.Count > 0) seed.AddRange(p.elementIds.Where(x => x > 0));
            if (p.startElementId.HasValue && p.startElementId.Value > 0) seed.Add(p.startElementId.Value);
            seed = seed.Distinct().ToList();
            if (seed.Count == 0) throw new ArgumentException("Provide startElementId or elementIds.");

            var uidoc = app.ActiveUIDocument;
            if (uidoc == null) throw new InvalidOperationException("No active UI document.");
            var doc = uidoc.Document;

            var max = p.maxElements <= 0 ? 5000 : Math.Min(p.maxElements, 50000);
            var adjacencyMaxHops = p.adjacencyMaxHops <= 0 ? 1 : Math.Min(p.adjacencyMaxHops, 12);
            var resolveTypeDriven = (p.resolveTypeDriven ?? "skip").Trim();
            if (resolveTypeDriven.Length == 0) resolveTypeDriven = "skip";
            if (!resolveTypeDriven.Equals("skip", StringComparison.OrdinalIgnoreCase) &&
                !resolveTypeDriven.Equals("auto", StringComparison.OrdinalIgnoreCase) &&
                !resolveTypeDriven.Equals("duplicate", StringComparison.OrdinalIgnoreCase))
            {
                throw new ArgumentException("resolveTypeDriven must be one of: auto | duplicate | skip.");
            }

            // Expand to connected set when startElementId is used.
            var targetIds = new HashSet<long>();
            if (p.startElementId.HasValue && p.startElementId.Value > 0)
            {
                var start = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(p.startElementId.Value));
                if (start == null) throw new InvalidOperationException($"Element {p.startElementId.Value} not found.");

                foreach (var id in TraceConnectedIds(doc, start.Id, max))
                {
                    if (targetIds.Count >= max) break;
                    targetIds.Add(id);
                }
            }

            foreach (var id in seed)
            {
                if (targetIds.Count >= max) break;
                targetIds.Add(id);
            }

            if (!p.dryRun && targetIds.Count > 50)
            {
                var requiredConfirm = BulkConfirmUtil.ExpectedApplyChanges(targetIds.Count);
                if (!BulkConfirmUtil.EqualsNormalized(p.confirm, requiredConfirm))
                {
                    throw new OperatorToolUserErrorException(
                        message: "Bulk size sync requires typed confirmation.",
                        code: "bulk_confirm_required",
                        requiredConfirm: requiredConfirm,
                        confirmReceived: BulkConfirmUtil.Normalize(p.confirm),
                        maxChangesPerCall: 25,
                        hint: "Retry with confirm set to the requiredConfirm string (exact, but markdown like **...** is ok).");
                }
            }

            // Pre-compute duct sizes (source of truth).
            var ductSizes = new Dictionary<long, Size>();
            foreach (var id in targetIds)
            {
                var e = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(id));
                if (e == null) continue;
                if (!IsDuctCurve(e)) continue;

                var s = TryGetDuctSize(e);
                if (s != null) ductSizes[id] = s;
            }

            var changes = new List<object>();
            var skipped = new List<object>();
            var updated = new HashSet<long>();
            var typeDriven = new List<object>();
            var typeDrivenCandidates = new List<TypeDrivenCandidate>();
            var changedCount = 0;
            var verifiedCount = 0;

            using (var t = new Transaction(doc, "Sync Connected Sizes"))
            {
                t.Start();
                WarningSuppressionUtil.SuppressWarnings(t);

                foreach (var id in targetIds)
                {
                    var e = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(id));
                    if (e == null)
                    {
                        skipped.Add(new { id, reason = "ElementNotFound" });
                        continue;
                    }

                    if (IsDuctCurve(e)) continue; // duct is the driver; assume resized elsewhere

                    var desired = TryGetDesiredSizeFromAdjacentDucts(
                        doc,
                        e,
                        ductSizes,
                        adjacencyMaxHops,
                        out var desiredReason,
                        out var desiredSource,
                        out var desiredHops,
                        out var nearbyDuctIds);

                    if (desired == null)
                    {
                        skipped.Add(new
                        {
                            id,
                            category = SelectionUtil.GetCategoryToken(e),
                            reason = desiredReason ?? "NoAdjacentDuctSize",
                            desiredSource,
                            desiredHops,
                            nearbyDuctIds
                        });
                        continue;
                    }

                    var apply = TryApplySizeToElement(doc, e, desired, desiredSource, desiredHops, nearbyDuctIds);
                    if (!apply.Ok)
                    {
                        if (!string.IsNullOrWhiteSpace(apply.TypeDrivenReason))
                        {
                            typeDriven.Add(new
                            {
                                id,
                                category = SelectionUtil.GetCategoryToken(e),
                                name = e.Name,
                                typeId = RevitBridge.Common.ElementIdCompat.GetValue(e.GetTypeId()),
                                desired = SizeForWire(doc, desired),
                                desiredSource,
                                desiredHops,
                                nearbyDuctIds,
                                reason = apply.TypeDrivenReason,
                                detail = apply.Diff
                            });
                            typeDrivenCandidates.Add(new TypeDrivenCandidate
                            {
                                InstanceId = id,
                                Category = SelectionUtil.GetCategoryToken(e) ?? "",
                                Name = e.Name ?? "",
                                TypeId = RevitBridge.Common.ElementIdCompat.GetValue(e.GetTypeId()),
                                Desired = desired,
                                DesiredSource = desiredSource,
                                DesiredHops = desiredHops,
                                NearbyDuctIds = nearbyDuctIds ?? new List<long>()
                            });
                        }
                        else
                        {
                            skipped.Add(apply.Diff);
                        }
                        continue;
                    }

                    changes.Add(apply.Diff);
                    updated.Add(id);
                    if (apply.Changed) changedCount++;
                    if (apply.Verified) verifiedCount++;
                }

                if (p.dryRun) t.RollBack();
                else t.Commit();
            }

            if (!p.dryRun && updated.Count > 0)
            {
                try { doc.Regenerate(); } catch { }
                try { uidoc.RefreshActiveView(); } catch { }
            }

            var typeResolveResult = new
            {
                mode = resolveTypeDriven,
                attempted = 0,
                duplicatesCreated = 0,
                instancesSwapped = 0,
                skipped = typeDrivenCandidates.Count,
                blockers = new List<object>()
            };

            if (!p.dryRun &&
                typeDrivenCandidates.Count > 0 &&
                !resolveTypeDriven.Equals("skip", StringComparison.OrdinalIgnoreCase))
            {
                var blockers = new List<object>();
                var attempted = 0;
                var duplicatesCreated = 0;
                var instancesSwapped = 0;

                foreach (var c in typeDrivenCandidates)
                {
                    attempted++;
                    var inst = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(c.InstanceId));
                    if (inst == null)
                    {
                        blockers.Add(new { id = c.InstanceId, reason = "InstanceNotFound" });
                        continue;
                    }

                    var type = doc.GetElement(inst.GetTypeId()) as ElementType;
                    if (type == null)
                    {
                        blockers.Add(new { id = c.InstanceId, reason = "TypeNotFound" });
                        continue;
                    }

                    var paramChanges = BuildTypeParamChanges(doc, type, c.Desired);
                    if (paramChanges.Count == 0)
                    {
                        blockers.Add(new
                        {
                            id = c.InstanceId,
                            typeId = RevitBridge.Common.ElementIdCompat.GetValue(type.Id),
                            reason = "NoWritableTypeSizeParameters",
                            desired = SizeForWire(doc, c.Desired)
                        });
                        continue;
                    }

                    try
                    {
                        var typeName = BuildAutoTypeName(type.Name, c.Desired, c.InstanceId);
                        var swapReq = new RevitBridge.Logic.Handlers.DuplicateTypeAndSwapInstanceHandler.Params
                        {
                            instanceId = c.InstanceId,
                            newTypeName = typeName,
                            typeParamChanges = paramChanges
                                .Select(x => new RevitBridge.Logic.Handlers.DuplicateTypeAndSwapInstanceHandler.Change
                                {
                                    parameterName = x.ParameterName,
                                    value = x.Value
                                })
                                .ToList(),
                            dryRun = false,
                            confirm = p.confirm
                        };
                        var swapRes = new RevitBridge.Logic.Handlers.DuplicateTypeAndSwapInstanceHandler().Handle(app, JsonSerializer.Serialize(swapReq)).GetAwaiter().GetResult();
                        duplicatesCreated++;
                        instancesSwapped++;
                        changes.Add(new
                        {
                            id = c.InstanceId,
                            category = c.Category,
                            name = c.Name,
                            desired = SizeForWire(doc, c.Desired),
                            changed = true,
                            verified = true,
                            desiredSource = c.DesiredSource,
                            desiredHops = c.DesiredHops,
                            nearbyDuctIds = c.NearbyDuctIds,
                            typeDrivenResolved = true,
                            resolution = swapRes
                        });
                    }
                    catch (Exception ex)
                    {
                        blockers.Add(new
                        {
                            id = c.InstanceId,
                            typeId = RevitBridge.Common.ElementIdCompat.GetValue(type.Id),
                            reason = "DuplicateAndSwapFailed",
                            error = ex.Message
                        });
                    }
                }

                typeResolveResult = new
                {
                    mode = resolveTypeDriven,
                    attempted,
                    duplicatesCreated,
                    instancesSwapped,
                    skipped = Math.Max(0, typeDrivenCandidates.Count - attempted),
                    blockers
                };
            }

            return Task.FromResult<object>(new
            {
                status = p.dryRun ? "Dry Run" : "Applied",
                dryRun = p.dryRun,
                mode = p.mode,
                input = new { startElementId = p.startElementId, elementIds = p.elementIds },
                maxElements = max,
                adjacencyMaxHops,
                targetsCount = targetIds.Count,
                ductDriversCount = ductSizes.Count,
                updatedCount = updated.Count,
                changedCount,
                verifiedCount,
                resolveTypeDriven,
                changes,
                skipped,
                typeDriven,
                typeDrivenResolution = typeResolveResult,
                notes = new[]
                {
                    "Sync now scans instance sizing params on fittings/terminals (Diameter, Duct Radius, Duct Radius 1/2/3, Width, Height, Duct Size) and attempts in-place updates.",
                    "When no immediate adjacent ducts are found, sync walks the connector graph (up to adjacencyMaxHops) to infer a target size.",
                    "If resolveTypeDriven is auto/duplicate and apply mode is used, sync can duplicate/swap type-driven fittings or terminals per instance."
                }
            });
        }

        private static IEnumerable<long> TraceConnectedIds(Document doc, ElementId startId, int max)
        {
            var visited = new HashSet<int>();
            var q = new Queue<ElementId>();
            q.Enqueue(startId);
            while (q.Count > 0 && visited.Count < max)
            {
                var id = q.Dequeue();
                if (!visited.Add(id.IntegerValue)) continue;
                yield return RevitBridge.Common.ElementIdCompat.GetValue(id);

                var e = doc.GetElement(id);
                if (e == null) continue;
                foreach (var next in MepSystemUtil.GetConnectedOwnerElementIds(e))
                {
                    if (!visited.Contains(next.IntegerValue)) q.Enqueue(next);
                }
            }
        }

        private static bool IsDuctCurve(Element e)
        {
            try
            {
                return RevitBridge.Common.ElementIdCompat.GetValue(e.Category?.Id) == (int)BuiltInCategory.OST_DuctCurves;
            }
            catch
            {
                return false;
            }
        }

        private static Size? TryGetDuctSize(Element duct)
        {
            try
            {
                foreach (var c in MepSystemUtil.GetConnectors(duct))
                {
                    if (c == null) continue;
                    if (c.Shape == ConnectorProfileType.Round)
                    {
                        var d = 2.0 * c.Radius;
                        return new Size { Kind = "round", DiameterFt = d };
                    }
                    if (c.Shape == ConnectorProfileType.Rectangular)
                    {
                        return new Size { Kind = "rect", WidthFt = c.Width, HeightFt = c.Height };
                    }
                }
            }
            catch { }
            return null;
        }

        private static double SizeScore(Size s)
        {
            if (s == null) return 0;
            if (string.Equals(s.Kind, "round", StringComparison.OrdinalIgnoreCase)) return s.DiameterFt;
            if (string.Equals(s.Kind, "rect", StringComparison.OrdinalIgnoreCase)) return Math.Max(s.WidthFt, s.HeightFt);
            return 0;
        }

        private static Size? TryGetDesiredSizeFromAdjacentDucts(
            Document doc,
            Element e,
            Dictionary<long, Size> ductSizes,
            int adjacencyMaxHops,
            out string? reason,
            out string desiredSource,
            out int desiredHops,
            out List<long> nearbyDuctIds)
        {
            reason = null;
            desiredSource = "none";
            desiredHops = 0;
            nearbyDuctIds = new List<long>();

            // 1) Direct adjacency first.
            var direct = new List<AdjacentSizeCandidate>();
            try
            {
                foreach (var c in MepSystemUtil.GetConnectors(e))
                {
                    if (c == null) continue;
                    ConnectorSet? refs = null;
                    try { refs = c.AllRefs; } catch { refs = null; }
                    if (refs == null) continue;

                    foreach (Connector r in refs)
                    {
                        var o = r?.Owner;
                        if (o == null) continue;
                        if (!IsDuctCurve(o)) continue;
                        if (!ductSizes.TryGetValue(RevitBridge.Common.ElementIdCompat.GetValue(o.Id), out var s)) continue;
                        direct.Add(new AdjacentSizeCandidate { DuctId = RevitBridge.Common.ElementIdCompat.GetValue(o.Id), Hops = 1, Size = s });
                    }
                }
            }
            catch
            {
                reason = "ConnectorReadError";
                return null;
            }

            if (direct.Count > 0)
            {
                var chosen = direct.OrderByDescending(c => SizeScore(c.Size)).First();
                desiredSource = "direct";
                desiredHops = 1;
                nearbyDuctIds = direct.Select(c => c.DuctId).Distinct().Take(8).ToList();
                return chosen.Size;
            }

            // 2) Graph walk fallback for fitting->fitting->duct chains.
            var candidates = new List<AdjacentSizeCandidate>();
            var visited = new HashSet<int>();
            var q = new Queue<(ElementId id, int hops)>();
            visited.Add(e.Id.IntegerValue);

            try
            {
                foreach (var nid in MepSystemUtil.GetConnectedOwnerElementIds(e))
                {
                    if (nid == null) continue;
                    q.Enqueue((nid, 1));
                }

                while (q.Count > 0 && visited.Count < 20000)
                {
                    var item = q.Dequeue();
                    var id = item.id;
                    var hops = item.hops;
                    if (!visited.Add(id.IntegerValue)) continue;

                    var node = doc.GetElement(id);
                    if (node == null) continue;

                    if (IsDuctCurve(node) && ductSizes.TryGetValue(RevitBridge.Common.ElementIdCompat.GetValue(node.Id), out var s))
                    {
                        candidates.Add(new AdjacentSizeCandidate
                        {
                            DuctId = RevitBridge.Common.ElementIdCompat.GetValue(node.Id),
                            Hops = hops,
                            Size = s
                        });
                    }

                    if (hops >= adjacencyMaxHops) continue;

                    foreach (var next in MepSystemUtil.GetConnectedOwnerElementIds(node))
                    {
                        if (!visited.Contains(next.IntegerValue)) q.Enqueue((next, hops + 1));
                    }
                }
            }
            catch
            {
                reason = "ConnectorGraphReadError";
                return null;
            }

            if (candidates.Count == 0)
            {
                reason = "NoAdjacentDucts";
                return null;
            }

            var minHops = candidates.Min(c => c.Hops);
            var nearest = candidates.Where(c => c.Hops == minHops).ToList();
            var selected = nearest.OrderByDescending(c => SizeScore(c.Size)).First();

            desiredSource = "graph";
            desiredHops = selected.Hops;
            nearbyDuctIds = nearest.Select(c => c.DuctId).Distinct().Take(8).ToList();
            return selected.Size;
        }

        private static ApplyResult TryApplySizeToElement(
            Document doc,
            Element e,
            Size desired,
            string desiredSource,
            int desiredHops,
            List<long> nearbyDuctIds)
        {
            var discovered = DiscoverSizeParameters(e, desired);
            var discoveredWire = discovered
                .Select(d => new
                {
                    name = d.Name,
                    kind = d.Kind,
                    readOnly = d.Param.IsReadOnly,
                    storageType = d.Param.StorageType.ToString()
                })
                .ToList();

            if (discovered.Count == 0)
            {
                var typeReason = IsFamilyInstance(e) ? "NoInstanceSizeParametersFound" : null;
                return new ApplyResult
                {
                    Ok = false,
                    Changed = false,
                    Verified = false,
                    TypeDrivenReason = typeReason,
                    Diff = new
                    {
                        id = RevitBridge.Common.ElementIdCompat.GetValue(e.Id),
                        category = SelectionUtil.GetCategoryToken(e),
                        name = e.Name,
                        desired = SizeForWire(doc, desired),
                        desiredSource,
                        desiredHops,
                        nearbyDuctIds,
                        reason = typeReason ?? "NoWritableSizeParameter",
                        discoveredParameters = discoveredWire,
                        appliedParameters = Array.Empty<object>(),
                        rejectedParameters = Array.Empty<object>()
                    }
                };
            }

            var connectorBefore = TryGetRepresentativeConnectorSize(e);
            var applied = new List<object>();
            var rejected = new List<object>();
            var changedAny = false;
            var paramVerified = true;
            var appliedCount = 0;

            foreach (var d in discovered)
            {
                var p = d.Param;
                var before = ParameterValueUtil.SnapshotForWire(p);
                var desiredText = FormatLength(doc, d.TargetFt);

                if (p.IsReadOnly)
                {
                    rejected.Add(new
                    {
                        name = d.Name,
                        kind = d.Kind,
                        reason = "ReadOnly",
                        desired = desiredText,
                        before
                    });
                    continue;
                }

                var changed = false;
                var ok = true;
                string? error = null;

                try
                {
                    if (p.StorageType == StorageType.Double)
                    {
                        var existing = p.AsDouble();
                        changed = Math.Abs(existing - d.TargetFt) > 1e-9;
                        if (changed) p.Set(d.TargetFt);
                    }
                    else
                    {
                        ok = ParameterValueUtil.TrySetFromString(p, desiredText, out changed, out error);
                    }
                }
                catch (Exception ex)
                {
                    ok = false;
                    error = ex.Message;
                }

                var after = ParameterValueUtil.SnapshotForWire(p);
                if (!ok)
                {
                    rejected.Add(new
                    {
                        name = d.Name,
                        kind = d.Kind,
                        reason = error ?? "SetFailed",
                        desired = desiredText,
                        before,
                        after
                    });
                    continue;
                }

                var verified = VerifyParameterReadback(p, d.TargetFt, desiredText);
                appliedCount++;
                changedAny = changedAny || changed;
                paramVerified = paramVerified && verified;

                applied.Add(new
                {
                    name = d.Name,
                    kind = d.Kind,
                    desired = desiredText,
                    before,
                    after,
                    changed,
                    verified,
                    storageType = p.StorageType.ToString()
                });
            }

            if (appliedCount == 0)
            {
                var allReadOnly = discovered.Count > 0 && discovered.All(x => x.Param.IsReadOnly);
                var typeReason = IsFamilyInstance(e) && allReadOnly ? "InstanceSizeParametersReadOnly" : (IsFamilyInstance(e) ? "NoWritableInstanceSizeParameters" : null);

                return new ApplyResult
                {
                    Ok = false,
                    Changed = false,
                    Verified = false,
                    TypeDrivenReason = typeReason,
                    Diff = new
                    {
                        id = RevitBridge.Common.ElementIdCompat.GetValue(e.Id),
                        category = SelectionUtil.GetCategoryToken(e),
                        name = e.Name,
                        desired = SizeForWire(doc, desired),
                        desiredSource,
                        desiredHops,
                        nearbyDuctIds,
                        reason = typeReason ?? "NoWritableSizeParameter",
                        discoveredParameters = discoveredWire,
                        appliedParameters = applied,
                        rejectedParameters = rejected
                    }
                };
            }

            var connectorAfter = TryGetRepresentativeConnectorSize(e);
            bool? connectorVerified = null;
            if (connectorAfter != null)
            {
                connectorVerified = SizesMatch(connectorAfter, desired);
            }

            var verifiedAll = paramVerified;
            if (connectorVerified.HasValue) verifiedAll = verifiedAll && connectorVerified.Value;

            return new ApplyResult
            {
                Ok = true,
                Changed = changedAny,
                Verified = verifiedAll,
                TypeDrivenReason = null,
                Diff = new
                {
                    id = RevitBridge.Common.ElementIdCompat.GetValue(e.Id),
                    category = SelectionUtil.GetCategoryToken(e),
                    name = e.Name,
                    desired = SizeForWire(doc, desired),
                    desiredSource,
                    desiredHops,
                    nearbyDuctIds,
                    changed = changedAny,
                    verified = verifiedAll,
                    connectorBefore = connectorBefore != null ? SizeForWire(doc, connectorBefore) : null,
                    connectorAfter = connectorAfter != null ? SizeForWire(doc, connectorAfter) : null,
                    connectorVerified,
                    discoveredParameters = discoveredWire,
                    appliedParameters = applied,
                    rejectedParameters = rejected
                }
            };
        }

        private static List<DiscoveredParam> DiscoverSizeParameters(Element e, Size desired)
        {
            var list = new List<DiscoveredParam>();
            var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

            void Add(Parameter p, string name, string kind, double targetFt)
            {
                if (p == null) return;
                var key = (name ?? "").Trim() + "|" + kind;
                if (!seen.Add(key)) return;
                list.Add(new DiscoveredParam
                {
                    Param = p,
                    Name = (name ?? "").Trim(),
                    Kind = kind,
                    TargetFt = targetFt
                });
            }

            try
            {
                foreach (Parameter p in e.Parameters)
                {
                    if (p == null) continue;
                    var rawName = p.Definition?.Name;
                    var name = (rawName ?? "").Trim();
                    if (name.Length == 0) continue;

                    var n = NormalizeName(name);

                    if (desired.Kind == "round")
                    {
                        if (IsRoundRadiusName(n))
                        {
                            Add(p, name, "radius", desired.DiameterFt / 2.0);
                            continue;
                        }

                        if (IsRoundDiameterName(n))
                        {
                            Add(p, name, "diameter", desired.DiameterFt);
                            continue;
                        }
                    }
                    else if (desired.Kind == "rect")
                    {
                        if (IsRectWidthName(n))
                        {
                            Add(p, name, "width", desired.WidthFt);
                            continue;
                        }

                        if (IsRectHeightName(n))
                        {
                            Add(p, name, "height", desired.HeightFt);
                            continue;
                        }
                    }
                }
            }
            catch
            {
                // ignore parameter enumeration failures
            }

            if (desired.Kind == "round")
            {
                try
                {
                    var p = e.get_Parameter(BuiltInParameter.RBS_CURVE_DIAMETER_PARAM);
                    if (p != null)
                    {
                        Add(p, p.Definition?.Name ?? "Diameter", "diameter", desired.DiameterFt);
                    }
                }
                catch
                {
                    // ignore
                }
            }

            return list;
        }

        private static bool IsRoundRadiusName(string normalized)
        {
            if (normalized.Length == 0) return false;
            return normalized == "ductradius" ||
                   normalized == "ductradius1" ||
                   normalized == "ductradius2" ||
                   normalized == "ductradius3" ||
                   normalized == "connectorradius";
        }

        private static bool IsRoundDiameterName(string normalized)
        {
            if (normalized.Length == 0) return false;
            return normalized == "diameter" ||
                   normalized == "diameter1" ||
                   normalized == "diameter2" ||
                   normalized == "nominaldiameter" ||
                   normalized == "ductdiameter" ||
                   normalized == "connectordiameter" ||
                   normalized == "ductsize" ||
                   normalized == "size";
        }

        private static bool IsRectWidthName(string normalized)
        {
            if (normalized.Length == 0) return false;
            return normalized == "width" ||
                   normalized == "width1" ||
                   normalized == "width2" ||
                   normalized == "ductwidth" ||
                   normalized == "connectorwidth";
        }

        private static bool IsRectHeightName(string normalized)
        {
            if (normalized.Length == 0) return false;
            return normalized == "height" ||
                   normalized == "height1" ||
                   normalized == "height2" ||
                   normalized == "ductheight" ||
                   normalized == "connectorheight";
        }

        private static string NormalizeName(string value)
        {
            if (string.IsNullOrWhiteSpace(value)) return "";
            var chars = value
                .Where(char.IsLetterOrDigit)
                .Select(char.ToLowerInvariant)
                .ToArray();
            return new string(chars);
        }

        private static bool VerifyParameterReadback(Parameter p, double targetFt, string desiredText)
        {
            if (p == null) return false;
            try
            {
                if (p.StorageType == StorageType.Double)
                {
                    var actual = p.AsDouble();
                    return Math.Abs(actual - targetFt) <= 1e-6;
                }

                var txt = (p.AsValueString() ?? p.AsString() ?? "").Trim();
                if (txt.Length == 0) return false;
                var a = NormalizeName(txt);
                var b = NormalizeName(desiredText);
                if (a.Length == 0 || b.Length == 0) return false;
                return a.Contains(b) || b.Contains(a);
            }
            catch
            {
                return false;
            }
        }

        private static Size? TryGetRepresentativeConnectorSize(Element e)
        {
            if (e == null) return null;
            try
            {
                foreach (var c in MepSystemUtil.GetConnectors(e))
                {
                    if (c == null) continue;
                    if (c.Shape == ConnectorProfileType.Round)
                    {
                        return new Size { Kind = "round", DiameterFt = 2.0 * c.Radius };
                    }

                    if (c.Shape == ConnectorProfileType.Rectangular)
                    {
                        return new Size { Kind = "rect", WidthFt = c.Width, HeightFt = c.Height };
                    }
                }
            }
            catch
            {
                // ignore
            }
            return null;
        }

        private static bool SizesMatch(Size actual, Size desired)
        {
            if (actual == null || desired == null) return false;
            if (!string.Equals(actual.Kind, desired.Kind, StringComparison.OrdinalIgnoreCase)) return false;

            if (actual.Kind == "round")
            {
                return Math.Abs(actual.DiameterFt - desired.DiameterFt) <= 1e-5;
            }

            if (actual.Kind == "rect")
            {
                var wMatch = Math.Abs(actual.WidthFt - desired.WidthFt) <= 1e-5;
                var hMatch = Math.Abs(actual.HeightFt - desired.HeightFt) <= 1e-5;
                return wMatch && hMatch;
            }

            return false;
        }

        private static bool IsFamilyInstance(Element e) => e is FamilyInstance;

        private sealed class TypeParamChange
        {
            public string ParameterName { get; set; } = "";
            public string Value { get; set; } = "";
        }

        private static List<TypeParamChange> BuildTypeParamChanges(Document doc, ElementType type, Size desired)
        {
            var changes = new List<TypeParamChange>();
            if (type == null) return changes;

            if (desired.Kind == "round")
            {
                var dText = FormatLength(doc, desired.DiameterFt);
                var rText = FormatLength(doc, desired.DiameterFt / 2.0);

                var radiusNames = new[] { "Duct Radius", "Duct Radius 1", "Duct Radius 2", "Duct Radius 3", "Connector Radius", "Radius" };
                foreach (var n in radiusNames)
                {
                    var p = TryGetWritableTypeParam(type, n);
                    if (p != null) changes.Add(new TypeParamChange { ParameterName = n, Value = rText });
                }

                var diameterNames = new[] { "Diameter", "Nominal Diameter", "Duct Diameter", "Connector Diameter", "Duct Size", "Size" };
                foreach (var n in diameterNames)
                {
                    var p = TryGetWritableTypeParam(type, n);
                    if (p != null) changes.Add(new TypeParamChange { ParameterName = n, Value = dText });
                }
            }
            else if (desired.Kind == "rect")
            {
                var wText = FormatLength(doc, desired.WidthFt);
                var hText = FormatLength(doc, desired.HeightFt);
                var widthNames = new[] { "Width", "Duct Width", "Connector Width", "Width 1", "Width 2" };
                var heightNames = new[] { "Height", "Duct Height", "Connector Height", "Height 1", "Height 2" };

                foreach (var n in widthNames)
                {
                    var p = TryGetWritableTypeParam(type, n);
                    if (p != null) changes.Add(new TypeParamChange { ParameterName = n, Value = wText });
                }

                foreach (var n in heightNames)
                {
                    var p = TryGetWritableTypeParam(type, n);
                    if (p != null) changes.Add(new TypeParamChange { ParameterName = n, Value = hText });
                }
            }

            return changes
                .GroupBy(x => x.ParameterName, StringComparer.OrdinalIgnoreCase)
                .Select(g => g.First())
                .ToList();
        }

        private static Parameter? TryGetWritableTypeParam(ElementType type, string name)
        {
            try
            {
                var p = type.LookupParameter(name);
                if (p == null || p.IsReadOnly) return null;
                return p;
            }
            catch
            {
                return null;
            }
        }

        private static string BuildAutoTypeName(string currentTypeName, Size desired, long instanceId)
        {
            var suffix = desired.Kind == "round"
                ? $"auto-{desired.DiameterFt.ToString("0.###", CultureInfo.InvariantCulture)}ft"
                : $"auto-{desired.WidthFt.ToString("0.###", CultureInfo.InvariantCulture)}x{desired.HeightFt.ToString("0.###", CultureInfo.InvariantCulture)}ft";
            return $"{currentTypeName} - {suffix} - {instanceId}";
        }

        private static object SizeForWire(Document doc, Size s)
        {
            if (s.Kind == "round") return new { kind = "round", diameter = FormatLength(doc, s.DiameterFt), diameterFt = s.DiameterFt };
            if (s.Kind == "rect") return new { kind = "rect", width = FormatLength(doc, s.WidthFt), height = FormatLength(doc, s.HeightFt), widthFt = s.WidthFt, heightFt = s.HeightFt };
            return new { kind = "unknown" };
        }

        private static string FormatLength(Document doc, double lengthFt)
        {
            try
            {
                var units = doc.GetUnits();
                return UnitFormatUtils.Format(units, SpecTypeId.Length, lengthFt, forEditing: true);
            }
            catch
            {
                return lengthFt.ToString("G", CultureInfo.InvariantCulture);
            }
        }
    }
}
