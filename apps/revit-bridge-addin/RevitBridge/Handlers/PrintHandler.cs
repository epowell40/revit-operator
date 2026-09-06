using System;
using System.Collections.Generic;
using System.Drawing.Printing;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitBridge.Common;

namespace RevitBridge.Handlers
{
    public sealed class PrintHandler : IRequestHandler
    {
        public sealed class Params : ExportPdfHandler.Params
        {
            public string? printerName { get; set; }
            public bool? printIndividually { get; set; }
            public int? copies { get; set; }
            public bool? collate { get; set; }
            public bool? reverseOrder { get; set; }
            public bool? printToFile { get; set; }
            public string? printToFileName { get; set; }
            public bool? combinedFile { get; set; }
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrWhiteSpace(jsonData)
                ? new Params()
                : (JsonSerializer.Deserialize<Params>(jsonData) ?? new Params());

            var doc = app.ActiveUIDocument?.Document;
            if (doc == null)
            {
                return Task.FromResult<object>(new
                {
                    status = "NoDocument",
                    message = "No active Revit document."
                });
            }

            var dryRun = p.dryRun ?? true;
            var printIndividually = p.printIndividually ?? true;
            var printerName = (p.printerName ?? "").Trim();

            var printManager = doc.PrintManager;
            var currentPrinter = SafeGetCurrentPrinter(printManager);
            var installedPrinters = GetInstalledPrinters();
            var selectedPrinter = string.IsNullOrWhiteSpace(printerName) ? currentPrinter : printerName;

            var views = ExportPdfHandler.ResolveSelectedViews(doc, p, out var selectionMeta);
            if (views.Count == 0) throw new InvalidOperationException("No views/sheets selected for printing.");

            var printToFile = p.printToFile ?? printManager.PrintToFile;
            string? outputPath = null;
            if (printToFile)
            {
                if (printIndividually && views.Count > 1)
                    throw new ArgumentException("Individual print-to-file needs distinct output names. Use printIndividually=false and combinedFile=true for one combined file.");
                if (!printIndividually && views.Count > 1 && p.combinedFile != true)
                    throw new ArgumentException("Multiple views printed to one file require combinedFile=true.");
                outputPath = OperatorPrintOutputPath.Resolve(p.printToFileName, p.outputFolder,
                    new[] { p.baseFileName, p.fileName, views[0].SheetNumber + ".pdf" }.First(name => !string.IsNullOrWhiteSpace(name))!, ExportPdfHandler.ResolvePdfOutputFolder);
                p.printToFileName = outputPath;
            }
            var plannedPaths = outputPath == null ? Array.Empty<string>() : new[] { outputPath };
            var selectedSheets = views.Select(v => new { viewId = ElementIdCompat.GetValue(v.ViewId), sheetNumber = v.SheetNumber, name = v.Name }).ToArray();

            var preflight = BuildPrinterPreflight(printerName, selectedPrinter, currentPrinter, installedPrinters);
            preflight.outputs = plannedPaths;
            var plan = new
            {
                printerName = string.IsNullOrWhiteSpace(selectedPrinter) ? null : selectedPrinter,
                printIndividually,
                copies = p.copies ?? 1,
                collate = p.collate,
                reverseOrder = p.reverseOrder,
                printToFile = p.printToFile,
                printToFileName = p.printToFileName,
                combinedFile = p.combinedFile,
                viewIds = views.Select(v => RevitBridge.Common.ElementIdCompat.GetValue(v.ViewId)).ToArray(),
                sheets = views.Select(v => new
                {
                    viewId = RevitBridge.Common.ElementIdCompat.GetValue(v.ViewId),
                    sheetNumber = v.SheetNumber,
                    name = v.Name
                }).ToArray()
            };

            if (dryRun)
            {
                return Task.FromResult<object>(new
                {
                    status = "Dry Run",
                    ok = preflight.available,
                    dryRun = true,
                    artifact_receipt = outputPath == null ? null : OperatorNativeArtifactReceipt.Preview(plannedPaths, 1, "/revit/print"),
                    selectedCount = views.Count,
                    selectedSheets,
                    selection = selectionMeta,
                    preflight,
                    plan
                });
            }

            if (!preflight.available)
            {
                throw new InvalidOperationException(preflight.failureClass + ": " + preflight.message);
            }

            var settings = new PrintSettingsPreservation(doc, !printIndividually, p.collate.HasValue);
            var capture = outputPath == null ? null : new OperatorNativeArtifactCapture(plannedPaths, 1, "/revit/print");
            if (outputPath != null) Directory.CreateDirectory(Path.GetDirectoryName(outputPath)!);
            var warnings = new List<string>();
            var results = new List<PrintResult>();
            bool restored;
            IReadOnlyList<string> restorationErrors;
            try
            {
                warnings.AddRange(ApplyPrintSettings(printManager, p, selectedPrinter));
                if (outputPath != null && (!printManager.PrintToFile || !string.Equals(printManager.PrintToFileName, outputPath, StringComparison.OrdinalIgnoreCase)))
                    throw new InvalidOperationException("Requested print-to-file settings were not accepted; no print was submitted.");
                results = printIndividually ? SubmitIndividualPrints(doc, printManager, views)
                    : new List<PrintResult> { SubmitSelectedSetPrint(doc, printManager, views) };
                foreach (var result in results) capture?.RecordNativeExport(result.ok);
            }
            catch (Exception ex) { results.Add(PrintResult.Failed(views[0], ex.GetType().Name + ": " + ex.Message)); }
            finally
            {
                try { restored = settings.Restore(out restorationErrors); }
                catch (Exception ex) { restored = false; restorationErrors = new[] { ex.GetType().Name + ": " + ex.Message }; }
            }
            var receipt = capture?.Complete(restored);
            var failed = results.Count(r => !r.ok);
            var complete = failed == 0 && restored && (receipt == null || receipt.Status == "complete");
            return Task.FromResult<object>(new
            {
                status = complete ? "Success" : "PrintFailed",
                ok = complete,
                dryRun = false,
                selectedCount = views.Count,
                selectedSheets,
                printerName = selectedPrinter,
                printJobs = results.Count,
                failedCount = failed,
                artifact_receipt = receipt,
                print_settings_restored = restored,
                print_settings_restoration_errors = restorationErrors,
                path = outputPath,
                warnings,
                results
            });
        }

        private static string SafeGetCurrentPrinter(PrintManager printManager)
        {
            try
            {
                return (printManager.PrinterName ?? "").Trim();
            }
            catch
            {
                return "";
            }
        }

        private static List<string> GetInstalledPrinters()
        {
            var names = new List<string>();
            try
            {
                foreach (string printer in PrinterSettings.InstalledPrinters)
                {
                    if (!string.IsNullOrWhiteSpace(printer)) names.Add(printer.Trim());
                }
            }
            catch
            {
                // Printer enumeration can be restricted on locked-down workstations.
            }

            return names
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .OrderBy(x => x, StringComparer.OrdinalIgnoreCase)
                .ToList();
        }

        private sealed class PrinterPreflight
        {
            public string[] outputs { get; set; } = Array.Empty<string>();
            public bool available { get; set; }
            public string? failureClass { get; set; }
            public string message { get; set; } = "";
            public string? requestedPrinter { get; set; }
            public string? currentPrinter { get; set; }
            public List<string> installedPrinters { get; set; } = new List<string>();
        }

        private static PrinterPreflight BuildPrinterPreflight(string requestedPrinter, string selectedPrinter, string currentPrinter, List<string> installedPrinters)
        {
            if (string.IsNullOrWhiteSpace(selectedPrinter))
            {
                return new PrinterPreflight
                {
                    available = false,
                    failureClass = "no_printer_configured",
                    message = "No printer was requested and Revit has no current printer.",
                    requestedPrinter = string.IsNullOrWhiteSpace(requestedPrinter) ? null : requestedPrinter,
                    currentPrinter = string.IsNullOrWhiteSpace(currentPrinter) ? null : currentPrinter,
                    installedPrinters = installedPrinters
                };
            }

            if (!string.IsNullOrWhiteSpace(requestedPrinter) &&
                installedPrinters.Count > 0 &&
                !installedPrinters.Any(x => string.Equals(x, requestedPrinter, StringComparison.OrdinalIgnoreCase)))
            {
                return new PrinterPreflight
                {
                    available = false,
                    failureClass = "printer_unavailable",
                    message = "Requested printer is not present in the installed printer list.",
                    requestedPrinter = requestedPrinter,
                    currentPrinter = string.IsNullOrWhiteSpace(currentPrinter) ? null : currentPrinter,
                    installedPrinters = installedPrinters
                };
            }

            return new PrinterPreflight
            {
                available = true,
                failureClass = (string?)null,
                message = string.IsNullOrWhiteSpace(requestedPrinter) ? "Using Revit current printer." : "Requested printer appears available.",
                requestedPrinter = string.IsNullOrWhiteSpace(requestedPrinter) ? null : requestedPrinter,
                currentPrinter = string.IsNullOrWhiteSpace(currentPrinter) ? null : currentPrinter,
                installedPrinters = installedPrinters
            };
        }

        private static List<string> ApplyPrintSettings(PrintManager printManager, Params p, string selectedPrinter)
        {
            var warnings = new List<string>();
            if (!string.IsNullOrWhiteSpace(p.printerName))
            {
                printManager.SelectNewPrintDriver(selectedPrinter);
            }

            if (p.copies.HasValue)
            {
                try
                {
                    printManager.CopyNumber = Math.Max(1, Math.Min(99, p.copies.Value));
                }
                catch (Exception ex)
                {
                    warnings.Add("CopyNumber not applied: " + ex.Message);
                }
            }

            TryApplyBool(warnings, "Collate", p.collate, value => printManager.Collate = value);
            TryApplyBool(warnings, "PrintOrderReverse", p.reverseOrder, value => printManager.PrintOrderReverse = value);
            TryApplyBool(warnings, "PrintToFile", p.printToFile, value => printManager.PrintToFile = value);
            TryApplyBool(warnings, "CombinedFile", p.combinedFile, value => printManager.CombinedFile = value);

            var printToFileName = (p.printToFileName ?? "").Trim();
            if (!string.IsNullOrWhiteSpace(printToFileName))
            {
                try
                {
                    printManager.PrintToFileName = printToFileName;
                }
                catch (Exception ex)
                {
                    warnings.Add("PrintToFileName not applied: " + ex.Message);
                }
            }

            return warnings;
        }

        private static void TryApplyBool(List<string> warnings, string name, bool? value, Action<bool> apply)
        {
            if (!value.HasValue) return;
            try
            {
                apply(value.Value);
            }
            catch (Exception ex)
            {
                warnings.Add(name + " not applied: " + ex.Message);
            }
        }

        private static List<PrintResult> SubmitIndividualPrints(Document doc, PrintManager printManager, List<ExportPdfHandler.ResolvedView> views)
        {
            var results = new List<PrintResult>(views.Count);
            foreach (var selected in views)
            {
                var view = doc.GetElement(selected.ViewId) as View;
                if (view == null)
                {
                    results.Add(PrintResult.Failed(selected, "resolved view was not found"));
                    continue;
                }

                try
                {
                    var ok = printManager.SubmitPrint(view);
                    results.Add(ok ? PrintResult.Ok(selected) : PrintResult.Failed(selected, "SubmitPrint returned false"));
                }
                catch (Exception ex)
                {
                    results.Add(PrintResult.Failed(selected, ex.GetType().Name + ": " + ex.Message));
                }
            }

            return results;
        }

        private static PrintResult SubmitSelectedSetPrint(Document doc, PrintManager printManager, List<ExportPdfHandler.ResolvedView> views)
        {
            var viewSet = new ViewSet();
            foreach (var selected in views)
            {
                var view = doc.GetElement(selected.ViewId) as View;
                if (view != null) viewSet.Insert(view);
            }

            if (viewSet.Size == 0)
            {
                return PrintResult.Failed(views[0], "no printable views were resolved");
            }

            try
            {
                printManager.PrintRange = Autodesk.Revit.DB.PrintRange.Select;
                printManager.ViewSheetSetting.CurrentViewSheetSet.Views = viewSet;
                var ok = printManager.SubmitPrint();
                return ok ? PrintResult.Ok(views[0]) : PrintResult.Failed(views[0], "SubmitPrint returned false");
            }
            catch (Exception ex)
            {
                return PrintResult.Failed(views[0], ex.GetType().Name + ": " + ex.Message);
            }
        }

        private sealed class PrintResult
        {
            public bool ok { get; set; }
            public long viewId { get; set; }
            public string sheetNumber { get; set; } = "";
            public string name { get; set; } = "";
            public string? error { get; set; }

            public static PrintResult Ok(ExportPdfHandler.ResolvedView view)
            {
                return new PrintResult
                {
                    ok = true,
                    viewId = RevitBridge.Common.ElementIdCompat.GetValue(view.ViewId),
                    sheetNumber = view.SheetNumber,
                    name = view.Name
                };
            }

            public static PrintResult Failed(ExportPdfHandler.ResolvedView view, string error)
            {
                return new PrintResult
                {
                    ok = false,
                    viewId = RevitBridge.Common.ElementIdCompat.GetValue(view.ViewId),
                    sheetNumber = view.SheetNumber,
                    name = view.Name,
                    error = error
                };
            }
        }
    }
}
