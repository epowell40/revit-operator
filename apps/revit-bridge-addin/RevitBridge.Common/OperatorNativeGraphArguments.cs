using System;
using System.Collections;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;

namespace RevitBridge.Common
{
    public sealed class NativeGraphArgument
    {
        public object? Value { get; }
        public IReadOnlyList<object> Owners { get; }
        public NativeGraphArgument(object? value, IEnumerable<object>? owners = null)
        { Value = value; Owners = (owners ?? Array.Empty<object>()).ToArray(); }
    }

    /// <summary>One request's bounded typed references; no object deserialization or persistent handles.</summary>
    public sealed class OperatorNativeGraphArguments
    {
        public const int MaxCollectionItems = 64;
        public const int MaxDepth = 4;
        public const int MaxNodes = 256;
        private int _nodes;

        public NativeGraphArgument Resolve(JsonElement input, Type type,
            Func<string, NativeGraphArgument?> lookup, Func<JsonElement, Type, object?> literal,
            Func<Type, bool> referenceOnly, Func<object, Type, object?>? referenceAdapter = null,
            Func<object, object?>? intrinsicOwner = null)
            => ResolveCore(input, type, lookup, literal, referenceOnly, referenceAdapter, intrinsicOwner, 0);

        private NativeGraphArgument ResolveCore(JsonElement input, Type type,
            Func<string, NativeGraphArgument?> lookup, Func<JsonElement, Type, object?> literal,
            Func<Type, bool> referenceOnly, Func<object, Type, object?>? referenceAdapter,
            Func<object, object?>? intrinsicOwner, int depth)
        {
            if (++_nodes > MaxNodes) throw new InvalidOperationException("Native graph argument node budget exceeded.");
            if (depth > MaxDepth) throw new InvalidOperationException("Native graph collection nesting limit exceeded.");
            if (input.ValueKind == JsonValueKind.Object && input.TryGetProperty("$ref", out var token))
            {
                if (input.EnumerateObject().Count() != 1 || token.ValueKind != JsonValueKind.String || string.IsNullOrWhiteSpace(token.GetString()))
                    throw new InvalidOperationException("Native graph reference must contain only a non-empty $ref string.");
                var id = token.GetString()!.Trim().TrimStart('$');
                var found = lookup(id) ?? throw new InvalidOperationException("Native graph reference was not found: $" + id);
                if (found.Value == null)
                {
                    if (referenceOnly(type) || type.IsValueType && Nullable.GetUnderlyingType(type) == null)
                        throw new InvalidOperationException("Native graph reference cannot be null for " + type.FullName);
                    return new NativeGraphArgument(null, found.Owners);
                }
                var converted = type.IsInstanceOfType(found.Value) ? found.Value : referenceAdapter?.Invoke(found.Value, type);
                if (converted == null || !type.IsInstanceOfType(converted))
                    throw new InvalidOperationException("Native graph reference $" + id + " is not assignable to " + type.FullName);
                var discoveredOwners = ValidateReferencedCollection(converted, type, intrinsicOwner, depth);
                return new NativeGraphArgument(converted, MergeOwners(found.Owners.Concat(discoveredOwners)));
            }
            var elementType = CollectionElementType(type);
            if (elementType != null)
            {
                if (input.ValueKind != JsonValueKind.Array) throw new InvalidOperationException("Native graph collection argument must be an array.");
                if (input.GetArrayLength() > MaxCollectionItems) throw new InvalidOperationException("Native graph collection item limit exceeded.");
                var items = new List<object?>();
                var owners = new List<object>();
                foreach (var item in input.EnumerateArray())
                {
                    var resolved = ResolveCore(item, elementType, lookup, literal, referenceOnly, referenceAdapter, intrinsicOwner, depth + 1);
                    items.Add(resolved.Value); owners.AddRange(resolved.Owners);
                }
                object output;
                if (type.IsArray)
                {
                    var array = Array.CreateInstance(elementType, items.Count);
                    for (var i = 0; i < items.Count; i++) array.SetValue(items[i], i);
                    output = array;
                }
                else
                {
                    var list = (IList)Activator.CreateInstance(typeof(List<>).MakeGenericType(elementType))!;
                    foreach (var item in items) list.Add(item);
                    output = list;
                }
                return new NativeGraphArgument(output, MergeOwners(owners));
            }
            if (referenceOnly(type)) throw new InvalidOperationException("Native graph " + type.FullName + " requires a prior typed $ref.");
            return new NativeGraphArgument(literal(input, type));
        }

        private IReadOnlyList<object> ValidateReferencedCollection(object? value, Type type, Func<object, object?>? intrinsicOwner, int depth)
        {
            var owners = new List<object>();
            var owner = value == null ? null : intrinsicOwner?.Invoke(value);
            if (owner != null) owners.Add(owner);
            var elementType = CollectionElementType(type);
            if (elementType == null || value == null) return owners;
            if (depth >= MaxDepth) throw new InvalidOperationException("Native graph collection nesting limit exceeded.");
            var count = 0;
            foreach (var item in (IEnumerable)value)
            {
                if (++count > MaxCollectionItems || ++_nodes > MaxNodes)
                    throw new InvalidOperationException("Native graph referenced collection limit exceeded.");
                if (item != null && !elementType.IsInstanceOfType(item))
                    throw new InvalidOperationException("Native graph referenced collection item has incompatible type.");
                owners.AddRange(ValidateReferencedCollection(item, elementType, intrinsicOwner, depth + 1));
            }
            return MergeOwners(owners);
        }

        public static Type? CollectionElementType(Type type)
        {
            if (type.IsArray && type.GetArrayRank() == 1) return type.GetElementType();
            if (!type.IsGenericType) return null;
            var definition = type.GetGenericTypeDefinition();
            return definition == typeof(List<>) || definition == typeof(IList<>) || definition == typeof(IEnumerable<>) || definition == typeof(IReadOnlyList<>)
                ? type.GetGenericArguments()[0] : null;
        }

        public static IReadOnlyList<object> MergeOwners(IEnumerable<object> owners)
        {
            var result = new List<object>();
            var seen = 0;
            foreach (var owner in owners)
            {
                if (++seen > MaxNodes) throw new InvalidOperationException("Native graph owner provenance limit exceeded.");
                if (!result.Any(existing => ReferenceEquals(existing, owner))) result.Add(owner);
            }
            return result;
        }

        public static void RequireActiveOwners(IEnumerable<object> owners, object active, Func<object, object, bool> sameDocument)
        {
            var all = MergeOwners(owners);
            if (all.Count == 0) throw new InvalidOperationException("Native mutation could not prove active-document ownership.");
            if (all.Any(owner => !sameDocument(owner, active)))
                throw new InvalidOperationException("Native mutation contains a target or argument owned by another document.");
        }
    }

    /// <summary>Trusted reflected signature classification, never supplied by graph input.</summary>
    public static class OperatorNativeGeometryGraphPolicy
    {
        public static bool IsReferenceOnlyType(string? name)
            => name == "Autodesk.Revit.DB.Curve" || name == "Autodesk.Revit.DB.CurveLoop"
                || name == "Autodesk.Revit.DB.Solid" || name == "Autodesk.Revit.DB.GeometryObject";

        public static bool IsDetachedFactory(string declaringType, string name, bool isStatic, string returnType, params string[] parameters)
        {
            if (!isStatic) return false;
            var xyz = "Autodesk.Revit.DB.XYZ";
            if (declaringType == "Autodesk.Revit.DB.Line" && name == "CreateBound" && returnType == declaringType)
                return parameters.SequenceEqual(new[] { xyz, xyz });
            if (declaringType == "Autodesk.Revit.DB.Arc" && name == "Create" && returnType == declaringType)
                return parameters.SequenceEqual(new[] { xyz, xyz, xyz });
            if (declaringType == "Autodesk.Revit.DB.CurveLoop" && name == "Create" && returnType == declaringType)
                return parameters.SequenceEqual(new[] { "System.Collections.Generic.IList`1<Autodesk.Revit.DB.Curve>" });
            if (declaringType == "Autodesk.Revit.DB.GeometryCreationUtilities" && name == "CreateExtrusionGeometry" && returnType == "Autodesk.Revit.DB.Solid")
                return parameters.SequenceEqual(new[] { "System.Collections.Generic.IList`1<Autodesk.Revit.DB.CurveLoop>", xyz, "System.Double" });
            return false;
        }
    }

    public static class OperatorNativeGraphFailureSettlement
    {
        // A missing status delegate is only valid when no Transaction was created.
        public static Dictionary<string, object?> Capture(Exception failure, Func<string>? getStatus,
            Func<string>? rollback, Func<OperatorNativeTransactionReceipt> committedInventory)
        {
            var errors = new List<string> { failure.Message };
            var status = "Uninitialized";
            if (getStatus != null)
            {
                try { status = getStatus(); }
                catch (Exception ex) { status = "unknown"; errors.Add(ex.Message); }
                if (status == "Started")
                {
                    try { status = rollback?.Invoke() ?? "unknown"; }
                    catch (Exception ex)
                    {
                        errors.Add(ex.Message);
                        try { status = getStatus(); }
                        catch (Exception statusError) { status = "unknown"; errors.Add(statusError.Message); }
                    }
                }
            }
            var receipt = OperatorNativeTransactionReceipt.FromObservedStatus(status, Array.Empty<long>());
            if (status == "Committed")
            {
                try
                {
                    var inventory = committedInventory();
                    if (inventory.Status != "committed" || inventory.CommittedValue != true)
                        throw new InvalidOperationException("Graph inventory contradicts observed commit.");
                    receipt = inventory;
                }
                catch (Exception ex) { errors.Add(ex.Message); }
            }
            var result = new Dictionary<string, object?>
            {
                ["ok"] = false, ["success"] = false, ["error"] = string.Join("; ", errors),
                ["transaction"] = receipt, ["applied"] = receipt.CommittedValue
            };
            result["status"] = OperatorNativeTransactionExecution.OutcomeStatus(result, "Success");
            return result;
        }
    }
}
