using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Events;
using Autodesk.Revit.UI;
using RevitBridge.Common;

namespace RevitBridge.Logic.Handlers
{
    internal sealed class TransactionDiffRecorder : IDisposable
    {
        internal sealed class CaptureOptions
        {
            public TransactionDiffLimits limits { get; set; } = TransactionDiffLimits.Defaults;
            public bool includeParameterDeltas { get; set; } = true;
            public bool includeGeometryDeltas { get; set; } = true;
            public bool includeViewSheetChanges { get; set; } = true;
            public bool persistArtifact { get; set; } = true;
            public string? artifactFolder { get; set; }

            public object ToWireObject()
            {
                return new
                {
                    includeParameterDeltas,
                    includeGeometryDeltas,
                    includeViewSheetChanges,
                    persistArtifact,
                    artifactFolder,
                    limits = new
                    {
                        maxTrackedElementIds = limits.MaxTrackedElementIds,
                        maxCreated = limits.MaxCreated,
                        maxDeleted = limits.MaxDeleted,
                        maxModified = limits.MaxModified,
                        maxParameterDeltas = limits.MaxParameterDeltas,
                        maxGeometryDeltas = limits.MaxGeometryDeltas,
                        maxViewSheetChanges = limits.MaxViewSheetChanges,
                        maxWatchElementsPerScope = limits.MaxWatchElementsPerScope
                    }
                };
            }
        }

        internal sealed class TransactionDiffScopeSummary
        {
            public int capturedCreated { get; set; }
            public int capturedDeleted { get; set; }
            public int capturedModified { get; set; }
            public int capturedParameterDeltas { get; set; }
            public int capturedGeometryDeltas { get; set; }
            public int capturedViewSheetChanges { get; set; }
            public int returnedCreated { get; set; }
            public int returnedDeleted { get; set; }
            public int returnedModified { get; set; }
            public int returnedParameterDeltas { get; set; }
            public int returnedGeometryDeltas { get; set; }
            public int returnedViewSheetChanges { get; set; }
        }

        internal sealed class TransactionDiffScopeResult
        {
            public string scopeId { get; set; } = "";
            public string scopeKind { get; set; } = "";
            public string? actionKind { get; set; }
            public DateTime startedUtc { get; set; }
            public DateTime stoppedUtc { get; set; }
            public IReadOnlyList<TransactionDiffElementRef> created { get; set; } = Array.Empty<TransactionDiffElementRef>();
            public IReadOnlyList<TransactionDiffElementRef> deleted { get; set; } = Array.Empty<TransactionDiffElementRef>();
            public IReadOnlyList<TransactionDiffModifiedElement> modified { get; set; } = Array.Empty<TransactionDiffModifiedElement>();
            public IReadOnlyList<TransactionDiffParameterDelta> parameterDeltas { get; set; } = Array.Empty<TransactionDiffParameterDelta>();
            public IReadOnlyList<TransactionDiffGeometryDelta> geometryDeltas { get; set; } = Array.Empty<TransactionDiffGeometryDelta>();
            public IReadOnlyList<TransactionDiffViewSheetChange> viewSheetChanges { get; set; } = Array.Empty<TransactionDiffViewSheetChange>();
            public bool truncated { get; set; }
            public Dictionary<string, int> omitted { get; set; } = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
            public TransactionDiffScopeSummary summary { get; set; } = new TransactionDiffScopeSummary();
        }

        internal class TransactionDiffElementRef
        {
            public long elementId { get; set; }
            public string? uniqueId { get; set; }
            public string? category { get; set; }
            public string? name { get; set; }
            public long? typeId { get; set; }
            public string? className { get; set; }
        }

        internal sealed class TransactionDiffModifiedElement : TransactionDiffElementRef
        {
            public bool hasBeforeSnapshot { get; set; }
            public int parameterDeltaCount { get; set; }
            public bool geometryChanged { get; set; }
        }

        internal sealed class TransactionDiffParameterDelta
        {
            public long elementId { get; set; }
            public string? uniqueId { get; set; }
            public string? category { get; set; }
            public string parameterName { get; set; } = "";
            public string? before { get; set; }
            public string? after { get; set; }
        }

        internal sealed class TransactionDiffGeometryDelta
        {
            public long elementId { get; set; }
            public string? uniqueId { get; set; }
            public string? category { get; set; }
            public object? before { get; set; }
            public object? after { get; set; }
            public object delta { get; set; } = new { };
        }

        internal sealed class TransactionDiffViewSheetChange
        {
            public string changeKind { get; set; } = "";
            public string entityKind { get; set; } = "";
            public long elementId { get; set; }
            public string? uniqueId { get; set; }
            public string? name { get; set; }
            public string? sheetNumber { get; set; }
            public string? viewType { get; set; }
        }

        private sealed class ElementSnapshot
        {
            public long ElementId { get; set; }
            public string? UniqueId { get; set; }
            public string? Category { get; set; }
            public string? Name { get; set; }
            public long? TypeId { get; set; }
            public string? ClassName { get; set; }
            public string? EntityKind { get; set; }
            public string? SheetNumber { get; set; }
            public string? ViewType { get; set; }
            public Dictionary<string, string?> ParameterValues { get; } = new Dictionary<string, string?>(StringComparer.OrdinalIgnoreCase);
            public GeometrySignature? Geometry { get; set; }
        }

        private sealed class GeometrySignature
        {
            public XYZ? point { get; set; }
            public double? rotationRadians { get; set; }
            public XYZ? curveStart { get; set; }
            public XYZ? curveEnd { get; set; }
            public double? curveLength { get; set; }
            public XYZ? bboxMin { get; set; }
            public XYZ? bboxMax { get; set; }

            public object ToWireObject()
            {
                return new
                {
                    point = point == null ? null : new { x = point.X, y = point.Y, z = point.Z },
                    rotationRadians,
                    curve = curveStart == null || curveEnd == null
                        ? null
                        : new
                        {
                            start = new { x = curveStart.X, y = curveStart.Y, z = curveStart.Z },
                            end = new { x = curveEnd.X, y = curveEnd.Y, z = curveEnd.Z },
                            length = curveLength
                        },
                    bbox = bboxMin == null || bboxMax == null
                        ? null
                        : new
                        {
                            min = new { x = bboxMin.X, y = bboxMin.Y, z = bboxMin.Z },
                            max = new { x = bboxMax.X, y = bboxMax.Y, z = bboxMax.Z }
                        }
                };
            }
        }

        private sealed class ActiveScope
        {
            public string ScopeId { get; set; } = "";
            public string ScopeKind { get; set; } = "";
            public string? ActionKind { get; set; }
            public DateTime StartedUtc { get; set; }
            public HashSet<long> WatchElementIds { get; } = new HashSet<long>();
            public Dictionary<long, ElementSnapshot> BeforeSnapshots { get; } = new Dictionary<long, ElementSnapshot>();
            public HashSet<long> AddedIds { get; } = new HashSet<long>();
            public HashSet<long> DeletedIds { get; } = new HashSet<long>();
            public HashSet<long> ModifiedIds { get; } = new HashSet<long>();
            public int DroppedAddedIds { get; set; }
            public int DroppedDeletedIds { get; set; }
            public int DroppedModifiedIds { get; set; }
        }

        private readonly UIApplication _app;
        private readonly Document _doc;
        private readonly CaptureOptions _options;
        private readonly object _gate = new object();
        private readonly Dictionary<string, ActiveScope> _activeScopes = new Dictionary<string, ActiveScope>(StringComparer.OrdinalIgnoreCase);
        private readonly Dictionary<string, TransactionDiffScopeResult> _completedScopes = new Dictionary<string, TransactionDiffScopeResult>(StringComparer.OrdinalIgnoreCase);
        private bool _disposed;

        private static readonly string[] GlobalParameterAllowlist =
        {
            "Mark",
            "Type Mark",
            "Comments",
            "Type Comments",
            "Family and Type",
            "Type Name",
            "Level",
            "Reference Level",
            "System Type",
            "System Name",
            "Size",
            "Length",
            "Width",
            "Height",
            "Diameter",
            "Offset",
            "View Name",
            "Sheet Number",
            "Sheet Name",
            "Detail Number",
            "Title on Sheet",
            "Scale"
        };

        private static readonly Dictionary<string, string[]> CategoryParameterAllowlists =
            new Dictionary<string, string[]>(StringComparer.OrdinalIgnoreCase)
            {
                { "tag", new[] { "Tag Text", "Leader", "Tag Head Position", "Text" } },
                { "dimension", new[] { "Value", "Text", "Prefix", "Suffix" } },
                { "mechanical equipment", new[] { "Flow", "Air Flow", "CFM", "System Type", "System Name" } },
                { "duct", new[] { "Diameter", "Width", "Height", "Offset", "Length", "System Type", "System Name" } },
                { "pipe", new[] { "Diameter", "Nominal Diameter", "Offset", "Length", "System Type", "System Name" } },
                { "sheet", new[] { "Sheet Number", "Sheet Name", "Appears In Sheet List" } },
                { "viewport", new[] { "View Name", "Detail Number", "Title on Sheet" } },
                { "view", new[] { "View Name", "Scale", "Detail Level", "Discipline" } }
            };

        public TransactionDiffRecorder(UIApplication app, Document doc, CaptureOptions options)
        {
            _app = app ?? throw new ArgumentNullException(nameof(app));
            _doc = doc ?? throw new ArgumentNullException(nameof(doc));
            _options = options ?? new CaptureOptions();

            _app.Application.DocumentChanged += OnDocumentChanged;
        }

        public void StartRecording(string scopeId, string scopeKind, IEnumerable<long>? watchElementIds = null, string? actionKind = null)
        {
            if (string.IsNullOrWhiteSpace(scopeId)) throw new ArgumentException("scopeId is required.", nameof(scopeId));
            if (string.IsNullOrWhiteSpace(scopeKind)) throw new ArgumentException("scopeKind is required.", nameof(scopeKind));

            var scope = new ActiveScope
            {
                ScopeId = scopeId.Trim(),
                ScopeKind = scopeKind.Trim(),
                ActionKind = string.IsNullOrWhiteSpace(actionKind) ? null : actionKind.Trim(),
                StartedUtc = DateTime.UtcNow
            };

            if (watchElementIds != null)
            {
                foreach (var id in watchElementIds)
                {
                    if (id <= 0) continue;
                    if (scope.WatchElementIds.Count >= _options.limits.MaxWatchElementsPerScope) break;
                    if (!scope.WatchElementIds.Add(id)) continue;
                    var snap = CaptureSnapshot(id, includeParameters: _options.includeParameterDeltas, includeGeometry: _options.includeGeometryDeltas);
                    if (snap != null) scope.BeforeSnapshots[id] = snap;
                }
            }

            lock (_gate)
            {
                if (_activeScopes.ContainsKey(scope.ScopeId))
                    throw new InvalidOperationException($"Diff scope '{scope.ScopeId}' is already active.");
                _activeScopes[scope.ScopeId] = scope;
            }
        }

        public bool TryGetRecording(string scopeId, out TransactionDiffScopeResult? result)
        {
            result = null;
            if (string.IsNullOrWhiteSpace(scopeId)) return false;
            lock (_gate)
            {
                if (!_completedScopes.TryGetValue(scopeId.Trim(), out var r) || r == null) return false;
                result = r;
                return true;
            }
        }

        public TransactionDiffScopeResult StopRecording(string scopeId)
        {
            if (string.IsNullOrWhiteSpace(scopeId)) throw new ArgumentException("scopeId is required.", nameof(scopeId));

            ActiveScope scope;
            lock (_gate)
            {
                if (!_activeScopes.TryGetValue(scopeId.Trim(), out scope!))
                    throw new InvalidOperationException($"Diff scope '{scopeId}' is not active.");
                _activeScopes.Remove(scopeId.Trim());
            }

            var result = BuildScopeResult(scope);
            lock (_gate)
            {
                _completedScopes[scope.ScopeId] = result;
            }
            return result;
        }

        private void OnDocumentChanged(object sender, DocumentChangedEventArgs args)
        {
            if (_disposed) return;
            if (args == null) return;

            Document? changedDoc = null;
            try { changedDoc = args.GetDocument(); } catch { changedDoc = null; }
            if (changedDoc == null || !ReferenceEquals(changedDoc, _doc)) return;

            ICollection<ElementId>? addedIds = null;
            ICollection<ElementId>? deletedIds = null;
            ICollection<ElementId>? modifiedIds = null;
            try { addedIds = args.GetAddedElementIds(); } catch { }
            try { deletedIds = args.GetDeletedElementIds(); } catch { }
            try { modifiedIds = args.GetModifiedElementIds(); } catch { }

            lock (_gate)
            {
                foreach (var scope in _activeScopes.Values)
                {
                    var droppedAdded = scope.DroppedAddedIds;
                    var droppedDeleted = scope.DroppedDeletedIds;
                    var droppedModified = scope.DroppedModifiedIds;

                    AddIds(scope.AddedIds, addedIds, _options.limits.MaxTrackedElementIds, ref droppedAdded);
                    AddIds(scope.DeletedIds, deletedIds, _options.limits.MaxTrackedElementIds, ref droppedDeleted);
                    AddIds(scope.ModifiedIds, modifiedIds, _options.limits.MaxTrackedElementIds, ref droppedModified);

                    scope.DroppedAddedIds = droppedAdded;
                    scope.DroppedDeletedIds = droppedDeleted;
                    scope.DroppedModifiedIds = droppedModified;
                }
            }
        }

        private static void AddIds(HashSet<long> set, ICollection<ElementId>? ids, int max, ref int dropped)
        {
            if (ids == null || ids.Count == 0) return;
            foreach (var id in ids)
            {
                if (id == null) continue;
                var v = ElementIdCompat.GetValue(id);
                if (v <= 0) continue;
                if (set.Count >= max)
                {
                    dropped++;
                    continue;
                }
                set.Add(v);
            }
        }

        private TransactionDiffScopeResult BuildScopeResult(ActiveScope scope)
        {
            var created = new List<TransactionDiffElementRef>();
            var deleted = new List<TransactionDiffElementRef>();
            var modified = new List<TransactionDiffModifiedElement>();
            var parameterDeltas = new List<TransactionDiffParameterDelta>();
            var geometryDeltas = new List<TransactionDiffGeometryDelta>();
            var viewSheetChanges = new List<TransactionDiffViewSheetChange>();
            var modifiedOrdered = scope.ModifiedIds.OrderBy(x => x).ToArray();

            foreach (var id in scope.AddedIds.OrderBy(x => x))
            {
                var snap = CaptureSnapshot(id, includeParameters: false, includeGeometry: false);
                if (snap != null)
                {
                    created.Add(ToElementRef(snap));
                    AddViewSheetChange(viewSheetChanges, "created", snap);
                }
                else
                {
                    created.Add(new TransactionDiffElementRef { elementId = id });
                }
            }

            foreach (var id in scope.DeletedIds.OrderBy(x => x))
            {
                if (scope.BeforeSnapshots.TryGetValue(id, out var before) && before != null)
                {
                    deleted.Add(ToElementRef(before));
                    AddViewSheetChange(viewSheetChanges, "deleted", before);
                }
                else
                {
                    deleted.Add(new TransactionDiffElementRef { elementId = id });
                }
            }

            foreach (var id in modifiedOrdered)
            {
                if (scope.DeletedIds.Contains(id)) continue;
                var after = CaptureSnapshot(id, includeParameters: _options.includeParameterDeltas, includeGeometry: _options.includeGeometryDeltas);
                if (after == null) continue;

                scope.BeforeSnapshots.TryGetValue(id, out var before);
                var modifiedEntry = new TransactionDiffModifiedElement
                {
                    elementId = id,
                    uniqueId = after.UniqueId ?? before?.UniqueId,
                    category = after.Category ?? before?.Category,
                    name = after.Name ?? before?.Name,
                    typeId = after.TypeId ?? before?.TypeId,
                    className = after.ClassName ?? before?.ClassName,
                    hasBeforeSnapshot = before != null,
                    parameterDeltaCount = 0,
                    geometryChanged = false
                };

                if (_options.includeParameterDeltas && before != null)
                {
                    foreach (var pd in ComputeParameterDeltas(before, after))
                    {
                        parameterDeltas.Add(new TransactionDiffParameterDelta
                        {
                            elementId = id,
                            uniqueId = modifiedEntry.uniqueId,
                            category = modifiedEntry.category,
                            parameterName = pd.Key,
                            before = pd.Before,
                            after = pd.After
                        });
                        modifiedEntry.parameterDeltaCount++;
                    }
                }

                if (_options.includeGeometryDeltas && before?.Geometry != null && after.Geometry != null)
                {
                    var g = ComputeGeometryDelta(before.Geometry, after.Geometry);
                    if (g != null)
                    {
                        geometryDeltas.Add(new TransactionDiffGeometryDelta
                        {
                            elementId = id,
                            uniqueId = modifiedEntry.uniqueId,
                            category = modifiedEntry.category,
                            before = before.Geometry.ToWireObject(),
                            after = after.Geometry.ToWireObject(),
                            delta = g
                        });
                        modifiedEntry.geometryChanged = true;
                    }
                }

                modified.Add(modifiedEntry);
                AddViewSheetChange(viewSheetChanges, "modified", after);
            }

            var createdCapped = TransactionDiffPayloadCap.Cap(created, _options.limits.MaxCreated, out var omittedCreated);
            var deletedCapped = TransactionDiffPayloadCap.Cap(deleted, _options.limits.MaxDeleted, out var omittedDeleted);
            var modifiedCapped = TransactionDiffPayloadCap.Cap(modified, _options.limits.MaxModified, out var omittedModified);
            var parameterCapped = TransactionDiffPayloadCap.Cap(parameterDeltas, _options.limits.MaxParameterDeltas, out var omittedParameter);
            var geometryCapped = TransactionDiffPayloadCap.Cap(geometryDeltas, _options.limits.MaxGeometryDeltas, out var omittedGeometry);
            var viewSheetCapped = TransactionDiffPayloadCap.Cap(viewSheetChanges, _options.limits.MaxViewSheetChanges, out var omittedViewSheet);

            var omitted = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
            AddOmitted(omitted, "created", omittedCreated);
            AddOmitted(omitted, "deleted", omittedDeleted);
            AddOmitted(omitted, "modified", omittedModified);
            AddOmitted(omitted, "parameterDeltas", omittedParameter);
            AddOmitted(omitted, "geometryDeltas", omittedGeometry);
            AddOmitted(omitted, "viewSheetChanges", omittedViewSheet);
            AddOmitted(omitted, "trackedAddedIds", scope.DroppedAddedIds);
            AddOmitted(omitted, "trackedDeletedIds", scope.DroppedDeletedIds);
            AddOmitted(omitted, "trackedModifiedIds", scope.DroppedModifiedIds);

            return new TransactionDiffScopeResult
            {
                scopeId = scope.ScopeId,
                scopeKind = scope.ScopeKind,
                actionKind = scope.ActionKind,
                startedUtc = scope.StartedUtc,
                stoppedUtc = DateTime.UtcNow,
                created = createdCapped,
                deleted = deletedCapped,
                modified = modifiedCapped,
                parameterDeltas = parameterCapped,
                geometryDeltas = geometryCapped,
                viewSheetChanges = _options.includeViewSheetChanges ? viewSheetCapped : Array.Empty<TransactionDiffViewSheetChange>(),
                truncated = omitted.Count > 0,
                omitted = omitted,
                summary = new TransactionDiffScopeSummary
                {
                    capturedCreated = created.Count,
                    capturedDeleted = deleted.Count,
                    capturedModified = modified.Count,
                    capturedParameterDeltas = parameterDeltas.Count,
                    capturedGeometryDeltas = geometryDeltas.Count,
                    capturedViewSheetChanges = viewSheetChanges.Count,
                    returnedCreated = createdCapped.Length,
                    returnedDeleted = deletedCapped.Length,
                    returnedModified = modifiedCapped.Length,
                    returnedParameterDeltas = parameterCapped.Length,
                    returnedGeometryDeltas = geometryCapped.Length,
                    returnedViewSheetChanges = _options.includeViewSheetChanges ? viewSheetCapped.Length : 0
                }
            };
        }

        private static void AddOmitted(Dictionary<string, int> omitted, string key, int count)
        {
            if (count <= 0) return;
            omitted[key] = count;
        }

        private static TransactionDiffElementRef ToElementRef(ElementSnapshot snap)
        {
            return new TransactionDiffElementRef
            {
                elementId = snap.ElementId,
                uniqueId = snap.UniqueId,
                category = snap.Category,
                name = snap.Name,
                typeId = snap.TypeId,
                className = snap.ClassName
            };
        }

        private static void AddViewSheetChange(List<TransactionDiffViewSheetChange> target, string changeKind, ElementSnapshot snap)
        {
            if (snap == null) return;
            if (string.IsNullOrWhiteSpace(snap.EntityKind)) return;
            target.Add(new TransactionDiffViewSheetChange
            {
                changeKind = changeKind,
                entityKind = snap.EntityKind!,
                elementId = snap.ElementId,
                uniqueId = snap.UniqueId,
                name = snap.Name,
                sheetNumber = snap.SheetNumber,
                viewType = snap.ViewType
            });
        }

        private ElementSnapshot? CaptureSnapshot(long elementId, bool includeParameters, bool includeGeometry)
        {
            try
            {
                var el = _doc.GetElement(ElementIdCompat.Create(elementId));
                if (el == null) return null;
                return CaptureSnapshot(el, includeParameters, includeGeometry);
            }
            catch
            {
                return null;
            }
        }

        private static ElementSnapshot? CaptureSnapshot(Element? element, bool includeParameters, bool includeGeometry)
        {
            if (element == null) return null;

            var snap = new ElementSnapshot
            {
                ElementId = ElementIdCompat.GetValue(element.Id),
                UniqueId = SafeGet(() => element.UniqueId),
                Category = SafeGet(() => element.Category?.Name),
                Name = SafeGet(() => element.Name),
                TypeId = SafeGetTypeId(element),
                ClassName = element.GetType().Name
            };

            if (element is ViewSheet sheet)
            {
                snap.EntityKind = "sheet";
                snap.SheetNumber = SafeGet(() => sheet.SheetNumber);
                snap.ViewType = "DrawingSheet";
            }
            else if (element is Viewport)
            {
                snap.EntityKind = "viewport";
            }
            else if (element is View v)
            {
                snap.EntityKind = "view";
                snap.ViewType = v.ViewType.ToString();
            }

            if (includeParameters)
            {
                var names = ResolveAllowlistedParameterNames(snap.Category);
                foreach (var name in names)
                {
                    try
                    {
                        var p = element.LookupParameter(name);
                        if (p == null) continue;
                        snap.ParameterValues[name] = ReadComparableParameterValue(p);
                    }
                    catch
                    {
                        // Ignore read failures and keep snapshot lightweight.
                    }
                }

                snap.ParameterValues["TypeId"] = (snap.TypeId ?? 0).ToString(CultureInfo.InvariantCulture);
            }

            if (includeGeometry)
            {
                snap.Geometry = CaptureGeometrySignature(element);
            }

            return snap;
        }

        private static IEnumerable<string> ResolveAllowlistedParameterNames(string? categoryName)
        {
            var names = new HashSet<string>(GlobalParameterAllowlist, StringComparer.OrdinalIgnoreCase);
            if (!string.IsNullOrWhiteSpace(categoryName))
            {
                foreach (var kvp in CategoryParameterAllowlists)
                {
                    if (categoryName.IndexOf(kvp.Key, StringComparison.OrdinalIgnoreCase) >= 0)
                    {
                        foreach (var n in kvp.Value) names.Add(n);
                    }
                }
            }
            return names;
        }

        private sealed class ParamDeltaPair
        {
            public string Key { get; set; } = "";
            public string? Before { get; set; }
            public string? After { get; set; }
        }

        private static IEnumerable<ParamDeltaPair> ComputeParameterDeltas(ElementSnapshot before, ElementSnapshot after)
        {
            const int maxPerElement = 32;
            var keys = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var k in before.ParameterValues.Keys) keys.Add(k);
            foreach (var k in after.ParameterValues.Keys) keys.Add(k);

            var emitted = 0;
            foreach (var key in keys.OrderBy(x => x, StringComparer.OrdinalIgnoreCase))
            {
                before.ParameterValues.TryGetValue(key, out var b);
                after.ParameterValues.TryGetValue(key, out var a);
                if (string.Equals(b, a, StringComparison.Ordinal)) continue;

                yield return new ParamDeltaPair
                {
                    Key = key,
                    Before = b,
                    After = a
                };

                emitted++;
                if (emitted >= maxPerElement) yield break;
            }
        }

        private static object? ComputeGeometryDelta(GeometrySignature before, GeometrySignature after)
        {
            const double tol = 1e-7;
            double? pointDistance = null;
            double? rotationDelta = null;
            double? curveStartDistance = null;
            double? curveEndDistance = null;
            double? curveLengthDelta = null;
            double? bboxCenterDistance = null;

            if (before.point != null && after.point != null)
                pointDistance = Distance(before.point, after.point);

            if (before.rotationRadians.HasValue && after.rotationRadians.HasValue)
                rotationDelta = after.rotationRadians.Value - before.rotationRadians.Value;

            if (before.curveStart != null && after.curveStart != null)
                curveStartDistance = Distance(before.curveStart, after.curveStart);

            if (before.curveEnd != null && after.curveEnd != null)
                curveEndDistance = Distance(before.curveEnd, after.curveEnd);

            if (before.curveLength.HasValue && after.curveLength.HasValue)
                curveLengthDelta = after.curveLength.Value - before.curveLength.Value;

            if (before.bboxMin != null && before.bboxMax != null && after.bboxMin != null && after.bboxMax != null)
            {
                var c0 = Midpoint(before.bboxMin, before.bboxMax);
                var c1 = Midpoint(after.bboxMin, after.bboxMax);
                bboxCenterDistance = Distance(c0, c1);
            }

            if ((pointDistance ?? 0) <= tol &&
                (rotationDelta.HasValue ? Math.Abs(rotationDelta.Value) : 0) <= tol &&
                (curveStartDistance ?? 0) <= tol &&
                (curveEndDistance ?? 0) <= tol &&
                (curveLengthDelta.HasValue ? Math.Abs(curveLengthDelta.Value) : 0) <= tol &&
                (bboxCenterDistance ?? 0) <= tol)
            {
                return null;
            }

            return new
            {
                pointDistance,
                rotationDeltaRadians = rotationDelta,
                curveStartDistance,
                curveEndDistance,
                curveLengthDelta,
                bboxCenterDistance
            };
        }

        private static GeometrySignature CaptureGeometrySignature(Element element)
        {
            var sig = new GeometrySignature();

            try
            {
                var loc = element.Location;
                if (loc is LocationPoint lp)
                {
                    sig.point = lp.Point;
                    sig.rotationRadians = lp.Rotation;
                }
                else if (loc is LocationCurve lc)
                {
                    var curve = lc.Curve;
                    if (curve != null)
                    {
                        sig.curveStart = curve.GetEndPoint(0);
                        sig.curveEnd = curve.GetEndPoint(1);
                        sig.curveLength = curve.Length;
                    }
                }
            }
            catch
            {
                // Ignore location failures.
            }

            try
            {
                var bb = element.get_BoundingBox(null);
                if (bb != null)
                {
                    sig.bboxMin = bb.Min;
                    sig.bboxMax = bb.Max;
                }
            }
            catch
            {
                // Ignore bbox failures.
            }

            return sig;
        }

        private static string? SafeGet(Func<string?> getter)
        {
            try { return getter(); } catch { return null; }
        }

        private static long? SafeGetTypeId(Element el)
        {
            try
            {
                var tid = el.GetTypeId();
                return tid == null ? (long?)null : ElementIdCompat.GetValue(tid);
            }
            catch
            {
                return null;
            }
        }

        private static string? ReadComparableParameterValue(Parameter p)
        {
            try
            {
                switch (p.StorageType)
                {
                    case StorageType.String:
                        return p.AsString();
                    case StorageType.Integer:
                        return p.AsInteger().ToString(CultureInfo.InvariantCulture);
                    case StorageType.Double:
                        return p.AsDouble().ToString("R", CultureInfo.InvariantCulture);
                    case StorageType.ElementId:
                        return ElementIdCompat.GetValue(p.AsElementId()).ToString(CultureInfo.InvariantCulture);
                    default:
                        break;
                }
            }
            catch
            {
                // Ignore raw read failure and try value string.
            }

            try
            {
                return p.AsValueString();
            }
            catch
            {
                return null;
            }
        }

        private static double Distance(XYZ a, XYZ b)
        {
            var dx = a.X - b.X;
            var dy = a.Y - b.Y;
            var dz = a.Z - b.Z;
            return Math.Sqrt(dx * dx + dy * dy + dz * dz);
        }

        private static XYZ Midpoint(XYZ a, XYZ b)
        {
            return new XYZ((a.X + b.X) * 0.5, (a.Y + b.Y) * 0.5, (a.Z + b.Z) * 0.5);
        }

        public void Dispose()
        {
            if (_disposed) return;
            _disposed = true;
            try { _app.Application.DocumentChanged -= OnDocumentChanged; } catch { }
        }
    }
}
