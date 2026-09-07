using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;

namespace RevitBridge.Common
{
    /// <summary>Recover property presence without treating nullable selectors or false flags as mandatory.</summary>
    public static class OperatorRequestPropertyPresence
    {
        public static bool IsRequired(PropertyInfo property, object? defaultValue, bool isDefaultValue)
        {
            if (property == null) throw new ArgumentNullException(nameof(property));
            if (property.GetCustomAttributesData().Any(attribute =>
                attribute.AttributeType.FullName == "System.Text.Json.Serialization.JsonRequiredAttribute" ||
                attribute.AttributeType.FullName == "System.Runtime.CompilerServices.RequiredMemberAttribute")) return true;

            var type = property.PropertyType;
            // Omitted Boolean controls deserialize to their native default.
            // Required approval/commit values remain enforced by explicit
            // request schemas and native domain/admission validators.
            if (type == typeof(bool)) return false;
            if (type == typeof(string) && defaultValue == null) return NullableReferenceFlag(property) != 2;
            return type.IsValueType && Nullable.GetUnderlyingType(type) == null && isDefaultValue;
        }

        private static byte? NullableReferenceFlag(PropertyInfo property)
        {
            // Read compiler metadata directly so net48 and net8 agree. Do not
            // instantiate attributes or depend on net6 NullabilityInfoContext.
            var direct = Flag(property.GetCustomAttributesData(), "NullableAttribute");
            if (direct.HasValue) return direct;
            var getter = property.GetGetMethod();
            if (getter != null)
            {
                direct = Flag(getter.ReturnParameter.GetCustomAttributesData(), "NullableAttribute")
                    ?? Flag(getter.GetCustomAttributesData(), "NullableContextAttribute");
                if (direct.HasValue) return direct;
            }
            for (var declaring = property.DeclaringType; declaring != null; declaring = declaring.DeclaringType)
            {
                var context = Flag(declaring.GetCustomAttributesData(), "NullableContextAttribute");
                if (context.HasValue) return context;
            }
            return null; // Preserve the legacy requirement when metadata is unknown.
        }

        private static byte? Flag(IList<CustomAttributeData> attributes, string name)
        {
            var attribute = attributes.FirstOrDefault(item =>
                item.AttributeType.FullName == "System.Runtime.CompilerServices." + name);
            if (attribute == null || attribute.ConstructorArguments.Count != 1) return null;
            var value = attribute.ConstructorArguments[0].Value;
            if (value is byte scalar) return scalar;
            if (value is IList<CustomAttributeTypedArgument> flags && flags.Count > 0 && flags[0].Value is byte first) return first;
            return null;
        }
    }
}
