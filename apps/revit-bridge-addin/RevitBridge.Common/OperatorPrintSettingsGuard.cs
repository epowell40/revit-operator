using System;
using System.Collections.Generic;
using System.Linq;

namespace RevitBridge.Common
{
    /// <summary>Preserve the print settings touched by one native submission and verify restoration from global readback.</summary>
    public sealed class OperatorPrintSettingsGuard
    {
        public static IReadOnlyList<string> FieldsForPrint(bool selectedSet, bool collateRequested)
        {
            var fields = new List<string> { "PrinterName", "PrintToFile", "CombinedFile", "PrintToFileName", "PrintRange", "CopyNumber", "PrintOrderReverse" };
            // Revit cannot read Collate for single-view/single-copy printing.
            // SubmitPrint inherits it unchanged unless the caller explicitly sets it.
            if (collateRequested) fields.Add("Collate");
            if (selectedSet) fields.Add("ViewSelection");
            return fields;
        }

        private readonly IReadOnlyList<string> names;
        private readonly Func<string, object> read;
        private readonly Action<string, object> write;
        private readonly Action apply;
        private readonly Dictionary<string, object> before;

        public OperatorPrintSettingsGuard(IReadOnlyList<string> names, Func<string, object> read,
            Action<string, object> write, Action apply)
        {
            if (names.Count == 0 || names.Distinct(StringComparer.Ordinal).Count() != names.Count)
                throw new ArgumentException("Print settings must have unique field identities.");
            this.names = names; this.read = read; this.write = write; this.apply = apply;
            // Snapshot failures occur before the caller changes or submits anything.
            before = names.ToDictionary(name => name, name => read(name), StringComparer.Ordinal);
        }

        public bool Restore(out IReadOnlyList<string> errors)
        {
            var failures = new List<string>();
            var changed = false;
            foreach (var name in names)
            {
                try
                {
                    if (Equals(read(name), before[name])) continue;
                    changed = true; write(name, before[name]);
                }
                catch (Exception ex) { failures.Add(name + ": " + ex.GetType().Name + ": " + ex.Message); }
            }
            if (changed)
            {
                try { apply(); }
                catch (Exception ex) { failures.Add("Apply: " + ex.GetType().Name + ": " + ex.Message); }
            }
            foreach (var name in names)
            {
                try { if (!Equals(read(name), before[name])) failures.Add(name + ": global readback differs"); }
                catch (Exception ex) { failures.Add(name + ": readback failed: " + ex.Message); }
            }
            errors = failures;
            return failures.Count == 0;
        }
    }
}
