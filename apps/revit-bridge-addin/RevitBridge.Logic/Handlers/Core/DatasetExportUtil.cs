using System;
using System.Collections.Generic;
using System.Linq;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Architecture;
using Autodesk.Revit.DB.Mechanical;
using RevitBridge.Common;
using RevitBridge.Logic.Handlers;
using RevitBridge.Logic.Handlers.MEP;

namespace RevitBridge.Logic.Handlers.Core
{
    internal static class DatasetExportUtil
    {
        private static readonly Dictionary<string, string[]> CuratedParameterAliases =
            new Dictionary<string, string[]>(StringComparer.OrdinalIgnoreCase)
            {
                ["mark"] = new[] { "Mark" },
                ["typeMark"] = new[] { "Type Mark" },
                ["comments"] = new[] { "Comments" },
                ["description"] = new[] { "Description" },
                ["manufacturer"] = new[] { "Manufacturer" },
                ["model"] = new[] { "Model" },
                ["keynote"] = new[] { "Keynote" },
                ["assemblyCode"] = new[] { "Assembly Code" },
                ["omniclassNumber"] = new[] { "OmniClass Number" },
                ["voltage"] = new[] { "Voltage" },
                ["amperage"] = new[] { "Amperage", "Current", "Current Rating" },
                ["apparentLoad"] = new[] { "Apparent Load" },
                ["connectedLoad"] = new[] { "Connected Load" },
                ["circuitNumber"] = new[] { "Circuit Number" },
                ["panel"] = new[] { "Panel" },
                ["loadClassification"] = new[] { "Load Classification" },
                ["numberOfPoles"] = new[] { "Number of Poles", "Poles" },
                ["frequency"] = new[] { "Frequency" },
                ["systemName"] = new[] { "System Name" },
                ["systemType"] = new[] { "System Type" },
                ["systemClassification"] = new[] { "System Classification", "System Classification Name" },
                ["cfm"] = new[] { "CFM", "Air Flow", "Flow" },
                ["airflow"] = new[] { "Air Flow", "Flow", "CFM" },
                ["staticPressure"] = new[] { "Static Pressure" },
                ["diameter"] = new[] { "Diameter", "Nominal Diameter", "Connector Diameter" },
                ["width"] = new[] { "Width", "Connector Width" },
                ["height"] = new[] { "Height", "Connector Height" },
                ["depth"] = new[] { "Depth" },
                ["mountingHeight"] = new[] { "Mounting Height", "Sill Height", "Head Height" },
                ["candela"] = new[] { "Candela" },
                ["wattage"] = new[] { "Wattage", "Power" },
                ["lumenOutput"] = new[] { "Lumen Output", "Lumens", "Luminous Flux" }
            };

        internal static string CreateSourceScopedId(Element element, RevitLinkInstance? linkInstance)
        {
            var elementId = ElementIdCompat.GetValue(element?.Id);
            if (elementId <= 0) return "";
            return CreateScopedId(elementId, linkInstance) ?? "";
        }

        internal static string? CreateScopedId(long? elementId, RevitLinkInstance? linkInstance)
        {
            if (!elementId.HasValue || elementId.Value <= 0) return null;
            if (linkInstance == null) return $"host:{elementId.Value}";

            var linkInstanceId = ElementIdCompat.GetValue(linkInstance.Id);
            return linkInstanceId > 0
                ? $"link:{linkInstanceId}:{elementId.Value}"
                : $"linked:{elementId.Value}";
        }

        internal static XYZ? TryGetElementPointInHostCoordinates(Element element, RevitLinkInstance? linkInstance)
        {
            var point = HostedPlacementUtil.TryGetElementPoint(element);
            if (point == null) return null;
            return TransformPointToHost(linkInstance, point);
        }

        internal static BoundingBoxXYZ? TryGetBoundingBoxInHostCoordinates(
            Element element,
            View? sourceView,
            RevitLinkInstance? linkInstance)
        {
            BoundingBoxXYZ? bbox = null;
            try { bbox = element.get_BoundingBox(sourceView) ?? element.get_BoundingBox(null); } catch { bbox = null; }
            if (bbox == null) return null;

            var corners = GetBoundingBoxCorners(bbox)
                .Select(point => TransformPointToHost(linkInstance, point))
                .ToList();
            if (corners.Count == 0) return null;

            var minX = corners.Min(x => x.X);
            var minY = corners.Min(x => x.Y);
            var minZ = corners.Min(x => x.Z);
            var maxX = corners.Max(x => x.X);
            var maxY = corners.Max(x => x.Y);
            var maxZ = corners.Max(x => x.Z);

            try
            {
                return new BoundingBoxXYZ
                {
                    Min = new XYZ(minX, minY, minZ),
                    Max = new XYZ(maxX, maxY, maxZ),
                    Transform = Transform.Identity
                };
            }
            catch
            {
                var hostBBox = new BoundingBoxXYZ();
                hostBBox.Min = new XYZ(minX, minY, minZ);
                hostBBox.Max = new XYZ(maxX, maxY, maxZ);
                hostBBox.Transform = Transform.Identity;
                return hostBBox;
            }
        }

        internal static XYZ? GetBoundingBoxCenter(BoundingBoxXYZ? bbox)
        {
            if (bbox == null) return null;
            try { return (bbox.Min + bbox.Max) * 0.5; } catch { return null; }
        }

        internal static Dictionary<string, object?> BuildCommonElementPayload(
            Document hostDocument,
            Element element,
            RevitLinkInstance? linkInstance = null,
            SpatialElement? associatedSpatial = null,
            XYZ? hostPointOverride = null,
            BoundingBoxXYZ? hostBoundingBoxOverride = null)
        {
            var sourceDocument = linkInstance?.GetLinkDocument() ?? hostDocument;
            HostedPlacementUtil.TryGetTypeInfo(sourceDocument, element, out var typeId, out var typeName, out var familyName);

            var point = hostPointOverride ?? TryGetElementPointInHostCoordinates(element, linkInstance);
            var bbox = hostBoundingBoxOverride ?? TryGetBoundingBoxInHostCoordinates(element, null, linkInstance);
            var bboxCenter = GetBoundingBoxCenter(bbox);
            var center = point ?? bboxCenter;

            var sourceScopedId = CreateSourceScopedId(element, linkInstance);
            var source = BuildSourcePayload(hostDocument, sourceDocument, element, linkInstance, sourceScopedId);
            var host = BuildHostPayload(element, sourceDocument, linkInstance);
            var hostingSurface = BuildHostingSurfacePayload(hostDocument, sourceDocument, element, linkInstance);
            if (host == null)
            {
                host = BuildHostPayloadFromHostingSurface(hostingSurface, sourceDocument);
            }
            var room = BuildSpatialPayload(SpatialIntentUtils.GetRoom(sourceDocument, element));
            var space = BuildSpatialPayload(GetSourceSpace(element));
            SpatialElement? effectiveAssociatedSpatial = associatedSpatial;
            if (effectiveAssociatedSpatial == null)
            {
                effectiveAssociatedSpatial = SpatialIntentUtils.GetRoom(sourceDocument, element) as SpatialElement
                    ?? GetSourceSpace(element);
            }
            var associatedSpatialPayload = BuildSpatialPayload(effectiveAssociatedSpatial);
            var systemPayload = BuildSystemPayload(element, linkInstance);
            var connectors = BuildConnectorSummary(element, linkInstance);
            var parameters = BuildCuratedParameters(sourceDocument, element);
            var parameterGroups = BuildParameterGroups(parameters);
            var hostScopedId = ResolveHostScopedId(element, linkInstance, host, hostingSurface);

            var hostPayloadId = TryReadLong(host, "id");
            var hostPayloadScopedId = TryReadString(host, "scopedId");
            var hostPayloadCategory = TryReadString(host, "category");
            var hostPayloadBuiltInCategory = TryReadString(host, "builtInCategory");
            var hostPayloadName = TryReadString(host, "name");
            var hostPayloadUniqueId = TryReadString(host, "uniqueId");
            var hostElementIdFromSurface = TryReadLong(hostingSurface, "hostElementId");
            var hostElementScopedId = TryReadString(hostingSurface, "hostElementScopedId");
            var hostElementCategoryFromSurface = TryReadString(hostingSurface, "hostElementCategory");
            var hostElementBuiltInCategoryFromSurface = TryReadString(hostingSurface, "hostElementBuiltInCategory");
            var hostElementNameFromSurface = TryReadString(hostingSurface, "hostElementName");
            var hostElementUniqueIdFromSurface = TryReadString(hostingSurface, "hostElementUniqueId");
            var hostLinkedElementId = TryReadLong(hostingSurface, "linkedElementId");
            var hostLinkedElementScopedId = TryReadString(hostingSurface, "linkedElementScopedId");
            var hostLinkedElementCategory = TryReadString(hostingSurface, "linkedElementCategory");
            var hostLinkedElementBuiltInCategory = TryReadString(hostingSurface, "linkedElementBuiltInCategory");
            var hostLinkedElementName = TryReadString(hostingSurface, "linkedElementName");
            var hostLinkedElementUniqueId = TryReadString(hostingSurface, "linkedElementUniqueId");
            var hostPayloadIdCandidate = hostPayloadId.HasValue && hostPayloadId.Value > 0 ? hostPayloadId : null;
            var hostElementIdFromSurfaceCandidate = hostElementIdFromSurface.HasValue && hostElementIdFromSurface.Value > 0 ? hostElementIdFromSurface : null;

            var hostElement = (element as FamilyInstance)?.Host;
            var hostId = hostElement != null
                ? ElementIdCompat.GetValue(hostElement.Id)
                : hostPayloadIdCandidate
                  ?? hostElementIdFromSurfaceCandidate
                  ?? 0L;
            var hostCategory = hostElement?.Category?.Name
                ?? hostPayloadCategory
                ?? hostElementCategoryFromSurface
                ?? hostLinkedElementCategory;
            var hostBuiltInCategory = hostElement?.Category?.BuiltInCategory.ToString()
                ?? hostPayloadBuiltInCategory
                ?? hostElementBuiltInCategoryFromSurface
                ?? hostLinkedElementBuiltInCategory;
            var hostLinkInstanceId = TryReadLong(host, "linkInstanceId") ?? TryReadLong(hostingSurface, "linkInstanceId");
            var hostLinkInstanceName = TryReadString(host, "linkInstanceName") ?? TryReadString(hostingSurface, "linkInstanceName");
            var hostLinkInstanceScopedId = TryReadString(host, "linkInstanceScopedId")
                ?? (hostLinkInstanceId.HasValue ? CreateScopedId(hostLinkInstanceId.Value, linkInstance) : null);
            var hostPlacementSupportedFromHostPayload = TryReadBool(host, "supportsPlacementHost");
            var hostPlacementSupported = hostElement != null
                ? (bool?)HostedPlacementUtil.IsSupportedPlacementHost(hostElement)
                : hostPlacementSupportedFromHostPayload
                  ?? InferHostingSurfacePlacementSupport(hostingSurface);
            var hostIdSource = hostElement != null
                ? "familyInstance.Host"
                : hostPayloadIdCandidate.HasValue
                    ? "host.id"
                    : hostElementIdFromSurfaceCandidate.HasValue
                        ? "hostingSurface.hostElementId"
                        : null;
            var hostScopedIdSource = ResolveHostScopedIdSource(
                hostScopedId,
                hostLinkedElementScopedId,
                hostElementScopedId,
                hostPayloadScopedId,
                hostElement != null);
            var hostCategorySource = hostElement?.Category != null
                ? "familyInstance.Host.Category"
                : !string.IsNullOrWhiteSpace(hostPayloadCategory)
                    ? "host.category"
                    : !string.IsNullOrWhiteSpace(hostElementCategoryFromSurface)
                        ? "hostingSurface.hostElementCategory"
                        : !string.IsNullOrWhiteSpace(hostLinkedElementCategory)
                            ? "hostingSurface.linkedElementCategory"
                            : null;
            var hostPlacementSupportedSource = hostElement != null
                ? "familyInstance.Host"
                : hostPlacementSupportedFromHostPayload.HasValue
                    ? "host.supportsPlacementHost"
                    : hostPlacementSupported.HasValue
                        ? "hostingSurface.surfaceType(inferred)"
                        : null;
            var hostResolvedId = hostLinkedElementId
                ?? (hostId > 0 ? hostId : (long?)null)
                ?? hostElementIdFromSurfaceCandidate
                ?? hostPayloadIdCandidate;
            var hostResolvedScopedId = hostLinkedElementScopedId
                ?? hostScopedId
                ?? hostElementScopedId
                ?? hostPayloadScopedId;
            var hostResolvedCategory = hostLinkedElementCategory
                ?? hostCategory
                ?? hostElementCategoryFromSurface
                ?? hostPayloadCategory;
            var hostResolvedBuiltInCategory = hostLinkedElementBuiltInCategory
                ?? hostBuiltInCategory
                ?? hostElementBuiltInCategoryFromSurface
                ?? hostPayloadBuiltInCategory;
            var hostResolvedName = hostLinkedElementName
                ?? hostElementNameFromSurface
                ?? hostPayloadName;
            var hostResolvedUniqueId = hostLinkedElementUniqueId
                ?? hostElementUniqueIdFromSurface
                ?? hostPayloadUniqueId;
            var hostResolvedSource = !string.IsNullOrWhiteSpace(hostLinkedElementScopedId) || hostLinkedElementId.HasValue
                ? "hostingSurface.linkedElement"
                : !string.IsNullOrWhiteSpace(hostElementScopedId) || hostElementIdFromSurfaceCandidate.HasValue
                    ? "hostingSurface.hostElement"
                    : !string.IsNullOrWhiteSpace(hostPayloadScopedId) || hostPayloadIdCandidate.HasValue
                        ? "host"
                        : hostElement != null
                            ? "familyInstance.Host"
                            : null;

            EnrichHostPayloadWithResolvedHost(
                host,
                hostScopedId,
                hostScopedIdSource,
                hostResolvedId,
                hostResolvedScopedId,
                hostResolvedCategory,
                hostResolvedBuiltInCategory,
                hostResolvedName,
                hostResolvedUniqueId,
                hostResolvedSource,
                hostLinkedElementId,
                hostLinkedElementScopedId,
                hostLinkedElementCategory,
                hostLinkedElementBuiltInCategory,
                hostLinkedElementName,
                hostLinkedElementUniqueId);

            return new Dictionary<string, object?>
            {
                ["id"] = ElementIdCompat.GetValue(element.Id),
                ["uniqueId"] = element.UniqueId,
                ["sourceScopedId"] = sourceScopedId,
                ["category"] = element.Category?.Name,
                ["builtInCategory"] = element.Category?.BuiltInCategory.ToString(),
                ["categoryType"] = element.Category?.CategoryType.ToString(),
                ["name"] = element.Name,
                ["familyName"] = familyName,
                ["typeId"] = typeId,
                ["typeName"] = typeName,
                ["levelName"] = SpatialIntentUtils.GetLevelName(sourceDocument, element),
                ["hostId"] = hostId > 0 ? hostId : (long?)null,
                ["hostIdSource"] = hostIdSource,
                ["hostScopedId"] = hostScopedId,
                ["hostScopedIdSource"] = hostScopedIdSource,
                ["hostCategory"] = hostCategory,
                ["hostBuiltInCategory"] = hostBuiltInCategory,
                ["hostCategorySource"] = hostCategorySource,
                ["hostPlacementSupported"] = hostPlacementSupported,
                ["hostPlacementSupportedSource"] = hostPlacementSupportedSource,
                ["hostLinkInstanceId"] = hostLinkInstanceId,
                ["hostLinkInstanceScopedId"] = hostLinkInstanceScopedId,
                ["hostLinkInstanceName"] = hostLinkInstanceName,
                ["hostLinkedElementId"] = hostLinkedElementId,
                ["hostLinkedElementScopedId"] = hostLinkedElementScopedId,
                ["hostLinkedElementCategory"] = hostLinkedElementCategory,
                ["hostLinkedElementBuiltInCategory"] = hostLinkedElementBuiltInCategory,
                ["hostLinkedElementName"] = hostLinkedElementName,
                ["hostLinkedElementUniqueId"] = hostLinkedElementUniqueId,
                ["hostResolvedId"] = hostResolvedId,
                ["hostResolvedScopedId"] = hostResolvedScopedId,
                ["hostResolvedCategory"] = hostResolvedCategory,
                ["hostResolvedBuiltInCategory"] = hostResolvedBuiltInCategory,
                ["hostResolvedName"] = hostResolvedName,
                ["hostResolvedUniqueId"] = hostResolvedUniqueId,
                ["hostResolvedSource"] = hostResolvedSource,
                ["point"] = HostedPlacementUtil.BuildVector(point),
                ["center"] = HostedPlacementUtil.BuildVector(center),
                ["bboxCenter"] = HostedPlacementUtil.BuildVector(bboxCenter),
                ["bbox"] = bbox == null ? null : new
                {
                    min = HostedPlacementUtil.BuildVector(bbox.Min),
                    max = HostedPlacementUtil.BuildVector(bbox.Max)
                },
                ["room"] = room,
                ["space"] = space,
                ["associatedSpatial"] = associatedSpatialPayload,
                ["orientation"] = HostedPlacementUtil.BuildOrientationPayload(element, linkInstance),
                ["source"] = source,
                ["host"] = host,
                ["hostingSurface"] = hostingSurface,
                ["systemName"] = systemPayload.TryGetValue("systemName", out var systemName) ? systemName : null,
                ["systemClassification"] = systemPayload.TryGetValue("systemClassification", out var systemClassification) ? systemClassification : null,
                ["system"] = systemPayload,
                ["connectorCount"] = connectors.TryGetValue("count", out var connectorCount) ? connectorCount : 0,
                ["connectorsSummary"] = connectors,
                ["parameters"] = parameters,
                ["parameterGroups"] = parameterGroups
            };
        }

        internal static Dictionary<string, object?> BuildSourcePayload(
            Document hostDocument,
            Document sourceDocument,
            Element element,
            RevitLinkInstance? linkInstance,
            string sourceScopedId)
        {
            var payload = new Dictionary<string, object?>
            {
                ["scope"] = linkInstance == null ? "host" : "linked",
                ["sourceScopedId"] = sourceScopedId,
                ["elementId"] = ElementIdCompat.GetValue(element.Id),
                ["elementUniqueId"] = element.UniqueId,
                ["hostDocumentTitle"] = hostDocument.Title,
                ["hostDocumentPath"] = SafeDocumentPath(hostDocument),
                ["sourceDocumentTitle"] = sourceDocument.Title,
                ["sourceDocumentPath"] = SafeDocumentPath(sourceDocument)
            };

            if (linkInstance != null)
            {
                payload["linkInstanceId"] = ElementIdCompat.GetValue(linkInstance.Id);
                payload["linkInstanceName"] = linkInstance.Name;
                payload["transform"] = BuildTransformPayload(GetHostTransform(linkInstance));
            }

            return payload;
        }

        internal static Dictionary<string, object?>? BuildHostPayload(
            Element element,
            Document sourceDocument,
            RevitLinkInstance? linkInstance)
        {
            var host = (element as FamilyInstance)?.Host;
            if (host == null) return null;

            var hostPoint = TryGetElementPointInHostCoordinates(host, linkInstance);
            var hostBoundingBox = TryGetBoundingBoxInHostCoordinates(host, null, linkInstance);
            var hostCenter = hostPoint ?? GetBoundingBoxCenter(hostBoundingBox);
            var hostSurfaceType = ResolveHostingSurfaceTypeWithSource(host);

            var payload = new Dictionary<string, object?>
            {
                ["id"] = ElementIdCompat.GetValue(host.Id),
                ["uniqueId"] = host.UniqueId,
                ["scopedId"] = CreateScopedId(ElementIdCompat.GetValue(host.Id), linkInstance),
                ["sourceScopedId"] = CreateScopedId(ElementIdCompat.GetValue(host.Id), linkInstance),
                ["mode"] = host is RevitLinkInstance ? "link_host" : "host_element",
                ["surfaceType"] = hostSurfaceType.surfaceType,
                ["surfaceTypeSource"] = hostSurfaceType.source,
                ["provenance"] = "familyInstance.Host",
                ["category"] = host.Category?.Name,
                ["builtInCategory"] = host.Category?.BuiltInCategory.ToString(),
                ["name"] = host.Name,
                ["point"] = HostedPlacementUtil.BuildVector(hostPoint),
                ["center"] = HostedPlacementUtil.BuildVector(hostCenter),
                ["bbox"] = hostBoundingBox == null ? null : new
                {
                    min = HostedPlacementUtil.BuildVector(hostBoundingBox.Min),
                    max = HostedPlacementUtil.BuildVector(hostBoundingBox.Max)
                },
                ["supportsPlacementHost"] = HostedPlacementUtil.IsSupportedPlacementHost(host),
                ["sourceDocumentTitle"] = sourceDocument.Title,
                ["sourceDocumentPath"] = SafeDocumentPath(sourceDocument)
            };

            if (host is RevitLinkInstance linkHost)
            {
                payload["linkInstanceId"] = ElementIdCompat.GetValue(linkHost.Id);
                payload["linkInstanceScopedId"] = CreateScopedId(ElementIdCompat.GetValue(linkHost.Id), linkInstance);
                payload["linkInstanceName"] = linkHost.Name;
                payload["linkDocumentTitle"] = linkHost.GetLinkDocument()?.Title;
                payload["linkDocumentPath"] = SafeDocumentPath(linkHost.GetLinkDocument());
            }

            return payload;
        }

        internal static Dictionary<string, object?>? BuildHostingSurfacePayload(
            Document hostDocument,
            Document sourceDocument,
            Element element,
            RevitLinkInstance? linkInstance)
        {
            if (element is not FamilyInstance familyInstance) return null;

            Element? directHost = null;
            try { directHost = familyInstance.Host; } catch { directHost = null; }

            Reference? hostFace = null;
            try { hostFace = familyInstance.HostFace; } catch { hostFace = null; }
            var hostFaceElement = TryResolveHostFaceElement(hostDocument, sourceDocument, hostFace, out var hostFaceDocument);
            var surfaceElement = hostFaceElement ?? directHost;
            if (surfaceElement == null) return null;

            var surfaceDocument = hostFaceElement != null ? (hostFaceDocument ?? sourceDocument) : sourceDocument;
            var surfacePoint = TryGetElementPointInHostCoordinates(surfaceElement, linkInstance);
            var surfaceBbox = TryGetBoundingBoxInHostCoordinates(surfaceElement, null, linkInstance);
            var surfaceCenter = surfacePoint ?? GetBoundingBoxCenter(surfaceBbox);
            var mode = ResolveHostingMode(surfaceElement, hostFace, linkInstance);
            var surfaceTypeInfo = ResolveHostingSurfaceTypeWithSource(surfaceElement);
            var surfaceType = surfaceTypeInfo.surfaceType;
            var surfaceTypeSource = surfaceTypeInfo.source;
            if (string.Equals(surfaceType, "unknown", StringComparison.OrdinalIgnoreCase))
            {
                var directHostSurfaceTypeInfo = ResolveHostingSurfaceTypeWithSource(directHost);
                if (!string.Equals(directHostSurfaceTypeInfo.surfaceType, "unknown", StringComparison.OrdinalIgnoreCase))
                {
                    surfaceType = directHostSurfaceTypeInfo.surfaceType;
                    surfaceTypeSource = $"directHost:{directHostSurfaceTypeInfo.source}";
                }
            }

            var payload = new Dictionary<string, object?>
            {
                ["mode"] = mode,
                ["surfaceType"] = surfaceType,
                ["surfaceTypeSource"] = surfaceTypeSource,
                ["isFaceHosted"] = hostFace != null,
                ["hasDirectHost"] = directHost != null,
                ["hostElementId"] = ElementIdCompat.GetValue(surfaceElement.Id),
                ["hostElementScopedId"] = CreateScopedId(ElementIdCompat.GetValue(surfaceElement.Id), linkInstance),
                ["hostElementCategory"] = surfaceElement.Category?.Name,
                ["hostElementBuiltInCategory"] = surfaceElement.Category?.BuiltInCategory.ToString(),
                ["hostElementName"] = surfaceElement.Name,
                ["hostElementUniqueId"] = surfaceElement.UniqueId,
                ["hostElementPoint"] = HostedPlacementUtil.BuildVector(surfacePoint),
                ["hostElementCenter"] = HostedPlacementUtil.BuildVector(surfaceCenter),
                ["hostElementBbox"] = surfaceBbox == null ? null : new
                {
                    min = HostedPlacementUtil.BuildVector(surfaceBbox.Min),
                    max = HostedPlacementUtil.BuildVector(surfaceBbox.Max)
                },
                ["sourceDocumentTitle"] = sourceDocument.Title,
                ["sourceDocumentPath"] = SafeDocumentPath(sourceDocument),
                ["hostElementSourceDocumentTitle"] = surfaceDocument.Title,
                ["hostElementSourceDocumentPath"] = SafeDocumentPath(surfaceDocument)
            };

            if (directHost != null)
            {
                var directHostSurfaceTypeInfo = ResolveHostingSurfaceTypeWithSource(directHost);
                payload["directHostElementId"] = ElementIdCompat.GetValue(directHost.Id);
                payload["directHostElementScopedId"] = CreateScopedId(ElementIdCompat.GetValue(directHost.Id), linkInstance);
                payload["directHostElementCategory"] = directHost.Category?.Name;
                payload["directHostElementBuiltInCategory"] = directHost.Category?.BuiltInCategory.ToString();
                payload["directHostElementName"] = directHost.Name;
                payload["directHostElementUniqueId"] = directHost.UniqueId;
                payload["directHostSurfaceType"] = directHostSurfaceTypeInfo.surfaceType;
                payload["directHostSurfaceTypeSource"] = directHostSurfaceTypeInfo.source;
                payload["directHostSupportsPlacement"] = HostedPlacementUtil.IsSupportedPlacementHost(directHost);
            }

            RevitLinkInstance? linkHost = surfaceElement as RevitLinkInstance ?? directHost as RevitLinkInstance;
            if (linkHost != null)
            {
                payload["linkInstanceId"] = ElementIdCompat.GetValue(linkHost.Id);
                payload["linkInstanceScopedId"] = CreateScopedId(ElementIdCompat.GetValue(linkHost.Id), linkInstance);
                payload["linkInstanceName"] = linkHost.Name;
                payload["linkDocumentTitle"] = linkHost.GetLinkDocument()?.Title;
                payload["linkDocumentPath"] = SafeDocumentPath(linkHost.GetLinkDocument());
            }

            if (hostFace != null)
            {
                payload["hostFaceElementId"] = ElementIdCompat.GetValue(hostFace.ElementId);
                payload["hostFaceElementScopedId"] = CreateScopedId(ElementIdCompat.GetValue(hostFace.ElementId), linkInstance);
                payload["hostFaceLinkedElementId"] = hostFace.LinkedElementId != null && hostFace.LinkedElementId != ElementId.InvalidElementId
                    ? ElementIdCompat.GetValue(hostFace.LinkedElementId)
                    : (long?)null;

                string? stableReference = null;
                try { stableReference = hostFace.ConvertToStableRepresentation(sourceDocument); } catch { stableReference = null; }
                if (string.IsNullOrWhiteSpace(stableReference))
                {
                    try { stableReference = hostFace.ConvertToStableRepresentation(hostDocument); } catch { stableReference = null; }
                }
                payload["hostFaceStableReference"] = stableReference;
            }

            if (linkHost != null &&
                hostFace?.LinkedElementId != null &&
                hostFace.LinkedElementId != ElementId.InvalidElementId)
            {
                var linkedId = ElementIdCompat.GetValue(hostFace.LinkedElementId);
                payload["linkedElementId"] = linkedId;
                payload["linkedElementScopedId"] = CreateScopedId(linkedId, linkHost);

                try
                {
                    var linkedElement = linkHost.GetLinkDocument()?.GetElement(hostFace.LinkedElementId);
                    if (linkedElement != null)
                    {
                        var linkedElementSurfaceTypeInfo = ResolveHostingSurfaceTypeWithSource(linkedElement);
                        payload["linkedElementUniqueId"] = linkedElement.UniqueId;
                        payload["linkedElementCategory"] = linkedElement.Category?.Name;
                        payload["linkedElementBuiltInCategory"] = linkedElement.Category?.BuiltInCategory.ToString();
                        payload["linkedElementName"] = linkedElement.Name;
                        payload["linkedElementSurfaceType"] = linkedElementSurfaceTypeInfo.surfaceType;
                        payload["linkedElementSurfaceTypeSource"] = linkedElementSurfaceTypeInfo.source;
                    }
                }
                catch { }
            }

            if (hostFaceElement == null && directHost != null)
            {
                payload["hostElementDerivedFrom"] = "direct_host";
            }
            else if (hostFaceElement != null)
            {
                payload["hostElementDerivedFrom"] = "host_face";
            }

            if (surfaceElement is RevitLinkInstance)
            {
                payload["hostIsLinkInstance"] = true;
            }
            else
            {
                payload["hostIsLinkInstance"] = false;
            }

            if (hostFace == null && directHost == null)
            {
                return null;
            }

            var familyPlacementType = TryReadFamilyPlacementType(familyInstance);
            if (!string.IsNullOrWhiteSpace(familyPlacementType))
            {
                payload["familyPlacementType"] = familyPlacementType;
            }

            if (hostFace != null && surfaceElement is not RevitLinkInstance)
            {
                payload["hostFaceSupportsPlacement"] = HostedPlacementUtil.IsSupportedPlacementHost(surfaceElement);
            }

            if (hostFaceElement == null && hostFace != null)
            {
                payload["hostFaceResolution"] = "unresolved";
            }
            else if (hostFace != null)
            {
                payload["hostFaceResolution"] = "resolved";
            }

            if (surfaceElement is RevitLinkInstance && hostFace == null)
            {
                payload["hostingContext"] = "linked_host";
            }
            else if (hostFace != null)
            {
                payload["hostingContext"] = "face";
            }
            else
            {
                payload["hostingContext"] = "direct_host";
            }

            if (directHost == null && hostFaceElement != null)
            {
                payload["directHostElementId"] = null;
                payload["directHostElementScopedId"] = null;
                payload["directHostElementCategory"] = null;
                payload["directHostElementBuiltInCategory"] = null;
                payload["directHostElementName"] = null;
                payload["directHostElementUniqueId"] = null;
                payload["directHostSurfaceType"] = null;
                payload["directHostSurfaceTypeSource"] = null;
                payload["directHostSupportsPlacement"] = null;
            }

            if (linkHost == null)
            {
                payload["linkInstanceId"] = null;
                payload["linkInstanceScopedId"] = null;
                payload["linkInstanceName"] = null;
                payload["linkDocumentTitle"] = null;
                payload["linkDocumentPath"] = null;
            }

            if (hostFace == null)
            {
                payload["hostFaceElementId"] = null;
                payload["hostFaceElementScopedId"] = null;
                payload["hostFaceLinkedElementId"] = null;
                payload["hostFaceStableReference"] = null;
            }

            if (!payload.ContainsKey("linkedElementId"))
            {
                payload["linkedElementId"] = null;
                payload["linkedElementScopedId"] = null;
                payload["linkedElementUniqueId"] = null;
                payload["linkedElementCategory"] = null;
                payload["linkedElementBuiltInCategory"] = null;
                payload["linkedElementName"] = null;
                payload["linkedElementSurfaceType"] = null;
                payload["linkedElementSurfaceTypeSource"] = null;
            }

            if (!payload.ContainsKey("hostFaceResolution"))
            {
                payload["hostFaceResolution"] = hostFace == null ? "none" : "resolved";
            }

            if (!payload.ContainsKey("familyPlacementType"))
            {
                payload["familyPlacementType"] = null;
            }

            if (!payload.ContainsKey("hostFaceSupportsPlacement"))
            {
                payload["hostFaceSupportsPlacement"] = null;
            }

            if (!payload.ContainsKey("hostingContext"))
            {
                payload["hostingContext"] = "direct_host";
            }

            if (!payload.ContainsKey("hostElementDerivedFrom"))
            {
                payload["hostElementDerivedFrom"] = "direct_host";
            }

            if (!payload.ContainsKey("hostIsLinkInstance"))
            {
                payload["hostIsLinkInstance"] = surfaceElement is RevitLinkInstance;
            }

            return payload;
        }

        internal static Dictionary<string, object?> BuildSystemPayload(Element element, RevitLinkInstance? linkInstance)
        {
            var candidates = MepSystemUtil.GetSystemTextCandidates(element);
            var preferred = MepSystemUtil.TryGetSystemName(element)
                ?? candidates.FirstOrDefault(x => !string.IsNullOrWhiteSpace(x));
            var classification = InferSystemClassification(candidates);

            return new Dictionary<string, object?>
            {
                ["systemName"] = preferred,
                ["systemClassification"] = classification,
                ["candidates"] = candidates,
                ["connectedElementScopedIds"] = MepSystemUtil.GetConnectedOwnerElementIds(element)
                    .Select(id => CreateScopedId(ElementIdCompat.GetValue(id), linkInstance))
                    .Where(id => !string.IsNullOrWhiteSpace(id))
                    .Distinct(StringComparer.OrdinalIgnoreCase)
                    .ToList()
            };
        }

        internal static Dictionary<string, object?> BuildConnectorSummary(Element element, RevitLinkInstance? linkInstance)
        {
            var shapes = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            var domains = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            var connectedScopedIds = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            var sampleConnectors = new List<object>();
            var count = 0;

            foreach (var connector in MepSystemUtil.GetConnectors(element))
            {
                if (connector == null) continue;
                count++;
                try { shapes.Add(connector.Shape.ToString()); } catch { }
                try { domains.Add(connector.Domain.ToString()); } catch { }

                try
                {
                    var refs = connector.AllRefs;
                    if (refs != null)
                    {
                        foreach (Connector other in refs)
                        {
                            try
                            {
                                var owner = other?.Owner;
                                if (owner == null || owner.Id == null || owner.Id == element.Id) continue;
                                var scopedId = CreateScopedId(ElementIdCompat.GetValue(owner.Id), linkInstance);
                                if (!string.IsNullOrWhiteSpace(scopedId)) connectedScopedIds.Add(scopedId!);
                            }
                            catch { }
                        }
                    }
                }
                catch { }

                if (sampleConnectors.Count >= 6) continue;

                object? size = null;
                try
                {
                    if (connector.Shape == ConnectorProfileType.Round)
                    {
                        size = new
                        {
                            kind = "round",
                            radiusFt = connector.Radius,
                            diameterFt = 2.0 * connector.Radius
                        };
                    }
                    else if (connector.Shape == ConnectorProfileType.Rectangular)
                    {
                        size = new
                        {
                            kind = "rect",
                            widthFt = connector.Width,
                            heightFt = connector.Height
                        };
                    }
                }
                catch { size = null; }

                var origin = TryGetConnectorOriginInHostCoordinates(connector, linkInstance);
                sampleConnectors.Add(new
                {
                    origin = HostedPlacementUtil.BuildVector(origin),
                    shape = SafeToString(() => connector.Shape.ToString()),
                    domain = SafeToString(() => connector.Domain.ToString()),
                    size
                });
            }

            return new Dictionary<string, object?>
            {
                ["count"] = count,
                ["shapes"] = shapes.OrderBy(x => x).ToList(),
                ["domains"] = domains.OrderBy(x => x).ToList(),
                ["connectedElementScopedIds"] = connectedScopedIds.OrderBy(x => x).ToList(),
                ["sampleConnectors"] = sampleConnectors
            };
        }

        internal static Dictionary<string, object?> BuildCuratedParameters(Document document, Element element)
        {
            var values = new Dictionary<string, object?>(StringComparer.OrdinalIgnoreCase);
            foreach (var pair in CuratedParameterAliases)
            {
                var value = TryResolveParameterValue(document, element, pair.Value);
                if (value != null) values[pair.Key] = value;
            }
            return values;
        }

        internal static Dictionary<string, object> BuildParameterGroups(
            Dictionary<string, object?> parameters)
        {
            var groups = new Dictionary<string, object>(StringComparer.OrdinalIgnoreCase);

            AddGroup(groups, "identity", parameters, "mark", "typeMark", "comments", "description", "manufacturer", "model", "keynote", "assemblyCode", "omniclassNumber");
            AddGroup(groups, "electrical", parameters, "voltage", "amperage", "apparentLoad", "connectedLoad", "circuitNumber", "panel", "loadClassification", "numberOfPoles", "frequency");
            AddGroup(groups, "mechanical", parameters, "cfm", "airflow", "staticPressure");
            AddGroup(groups, "dimensions", parameters, "diameter", "width", "height", "depth", "mountingHeight");
            AddGroup(groups, "lifeSafety", parameters, "candela");
            AddGroup(groups, "lighting", parameters, "wattage", "lumenOutput");
            AddGroup(groups, "systems", parameters, "systemName", "systemType", "systemClassification");

            return groups;
        }

        internal static XYZ TransformPointToHost(RevitLinkInstance? linkInstance, XYZ point)
        {
            if (linkInstance == null) return point;
            try { return linkInstance.GetTotalTransform().OfPoint(point); } catch { }
            try { return linkInstance.GetTransform().OfPoint(point); } catch { }
            return point;
        }

        internal static XYZ TransformVectorToHost(RevitLinkInstance? linkInstance, XYZ vector)
        {
            if (linkInstance == null) return vector;
            try { return linkInstance.GetTotalTransform().OfVector(vector); } catch { }
            try { return linkInstance.GetTransform().OfVector(vector); } catch { }
            return vector;
        }

        private static Element? TryResolveHostFaceElement(
            Document hostDocument,
            Document sourceDocument,
            Reference? hostFace,
            out Document? resolvedDocument)
        {
            resolvedDocument = null;
            if (hostFace == null) return null;

            Element? hostFaceElement = null;
            try { hostFaceElement = sourceDocument.GetElement(hostFace.ElementId); } catch { hostFaceElement = null; }
            if (hostFaceElement != null)
            {
                resolvedDocument = sourceDocument;
                return hostFaceElement;
            }

            try { hostFaceElement = hostDocument.GetElement(hostFace.ElementId); } catch { hostFaceElement = null; }
            if (hostFaceElement != null)
            {
                resolvedDocument = hostDocument;
                return hostFaceElement;
            }

            return null;
        }

        private static string ResolveHostingMode(
            Element surfaceElement,
            Reference? hostFace,
            RevitLinkInstance? linkInstance)
        {
            if (hostFace != null)
            {
                if (surfaceElement is RevitLinkInstance) return "linked_face";
                return linkInstance == null ? "host_face" : "source_link_face";
            }

            if (surfaceElement is RevitLinkInstance) return "linked_host";
            return linkInstance == null ? "host_element" : "source_link_host";
        }

        private static string ResolveHostingSurfaceType(Element? hostElement)
        {
            return ResolveHostingSurfaceTypeWithSource(hostElement).surfaceType;
        }

        private static (string surfaceType, string source) ResolveHostingSurfaceTypeWithSource(Element? hostElement)
        {
            if (hostElement == null) return ("unknown", "none");
            if (hostElement is Wall) return ("wall", "revit_type");
            if (hostElement is Floor) return ("floor", "revit_type");
            if (hostElement is Ceiling) return ("ceiling", "revit_type");
            if (hostElement is RoofBase) return ("roof", "revit_type");
            if (hostElement is RevitLinkInstance) return ("linked", "revit_type");

            var bic = hostElement.Category?.BuiltInCategory;
            if (bic.HasValue)
            {
                switch (bic.Value)
                {
                    case BuiltInCategory.OST_Walls:
                        return ("wall", "built_in_category");
                    case BuiltInCategory.OST_Floors:
                    case BuiltInCategory.OST_StructuralFoundation:
                    case BuiltInCategory.OST_StructuralFraming:
                        return ("floor", "built_in_category");
                    case BuiltInCategory.OST_Ceilings:
                        return ("ceiling", "built_in_category");
                    case BuiltInCategory.OST_Roofs:
                        return ("roof", "built_in_category");
                }
            }

            var token = (hostElement.Category?.Name ?? hostElement.GetType().Name ?? "").ToLowerInvariant();
            if (token.Contains("wall")) return ("wall", "category_name_heuristic");
            if (token.Contains("ceil")) return ("ceiling", "category_name_heuristic");
            if (token.Contains("floor") || token.Contains("slab")) return ("floor", "category_name_heuristic");
            if (token.Contains("roof")) return ("roof", "category_name_heuristic");
            if (token.Contains("face")) return ("face", "category_name_heuristic");
            if (token.Contains("host")) return ("host", "category_name_heuristic");
            return ("unknown", "unresolved");
        }

        private static bool? InferHostingSurfacePlacementSupport(IReadOnlyDictionary<string, object?>? hostingSurface)
        {
            var surfaceType = (TryReadString(hostingSurface, "surfaceType") ?? "").Trim();
            if (surfaceType.Length == 0) return null;

            if (surfaceType.Equals("wall", StringComparison.OrdinalIgnoreCase)) return true;
            if (surfaceType.Equals("linked", StringComparison.OrdinalIgnoreCase)) return true;
            return false;
        }

        private static string? TryReadFamilyPlacementType(FamilyInstance familyInstance)
        {
            try
            {
                var symbol = familyInstance.Symbol;
                var family = symbol?.Family;
                if (family == null) return null;
                return family.FamilyPlacementType.ToString();
            }
            catch
            {
                return null;
            }
        }

        private static long? TryReadLong(IReadOnlyDictionary<string, object?>? payload, string key)
        {
            if (payload == null || !payload.TryGetValue(key, out var value) || value == null) return null;
            try
            {
                if (value is long l) return l;
                if (value is int i) return i;
                if (value is short s) return s;
                if (value is uint ui) return (long)ui;
                if (value is ulong ul && ul <= (ulong)long.MaxValue) return (long)ul;
                if (value is double d && Math.Abs(d) <= long.MaxValue) return Convert.ToInt64(d);
                if (value is float f && Math.Abs(f) <= long.MaxValue) return Convert.ToInt64(f);
                if (value is decimal m && Math.Abs(m) <= long.MaxValue) return Convert.ToInt64(m);
                if (value is string text && long.TryParse(text, out var parsed)) return parsed;
                if (value is ElementId elementId) return ElementIdCompat.GetValue(elementId);
            }
            catch { }
            return null;
        }

        private static string? TryReadString(IReadOnlyDictionary<string, object?>? payload, string key)
        {
            if (payload == null || !payload.TryGetValue(key, out var value) || value == null) return null;
            try
            {
                var text = value as string ?? value.ToString();
                return string.IsNullOrWhiteSpace(text) ? null : text.Trim();
            }
            catch
            {
                return null;
            }
        }

        private static bool? TryReadBool(IReadOnlyDictionary<string, object?>? payload, string key)
        {
            if (payload == null || !payload.TryGetValue(key, out var value) || value == null) return null;
            try
            {
                if (value is bool b) return b;
                if (value is string text)
                {
                    if (bool.TryParse(text, out var parsed)) return parsed;
                    if (long.TryParse(text, out var number)) return number != 0;
                }

                if (value is sbyte sb) return sb != 0;
                if (value is byte bt) return bt != 0;
                if (value is short s) return s != 0;
                if (value is ushort us) return us != 0;
                if (value is int i) return i != 0;
                if (value is uint ui) return ui != 0;
                if (value is long l) return l != 0;
                if (value is ulong ul) return ul != 0;
            }
            catch
            {
                return null;
            }

            return null;
        }

        private static object? TryReadValue(IReadOnlyDictionary<string, object?>? payload, string key)
        {
            if (payload == null || !payload.TryGetValue(key, out var value)) return null;
            return value;
        }

        private static Dictionary<string, object?>? BuildHostPayloadFromHostingSurface(
            IReadOnlyDictionary<string, object?>? hostingSurface,
            Document sourceDocument)
        {
            var hostElementId = TryReadLong(hostingSurface, "hostElementId");
            var hostElementScopedId = TryReadString(hostingSurface, "hostElementScopedId");
            if ((!hostElementId.HasValue || hostElementId.Value <= 0) && string.IsNullOrWhiteSpace(hostElementScopedId)) return null;

            var payload = new Dictionary<string, object?>
            {
                ["id"] = hostElementId.HasValue && hostElementId.Value > 0 ? hostElementId : null,
                ["uniqueId"] = TryReadString(hostingSurface, "hostElementUniqueId"),
                ["scopedId"] = hostElementScopedId,
                ["sourceScopedId"] = hostElementScopedId,
                ["mode"] = TryReadString(hostingSurface, "mode") ?? "hosting_surface_fallback",
                ["surfaceType"] = TryReadString(hostingSurface, "surfaceType"),
                ["surfaceTypeSource"] = TryReadString(hostingSurface, "surfaceTypeSource"),
                ["category"] = TryReadString(hostingSurface, "hostElementCategory"),
                ["builtInCategory"] = TryReadString(hostingSurface, "hostElementBuiltInCategory"),
                ["name"] = TryReadString(hostingSurface, "hostElementName"),
                ["point"] = TryReadValue(hostingSurface, "hostElementPoint"),
                ["center"] = TryReadValue(hostingSurface, "hostElementCenter"),
                ["bbox"] = TryReadValue(hostingSurface, "hostElementBbox"),
                ["supportsPlacementHost"] = TryReadBool(hostingSurface, "directHostSupportsPlacement"),
                ["sourceDocumentTitle"] = sourceDocument.Title,
                ["sourceDocumentPath"] = SafeDocumentPath(sourceDocument),
                ["provenance"] = "hostingSurfaceFallback"
            };

            payload["linkInstanceId"] = TryReadLong(hostingSurface, "linkInstanceId");
            payload["linkInstanceScopedId"] = TryReadString(hostingSurface, "linkInstanceScopedId");
            payload["linkInstanceName"] = TryReadString(hostingSurface, "linkInstanceName");
            payload["linkDocumentTitle"] = TryReadString(hostingSurface, "linkDocumentTitle");
            payload["linkDocumentPath"] = TryReadString(hostingSurface, "linkDocumentPath");
            payload["linkedElementId"] = TryReadLong(hostingSurface, "linkedElementId");
            payload["linkedElementScopedId"] = TryReadString(hostingSurface, "linkedElementScopedId");
            payload["linkedElementCategory"] = TryReadString(hostingSurface, "linkedElementCategory");
            payload["linkedElementBuiltInCategory"] = TryReadString(hostingSurface, "linkedElementBuiltInCategory");
            payload["linkedElementName"] = TryReadString(hostingSurface, "linkedElementName");
            payload["linkedElementUniqueId"] = TryReadString(hostingSurface, "linkedElementUniqueId");

            return payload;
        }

        private static void EnrichHostPayloadWithResolvedHost(
            IDictionary<string, object?>? hostPayload,
            string? hostScopedId,
            string? hostScopedIdSource,
            long? hostResolvedId,
            string? hostResolvedScopedId,
            string? hostResolvedCategory,
            string? hostResolvedBuiltInCategory,
            string? hostResolvedName,
            string? hostResolvedUniqueId,
            string? hostResolvedSource,
            long? hostLinkedElementId,
            string? hostLinkedElementScopedId,
            string? hostLinkedElementCategory,
            string? hostLinkedElementBuiltInCategory,
            string? hostLinkedElementName,
            string? hostLinkedElementUniqueId)
        {
            if (hostPayload == null) return;

            hostPayload["hostScopedId"] = hostScopedId;
            hostPayload["hostScopedIdSource"] = hostScopedIdSource;
            hostPayload["resolvedElementId"] = hostResolvedId;
            hostPayload["resolvedElementScopedId"] = hostResolvedScopedId;
            hostPayload["resolvedElementCategory"] = hostResolvedCategory;
            hostPayload["resolvedElementBuiltInCategory"] = hostResolvedBuiltInCategory;
            hostPayload["resolvedElementName"] = hostResolvedName;
            hostPayload["resolvedElementUniqueId"] = hostResolvedUniqueId;
            hostPayload["resolvedElementSource"] = hostResolvedSource;
            hostPayload["linkedElementId"] = hostLinkedElementId;
            hostPayload["linkedElementScopedId"] = hostLinkedElementScopedId;
            hostPayload["linkedElementCategory"] = hostLinkedElementCategory;
            hostPayload["linkedElementBuiltInCategory"] = hostLinkedElementBuiltInCategory;
            hostPayload["linkedElementName"] = hostLinkedElementName;
            hostPayload["linkedElementUniqueId"] = hostLinkedElementUniqueId;
        }

        private static string? ResolveHostScopedIdSource(
            string? hostScopedId,
            string? linkedElementScopedId,
            string? hostElementScopedId,
            string? hostPayloadScopedId,
            bool hasDirectHost)
        {
            if (string.IsNullOrWhiteSpace(hostScopedId)) return null;
            if (!string.IsNullOrWhiteSpace(linkedElementScopedId) &&
                string.Equals(hostScopedId, linkedElementScopedId, StringComparison.OrdinalIgnoreCase))
            {
                return "hostingSurface.linkedElementScopedId";
            }

            if (!string.IsNullOrWhiteSpace(hostElementScopedId) &&
                string.Equals(hostScopedId, hostElementScopedId, StringComparison.OrdinalIgnoreCase))
            {
                return "hostingSurface.hostElementScopedId";
            }

            if (!string.IsNullOrWhiteSpace(hostPayloadScopedId) &&
                string.Equals(hostScopedId, hostPayloadScopedId, StringComparison.OrdinalIgnoreCase))
            {
                return "host.scopedId";
            }

            return hasDirectHost ? "familyInstance.Host" : "fallback";
        }

        private static object? BuildSpatialPayload(SpatialElement? spatial)
        {
            if (spatial == null) return null;
            return new
            {
                id = ElementIdCompat.GetValue(spatial.Id),
                number = SpatialIntentUtils.GetSpatialNumber(spatial),
                name = SpatialIntentUtils.GetSpatialName(spatial),
                kind = SpatialIntentUtils.GetSpatialKind(spatial)
            };
        }

        private static Space? GetSourceSpace(Element element)
        {
            if (element is Space space) return space;
            try
            {
                if (element is FamilyInstance familyInstance) return familyInstance.Space;
            }
            catch { }
            return null;
        }

        private static string? ResolveHostScopedId(
            Element element,
            RevitLinkInstance? linkInstance,
            Dictionary<string, object?>? hostPayload,
            Dictionary<string, object?>? hostingSurface)
        {
            if (hostingSurface != null &&
                hostingSurface.TryGetValue("linkedElementScopedId", out var linkedScopedId) &&
                linkedScopedId is string linkedScoped &&
                !string.IsNullOrWhiteSpace(linkedScoped))
            {
                return linkedScoped;
            }

            if (hostingSurface != null &&
                hostingSurface.TryGetValue("hostElementScopedId", out var hostElementScopedId) &&
                hostElementScopedId is string hostFaceScoped &&
                !string.IsNullOrWhiteSpace(hostFaceScoped))
            {
                return hostFaceScoped;
            }

            if (hostPayload != null &&
                hostPayload.TryGetValue("scopedId", out var directScopedId) &&
                directScopedId is string directScoped &&
                !string.IsNullOrWhiteSpace(directScoped))
            {
                return directScoped;
            }

            var directHost = (element as FamilyInstance)?.Host;
            return directHost == null ? null : CreateScopedId(ElementIdCompat.GetValue(directHost.Id), linkInstance);
        }

        private static Transform GetHostTransform(RevitLinkInstance? linkInstance)
        {
            if (linkInstance == null) return Transform.Identity;
            try { return linkInstance.GetTotalTransform(); } catch { }
            try { return linkInstance.GetTransform(); } catch { }
            return Transform.Identity;
        }

        private static object BuildTransformPayload(Transform transform)
        {
            return new
            {
                origin = new[] { transform.Origin.X, transform.Origin.Y, transform.Origin.Z },
                basisX = new[] { transform.BasisX.X, transform.BasisX.Y, transform.BasisX.Z },
                basisY = new[] { transform.BasisY.X, transform.BasisY.Y, transform.BasisY.Z },
                basisZ = new[] { transform.BasisZ.X, transform.BasisZ.Y, transform.BasisZ.Z }
            };
        }

        private static IEnumerable<XYZ> GetBoundingBoxCorners(BoundingBoxXYZ bbox)
        {
            var transform = bbox.Transform ?? Transform.Identity;
            var min = bbox.Min;
            var max = bbox.Max;
            yield return transform.OfPoint(new XYZ(min.X, min.Y, min.Z));
            yield return transform.OfPoint(new XYZ(min.X, min.Y, max.Z));
            yield return transform.OfPoint(new XYZ(min.X, max.Y, min.Z));
            yield return transform.OfPoint(new XYZ(min.X, max.Y, max.Z));
            yield return transform.OfPoint(new XYZ(max.X, min.Y, min.Z));
            yield return transform.OfPoint(new XYZ(max.X, min.Y, max.Z));
            yield return transform.OfPoint(new XYZ(max.X, max.Y, min.Z));
            yield return transform.OfPoint(new XYZ(max.X, max.Y, max.Z));
        }

        private static object? TryResolveParameterValue(
            Document document,
            Element element,
            IEnumerable<string> aliases)
        {
            foreach (var alias in aliases)
            {
                var value = TryResolveParameterValue(document, element, alias);
                if (value != null) return value;
            }
            return null;
        }

        private static object? TryResolveParameterValue(
            Document document,
            Element element,
            string alias)
        {
            var value = TryReadParameterValue(element.LookupParameter(alias));
            if (value != null) return value;

            try
            {
                var typeId = element.GetTypeId();
                if (typeId == ElementId.InvalidElementId) return null;
                var type = document.GetElement(typeId);
                return type == null ? null : TryReadParameterValue(type.LookupParameter(alias));
            }
            catch
            {
                return null;
            }
        }

        private static object? TryReadParameterValue(Parameter? parameter)
        {
            if (parameter == null) return null;
            try
            {
                switch (parameter.StorageType)
                {
                    case StorageType.String:
                        return CleanString(parameter.AsString());
                    case StorageType.Integer:
                        return parameter.AsInteger();
                    case StorageType.Double:
                    {
                        var display = CleanString(parameter.AsValueString());
                        return display ?? (object)parameter.AsDouble();
                    }
                    case StorageType.ElementId:
                    {
                        var display = CleanString(parameter.AsValueString());
                        return display ?? (object)ElementIdCompat.GetValue(parameter.AsElementId());
                    }
                    default:
                    {
                        var display = CleanString(parameter.AsValueString()) ?? CleanString(parameter.AsString());
                        return display;
                    }
                }
            }
            catch
            {
                return null;
            }
        }

        private static string? InferSystemClassification(IEnumerable<string> candidates)
        {
            var items = (candidates ?? Enumerable.Empty<string>())
                .Where(x => !string.IsNullOrWhiteSpace(x))
                .ToList();
            if (items.Count == 0) return null;
            if (MepSystemUtil.MatchesSystemClassificationCandidates(items, "Supply")) return "Supply";
            if (MepSystemUtil.MatchesSystemClassificationCandidates(items, "Return")) return "Return";
            if (MepSystemUtil.MatchesSystemClassificationCandidates(items, "Exhaust")) return "Exhaust";
            return null;
        }

        private static void AddGroup(
            IDictionary<string, object> groups,
            string name,
            IReadOnlyDictionary<string, object?> parameters,
            params string[] keys)
        {
            var group = new Dictionary<string, object?>(StringComparer.OrdinalIgnoreCase);
            foreach (var key in keys)
            {
                if (parameters.TryGetValue(key, out var value) && value != null)
                {
                    group[key] = value;
                }
            }

            if (group.Count > 0) groups[name] = group;
        }

        private static string? SafeDocumentPath(Document? document)
        {
            if (document == null) return null;
            try
            {
                var path = document.PathName;
                return string.IsNullOrWhiteSpace(path) ? null : path;
            }
            catch
            {
                return null;
            }
        }

        private static string? SafeToString(Func<string> getter)
        {
            try
            {
                var value = getter();
                return string.IsNullOrWhiteSpace(value) ? null : value;
            }
            catch
            {
                return null;
            }
        }

        private static string? CleanString(string? value)
        {
            var text = (value ?? "").Trim();
            return text.Length == 0 ? null : text;
        }

        private static XYZ? TryGetConnectorOriginInHostCoordinates(
            Connector connector,
            RevitLinkInstance? linkInstance)
        {
            try
            {
                return TransformPointToHost(linkInstance, connector.Origin);
            }
            catch
            {
                return null;
            }
        }
    }
}
