using System;
using System.Collections.Generic;
using System.Linq;
using Autodesk.Revit.DB;
using RevitBridge.Common;
using RevitBridge.Common.Annotation;

namespace RevitBridge.Logic.Handlers
{
    internal static class NativeTagReferenceSummary
    {
        public static object Read(Document host, Element element, int limit)
        {
            if (!(element is IndependentTag tag)) return new
            {
                schema = "operator.tag_references.v1", applicable = false, complete = false,
                reason = "element_is_not_an_independent_tag"
            };

            var ownerView = host.GetElement(tag.OwnerViewId) as View;
            var ownerPhaseId = ownerView?.get_Parameter(BuiltInParameter.VIEW_PHASE)?.AsElementId();
            var errors = new List<string>();
            var rows = new List<object>();
            var unresolved = 0;
            var enumerationFailed = false;
            var orphaned = tag.IsOrphaned;
            var references = new List<LinkElementId>();
            try { references = tag.GetTaggedElementIds().ToList(); }
            catch (Exception ex) { enumerationFailed = true; errors.Add("reference_enumeration_failed:" + ex.GetType().Name); }

            foreach (var reference in references.Take(limit))
            {
                var linked = Positive(reference.LinkInstanceId).HasValue;
                var linkId = linked ? Positive(reference.LinkInstanceId) : null;
                var subjectId = linked ? reference.LinkedElementId : reference.HostElementId;
                var nativeId = Positive(subjectId);
                if (!nativeId.HasValue)
                {
                    unresolved++;
                    rows.Add(new { resolved = false, reason = "invalid_reference_id", documentScope = linked ? "linked" : "host", linkInstanceId = linkId });
                    continue;
                }

                try
                {
                    var subjectDocument = linked ? (host.GetElement(reference.LinkInstanceId) as RevitLinkInstance)?.GetLinkDocument() : host;
                    var subject = subjectDocument?.GetElement(subjectId);
                    if (subject == null)
                    {
                        unresolved++;
                        rows.Add(new
                        {
                            identityKey = TagReferenceReadPolicy.IdentityKey(linkId, nativeId.Value), resolved = false,
                            reason = subjectDocument == null ? "linked_document_unavailable" : "referenced_element_unavailable",
                            documentScope = linked ? "linked" : "host", linkInstanceId = linkId, elementId = nativeId.Value
                        });
                        continue;
                    }

                    var type = subjectDocument.GetElement(subject.GetTypeId()) as ElementType;
                    rows.Add(new
                    {
                        identityKey = TagReferenceReadPolicy.IdentityKey(linkId, nativeId.Value), resolved = true,
                        documentScope = linked ? "linked" : "host", linkInstanceId = linkId,
                        documentTitle = subjectDocument.Title, elementId = nativeId.Value, uniqueId = subject.UniqueId,
                        name = subject.Name, category = subject.Category?.Name,
                        typeId = Positive(subject.GetTypeId()), typeName = type?.Name, familyName = (type as FamilySymbol)?.FamilyName,
                        phase = ReadPhase(subjectDocument, subject, linked ? null : ownerPhaseId),
                        // Linked-document phase IDs must not be compared to host
                        // IDs. Mapping is a separate required read for that case.
                        hostViewPhaseComparable = !linked,
                        hostViewPhaseLimitation = linked ? "linked_phase_mapping_not_evaluated" : null
                    });
                }
                catch (Exception ex)
                {
                    unresolved++;
                    rows.Add(new
                    {
                        identityKey = TagReferenceReadPolicy.IdentityKey(linkId, nativeId.Value), resolved = false,
                        reason = "reference_read_failed:" + ex.GetType().Name,
                        documentScope = linked ? "linked" : "host", linkInstanceId = linkId, elementId = nativeId.Value
                    });
                }
            }

            return new
            {
                schema = "operator.tag_references.v1", applicable = true,
                complete = TagReferenceReadPolicy.Complete(references.Count, rows.Count, unresolved, orphaned, enumerationFailed),
                orphaned, enumerationFailed, totalReferences = references.Count, returned = rows.Count,
                unresolvedReferences = unresolved, truncated = references.Count > rows.Count, limit,
                ownerView = ownerView == null ? null : new
                {
                    elementId = ElementIdCompat.GetValue(ownerView.Id), uniqueId = ownerView.UniqueId, name = ownerView.Name,
                    phaseId = Positive(ownerPhaseId), phaseName = PhaseName(host, ownerPhaseId)
                },
                items = rows, errors
            };
        }

        private static object ReadPhase(Document document, Element subject, ElementId ownerPhaseId)
        {
            try
            {
                var supported = subject.HasPhases();
                var created = supported ? subject.CreatedPhaseId : null;
                var demolished = supported ? subject.DemolishedPhaseId : null;
                string status = null;
                string statusError = null;
                if (supported && Positive(ownerPhaseId).HasValue)
                {
                    try { status = subject.GetPhaseStatus(ownerPhaseId).ToString(); }
                    catch (Exception ex) { statusError = "phase_status_unavailable:" + ex.GetType().Name; }
                }
                return new
                {
                    available = true, hasPhases = supported,
                    createdPhaseId = Positive(created), createdPhaseName = PhaseName(document, created),
                    demolishedPhaseId = Positive(demolished), demolishedPhaseName = PhaseName(document, demolished),
                    statusInOwnerViewPhase = status, statusError
                };
            }
            catch (Exception ex) { return new { available = false, error = "phase_read_failed:" + ex.GetType().Name }; }
        }

        private static long? Positive(ElementId id)
        {
            if (id == null || id == ElementId.InvalidElementId) return null;
            var value = ElementIdCompat.GetValue(id);
            return value > 0 ? (long?)value : null;
        }

        private static string PhaseName(Document document, ElementId id)
        {
            return Positive(id).HasValue ? (document.GetElement(id) as Phase)?.Name : null;
        }
    }
}
