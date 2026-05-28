using System;
using System.Reflection;
using Autodesk.Revit.DB;

namespace RevitBridge.Common
{
    public static class ElementIdCompat
    {
        private static readonly PropertyInfo? ValueProperty = typeof(ElementId).GetProperty("Value", BindingFlags.Public | BindingFlags.Instance);
        private static readonly PropertyInfo? IntegerValueProperty = typeof(ElementId).GetProperty("IntegerValue", BindingFlags.Public | BindingFlags.Instance);
        private static readonly ConstructorInfo? LongCtor = typeof(ElementId).GetConstructor(new[] { typeof(long) });
        private static readonly ConstructorInfo? IntCtor = typeof(ElementId).GetConstructor(new[] { typeof(int) });

        public static long GetValue(ElementId? id)
        {
            if (id == null) return -1;

            if (ValueProperty != null)
            {
                var raw = ValueProperty.GetValue(id);
                if (raw is long l) return l;
                if (raw is int i) return i;
            }

            if (IntegerValueProperty != null)
            {
                var raw = IntegerValueProperty.GetValue(id);
                if (raw is int i) return i;
                if (raw is long l) return l;
            }

            return -1;
        }

        public static ElementId Create(long value)
        {
            if (LongCtor != null)
            {
                return (ElementId)LongCtor.Invoke(new object[] { value });
            }

            if (IntCtor != null)
            {
                if (value > int.MaxValue || value < int.MinValue)
                {
                    throw new ArgumentOutOfRangeException(nameof(value), "ElementId value is outside Int32 range for this Revit API version.");
                }

                return (ElementId)IntCtor.Invoke(new object[] { (int)value });
            }

            throw new InvalidOperationException("Unable to construct Autodesk.Revit.DB.ElementId for the current Revit API version.");
        }
    }
}
