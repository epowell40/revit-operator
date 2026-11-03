using System;
using Autodesk.Revit.DB;

namespace RevitBridge.Common
{
    /// <summary>Selected native identity/name fields. Not a write receipt or
    /// a claim about all views, schedule membership, or rendered appearance.</summary>
    public sealed class NativeViewNameObservation
    {
        public long elementId { get; private set; }
        public string uniqueId { get; private set; } = "";
        public long parameterId => (long)BuiltInParameter.VIEW_NAME;
        public string parameterName { get; private set; } = "";
        public string name { get; private set; } = "";
        public long familyParameterId => (long)BuiltInParameter.VIEW_FAMILY_AND_TYPE_SCHEDULES;
        public string familyParameterName { get; private set; } = "";
        public string familyAndType { get; private set; } = "";

        private NativeViewNameObservation() { }

        public static NativeViewNameObservation Create(long id, string uid, string parameterName,
            string name, string familyParameterName, string familyAndType)
        {
            bool Valid(string value) => !string.IsNullOrWhiteSpace(value) && value.Length <= 256
                && Array.TrueForAll(value.ToCharArray(), c => !char.IsControl(c));
            if (id <= 0 || !Valid(uid) || !Valid(parameterName) || !Valid(name)
                || !Valid(familyParameterName) || !Valid(familyAndType))
                throw new ArgumentException("Finite selected native view-name identity fields are required.");
            return new NativeViewNameObservation { elementId = id, uniqueId = uid,
                parameterName = parameterName, name = name, familyParameterName = familyParameterName,
                familyAndType = familyAndType };
        }

        public static NativeViewNameObservation Read(View view)
        {
            if (view == null) throw new ArgumentNullException(nameof(view));
            var name = view.get_Parameter(BuiltInParameter.VIEW_NAME);
            var family = view.get_Parameter(BuiltInParameter.VIEW_FAMILY_AND_TYPE_SCHEDULES);
            if (name == null || family == null || name.StorageType != StorageType.String
                || family.StorageType != StorageType.String || name.AsString() != view.Name)
                throw new InvalidOperationException("Selected view name/type observation is unavailable or inconsistent.");
            return Create(ElementIdCompat.GetValue(view.Id), view.UniqueId, name.Definition.Name,
                name.AsString(), family.Definition.Name, family.AsString());
        }
    }
}
