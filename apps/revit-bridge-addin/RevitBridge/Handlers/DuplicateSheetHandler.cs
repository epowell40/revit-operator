using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitBridge.Common;

namespace RevitBridge.Handlers
{
    public sealed class DuplicateSheetHandler : IRequestHandler
    {
        public sealed class Params
        {
            public long? sourceSheetId { get; set; }
            public string? sourceSheetNumber { get; set; }
            public string? sourceQuery { get; set; }
            public string? option { get; set; }
            public string? newNumber { get; set; }
            public string? newName { get; set; }
            public bool? dryRun { get; set; }
            public bool? verify { get; set; }
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var request = string.IsNullOrWhiteSpace(jsonData) ? new Params() : JsonSerializer.Deserialize<Params>(jsonData) ?? new Params();
            var doc = app.ActiveUIDocument?.Document ?? throw new InvalidOperationException("No active Revit document.");
            var source = ResolveSource(doc, request);
            var optionName = ResolveOptionName(request.option);
            var targetNumber = string.IsNullOrWhiteSpace(request.newNumber) ? NextSheetNumber(doc, source.SheetNumber) : request.newNumber!.Trim();
            var targetName = string.IsNullOrWhiteSpace(request.newName) ? $"{source.Name} Copy" : RevitTextCasePolicy.NormalizeSheetName(request.newName);
            var plan = new
            {
                sourceSheetId = ElementIdCompat.GetValue(source.Id), sourceSheetNumber = source.SheetNumber,
                sourceSheetName = source.Name, option = NormalizeOption(request.option), newNumber = targetNumber, newName = targetName
            };
            if (request.dryRun == true) return Task.FromResult<object>(new { ok = true, dryRun = true, plan });

            ViewSheet duplicate;
            using (var transaction = new Transaction(doc, "Duplicate Sheet"))
            {
                transaction.Start();
                try
                {
                    var duplicateId = InvokeNativeDuplicate(source, optionName);
                    duplicate = doc.GetElement(duplicateId) as ViewSheet ?? throw new InvalidOperationException("Revit did not return the duplicated sheet.");
                    duplicate.SheetNumber = targetNumber;
                    duplicate.Name = targetName;
                    transaction.Commit();
                }
                catch
                {
                    if (transaction.GetStatus() == TransactionStatus.Started) transaction.RollBack();
                    throw;
                }
            }

            var viewportCount = duplicate.GetAllViewports().Count;
            var scheduleCount = new FilteredElementCollector(doc, duplicate.Id).OfClass(typeof(ScheduleSheetInstance)).Cast<ScheduleSheetInstance>()
                .Count(instance => !instance.IsTitleblockRevisionSchedule);
            var verified = request.verify == false || (doc.GetElement(duplicate.Id) is ViewSheet readback &&
                string.Equals(readback.SheetNumber, targetNumber, StringComparison.Ordinal) && string.Equals(readback.Name, targetName, StringComparison.Ordinal));
            return Task.FromResult<object>(new
            {
                ok = true, dryRun = false, applied = true, verified, plan,
                sheet = new { id = ElementIdCompat.GetValue(duplicate.Id), number = duplicate.SheetNumber, name = duplicate.Name, viewportCount, scheduleCount }
            });
        }

        private static ViewSheet ResolveSource(Document doc, Params request)
        {
            var sheets = new FilteredElementCollector(doc).OfClass(typeof(ViewSheet)).Cast<ViewSheet>().Where(sheet => !sheet.IsPlaceholder).ToList();
            if (request.sourceSheetId.HasValue && request.sourceSheetId.Value > 0)
            {
                var byId = doc.GetElement(ElementIdCompat.Create(request.sourceSheetId.Value)) as ViewSheet;
                if (byId == null || byId.IsPlaceholder) throw new InvalidOperationException($"Source sheet {request.sourceSheetId.Value} was not found.");
                return byId;
            }
            if (!string.IsNullOrWhiteSpace(request.sourceSheetNumber))
            {
                var number = request.sourceSheetNumber.Trim();
                var exact = sheets.Where(sheet => string.Equals(sheet.SheetNumber, number, StringComparison.OrdinalIgnoreCase)).ToList();
                if (exact.Count == 1) return exact[0];
                if (exact.Count == 0) throw new InvalidOperationException($"Source sheet number '{number}' was not found.");
                throw new InvalidOperationException($"Source sheet number '{number}' is ambiguous.");
            }
            if (!string.IsNullOrWhiteSpace(request.sourceQuery))
            {
                var query = request.sourceQuery.Trim();
                var matches = sheets.Where(sheet => sheet.SheetNumber.IndexOf(query, StringComparison.OrdinalIgnoreCase) >= 0 ||
                    sheet.Name.IndexOf(query, StringComparison.OrdinalIgnoreCase) >= 0).ToList();
                if (matches.Count == 1) return matches[0];
                if (matches.Count == 0) throw new InvalidOperationException($"No source sheet matched '{query}'.");
                throw new InvalidOperationException($"Source sheet query '{query}' matched {matches.Count} sheets; use sourceSheetId or sourceSheetNumber.");
            }
            throw new InvalidOperationException("sourceSheetId, sourceSheetNumber, or sourceQuery is required.");
        }

        private static string NormalizeOption(string? value) => (value ?? "views_and_detailing").Trim().ToLowerInvariant().Replace('-', '_').Replace(' ', '_');

        private static string ResolveOptionName(string? value)
        {
            var names = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
            {
                ["empty"] = "DuplicateEmptySheet", ["detailing"] = "DuplicateSheetWithDetailing",
                ["views_only"] = "DuplicateSheetWithViewsOnly", ["views_and_detailing"] = "DuplicateSheetWithViewsAndDetailing",
                ["views_as_dependent"] = "DuplicateSheetWithViewsAsDependent"
            };
            if (!names.TryGetValue(NormalizeOption(value), out var optionName))
                throw new InvalidOperationException("option must be empty, detailing, views_only, views_and_detailing, or views_as_dependent.");
            return optionName;
        }

        private static ElementId InvokeNativeDuplicate(ViewSheet source, string optionName)
        {
            var enumType = Type.GetType("Autodesk.Revit.DB.SheetDuplicateOption, RevitAPI", throwOnError: false);
            if (enumType == null || !enumType.IsEnum) throw new InvalidOperationException("This Revit version does not expose the native sheet-duplication API.");
            var method = typeof(ViewSheet).GetMethod("Duplicate", BindingFlags.Public | BindingFlags.Instance, null, new[] { enumType }, null);
            if (method == null) throw new InvalidOperationException("This Revit version does not expose ViewSheet.Duplicate.");
            object option;
            try { option = Enum.Parse(enumType, optionName, ignoreCase: false); }
            catch (Exception ex) { throw new InvalidOperationException($"This Revit version does not support sheet duplication option {optionName}.", ex); }
            try { return method.Invoke(source, new[] { option }) as ElementId ?? throw new InvalidOperationException("Revit returned no duplicated sheet id."); }
            catch (TargetInvocationException ex) { throw new InvalidOperationException(ex.InnerException?.Message ?? ex.Message, ex.InnerException ?? ex); }
        }

        private static string NextSheetNumber(Document doc, string sourceNumber)
        {
            var existing = new HashSet<string>(new FilteredElementCollector(doc).OfClass(typeof(ViewSheet)).Cast<ViewSheet>().Select(sheet => sheet.SheetNumber), StringComparer.OrdinalIgnoreCase);
            var basis = string.IsNullOrWhiteSpace(sourceNumber) ? "SHEET" : sourceNumber.Trim();
            var candidate = $"{basis}-COPY";
            if (!existing.Contains(candidate)) return candidate;
            for (var index = 2; index <= 9999; index++) { candidate = $"{basis}-COPY-{index}"; if (!existing.Contains(candidate)) return candidate; }
            throw new InvalidOperationException("Could not generate a unique duplicated sheet number.");
        }
    }
}
