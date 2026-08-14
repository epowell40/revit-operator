using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitBridge.Common;

namespace RevitBridge.Logic.Handlers
{
    public class OpenModelHandler : IRequestHandler
    {
        public class Params
        {
            public string filePath { get; set; }
            public bool audit { get; set; } = false;
            public bool detach { get; set; } = false;
            public bool discardExistingOpenDocument { get; set; } = false;
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = JsonSerializer.Deserialize<Params>(jsonData) ?? throw new Exception("Invalid request body.");
            if (string.IsNullOrWhiteSpace(p.filePath)) throw new Exception("filePath is required.");

            // Phase 0 hardening: all file IO must stay inside the per-user workspace.
            var filePath = WorkspacePaths.ResolveExistingFileUnderWorkspace(p.filePath);

            // Opening a document usually requires no active transaction, 
            // but must be done on UI thread (which we are).
            
            ModelPath modelPath = ModelPathUtils.ConvertUserVisiblePathToModelPath(filePath);
            OpenOptions opts = new OpenOptions();
            opts.Audit = p.audit;
            
            if (p.detach)
            {
                opts.DetachFromCentralOption = DetachFromCentralOption.DetachAndPreserveWorksets;
            }

            var existing = FindOpenDocument(app, filePath);
            if (existing != null)
            {
                var active = app.ActiveUIDocument?.Document;
                if (active != null && active.Equals(existing))
                    return Task.FromResult<object>(new { status = "Already Active", title = existing.Title, path = existing.PathName });

                if (!p.discardExistingOpenDocument)
                {
                    return Task.FromResult<object>(new
                    {
                        status = "Already Open Inactive",
                        title = existing.Title,
                        path = existing.PathName,
                        activeTitle = active?.Title,
                        completionEligible = false,
                        requestedEffectSatisfied = false,
                        requiresExplicitDiscardAndReopen = true
                    });
                }

                return Task.FromResult(ReopenInactiveDocument(app, existing, modelPath, opts, filePath));
            }

            var linkedReferences = FindLinkedDocumentReferences(app, filePath);
            if (linkedReferences.Count > 0)
            {
                if (!p.discardExistingOpenDocument)
                {
                    return Task.FromResult<object>(new
                    {
                        status = "Already Loaded As Link",
                        path = filePath,
                        completionEligible = false,
                        requestedEffectSatisfied = false,
                        requiresExplicitUnloadAndOpen = true,
                        linkedHosts = DescribeLinkedDocumentReferences(linkedReferences)
                    });
                }

                var unloadedLinks = UnloadLinkedDocumentReferences(linkedReferences);
                UIDocument openedLinkedDocument = app.OpenAndActivateDocument(modelPath, opts, false);
                return Task.FromResult<object>(new
                {
                    status = "Unloaded Link and Activated",
                    title = openedLinkedDocument.Document.Title,
                    path = openedLinkedDocument.Document.PathName,
                    unloadedLinks
                });
            }

            try 
            {
                UIDocument uidoc = app.OpenAndActivateDocument(modelPath, opts, false);
                return Task.FromResult<object>(new 
                { 
                    status = "Success", 
                    title = uidoc.Document.Title,
                    path = uidoc.Document.PathName
                });
            }
            catch (Exception ex)
            {
                var racedOpenDocument = FindOpenDocument(app, filePath);
                if (racedOpenDocument != null)
                {
                    var active = app.ActiveUIDocument?.Document;
                    if (active != null && active.Equals(racedOpenDocument))
                    {
                        return Task.FromResult<object>(new { status = "Already Active", title = racedOpenDocument.Title, path = racedOpenDocument.PathName });
                    }

                    if (p.discardExistingOpenDocument)
                        return Task.FromResult(ReopenInactiveDocument(app, racedOpenDocument, modelPath, opts, filePath));

                    throw new InvalidOperationException(
                        $"The requested model is open but inactive. Retry with discardExistingOpenDocument=true only when discarding unsaved changes is explicitly authorized: {filePath}",
                        ex);
                }
                throw;
            }
        }

        private static object ReopenInactiveDocument(
            UIApplication app,
            Document existing,
            ModelPath modelPath,
            OpenOptions opts,
            string filePath)
        {
            var discardedUnsavedChanges = existing.IsModified;
            if (!existing.Close(false))
                throw new InvalidOperationException($"Revit did not close the inactive document before reopening it: {filePath}");

            UIDocument reopened = app.OpenAndActivateDocument(modelPath, opts, false);
            return new
            {
                status = "Reopened and Activated",
                title = reopened.Document.Title,
                path = reopened.Document.PathName,
                discardedUnsavedChanges
            };
        }

        private static Document? FindOpenDocument(UIApplication app, string filePath)
        {
            foreach (Document document in app.Application.Documents)
            {
                // Linked documents cannot be activated, saved, or closed as
                // top-level UI documents. Ignore them when resolving an
                // already-open project that may be discarded and reopened.
                if (document.IsLinked) continue;
                if (string.Equals(document.PathName, filePath, StringComparison.OrdinalIgnoreCase))
                    return document;
            }

            return null;
        }

        private sealed class LinkedDocumentReference
        {
            public Document HostDocument { get; set; } = null!;
            public ElementId LinkTypeId { get; set; } = null!;
            public string LinkTypeName { get; set; } = "";
            public string LinkedDocumentTitle { get; set; } = "";
        }

        private static List<LinkedDocumentReference> FindLinkedDocumentReferences(UIApplication app, string filePath)
        {
            var references = new List<LinkedDocumentReference>();
            foreach (Document hostDocument in app.Application.Documents)
            {
                if (hostDocument.IsLinked) continue;

                foreach (var instance in new FilteredElementCollector(hostDocument)
                    .OfClass(typeof(RevitLinkInstance))
                    .Cast<RevitLinkInstance>())
                {
                    var linkedDocument = instance.GetLinkDocument();
                    if (linkedDocument == null ||
                        !string.Equals(linkedDocument.PathName, filePath, StringComparison.OrdinalIgnoreCase))
                        continue;

                    var linkTypeId = instance.GetTypeId();
                    var rawLinkTypeId = ElementIdCompat.GetValue(linkTypeId);
                    if (references.Any(reference =>
                        reference.HostDocument.Equals(hostDocument) &&
                        ElementIdCompat.GetValue(reference.LinkTypeId) == rawLinkTypeId))
                        continue;

                    var linkType = hostDocument.GetElement(linkTypeId) as RevitLinkType;
                    references.Add(new LinkedDocumentReference
                    {
                        HostDocument = hostDocument,
                        LinkTypeId = linkTypeId,
                        LinkTypeName = linkType?.Name ?? instance.Name,
                        LinkedDocumentTitle = linkedDocument.Title
                    });
                }
            }

            return references;
        }

        private static object[] DescribeLinkedDocumentReferences(IEnumerable<LinkedDocumentReference> references)
        {
            return references.Select(reference => (object)new
            {
                hostTitle = reference.HostDocument.Title,
                hostPath = reference.HostDocument.PathName,
                linkTypeId = ElementIdCompat.GetValue(reference.LinkTypeId),
                linkTypeName = reference.LinkTypeName,
                linkedDocumentTitle = reference.LinkedDocumentTitle
            }).ToArray();
        }

        private static object[] UnloadLinkedDocumentReferences(IEnumerable<LinkedDocumentReference> references)
        {
            var unloaded = new List<object>();
            foreach (var reference in references)
            {
                var linkType = reference.HostDocument.GetElement(reference.LinkTypeId) as RevitLinkType;
                if (linkType == null)
                    throw new InvalidOperationException($"Revit link type {ElementIdCompat.GetValue(reference.LinkTypeId)} was not found in host {reference.HostDocument.Title}.");

                InvokeUnload(linkType);
                unloaded.Add(new
                {
                    hostTitle = reference.HostDocument.Title,
                    hostPath = reference.HostDocument.PathName,
                    linkTypeId = ElementIdCompat.GetValue(reference.LinkTypeId),
                    linkTypeName = reference.LinkTypeName,
                    linkedDocumentTitle = reference.LinkedDocumentTitle
                });
            }

            return unloaded.ToArray();
        }

        private static void InvokeUnload(RevitLinkType linkType)
        {
            var methods = typeof(RevitLinkType)
                .GetMethods(BindingFlags.Public | BindingFlags.Instance)
                .Where(method => string.Equals(method.Name, "Unload", StringComparison.Ordinal))
                .OrderBy(method => method.GetParameters().Length)
                .ToList();

            Exception? lastError = null;
            foreach (var method in methods)
            {
                try
                {
                    var args = method.GetParameters()
                        .Select(parameter => parameter.ParameterType.IsValueType ? Activator.CreateInstance(parameter.ParameterType) : null)
                        .ToArray();
                    method.Invoke(linkType, args);
                    return;
                }
                catch (TargetInvocationException ex)
                {
                    lastError = ex.InnerException ?? ex;
                }
                catch (Exception ex)
                {
                    lastError = ex;
                }
            }

            throw new InvalidOperationException(
                lastError == null
                    ? "This Revit API version does not expose RevitLinkType.Unload."
                    : $"Revit link type unload failed: {lastError.Message}");
        }
    }
}

