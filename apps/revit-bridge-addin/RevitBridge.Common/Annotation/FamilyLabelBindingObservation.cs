using System;
using System.Collections.Generic;
using System.Linq;

namespace RevitBridge.Common.Annotation
{
    public static class FamilyLabelBindingObservation
    {
        public sealed class DriverObservation
        {
            internal DriverObservation(string[] names, bool requested, string? error)
            { DriverParameters = names; Requested = requested; Error = error; }

            public string[] DriverParameters { get; }
            public bool Requested { get; }
            public string? Error { get; }
            public object Detail => new
            {
                state = !Requested ? "not_requested" : Error != null ? "read_error"
                    : DriverParameters.Length > 0 ? "references_observed" : "binding_undetermined",
                requested = Requested,
                parameterReadSucceeded = Requested && Error == null,
                bindingDetermined = false,
                coverageComplete = false,
                basis = "ordered_element_parameter_references_to_family_parameters",
                error = Error
            };
        }

        // This reader observes only one exposed reference channel. A missing
        // reference, or even a successful scan, cannot prove label binding.
        public static DriverObservation Observe(Action<ICollection<string>> collect, bool requested = true)
        {
            if (collect == null) throw new ArgumentNullException(nameof(collect));
            var names = new List<string>();
            string? error = null;
            if (requested)
            {
                try { collect(names); }
                catch (Exception exception) { error = exception.GetType().Name; }
            }
            return new DriverObservation(names.Where(name => !string.IsNullOrWhiteSpace(name))
                .Select(name => name.Trim()).Distinct(StringComparer.OrdinalIgnoreCase)
                .OrderBy(name => name, StringComparer.OrdinalIgnoreCase).ToArray(), requested, error);
        }

        public static object ClassifyDriverNames(IEnumerable<string[]> drivers, int staticTextCount,
            int nestedFamilyCount, int nestedAnnotationCount)
            => Classify(drivers.Select(values => Observe(names =>
                { foreach (var value in values) names.Add(value); })), staticTextCount, nestedFamilyCount, nestedAnnotationCount);

        public static object Classify(IEnumerable<DriverObservation> observations, int staticTextCount,
            int nestedFamilyCount, int nestedAnnotationCount)
        {
            var labels = observations.ToArray();
            return new
            {
                staticTextCount,
                // Retained numeric alias counts observed references, not proven
                // parameter-driven text. New consumers should use the named count.
                parameterDrivenLabelCount = labels.Count(value => value.DriverParameters.Length > 0),
                observedDriverReferenceLabelCount = labels.Count(value => value.DriverParameters.Length > 0),
                unboundLabelCount = labels.Length == 0 ? (int?)0 : null,
                bindingUndeterminedLabelCount = labels.Length,
                bindingInspectionComplete = labels.Length == 0,
                scope = "returned_label_rows_only",
                note = "Driver references are partial observations, not complete label binding or compatibility proof. "
                    + "parameterDrivenLabelCount is a legacy alias for observedDriverReferenceLabelCount. "
                    + "Empty driverParameters does not prove an unbound label.",
                nestedFamilyCount,
                nestedAnnotationCount
            };
        }
    }
}
