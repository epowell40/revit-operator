using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitBridge.Common;

namespace RevitBridge.Logic.Handlers
{
    public sealed class RevitStateSnapshotHandler : IRequestHandler
    {
        private const string SchemaVersion = "revit.state_snapshot.v1";
        private const int DefaultMaxItems = 50;

        private sealed class DialogInfo
        {
            public string title { get; set; } = "";
            public string class_name { get; set; } = "";
            public bool is_modal { get; set; }
            public bool is_top_most { get; set; }
            public string? default_button { get; set; }
            public List<string> buttons { get; set; } = new List<string>();
        }

        public sealed class Params
        {
            public bool? include_dialogs { get; set; }
            public bool? include_selection_details { get; set; }
            public bool? include_sheet_viewports { get; set; }
            public bool? include_all_views_index { get; set; }
            public bool? include_warnings_summary { get; set; }
            public bool? include_warnings_detail { get; set; }
            public bool? include_element_bboxes { get; set; }
            public int? max_items { get; set; }
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var started = DateTime.UtcNow;
            var sw = Stopwatch.StartNew();
            var p = ParseParams(jsonData);
            var maxItems = Clamp(p.max_items ?? DefaultMaxItems, 1, 500);
            var includeDialogs = p.include_dialogs ?? true;
            var includeSelectionDetails = p.include_selection_details ?? true;
            var includeSheetViewports = p.include_sheet_viewports ?? true;
            var includeAllViewsIndex = p.include_all_views_index ?? false;
            var includeWarningsSummary = p.include_warnings_summary ?? true;
            var includeWarningsDetail = p.include_warnings_detail ?? false;
            var includeElementBboxes = p.include_element_bboxes ?? false;
            var captureWarnings = new List<string>();

            var uidoc = app.ActiveUIDocument;
            var doc = uidoc?.Document;
            var activeView = doc?.ActiveView;

            var selection = BuildSelection(doc, uidoc, activeView, includeSelectionDetails, includeElementBboxes, maxItems);
            var dialogs = BuildDialogs(app, includeDialogs, maxItems, captureWarnings);
            var sheetContext = BuildSheetContext(doc, activeView, includeSheetViewports, maxItems);
            var warnings = BuildWarnings(doc, includeWarningsSummary, includeWarningsDetail, maxItems);
            var allViews = BuildAllViewsIndex(doc, includeAllViewsIndex, maxItems);

            sw.Stop();

            return Task.FromResult<object>(new
            {
                schema_version = SchemaVersion,
                captured_at = started.ToString("o"),
                capture_duration_ms = sw.ElapsedMilliseconds,
                capabilities = new[]
                {
                    "schema.v1", "app_state", "document_state", "view_state", "transaction_state_basic",
                    "selection_state", "dialog_state", "sheet_viewport_context", "warnings_summary",
                    "warnings_detail", "all_views_index", "selection_element_bboxes"
                },
                options = new
                {
                    include_dialogs = includeDialogs,
                    include_selection_details = includeSelectionDetails,
                    include_sheet_viewports = includeSheetViewports,
                    include_all_views_index = includeAllViewsIndex,
                    include_warnings_summary = includeWarningsSummary,
                    include_warnings_detail = includeWarningsDetail,
                    include_element_bboxes = includeElementBboxes,
                    max_items = maxItems
                },
                app = new
                {
                    process_id = Process.GetCurrentProcess().Id,
                    version_name = app.Application.VersionName,
                    version_number = app.Application.VersionNumber,
                    version_build = app.Application.VersionBuild,
                    username = app.Application.Username
                },
                document = BuildDocumentState(doc),
                view = BuildViewState(doc, activeView),
                transaction = new
                {
                    is_transaction_open = doc != null && SafeBool(() => doc.IsModifiable),
                    last_transaction_name = (string?)null,
                    last_failure_count = (int?)null
                },
                selection,
                dialog_state = dialogs,
                last_dialog_event = BuildLastDialogEventSummary(),
                sheet_viewport_context = sheetContext,
                warnings,
                all_views_index = allViews,
                capture_warnings = captureWarnings
            });
        }

        private static Params ParseParams(string jsonData)
        {
            if (string.IsNullOrWhiteSpace(jsonData)) return new Params();
            try { return JsonSerializer.Deserialize<Params>(jsonData) ?? new Params(); }
            catch { return new Params(); }
        }

        private static object BuildDocumentState(Document? doc)
        {
            if (doc == null)
            {
                return new
                {
                    is_open = false,
                    title = (string?)null,
                    path = (string?)null,
                    is_workshared = (bool?)null,
                    central_path = (string?)null,
                    is_modifiable = (bool?)null,
                    is_read_only = (bool?)null
                };
            }

            string? centralPath = null;
            try
            {
                if (doc.IsWorkshared)
                {
                    var mp = doc.GetWorksharingCentralModelPath();
                    if (mp != null) centralPath = ModelPathUtils.ConvertModelPathToUserVisiblePath(mp);
                }
            }
            catch { }

            return new
            {
                is_open = true,
                title = doc.Title,
                path = doc.PathName,
                is_workshared = doc.IsWorkshared,
                central_path = string.IsNullOrWhiteSpace(centralPath) ? null : centralPath,
                is_modifiable = SafeBool(() => doc.IsModifiable),
                is_read_only = SafeBool(() => doc.IsReadOnly)
            };
        }

        private static object BuildViewState(Document? doc, View? view)
        {
            if (doc == null || view == null)
            {
                return new
                {
                    id = (long?)null,
                    unique_id = (string?)null,
                    name = (string?)null,
                    view_type = (string?)null,
                    discipline = (string?)null,
                    scale = (int?)null,
                    detail_level = (string?)null,
                    crop_box_active = (bool?)null,
                    crop_box_visible = (bool?)null,
                    view_template_id = (long?)null,
                    view_template_name = (string?)null,
                    phase = (string?)null,
                    design_option = (string?)null,
                    is_sheet = false
                };
            }

            var templateId = Safe(() => view.ViewTemplateId);
            var templateName = templateId != null && templateId != ElementId.InvalidElementId
                ? doc.GetElement(templateId)?.Name
                : null;
            return new
            {
                id = ElementIdCompat.GetValue(view.Id),
                unique_id = Safe(() => view.UniqueId),
                name = Safe(() => view.Name),
                view_type = Safe(() => view.ViewType.ToString()),
                discipline = Safe(() => view.Discipline.ToString()),
                scale = Safe(() => view.Scale),
                detail_level = Safe(() => view.DetailLevel.ToString()),
                crop_box_active = SafeBool(() => view.CropBoxActive),
                crop_box_visible = SafeBool(() => view.CropBoxVisible),
                view_template_id = templateId != null && templateId != ElementId.InvalidElementId ? (long?)ElementIdCompat.GetValue(templateId) : null,
                view_template_name = string.IsNullOrWhiteSpace(templateName) ? null : templateName,
                phase = TryParamText(view, BuiltInParameter.VIEW_PHASE),
                design_option = Safe(() => view.LookupParameter("Design Option")?.AsValueString() ?? view.LookupParameter("Design Option")?.AsString()),
                is_sheet = view is ViewSheet
            };
        }

        private static object BuildSelection(Document? doc, UIDocument? uidoc, View? activeView, bool includeDetails, bool includeBboxes, int maxItems)
        {
            var rawIds = uidoc?.Selection?.GetElementIds()?.ToList() ?? new List<ElementId>();
            var selectedIds = rawIds.Take(maxItems).Select(ElementIdCompat.GetValue).ToList();
            var categoryCounts = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
            foreach (var id in rawIds)
            {
                var name = (doc?.GetElement(id)?.Category?.Name ?? "Uncategorized").Trim();
                if (!categoryCounts.ContainsKey(name)) categoryCounts[name] = 0;
                categoryCounts[name]++;
            }

            var elements = new List<object>();
            if (includeDetails && doc != null)
            {
                foreach (var id in rawIds.Take(maxItems))
                {
                    var e = doc.GetElement(id);
                    if (e == null) continue;
                    var type = Safe(() => doc.GetElement(e.GetTypeId()) as ElementType);
                    var levelName = ResolveLevelName(doc, e);
                    var modelBox = includeBboxes ? ToBoxObj(Safe(() => e.get_BoundingBox(null))) : null;
                    var viewBox = includeBboxes && activeView != null ? ToBoxObj(Safe(() => e.get_BoundingBox(activeView))) : null;
                    elements.Add(new
                    {
                        element_id = ElementIdCompat.GetValue(e.Id),
                        unique_id = e.UniqueId,
                        category = e.Category?.Name,
                        family = ResolveFamilyName(e, type),
                        type = type?.Name ?? e.Name,
                        level = levelName,
                        key_parameters = new
                        {
                            mark = TryParamText(e, BuiltInParameter.ALL_MODEL_MARK),
                            type_mark = TryParamText(e, BuiltInParameter.ALL_MODEL_TYPE_MARK),
                            comments = TryParamText(e, BuiltInParameter.ALL_MODEL_INSTANCE_COMMENTS)
                        },
                        model_bbox = modelBox,
                        view_bbox = viewBox
                    });
                }
            }

            return new
            {
                count = rawIds.Count,
                element_ids = selectedIds,
                element_ids_total_count = rawIds.Count,
                element_ids_truncated = rawIds.Count > selectedIds.Count,
                categories = categoryCounts.OrderByDescending(k => k.Value).ThenBy(k => k.Key).Select(k => new { category = k.Key, count = k.Value }).ToList(),
                selection_details_included = includeDetails,
                selection_details_truncated = includeDetails && rawIds.Count > elements.Count,
                elements
            };
        }

        private static object BuildSheetContext(Document? doc, View? activeView, bool includeSheetViewports, int maxItems)
        {
            if (!includeSheetViewports || doc == null || !(activeView is ViewSheet sheet))
            {
                return new
                {
                    included = includeSheetViewports,
                    is_sheet_view = false,
                    sheet_id = (long?)null,
                    sheet_number = (string?)null,
                    sheet_name = (string?)null,
                    viewport_count = (int?)null,
                    viewport_truncated = false,
                    viewports = new List<object>()
                };
            }

            var vps = (sheet.GetAllViewports() ?? new List<ElementId>()).ToList();
            var items = new List<object>();
            foreach (var id in vps.Take(maxItems))
            {
                var vp = doc.GetElement(id) as Viewport;
                var view = vp != null ? doc.GetElement(vp.ViewId) as View : null;
                if (vp == null) continue;
                items.Add(new
                {
                    viewport_id = ElementIdCompat.GetValue(vp.Id),
                    view_id = ElementIdCompat.GetValue(vp.ViewId),
                    view_name = view?.Name,
                    view_type = view?.ViewType.ToString(),
                    detail_number = TryParamText(vp, BuiltInParameter.VIEWPORT_DETAIL_NUMBER)
                });
            }
            return new
            {
                included = true,
                is_sheet_view = true,
                sheet_id = (long?)ElementIdCompat.GetValue(sheet.Id),
                sheet_number = sheet.SheetNumber,
                sheet_name = sheet.Name,
                viewport_count = vps.Count,
                viewport_truncated = vps.Count > items.Count,
                viewports = items
            };
        }

        private static object BuildWarnings(Document? doc, bool includeSummary, bool includeDetail, int maxItems)
        {
            if (doc == null)
            {
                return new
                {
                    summary_included = includeSummary,
                    detail_included = includeDetail,
                    summary = new { count = (int?)null, top = new List<object>() },
                    detail = new { count = (int?)null, truncated = false, items = new List<object>() }
                };
            }

            var all = (includeSummary || includeDetail) ? (doc.GetWarnings() ?? new List<FailureMessage>()).ToList() : new List<FailureMessage>();
            var top = includeSummary
                ? all.Select(x => (x.GetDescriptionText() ?? "").Trim()).Where(x => x.Length > 0).GroupBy(x => x).OrderByDescending(g => g.Count()).Take(Math.Min(maxItems, 10)).Select(g => new { description = g.Key, count = g.Count() }).ToList<object>()
                : new List<object>();

            var detail = new List<object>();
            if (includeDetail)
            {
                var page = all.Take(maxItems).ToList();
                for (var i = 0; i < page.Count; i++)
                {
                    var w = page[i];
                    detail.Add(new
                    {
                        index = i + 1,
                        warning_id = SafeWarningId(w, i + 1),
                        severity = Safe(() => w.GetSeverity().ToString()) ?? "Unknown",
                        description = Safe(() => w.GetDescriptionText()) ?? "",
                        failing_element_ids = SafeWarningElementIds(w, false),
                        additional_element_ids = SafeWarningElementIds(w, true)
                    });
                }
            }

            return new
            {
                summary_included = includeSummary,
                detail_included = includeDetail,
                summary = new { count = (int?)all.Count, top },
                detail = new { count = includeDetail ? (int?)all.Count : null, truncated = includeDetail && all.Count > detail.Count, items = detail }
            };
        }

        private static object BuildAllViewsIndex(Document? doc, bool includeAllViewsIndex, int maxItems)
        {
            if (!includeAllViewsIndex || doc == null)
            {
                return new { included = includeAllViewsIndex, count = (int?)null, truncated = false, items = new List<object>() };
            }
            var views = new FilteredElementCollector(doc).OfClass(typeof(View)).Cast<View>().Where(v => !v.IsTemplate).ToList();
            var items = views.OrderBy(v => v.Name).Take(maxItems).Select(v => new { id = ElementIdCompat.GetValue(v.Id), name = v.Name, view_type = v.ViewType.ToString(), is_sheet = v is ViewSheet }).ToList<object>();
            return new { included = true, count = views.Count, truncated = views.Count > items.Count, items };
        }

        private static object BuildDialogs(UIApplication app, bool includeDialogs, int maxItems, List<string> captureWarnings)
        {
            if (!includeDialogs)
            {
                return new { included = false, count = (int?)null, top_most_title = (string?)null, blocked_by_modal = (bool?)null, dialogs = new List<object>() };
            }

            var windows = new List<DialogInfo>();
            try
            {
                var pid = Process.GetCurrentProcess().Id;
                var foreground = GetForegroundWindow();
                EnumWindows((hWnd, _) =>
                {
                    if (windows.Count >= maxItems) return false;
                    if (hWnd == IntPtr.Zero || hWnd == app.MainWindowHandle || !IsWindowVisible(hWnd)) return true;
                    GetWindowThreadProcessId(hWnd, out var ownerPid);
                    if (ownerPid != pid) return true;

                    var className = ReadClassName(hWnd);
                    var title = ReadWindowText(hWnd);
                    var owner = GetWindow(hWnd, GW_OWNER);
                    var classIsDialog = string.Equals(className, "#32770", StringComparison.OrdinalIgnoreCase);
                    var ownedByMain = owner == app.MainWindowHandle;
                    if (!classIsDialog && !ownedByMain) return true;

                    var buttons = new List<string>();
                    string? defaultButton = null;
                    EnumChildWindows(hWnd, (child, __) =>
                    {
                        if (!string.Equals(ReadClassName(child), "Button", StringComparison.OrdinalIgnoreCase)) return true;
                        var label = ReadWindowText(child);
                        if (string.IsNullOrWhiteSpace(label)) return true;
                        if (!buttons.Contains(label, StringComparer.OrdinalIgnoreCase)) buttons.Add(label);
                        var style = GetWindowLongPtrCompat(child, GWL_STYLE).ToInt64();
                        if ((style & BS_DEFPUSHBUTTON) != 0 && string.IsNullOrWhiteSpace(defaultButton)) defaultButton = label;
                        return true;
                    }, IntPtr.Zero);

                    if (string.IsNullOrWhiteSpace(title) && buttons.Count == 0) return true;
                    var isModal = (ownedByMain && !IsWindowEnabled(app.MainWindowHandle)) || classIsDialog;
                    windows.Add(new DialogInfo
                    {
                        title = title,
                        class_name = className,
                        is_modal = isModal,
                        is_top_most = hWnd == foreground,
                        default_button = defaultButton ?? buttons.FirstOrDefault(),
                        buttons = buttons
                    });
                    return true;
                }, IntPtr.Zero);
            }
            catch (Exception ex)
            {
                captureWarnings.Add("dialog capture failed: " + ex.Message);
            }

            var topMostTitle = windows.FirstOrDefault(w => w.is_top_most)?.title;
            var blocked = windows.Any(w => w.is_modal);
            return new { included = true, count = windows.Count, top_most_title = string.IsNullOrWhiteSpace(topMostTitle) ? null : topMostTitle, blocked_by_modal = blocked, dialogs = windows };
        }

        private static object? BuildLastDialogEventSummary()
        {
            try
            {
                var appType = Type.GetType("RevitBridge.App, RevitBridge", throwOnError: false);
                var instance = appType?.GetProperty("Instance", System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Static)?.GetValue(null);
                var dialogComputerUse = instance?.GetType().GetProperty("DialogComputerUse", System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Instance)?.GetValue(instance);
                var method = dialogComputerUse?.GetType().GetMethod("GetLastDialogEventSummary", System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Instance);
                return method?.Invoke(dialogComputerUse, null);
            }
            catch
            {
                return null;
            }
        }

        private static string? ResolveFamilyName(Element e, ElementType? t)
        {
            try
            {
                if (e is FamilyInstance fi)
                {
                    if (!string.IsNullOrWhiteSpace(fi.Symbol?.FamilyName)) return fi.Symbol.FamilyName;
                    if (!string.IsNullOrWhiteSpace(fi.Symbol?.Family?.Name)) return fi.Symbol.Family.Name;
                }
            }
            catch { }
            return !string.IsNullOrWhiteSpace(t?.FamilyName) ? t!.FamilyName : null;
        }

        private static string? ResolveLevelName(Document doc, Element e)
        {
            try
            {
                var lid = e.LevelId;
                if (lid != null && lid != ElementId.InvalidElementId) return doc.GetElement(lid)?.Name;
            }
            catch { }
            return TryParamText(e, BuiltInParameter.LEVEL_PARAM) ?? TryParamText(e, BuiltInParameter.RBS_START_LEVEL_PARAM);
        }

        private static object? ToBoxObj(BoundingBoxXYZ? box) => box == null ? null : new { min = new { x = box.Min.X, y = box.Min.Y, z = box.Min.Z }, max = new { x = box.Max.X, y = box.Max.Y, z = box.Max.Z } };

        private static string? TryParamText(Element e, BuiltInParameter bip)
        {
            try
            {
                var p = e.get_Parameter(bip);
                if (p == null) return null;
                var v = p.AsValueString();
                if (!string.IsNullOrWhiteSpace(v)) return v;
                if (p.StorageType == StorageType.String) return p.AsString();
                if (p.StorageType == StorageType.Integer) return p.AsInteger().ToString(CultureInfo.InvariantCulture);
                if (p.StorageType == StorageType.Double) return p.AsDouble().ToString("G", CultureInfo.InvariantCulture);
                if (p.StorageType == StorageType.ElementId) return ElementIdCompat.GetValue(p.AsElementId()).ToString(CultureInfo.InvariantCulture);
            }
            catch { }
            return null;
        }

        private static string SafeWarningId(FailureMessage warning, int fallbackIndex)
        {
            try
            {
                var id = warning.GetFailureDefinitionId();
                var guidProp = id?.GetType().GetProperty("Guid");
                var guidVal = guidProp?.GetValue(id);
                if (guidVal is Guid g && g != Guid.Empty) return g.ToString("D");
                var text = id?.ToString();
                if (!string.IsNullOrWhiteSpace(text)) return text!;
            }
            catch { }
            return "warning-" + fallbackIndex.ToString(CultureInfo.InvariantCulture);
        }

        private static List<long> SafeWarningElementIds(FailureMessage warning, bool additional)
        {
            try
            {
                var ids = additional ? warning.GetAdditionalElements() : warning.GetFailingElements();
                return ids?.Where(i => i != null).Select(ElementIdCompat.GetValue).ToList() ?? new List<long>();
            }
            catch { return new List<long>(); }
        }

        private static T? Safe<T>(Func<T> getter)
        {
            try { return getter(); }
            catch { return default; }
        }

        private static bool SafeBool(Func<bool> getter)
        {
            try { return getter(); }
            catch { return false; }
        }

        private static int Clamp(int value, int min, int max) => value < min ? min : (value > max ? max : value);

        private const uint GW_OWNER = 4;
        private const int GWL_STYLE = -16;
        private const long BS_DEFPUSHBUTTON = 0x00000001L;
        private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

        [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
        [DllImport("user32.dll")] private static extern bool EnumChildWindows(IntPtr hWndParent, EnumWindowsProc cb, IntPtr lParam);
        [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hWnd);
        [DllImport("user32.dll")] private static extern bool IsWindowEnabled(IntPtr hWnd);
        [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr hWnd, uint cmd);
        [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out int processId);
        [DllImport("user32.dll", SetLastError = true)] private static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxCount);
        [DllImport("user32.dll", SetLastError = true)] private static extern int GetWindowTextLength(IntPtr hWnd);
        [DllImport("user32.dll", SetLastError = true)] private static extern int GetClassName(IntPtr hWnd, StringBuilder className, int maxCount);
        [DllImport("user32.dll", EntryPoint = "GetWindowLong")] private static extern int GetWindowLong32(IntPtr hWnd, int nIndex);
        [DllImport("user32.dll", EntryPoint = "GetWindowLongPtr")] private static extern IntPtr GetWindowLongPtr64(IntPtr hWnd, int nIndex);
        private static IntPtr GetWindowLongPtrCompat(IntPtr hWnd, int nIndex) => IntPtr.Size == 8 ? GetWindowLongPtr64(hWnd, nIndex) : new IntPtr(GetWindowLong32(hWnd, nIndex));
        private static string ReadWindowText(IntPtr hWnd) { var len = GetWindowTextLength(hWnd); if (len <= 0) return ""; var sb = new StringBuilder(len + 2); _ = GetWindowText(hWnd, sb, sb.Capacity); return sb.ToString().Trim(); }
        private static string ReadClassName(IntPtr hWnd) { var sb = new StringBuilder(256); var len = GetClassName(hWnd, sb, sb.Capacity); return len <= 0 ? "" : sb.ToString().Trim(); }
    }
}
