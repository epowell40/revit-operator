using System;
using System.Collections.Generic;
using System.Linq;
using Autodesk.Revit.DB;
using RevitBridge.Common;

namespace RevitBridge.Handlers
{
    internal sealed class PrintSettingsPreservation
    {
        private readonly Document document;
        private PrintManager restoreManager;
        private readonly OperatorPrintSettingsGuard guard;

        internal PrintSettingsPreservation(Document document, bool selectedSet)
        {
            this.document = document;
            restoreManager = document.PrintManager;
            var names = new List<string> { "PrinterName", "PrintToFile", "CombinedFile", "PrintToFileName", "PrintRange", "CopyNumber", "PrintOrderReverse", "Collate" };
            if (selectedSet) names.Add("ViewSelection");
            guard = new OperatorPrintSettingsGuard(names, name => Read(document.PrintManager, name), Write, () => restoreManager.Apply());
        }

        private static object Read(PrintManager manager, string name)
        {
            if (name == "ViewSelection")
            {
                // ViewSheetSetting requires Select on this local manager; do not apply it globally.
                manager.PrintRange = PrintRange.Select;
                return string.Join(",", manager.ViewSheetSetting.CurrentViewSheetSet.Views.Cast<View>()
                    .Select(view => ElementIdCompat.GetValue(view.Id)).OrderBy(id => id));
            }
            // Fixed, reviewed PrintManager properties; no caller-controlled reflection.
            return typeof(PrintManager).GetProperty(name)!.GetValue(manager, null)!;
        }

        private void Write(string name, object value)
        {
            if (name == "PrinterName") { restoreManager.SelectNewPrintDriver((string)value); return; }
            if (name == "ViewSelection")
            {
                var views = new ViewSet();
                foreach (var text in ((string)value).Split(new[] { ',' }, StringSplitOptions.RemoveEmptyEntries))
                {
                    var view = document.GetElement(ElementIdCompat.Create(long.Parse(text))) as View;
                    if (view == null) throw new InvalidOperationException("Original print selection view is missing.");
                    views.Insert(view);
                }
                var range = restoreManager.PrintRange;
                try
                {
                    restoreManager.PrintRange = PrintRange.Select;
                    restoreManager.ViewSheetSetting.CurrentViewSheetSet.Views = views;
                }
                finally { restoreManager.PrintRange = range; }
                return;
            }
            typeof(PrintManager).GetProperty(name)!.SetValue(restoreManager, value, null);
        }

        internal bool Restore(out IReadOnlyList<string> errors)
        {
            restoreManager = document.PrintManager;
            return guard.Restore(out errors);
        }
    }
}
