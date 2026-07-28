using System;
using System.Diagnostics;
using System.Linq;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;

namespace RevitBridge.Handlers
{
    public class ContextHandler : IRequestHandler
    {
        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var uidoc = app.ActiveUIDocument;
            var doc = uidoc?.Document;
            var view = doc?.ActiveView;
            var documentLoaded = doc != null && !string.IsNullOrWhiteSpace(doc.Title);
            var activeViewReady = view != null && view.IsValidObject;
            string? projectUniqueId = null;
            try { projectUniqueId = doc?.ProjectInformation?.UniqueId; } catch { }
            var projectFingerprint = doc == null
                ? null
                : RevitBridge.Common.OperatorRevitBatchBinding.ComputeProjectFingerprint(doc.Title, doc.PathName, projectUniqueId);

            return Task.FromResult<object>(new
            {
                version = app.Application.VersionName,
                username = app.Application.Username,
                process_id = Process.GetCurrentProcess().Id,
                courier_executor_id = RevitBridge.Operator.OperatorRevitCourierWorker.ExecutorIdForCurrentProcess(),
                readiness = new
                {
                    revit_launched = true,
                    has_active_uidocument = uidoc != null,
                    document_loaded = documentLoaded,
                    active_document_name = doc?.Title,
                    active_document_path = doc?.PathName,
                    active_view_ready = activeViewReady,
                    active_view_name = view?.Name,
                    active_view_type = view == null ? null : view.ViewType.ToString(),
                    selection_count = uidoc?.Selection.GetElementIds().Count ?? 0
                },
                document = doc == null ? null : new
                {
                    title = doc.Title,
                    path = doc.PathName,
                    projectIdentity = new
                    {
                        fingerprint = projectFingerprint,
                        scheme = "revit-operator.project.v1",
                        anchorKind = string.IsNullOrWhiteSpace(projectUniqueId)
                            ? (string.IsNullOrWhiteSpace(doc.PathName) ? "document_title" : "document_path")
                            : "project_information_unique_id",
                        stableAcrossPathChanges = !string.IsNullOrWhiteSpace(projectUniqueId)
                    },
                    isWorkshared = doc.IsWorkshared,
                    activeView = view == null ? null : new
                    {
                        id = RevitBridge.Common.ElementIdCompat.GetValue(view.Id),
                        name = view.Name,
                        type = view.ViewType.ToString()
                    },
                    selection = uidoc?.Selection.GetElementIds().Select(id => RevitBridge.Common.ElementIdCompat.GetValue(id)).ToList()
                }
            });
        }
    }
}
