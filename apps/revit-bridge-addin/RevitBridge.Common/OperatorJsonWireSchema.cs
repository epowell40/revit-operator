using System;
using System.Collections.Generic;
using System.Text.Json;

namespace RevitBridge.Common
{
    /// <summary>Describe serialized JSON values, never their CLR inspection properties.</summary>
    public static class OperatorJsonWireSchema
    {
        public static bool TryCreate(Type type, out object? schema)
        {
            schema = null;
            if (type != typeof(JsonElement) && type != typeof(JsonDocument) && type != typeof(object)) return false;
            // These types serialize as the JSON they hold (object, array, scalar,
            // or null). The empty JSON Schema accepts that wire representation.
            // A consuming handler still validates its own domain payload.
            schema = new Dictionary<string, object>();
            return true;
        }
    }
}
