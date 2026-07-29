using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;

namespace RevitSafeReadProof;

internal sealed class WholeAssemblyVerifier
{
    private readonly string _manifestPath;
    private readonly ProofManifest _manifest;
    private readonly bool _checkExpected;
    private readonly List<ProofIssue> _issues = new();

    public WholeAssemblyVerifier(string manifestPath, ProofManifest manifest, bool checkExpected)
    {
        _manifestPath = manifestPath;
        _manifest = manifest;
        _checkExpected = checkExpected;
    }

    public VerificationResult Run()
    {
        var observation = new ProofObservation();
        var inputs = new InputVerifier(_manifestPath, _manifest, _issues).Verify();
        ValidatePolicyShape();
        observation.Resources = Canonical.Inventory(inputs.Resources.Select(static resource =>
            "RESOURCE|" + resource.LogicalPath + "|name=" + resource.LogicalName + "|public=" + resource.IsPublic + "|sha256=" + Canonical.Sha256(resource.Bytes)), preserveOrder: false);

        if (inputs.Sources.Count != _manifest.Source.Files.Count || inputs.FrameworkReferences.Count != _manifest.Framework.Files.Count)
        {
            Add("INPUTS_INCOMPLETE", "Locked inputs were incomplete; compilation and certification cannot proceed.");
            return Finish(observation);
        }

        var sourceInspector = new SourceInspector(_manifest, inputs, _issues);
        var compiler = new DirectCompiler(_manifest, inputs, _issues);
        SourceInspection? shared = null;

        foreach (var variant in _manifest.Variants.OrderBy(static variant => variant.RevitYear, StringComparer.Ordinal))
        {
            var trees = sourceInspector.Parse(variant);
            var syntax = sourceInspector.InspectSyntax(trees);
            if (shared is null)
            {
                shared = new SourceInspection { Trees = trees, Syntax = syntax };
                observation.Syntax = syntax;
            }
            else if (!InventoryEqual(shared.Syntax, syntax))
            {
                Add("VARIANT_SYNTAX_DRIFT", "Preprocessor variants changed the syntax inventory. Conditional source is forbidden.");
            }

            var compile = compiler.Compile(variant, trees);
            if (shared is not null && shared.Types.Items.Count == 0)
            {
                var declarations = sourceInspector.InspectDeclarations(compile.Compilation);
                shared.Types = declarations.Types;
                shared.Members = declarations.Members;
                shared.SerializationClosure = sourceInspector.InspectSerializationClosure(compile.Compilation);
                observation.Types = shared.Types;
                observation.Members = shared.Members;
                observation.SerializationClosure = shared.SerializationClosure;
                ValidateSensitiveRoles(compile.Compilation);
            }

            var methods = new MethodInspector(_manifest, _issues).Inspect(compile.Compilation);
            var metadata = new MetadataInspector(_issues).Inspect(compile.EmittedBytes);
            observation.Variants[variant.RevitYear] = new VariantObservation
            {
                EmittedBytes = compile.EmittedBytes,
                References = compile.References,
                SymbolBindings = methods.SymbolBindings,
                Methods = methods.Methods,
                Metadata = metadata.Metadata,
                Il = metadata.Il,
                OutputSha256 = Canonical.Sha256(compile.EmittedBytes),
            };
        }

        return Finish(observation);
    }

    private VerificationResult Finish(ProofObservation observation)
    {
        if (_checkExpected)
        {
            CompareExpected(observation);
        }
        _issues.Sort(static (left, right) =>
        {
            var code = string.Compare(left.Code, right.Code, StringComparison.Ordinal);
            return code != 0 ? code : string.Compare(left.Message, right.Message, StringComparison.Ordinal);
        });
        var unique = _issues
            .GroupBy(static issue => issue.Code + "\0" + issue.Message, StringComparer.Ordinal)
            .Select(static group => group.First())
            .ToList();
        return new VerificationResult
        {
            Issues = unique,
            Observation = observation,
        };
    }

    private void CompareExpected(ProofObservation actual)
    {
        if (_manifest.Expected is null)
        {
            Add("EXPECTED_MISSING", "check mode requires a complete frozen expected inventory.");
            return;
        }
        CompareInventory("INVENTORY_SYNTAX", _manifest.Expected.Syntax, actual.Syntax);
        CompareInventory("INVENTORY_TYPES", _manifest.Expected.Types, actual.Types);
        CompareInventory("INVENTORY_MEMBERS", _manifest.Expected.Members, actual.Members);
        CompareInventory("INVENTORY_SERIALIZATION", _manifest.Expected.SerializationClosure, actual.SerializationClosure);
        CompareInventory("INVENTORY_RESOURCES", _manifest.Expected.Resources, actual.Resources);

        var expectedYears = _manifest.Expected.Variants.Keys.OrderBy(static value => value, StringComparer.Ordinal).ToArray();
        var actualYears = actual.Variants.Keys.OrderBy(static value => value, StringComparer.Ordinal).ToArray();
        if (!expectedYears.SequenceEqual(actualYears, StringComparer.Ordinal))
        {
            Add("INVENTORY_VARIANTS", "Expected variant inventory keys differ from observed keys.");
        }
        foreach (var pair in actual.Variants)
        {
            if (!_manifest.Expected.Variants.TryGetValue(pair.Key, out var expected))
            {
                continue;
            }
            CompareInventory("INVENTORY_REFERENCES_" + pair.Key, expected.References, pair.Value.References);
            CompareInventory("INVENTORY_SYMBOL_BINDINGS_" + pair.Key, expected.SymbolBindings, pair.Value.SymbolBindings);
            CompareInventory("INVENTORY_METHODS_" + pair.Key, expected.Methods, pair.Value.Methods);
            CompareInventory("INVENTORY_METADATA_" + pair.Key, expected.Metadata, pair.Value.Metadata);
            CompareInventory("INVENTORY_IL_" + pair.Key, expected.Il, pair.Value.Il);
            if (!string.Equals(expected.OutputSha256, pair.Value.OutputSha256, StringComparison.Ordinal))
            {
                Add("OUTPUT_HASH_" + pair.Key, "Emitted output SHA-256 differs. expected=" + expected.OutputSha256 + " actual=" + pair.Value.OutputSha256 + ".");
            }
        }
    }

    private void CompareInventory(string code, InventoryExpectation expected, InventoryExpectation actual)
    {
        var expectedCanonical = Canonical.Inventory(expected.Items);
        if (expected.Items.Count != 0 &&
            (expected.Count != expected.Items.Count || !string.Equals(expected.Sha256, expectedCanonical.Sha256, StringComparison.Ordinal)))
        {
            Add("EXPECTED_SELF_INCONSISTENT", code + " expected inventory count/hash does not match its own full item list.");
        }
        if (expected.Count != actual.Count ||
            !string.Equals(expected.Sha256, actual.Sha256, StringComparison.Ordinal) ||
            (expected.Items.Count != 0 && !expected.Items.SequenceEqual(actual.Items, StringComparer.Ordinal)))
        {
            var firstDifference = FirstDifference(expected.Items, actual.Items);
            Add(code, "Exact inventory differs. expectedCount=" + expected.Count + " actualCount=" + actual.Count + " expectedSha256=" + expected.Sha256 + " actualSha256=" + actual.Sha256 + " firstDifference=" + firstDifference);
        }
    }

    private void ValidatePolicyShape()
    {
        var hardForbiddenAllowed = _manifest.Policy.AllowedOperationKinds.Where(static kind => kind is
            "AnonymousFunction" or "Await" or "DynamicIndexerAccess" or "DynamicInvocation" or
            "DynamicMemberReference" or "DynamicObjectCreation" or "FunctionPointerInvocation" or
            "Invalid" or "LocalFunction" or "Lock" or "MethodReference" or "None" or "PointerIndirectionReference" or
            "YieldBreak" or "YieldReturn").ToList();
        if (hardForbiddenAllowed.Count != 0)
        {
            Add("POLICY_HARD_FORBIDDEN_KIND", "allowedOperationKinds attempts to allow hard-forbidden kinds: " + string.Join(",", hardForbiddenAllowed) + ".");
        }
        foreach (var kind in _manifest.Policy.AllowedImplicitOperationKinds)
        {
            if (!_manifest.Policy.AllowedOperationKinds.Contains(kind, StringComparer.Ordinal))
            {
                Add("POLICY_IMPLICIT_SUBSET", "Implicit OperationKind is not present in the general operation allowlist: " + kind + ".");
            }
        }
        foreach (var symbol in _manifest.Policy.AllowedSensitiveSymbols)
        {
            var approvedFamily = symbol.Contains("global::System.Net.HttpListener", StringComparison.Ordinal) ||
                                 symbol.Contains("global::System.Threading.Interlocked", StringComparison.Ordinal) ||
                                 symbol.Contains("global::Autodesk.Revit.", StringComparison.Ordinal);
            if (!approvedFamily)
            {
                Add("POLICY_SENSITIVE_FAMILY", "Sensitive allowlist entry is outside exact HttpListener/Interlocked/ExternalEvent families: " + symbol + ".");
            }
        }
        if (_manifest.Policy.AllowedMutableFields.Count != 1)
        {
            Add("POLICY_MUTABLE_STATE_COUNT", "Exactly one mutable ExternalEvent handoff field must be allowlisted.");
        }
        if (_manifest.Policy.SerializationRoots.Count == 0)
        {
            Add("POLICY_SERIALIZATION_ROOTS", "At least one serialization root is required.");
        }
    }

    private void ValidateSensitiveRoles(CSharpCompilation compilation)
    {
        var types = GetSourceTypes(compilation).ToDictionary(Canonical.QualifiedName, StringComparer.Ordinal);
        ValidateFieldRole(types, _manifest.Policy.Roles.HttpListenerOwnerType, _manifest.Policy.Roles.HttpListenerField, "global::System.Net.HttpListener", mustBeReadonly: true, "HTTP_LISTENER_FIELD_ROLE");
        ValidateFieldRole(types, _manifest.Policy.Roles.ExternalEventOwnerType, _manifest.Policy.Roles.ExternalEventField, "global::Autodesk.Revit.UI.ExternalEvent", mustBeReadonly: true, "EXTERNAL_EVENT_FIELD_ROLE");
        var stateField = ValidateFieldRole(types, _manifest.Policy.Roles.ExternalEventHandlerType, _manifest.Policy.Roles.ExternalEventStateField, "global::System.Net.HttpListenerContext", mustBeReadonly: false, "EXTERNAL_EVENT_STATE_ROLE");
        if (stateField is not null && (_manifest.Policy.AllowedMutableFields.Count != 1 || !string.Equals(_manifest.Policy.AllowedMutableFields[0], Canonical.SymbolId(stateField), StringComparison.Ordinal)))
        {
            Add("EXTERNAL_EVENT_STATE_ALLOWLIST", "allowedMutableFields must contain exactly the canonical ExternalEvent handoff field: " + Canonical.SymbolId(stateField) + ".");
        }
        if (!types.TryGetValue(_manifest.Policy.Roles.ExternalEventHandlerType, out var handler))
        {
            Add("EXTERNAL_EVENT_HANDLER_ROLE", "ExternalEvent handler role type was not found.");
        }
        else if (handler.Interfaces.Count() != 1 || Canonical.QualifiedName(handler.Interfaces[0]) != "global::Autodesk.Revit.UI.IExternalEventHandler")
        {
            Add("EXTERNAL_EVENT_HANDLER_ROLE", "ExternalEvent handler must implement exactly Autodesk.Revit.UI.IExternalEventHandler.");
        }
    }

    private IFieldSymbol? ValidateFieldRole(
        IReadOnlyDictionary<string, INamedTypeSymbol> types,
        string ownerName,
        string fieldName,
        string expectedType,
        bool mustBeReadonly,
        string code)
    {
        if (!types.TryGetValue(ownerName, out var owner))
        {
            Add(code, "Role owner type was not found: " + ownerName + ".");
            return null;
        }
        var fields = owner.GetMembers(fieldName).OfType<IFieldSymbol>().ToList();
        if (fields.Count != 1)
        {
            Add(code, "Role must resolve to exactly one field: " + ownerName + "." + fieldName + ".");
            return null;
        }
        var field = fields[0];
        if (!string.Equals(Canonical.QualifiedName(field.Type), expectedType, StringComparison.Ordinal))
        {
            Add(code, "Role field type differs. expected=" + expectedType + " actual=" + Canonical.QualifiedName(field.Type) + ".");
        }
        if (field.IsStatic || field.IsReadOnly != mustBeReadonly)
        {
            Add(code, "Role field static/readonly shape differs for " + Canonical.SymbolId(field) + ".");
        }
        return field;
    }

    private static string FirstDifference(IReadOnlyList<string> expected, IReadOnlyList<string> actual)
    {
        var common = Math.Min(expected.Count, actual.Count);
        for (var index = 0; index < common; index++)
        {
            if (!string.Equals(expected[index], actual[index], StringComparison.Ordinal))
            {
                return "index=" + index + " expected=" + expected[index] + " actual=" + actual[index];
            }
        }
        return expected.Count == actual.Count ? "none" : "index=" + common + " list-length-differs";
    }

    private static bool InventoryEqual(InventoryExpectation left, InventoryExpectation right)
    {
        return left.Count == right.Count &&
               string.Equals(left.Sha256, right.Sha256, StringComparison.Ordinal) &&
               left.Items.SequenceEqual(right.Items, StringComparer.Ordinal);
    }

    private static IEnumerable<INamedTypeSymbol> GetSourceTypes(CSharpCompilation compilation)
    {
        var result = new List<INamedTypeSymbol>();
        VisitNamespace(compilation.Assembly.GlobalNamespace, compilation.Assembly, result);
        return result;
    }

    private static void VisitNamespace(INamespaceSymbol @namespace, IAssemblySymbol sourceAssembly, List<INamedTypeSymbol> result)
    {
        foreach (var member in @namespace.GetMembers())
        {
            if (member is INamespaceSymbol child)
            {
                VisitNamespace(child, sourceAssembly, result);
            }
            else if (member is INamedTypeSymbol type && SymbolEqualityComparer.Default.Equals(type.ContainingAssembly, sourceAssembly))
            {
                result.Add(type);
                foreach (var nested in type.GetTypeMembers())
                {
                    VisitNested(nested, result);
                }
            }
        }
    }

    private static void VisitNested(INamedTypeSymbol type, List<INamedTypeSymbol> result)
    {
        result.Add(type);
        foreach (var nested in type.GetTypeMembers())
        {
            VisitNested(nested, result);
        }
    }

    private void Add(string code, string message)
    {
        _issues.Add(new ProofIssue(code, message));
    }
}
