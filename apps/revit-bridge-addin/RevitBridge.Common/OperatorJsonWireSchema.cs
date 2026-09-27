using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;

namespace RevitBridge.Common
{
    /// <summary>Describe serialized JSON values, never their CLR inspection properties.</summary>
    public static class OperatorJsonWireSchema
    {
        /// <summary>String-key dictionaries serialize as JSON property maps, not CLR property bags.</summary>
        public static bool TryCreateDictionary(Type type, Func<Type, object> valueSchema, out object? schema)
        {
            schema = null;
            var contracts = new[] { type }.Concat(type.GetInterfaces()).Where(candidate =>
                candidate.IsGenericType && (candidate.GetGenericTypeDefinition() == typeof(IDictionary<,>)
                    || candidate.GetGenericTypeDefinition() == typeof(IReadOnlyDictionary<,>))).ToArray();
            if (contracts.Length == 0 || contracts.Any(candidate => candidate.GetGenericArguments()[0] != typeof(string))) return false;
            var values = contracts.Select(candidate => candidate.GetGenericArguments()[1]).Distinct().ToArray();
            if (values.Length != 1) return false;
            // The caller owns recursive DTO/list expansion and its depth limit.
            schema = new Dictionary<string, object> { ["type"] = "object", ["additionalProperties"] = valueSchema(values[0]) };
            return true;
        }

        public static bool TryCreate(Type type, out object? schema)
        {
            schema = null;
            var scalarType = type == typeof(string) ? "string"
                : type == typeof(bool) ? "boolean"
                : type == typeof(int) || type == typeof(long) || type == typeof(short) ? "integer"
                : type == typeof(double) || type == typeof(float) || type == typeof(decimal) ? "number" : null;
            if (scalarType != null)
            {
                schema = new Dictionary<string, object> { ["type"] = scalarType };
                return true;
            }
            if (type != typeof(JsonElement) && type != typeof(JsonDocument) && type != typeof(object)) return false;
            // These types serialize as the JSON they hold (object, array, scalar,
            // or null). The empty JSON Schema accepts that wire representation.
            // A consuming handler still validates its own domain payload.
            schema = new Dictionary<string, object>();
            return true;
        }
    }
}
