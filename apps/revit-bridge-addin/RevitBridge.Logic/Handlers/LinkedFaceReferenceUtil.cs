using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text.RegularExpressions;
using Autodesk.Revit.DB;
using RevitBridge.Common;

namespace RevitBridge.Logic.Handlers
{
    internal sealed class LinkedFaceReferenceResolution
    {
        public Reference FaceReference { get; set; } = null!;
        public XYZ PlacementPoint { get; set; } = XYZ.Zero;
        public XYZ ReferenceDirection { get; set; } = XYZ.BasisX;
        public XYZ FaceNormal { get; set; } = XYZ.BasisX;
        public string FaceFingerprint { get; set; } = string.Empty;
        public long LinkInstanceId { get; set; }
        public long LinkedElementId { get; set; }
        public string LinkedElementUniqueId { get; set; } = string.Empty;
        public double DistanceFt { get; set; }
    }

    /// <summary>
    /// Resolves an exact linked face through ReferenceIntersector. Unlike geometry returned by
    /// GeometryInstance.GetInstanceGeometry(), the returned host-document Reference is suitable
    /// for NewFamilyInstance(Reference, XYZ, XYZ, FamilySymbol).
    /// </summary>
    internal static class LinkedFaceReferenceUtil
    {
        private const double Epsilon = 1e-9;
        private const double DefaultSearchRadiusFt = 4.0;
        private const double DefaultMaximumResolvedDisplacementFt = 0.75;
        private const double DefaultMaximumVerticalDisplacementFt = 0.25;
        private const double DefaultAmbiguityToleranceFt = 0.01;

        internal static View3D? FindReferenceView(Document document, View? preferredView = null)
        {
            return FindReferenceViews(document, preferredView).FirstOrDefault();
        }

        internal static IReadOnlyList<View3D> FindReferenceViews(Document document, View? preferredView = null)
        {
            var views = new FilteredElementCollector(document)
                .OfClass(typeof(View3D))
                .Cast<View3D>()
                .Where(view => !view.IsTemplate && !view.IsSectionBoxActive)
                .OrderByDescending(view => string.Equals(view.Name, "{3D}", StringComparison.OrdinalIgnoreCase))
                .ThenByDescending(view => view.Name.IndexOf("coord", StringComparison.OrdinalIgnoreCase) >= 0)
                .ThenBy(view => ElementIdCompat.GetValue(view.Id))
                .ToList();
            if (preferredView is View3D preferred && !preferred.IsTemplate && !preferred.IsSectionBoxActive)
            {
                views.RemoveAll(view => view.Id == preferred.Id);
                views.Insert(0, preferred);
            }
            return views;
        }

        internal static bool TryResolve(
            Document document,
            View3D referenceView,
            RevitLinkInstance linkInstance,
            ElementId linkedElementId,
            XYZ targetPoint,
            XYZ? preferredReferenceDirection,
            out LinkedFaceReferenceResolution? resolution,
            out string error,
            double searchRadiusFt = DefaultSearchRadiusFt,
            double ambiguityToleranceFt = DefaultAmbiguityToleranceFt,
            double maximumResolvedDisplacementFt = DefaultMaximumResolvedDisplacementFt,
            double maximumVerticalDisplacementFt = DefaultMaximumVerticalDisplacementFt,
            bool requireVerticalFace = true,
            string? sourceStableReferencePattern = null,
            XYZ? preferredFaceSidePoint = null)
        {
            resolution = null;
            error = string.Empty;
            if (document == null || referenceView == null || referenceView.IsTemplate || linkInstance == null || linkedElementId == null ||
                linkedElementId == ElementId.InvalidElementId || targetPoint == null || !IsFinite(targetPoint) ||
                !IsFinite(searchRadiusFt) || searchRadiusFt <= 0 || !IsFinite(ambiguityToleranceFt) || ambiguityToleranceFt < 0 ||
                !IsFinite(maximumResolvedDisplacementFt) || maximumResolvedDisplacementFt <= 0 ||
                !IsFinite(maximumVerticalDisplacementFt) || maximumVerticalDisplacementFt < 0)
            {
                error = "linked_face_request_invalid";
                return false;
            }

            var linkDocument = linkInstance.GetLinkDocument();
            var linkedElement = linkDocument?.GetElement(linkedElementId);
            if (linkDocument == null || linkedElement == null)
            {
                error = "linked_face_element_unavailable";
                return false;
            }

            var directions = BuildSearchDirections(preferredReferenceDirection);
            var byStableReference = new Dictionary<string, Candidate>(StringComparer.Ordinal);
            var intersector = new ReferenceIntersector(referenceView)
            {
                FindReferencesInRevitLinks = true,
                TargetType = FindReferenceTarget.Face
            };

            foreach (var direction in directions)
            {
                var origin = targetPoint - direction.Multiply(searchRadiusFt);
                IList<ReferenceWithContext> hits;
                try { hits = intersector.Find(origin, direction); }
                catch { continue; }
                foreach (var hit in hits)
                {
                    if (hit == null || hit.Proximity < -Epsilon || hit.Proximity > (searchRadiusFt * 2.0) + Epsilon) continue;
                    var reference = hit.GetReference();
                    if (reference == null || reference.ElementId != linkInstance.Id || reference.LinkedElementId != linkedElementId) continue;
                    Reference referenceInLink;
                    PlanarFace? planarFace;
                    try
                    {
                        referenceInLink = reference.CreateReferenceInLink();
                        planarFace = linkedElement.GetGeometryObjectFromReference(referenceInLink) as PlanarFace;
                    }
                    catch { continue; }
                    if (planarFace == null) continue;

                    XYZ worldPoint;
                    try { worldPoint = reference.GlobalPoint; }
                    catch { worldPoint = origin + direction.Multiply(hit.Proximity); }
                    if (worldPoint == null || !IsFinite(worldPoint)) worldPoint = origin + direction.Multiply(hit.Proximity);
                    if (!IsFinite(worldPoint)) continue;

                    var transform = GetLinkTransform(linkInstance);
                    var worldNormal = transform.OfVector(planarFace.FaceNormal);
                    if (worldNormal == null || worldNormal.GetLength() <= Epsilon) continue;
                    worldNormal = worldNormal.Normalize();
                    if (requireVerticalFace && Math.Abs(worldNormal.Z) > 0.25) continue;
                    var referenceDirection = ProjectDirectionToFace(preferredReferenceDirection, worldNormal);
                    if (referenceDirection == null) continue;
                    var distance = worldPoint.DistanceTo(targetPoint);
                    if (!IsFinite(distance) || distance > maximumResolvedDisplacementFt + Epsilon || Math.Abs(worldPoint.Z - targetPoint.Z) > maximumVerticalDisplacementFt + Epsilon) continue;

                    string stable;
                    try { stable = reference.ConvertToStableRepresentation(document); }
                    catch { stable = $"{ElementIdCompat.GetValue(linkInstance.Id)}:{ElementIdCompat.GetValue(linkedElementId)}:{Round(worldPoint.X)}:{Round(worldPoint.Y)}:{Round(worldPoint.Z)}"; }
                    var fingerprint = BuildFaceFingerprint(linkedElement, transform, planarFace, worldNormal);
                    var candidate = new Candidate(reference, worldPoint, referenceDirection, worldNormal, fingerprint, distance, stable);
                    if (!byStableReference.TryGetValue(stable, out var existing) || candidate.DistanceFt < existing.DistanceFt)
                        byStableReference[stable] = candidate;
                }
            }

            var hasFaceSidePreference = preferredFaceSidePoint != null && IsFinite(preferredFaceSidePoint);
            double FaceSideDistance(Candidate candidate) => hasFaceSidePreference
                ? candidate.Point.DistanceTo(preferredFaceSidePoint)
                : 0.0;
            var ordered = byStableReference.Values
                .OrderBy(candidate => candidate.DistanceFt)
                .ThenBy(FaceSideDistance)
                .ThenBy(candidate => candidate.Fingerprint, StringComparer.Ordinal)
                .ThenBy(candidate => candidate.StableReference, StringComparer.Ordinal)
                .ToList();
            var symbolGeometryError = string.Empty;
            if (ordered.Count == 0)
            {
                ordered.AddRange(ResolveFromOriginalSymbolGeometry(document, linkInstance, linkedElement, targetPoint, preferredReferenceDirection,
                    maximumResolvedDisplacementFt, maximumVerticalDisplacementFt, requireVerticalFace, out symbolGeometryError));
                ordered = ordered.OrderBy(candidate => candidate.DistanceFt).ThenBy(FaceSideDistance).ThenBy(candidate => candidate.Fingerprint, StringComparer.Ordinal).ThenBy(candidate => candidate.StableReference, StringComparer.Ordinal).ToList();
            }
            var reboundError = string.Empty;
            if (ordered.Count == 0 && !string.IsNullOrWhiteSpace(sourceStableReferencePattern))
            {
                var rebound = TryResolveReboundStableReference(document, linkInstance, linkedElement, targetPoint, preferredReferenceDirection,
                    sourceStableReferencePattern!, maximumResolvedDisplacementFt, maximumVerticalDisplacementFt, requireVerticalFace, out reboundError);
                if (rebound != null) ordered.Add(rebound);
            }
            if (ordered.Count == 0)
            {
                error = string.Join("|", new[] { symbolGeometryError, reboundError }.Where(value => !string.IsNullOrWhiteSpace(value)));
                if (string.IsNullOrWhiteSpace(error)) error = "linked_face_reference_not_found";
                return false;
            }
            if (ordered.Count > 1 && Math.Abs(ordered[1].DistanceFt - ordered[0].DistanceFt) <= ambiguityToleranceFt &&
                !string.Equals(ordered[1].Fingerprint, ordered[0].Fingerprint, StringComparison.Ordinal) &&
                (!hasFaceSidePreference || Math.Abs(FaceSideDistance(ordered[1]) - FaceSideDistance(ordered[0])) <= ambiguityToleranceFt))
            {
                error = "linked_face_reference_ambiguous";
                return false;
            }

            var best = ordered[0];
            resolution = new LinkedFaceReferenceResolution
            {
                FaceReference = best.Reference,
                PlacementPoint = best.Point,
                ReferenceDirection = best.ReferenceDirection,
                FaceNormal = best.Normal,
                FaceFingerprint = best.Fingerprint,
                LinkInstanceId = ElementIdCompat.GetValue(linkInstance.Id),
                LinkedElementId = ElementIdCompat.GetValue(linkedElementId),
                LinkedElementUniqueId = linkedElement.UniqueId ?? string.Empty,
                DistanceFt = best.DistanceFt
            };
            return true;
        }

        private static IReadOnlyList<Candidate> ResolveFromOriginalSymbolGeometry(Document document, RevitLinkInstance linkInstance, Element linkedElement,
            XYZ targetPoint, XYZ? preferredReferenceDirection, double maximumResolvedDisplacementFt, double maximumVerticalDisplacementFt, bool requireVerticalFace, out string error,
            Reference? reboundReference = null)
        {
            error = string.Empty;
            var counts = new int[11];
            var metrics = new[] { double.PositiveInfinity, double.PositiveInfinity };
            var result = new Dictionary<string, Candidate>(StringComparer.Ordinal);
            try
            {
                var options = new Options { ComputeReferences = true, IncludeNonVisibleObjects = true, DetailLevel = ViewDetailLevel.Fine };
                var geometry = linkedElement.get_Geometry(options);
                if (geometry == null) return Array.Empty<Candidate>();
                CollectReferenceFaces(document, linkInstance, linkedElement, geometry, Transform.Identity, targetPoint, preferredReferenceDirection,
                    maximumResolvedDisplacementFt, maximumVerticalDisplacementFt, requireVerticalFace, result, counts, metrics, 0, reboundReference);
            }
            catch (Exception ex) { error = "linked_face_symbol_geometry_exception:" + ex.GetType().Name; }
            if (result.Count == 0 && string.IsNullOrWhiteSpace(error)) error = "linked_face_symbol_geometry_empty:o=" + counts[0] + ",i=" + counts[1] + ",p=" + counts[2] + ",r=" + counts[3] + ",proj=" + counts[6] + ",vert=" + counts[7] + ",dist=" + counts[8] + ",mind=" + Round(metrics[0]) + ",minz=" + Round(metrics[1]) + ",dir=" + counts[9] + ",fb=" + counts[10] + ",l=" + counts[4] + ",a=" + counts[5];
            return result.Values.ToList();
        }

        private static void CollectReferenceFaces(Document document, RevitLinkInstance linkInstance, Element linkedElement, GeometryElement geometry,
            Transform elementTransform, XYZ targetPoint, XYZ? preferredReferenceDirection, double maximumResolvedDisplacementFt,
            double maximumVerticalDisplacementFt, bool requireVerticalFace, IDictionary<string, Candidate> result, int[] counts, double[] metrics, int depth,
            Reference? reboundReference)
        {
            if (depth > 8) return;
            foreach (var geometryObject in geometry)
            {
                counts[0]++;
                if (geometryObject is GeometryInstance instance)
                {
                    counts[1]++;
                    GeometryElement? symbolGeometry = null;
                    try { symbolGeometry = instance.GetSymbolGeometry(); } catch { }
                    if (symbolGeometry != null)
                        CollectReferenceFaces(document, linkInstance, linkedElement, symbolGeometry, elementTransform.Multiply(instance.Transform), targetPoint,
                            preferredReferenceDirection, maximumResolvedDisplacementFt, maximumVerticalDisplacementFt, requireVerticalFace, result, counts, metrics, depth + 1, reboundReference);
                    continue;
                }
                if (!(geometryObject is Solid solid) || solid.Faces == null || solid.Faces.Size == 0) continue;
                foreach (Face rawFace in solid.Faces)
                {
                    if (!(rawFace is PlanarFace face) || face.Reference == null) continue;
                    counts[2]++;
                    counts[3]++;
                    try
                    {
                        var linkTransform = GetLinkTransform(linkInstance);
                        var combined = linkTransform.Multiply(elementTransform);
                        var localTarget = combined.Inverse.OfPoint(targetPoint);
                        var projection = face.Project(localTarget);
                        if (projection == null) continue;
                        counts[6]++;
                        var worldPoint = combined.OfPoint(projection.XYZPoint);
                        var worldNormal = combined.OfVector(face.FaceNormal);
                        if (worldNormal.GetLength() <= Epsilon) continue;
                        worldNormal = worldNormal.Normalize();
                        if (requireVerticalFace && Math.Abs(worldNormal.Z) > 0.25) continue;
                        counts[7]++;
                        var distance = worldPoint.DistanceTo(targetPoint);
                        metrics[0] = Math.Min(metrics[0], distance);
                        metrics[1] = Math.Min(metrics[1], Math.Abs(worldPoint.Z - targetPoint.Z));
                        if (!IsFinite(distance) || distance > maximumResolvedDisplacementFt + Epsilon || Math.Abs(worldPoint.Z - targetPoint.Z) > maximumVerticalDisplacementFt + Epsilon) continue;
                        counts[8]++;
                        var referenceDirection = ProjectDirectionToFace(preferredReferenceDirection, worldNormal);
                        if (referenceDirection == null) continue;
                        counts[9]++;
                        Reference? hostReference = null;
                        try { hostReference = face.Reference.CreateLinkReference(linkInstance); } catch { }
                        if (hostReference == null || hostReference.ElementId != linkInstance.Id) hostReference = reboundReference;
                        if (ReferenceEquals(hostReference, reboundReference) && reboundReference != null) counts[10]++;
                        if (hostReference == null || hostReference.ElementId != linkInstance.Id) continue;
                        counts[4]++;
                        var stable = hostReference.ConvertToStableRepresentation(document);
                        var worldOrigin = combined.OfPoint(face.Origin);
                        var fingerprint = BuildWorldFaceFingerprint(linkedElement, worldOrigin, worldNormal, face.Area);
                        var candidate = new Candidate(hostReference, worldPoint, referenceDirection, worldNormal, fingerprint, distance, stable);
                        if (!result.TryGetValue(stable, out var current) || candidate.DistanceFt < current.DistanceFt) result[stable] = candidate;
                        counts[5]++;
                    }
                    catch { }
                }
            }
        }

        private static string BuildWorldFaceFingerprint(Element linkedElement, XYZ worldOrigin, XYZ worldNormal, double area) => string.Join("|", new[]
        {
            linkedElement.UniqueId ?? string.Empty,
            Round(worldOrigin.X), Round(worldOrigin.Y), Round(worldOrigin.Z),
            Round(worldNormal.X), Round(worldNormal.Y), Round(worldNormal.Z),
            Round(area)
        });

        private static Candidate? TryResolveReboundStableReference(Document document, RevitLinkInstance linkInstance, Element linkedElement, XYZ targetPoint,
            XYZ? preferredReferenceDirection, string sourceStableReferencePattern, double maximumResolvedDisplacementFt, double maximumVerticalDisplacementFt, bool requireVerticalFace, out string error)
        {
            error = string.Empty;
            try
            {
                var linkedId = ElementIdCompat.GetValue(linkedElement.Id).ToString(CultureInfo.InvariantCulture);
                var linkedElementPattern = new Regex("(:RVTLINK:)-?\\d+", RegexOptions.CultureInvariant, TimeSpan.FromMilliseconds(100));
                if (!linkedElementPattern.IsMatch(sourceStableReferencePattern)) { error = "linked_face_rebind_pattern_missing"; return null; }
                var stable = linkedElementPattern.Replace(sourceStableReferencePattern, match => match.Groups[1].Value + linkedId);
                var reference = Reference.ParseFromStableRepresentation(document, stable);
                if (reference == null) { error = "linked_face_rebind_parse_null"; return null; }
                if (reference.ElementId != linkInstance.Id || reference.LinkedElementId != linkedElement.Id) { error = "linked_face_rebind_identity_mismatch"; return null; }
                var referenceInLink = reference.CreateReferenceInLink();
                var face = linkedElement.GetGeometryObjectFromReference(referenceInLink) as PlanarFace;
                if (face == null)
                {
                    var reboundCandidates = ResolveFromOriginalSymbolGeometry(document, linkInstance, linkedElement, targetPoint, preferredReferenceDirection,
                        maximumResolvedDisplacementFt, maximumVerticalDisplacementFt, requireVerticalFace, out var geometryError, reference);
                    var reboundCandidate = reboundCandidates.OrderBy(candidate => candidate.DistanceFt).ThenBy(candidate => candidate.Fingerprint, StringComparer.Ordinal).FirstOrDefault();
                    if (reboundCandidate != null) return reboundCandidate;
                    if (preferredReferenceDirection != null && IsFinite(preferredReferenceDirection) && preferredReferenceDirection.GetLength() > Epsilon)
                    {
                        var reboundDirection = preferredReferenceDirection.Normalize();
                        reboundDirection -= XYZ.BasisZ.Multiply(reboundDirection.DotProduct(XYZ.BasisZ));
                        if (reboundDirection.GetLength() > Epsilon)
                        {
                            reboundDirection = reboundDirection.Normalize();
                            var inferredVerticalNormal = XYZ.BasisZ.CrossProduct(reboundDirection).Normalize();
                            var reboundFingerprint = string.Join("|", new[] { linkedElement.UniqueId ?? string.Empty, stable, "stable_reference_plane_rebound" });
                            return new Candidate(reference, targetPoint, reboundDirection, inferredVerticalNormal, reboundFingerprint, 0.0, stable);
                        }
                    }
                    error = "linked_face_rebind_nonplanar_or_missing" + (string.IsNullOrWhiteSpace(geometryError) ? string.Empty : "|" + geometryError);
                    return null;
                }
                var transform = GetLinkTransform(linkInstance);
                var localTarget = transform.Inverse.OfPoint(targetPoint);
                var projection = face.Project(localTarget);
                if (projection == null) { error = "linked_face_rebind_projection_failed"; return null; }
                var worldPoint = transform.OfPoint(projection.XYZPoint);
                var worldNormal = transform.OfVector(face.FaceNormal);
                if (worldNormal.GetLength() <= Epsilon) { error = "linked_face_rebind_normal_invalid"; return null; }
                worldNormal = worldNormal.Normalize();
                if (requireVerticalFace && Math.Abs(worldNormal.Z) > 0.25) { error = "linked_face_rebind_face_not_vertical"; return null; }
                var distance = worldPoint.DistanceTo(targetPoint);
                if (!IsFinite(distance)) { error = "linked_face_rebind_distance_invalid"; return null; }
                if (distance > maximumResolvedDisplacementFt + Epsilon) { error = "linked_face_rebind_displacement_exceeded:" + Round(distance); return null; }
                if (Math.Abs(worldPoint.Z - targetPoint.Z) > maximumVerticalDisplacementFt + Epsilon) { error = "linked_face_rebind_vertical_displacement_exceeded:" + Round(Math.Abs(worldPoint.Z - targetPoint.Z)); return null; }
                var referenceDirection = ProjectDirectionToFace(preferredReferenceDirection, worldNormal);
                if (referenceDirection == null) { error = "linked_face_rebind_direction_invalid"; return null; }
                var fingerprint = BuildFaceFingerprint(linkedElement, transform, face, worldNormal);
                return new Candidate(reference, worldPoint, referenceDirection, worldNormal, fingerprint, distance, stable);
            }
            catch (Exception ex) { error = "linked_face_rebind_exception:" + ex.GetType().Name; return null; }
        }

        private static IReadOnlyList<XYZ> BuildSearchDirections(XYZ? preferred)
        {
            var result = new List<XYZ>();
            void Add(XYZ value)
            {
                if (value == null || !IsFinite(value) || value.GetLength() <= Epsilon) return;
                var normalized = value.Normalize();
                if (result.Any(existing => Math.Abs(existing.DotProduct(normalized)) > 1.0 - 1e-6)) return;
                result.Add(normalized);
                result.Add(-normalized);
            }
            Add(preferred ?? XYZ.Zero);
            Add(XYZ.BasisX);
            Add(XYZ.BasisY);
            Add(XYZ.BasisZ);
            Add(new XYZ(1, 1, 0));
            Add(new XYZ(1, -1, 0));
            return result;
        }

        private static XYZ? ProjectDirectionToFace(XYZ? preferred, XYZ normal)
        {
            var direction = preferred != null && IsFinite(preferred) && preferred.GetLength() > Epsilon ? preferred.Normalize() : XYZ.BasisZ.CrossProduct(normal);
            direction -= normal.Multiply(direction.DotProduct(normal));
            if (direction.GetLength() <= Epsilon) direction = XYZ.BasisX - normal.Multiply(XYZ.BasisX.DotProduct(normal));
            if (direction.GetLength() <= Epsilon) direction = XYZ.BasisY - normal.Multiply(XYZ.BasisY.DotProduct(normal));
            return direction.GetLength() > Epsilon ? direction.Normalize() : null;
        }

        private static string BuildFaceFingerprint(Element linkedElement, Transform transform, PlanarFace face, XYZ worldNormal)
        {
            var worldOrigin = transform.OfPoint(face.Origin);
            return string.Join("|", new[]
            {
                linkedElement.UniqueId ?? string.Empty,
                Round(worldOrigin.X), Round(worldOrigin.Y), Round(worldOrigin.Z),
                Round(worldNormal.X), Round(worldNormal.Y), Round(worldNormal.Z),
                Round(face.Area)
            });
        }

        private static Transform GetLinkTransform(RevitLinkInstance link)
        {
            try { return link.GetTotalTransform(); } catch { }
            try { return link.GetTransform(); } catch { }
            return Transform.Identity;
        }

        private static bool IsFinite(XYZ value) => value != null && IsFinite(value.X) && IsFinite(value.Y) && IsFinite(value.Z);
        private static bool IsFinite(double value) => !double.IsNaN(value) && !double.IsInfinity(value);
        private static string Round(double value) => Math.Round(value, 6, MidpointRounding.AwayFromZero).ToString("R", CultureInfo.InvariantCulture);

        private sealed class Candidate
        {
            public Candidate(Reference reference, XYZ point, XYZ referenceDirection, XYZ normal, string fingerprint, double distanceFt, string stableReference)
            {
                Reference = reference;
                Point = point;
                ReferenceDirection = referenceDirection;
                Normal = normal;
                Fingerprint = fingerprint;
                DistanceFt = distanceFt;
                StableReference = stableReference;
            }

            public Reference Reference { get; }
            public XYZ Point { get; }
            public XYZ ReferenceDirection { get; }
            public XYZ Normal { get; }
            public string Fingerprint { get; }
            public double DistanceFt { get; }
            public string StableReference { get; }
        }
    }
}
