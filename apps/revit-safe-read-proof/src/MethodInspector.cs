using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.FlowAnalysis;
using Microsoft.CodeAnalysis.Operations;

namespace RevitSafeReadProof;

internal sealed class MethodInspection
{
    public InventoryExpectation Methods { get; set; } = new();
    public InventoryExpectation SymbolBindings { get; set; } = new();
    public List<string> SerializationCallsites { get; set; } = new();
    public List<string> SerializationRoots { get; set; } = new();
}

internal sealed class MethodInspector
{
    private static readonly HashSet<string> HardForbiddenOperationKinds = new(StringComparer.Ordinal)
    {
        "AnonymousFunction",
        "Await",
        "DynamicIndexerAccess",
        "DynamicInvocation",
        "DynamicMemberReference",
        "DynamicObjectCreation",
        "FunctionPointerInvocation",
        "Invalid",
        "LocalFunction",
        "Lock",
        "MethodReference",
        "None",
        "PointerIndirectionReference",
        "Utf8String",
        "YieldBreak",
        "YieldReturn",
    };

    private readonly ProofManifest _manifest;
    private readonly HashSet<string> _allowedSensitiveSymbols;
    private readonly List<ProofIssue> _issues;

    public MethodInspector(ProofManifest manifest, VariantLock variant, List<ProofIssue> issues)
    {
        _manifest = manifest;
        _allowedSensitiveSymbols = CertifiedKernelProfile.AllowedSensitiveSymbols(variant);
        _issues = issues;
    }

    public MethodInspection Inspect(CSharpCompilation compilation)
    {
        var methodLines = new List<string>();
        var bindings = new List<string>();
        var serializationCallsites = new List<string>();
        var serializationRoots = new List<string>();
        var sourceMethods = GetSourceTypes(compilation)
            .SelectMany(static type => type.GetMembers().OfType<IMethodSymbol>())
            .OrderBy(Canonical.SymbolId, StringComparer.Ordinal)
            .ToList();

        foreach (var method in sourceMethods)
        {
            var methodId = Canonical.SymbolId(method);
            methodLines.Add("METHOD|" + methodId + "|implicit=" + method.IsImplicitlyDeclared + "|syntaxRefs=" + method.DeclaringSyntaxReferences.Length);
            if (method.IsImplicitlyDeclared)
            {
                Add("METHOD_BODY_MISSING", "Implicit method/accessor/constructor has no auditable source CFG: " + methodId + ".");
                continue;
            }
            if (method.DeclaringSyntaxReferences.Length != 1)
            {
                Add("METHOD_SOURCE_COUNT", "Method must have exactly one source declaration: " + methodId + ".");
                continue;
            }
            var node = method.DeclaringSyntaxReferences[0].GetSyntax();
            var model = compilation.GetSemanticModel(node.SyntaxTree, ignoreAccessibility: false);
            ControlFlowGraph? graph;
            try
            {
                graph = ControlFlowGraph.Create(node, model);
            }
            catch (ArgumentException exception)
            {
                Add("CFG_CREATE", "Could not create CFG for " + methodId + ": " + exception.Message);
                continue;
            }
            if (graph is null)
            {
                Add("CFG_CREATE", "Roslyn returned no CFG for " + methodId + ".");
                continue;
            }

            foreach (var block in graph.Blocks)
            {
                methodLines.Add(
                    "BLOCK|" + methodId +
                    "|ordinal=" + block.Ordinal +
                    "|kind=" + block.Kind +
                    "|reachable=" + block.IsReachable +
                    "|condition=" + block.ConditionKind +
                    "|region=" + RegionId(block.EnclosingRegion));
                if (!block.IsReachable)
                {
                    Add("CFG_UNREACHABLE", methodId + " contains unreachable CFG block " + block.Ordinal + ".");
                }
                foreach (var predecessor in block.Predecessors.OrderBy(static branch => branch.Source.Ordinal))
                {
                    methodLines.Add("EDGE|" + methodId + "|from=" + predecessor.Source.Ordinal + "|to=" + block.Ordinal + "|semantics=" + predecessor.Semantics + "|conditional=" + predecessor.IsConditionalSuccessor + "|regions=" + BranchRegions(predecessor));
                }

                var operationOrdinal = 0;
                foreach (var operation in block.Operations)
                {
                    VisitOperation(operation, method, block.Ordinal, ref operationOrdinal, methodLines, bindings, serializationCallsites, serializationRoots, 0);
                }
                if (block.BranchValue is not null)
                {
                    methodLines.Add("BRANCH_VALUE|" + methodId + "|block=" + block.Ordinal);
                    VisitOperation(block.BranchValue, method, block.Ordinal, ref operationOrdinal, methodLines, bindings, serializationCallsites, serializationRoots, 0);
                }
                AddSuccessor(methodLines, methodId, block.Ordinal, "fallthrough", block.FallThroughSuccessor);
                AddSuccessor(methodLines, methodId, block.Ordinal, "conditional", block.ConditionalSuccessor);
            }
        }

        return new MethodInspection
        {
            Methods = Canonical.Inventory(methodLines),
            SymbolBindings = Canonical.Inventory(bindings),
            SerializationCallsites = serializationCallsites.Distinct(StringComparer.Ordinal).ToList(),
            SerializationRoots = serializationRoots.Distinct(StringComparer.Ordinal).ToList(),
        };
    }

    private void VisitOperation(
        IOperation operation,
        IMethodSymbol containingMethod,
        int blockOrdinal,
        ref int ordinal,
        List<string> methodLines,
        List<string> bindings,
        List<string> serializationCallsites,
        List<string> serializationRoots,
        int depth)
    {
        var currentOrdinal = ordinal++;
        var kind = operation.Kind.ToString();
        var methodId = Canonical.SymbolId(containingMethod);
        methodLines.Add(
            "OP|" + methodId +
            "|block=" + blockOrdinal +
            "|ordinal=" + currentOrdinal +
            "|depth=" + depth +
            "|kind=" + kind +
            "|implicit=" + operation.IsImplicit +
            "|type=" + Canonical.TypeId(operation.Type) +
            "|constant=" + Canonical.ConstantValue(operation.ConstantValue) +
            "|syntax=" + operation.Syntax.SyntaxTree.FilePath + ":" + operation.Syntax.SpanStart + ":" + operation.Syntax.Span.Length);

        if (!_manifest.Policy.AllowedOperationKinds.Contains(kind, StringComparer.Ordinal))
        {
            Add("OPERATION_KIND_FORBIDDEN", methodId + " block " + blockOrdinal + " contains non-allowlisted OperationKind " + kind + ".");
        }
        if (HardForbiddenOperationKinds.Contains(kind))
        {
            Add("OPERATION_HARD_FORBIDDEN", methodId + " contains hard-forbidden OperationKind " + kind + ".");
        }
        if (operation.IsImplicit && !_manifest.Policy.AllowedImplicitOperationKinds.Contains(kind, StringComparer.Ordinal))
        {
            Add("IMPLICIT_LOWERING_FORBIDDEN", methodId + " block " + blockOrdinal + " contains non-allowlisted implicit lowering " + kind + ".");
        }

        foreach (var symbol in ReferencedSymbols(operation))
        {
            var id = Canonical.SymbolId(symbol.Symbol);
            bindings.Add(
                "BINDING|" + methodId +
                "|block=" + blockOrdinal +
                "|op=" + currentOrdinal +
                "|role=" + symbol.Role +
                "|" + id);
            InspectSensitiveSymbol(symbol.Symbol, containingMethod);
            InspectDispatchAndOperator(symbol.Symbol, containingMethod);
        }

        var called = CalledSymbol(operation);
        if (called is not null)
        {
            var calledId = Canonical.SymbolId(called);
            methodLines.Add("CALL|" + methodId + "|block=" + blockOrdinal + "|op=" + currentOrdinal + "|" + calledId);
        }

        foreach (var child in operation.ChildOperations)
        {
            VisitOperation(child, containingMethod, blockOrdinal, ref ordinal, methodLines, bindings, serializationCallsites, serializationRoots, depth + 1);
        }
    }

    private void InspectDispatchAndOperator(ISymbol symbol, IMethodSymbol containingMethod)
    {
        if (symbol is not IMethodSymbol method)
        {
            return;
        }
        if (method.MethodKind is MethodKind.UserDefinedOperator or MethodKind.Conversion)
        {
            Add("OPERATOR_OR_CONVERSION_CALL_FORBIDDEN", Canonical.SymbolId(containingMethod) + " binds user-defined operator/conversion " + Canonical.SymbolId(method) + ".");
        }
        if (method.ContainingType?.TypeKind == TypeKind.Interface)
        {
            if (!IsExactIteratorDisposal(method, containingMethod))
            {
                Add("INTERFACE_DISPATCH_FORBIDDEN", Canonical.SymbolId(containingMethod) + " dispatches through interface member " + Canonical.SymbolId(method) + ".");
            }
        }
        if (method.IsVirtual || method.IsAbstract || method.IsOverride)
        {
            var ns = method.ContainingNamespace?.ToDisplayString() ?? string.Empty;
            var exactRoleException = (_allowedSensitiveSymbols.Contains(Canonical.SymbolId(method)) &&
                                      ns.StartsWith("Autodesk.Revit.", StringComparison.Ordinal)) || IsExactIteratorDisposal(method, containingMethod);
            if (!exactRoleException)
            {
                Add("VIRTUAL_DISPATCH_FORBIDDEN", Canonical.SymbolId(containingMethod) + " binds virtual/abstract/override member " + Canonical.SymbolId(method) + ".");
            }
        }
    }

    private bool IsExactIteratorDisposal(IMethodSymbol method, IMethodSymbol containingMethod)
    {
        return string.Equals(Canonical.SymbolId(containingMethod), _manifest.Policy.EntryPointMethod, StringComparison.Ordinal) &&
               string.Equals(Canonical.QualifiedName(method.ContainingType), "global::System.IDisposable", StringComparison.Ordinal) &&
               string.Equals(method.Name, "Dispose", StringComparison.Ordinal) &&
               method.Parameters.Length == 0 &&
               _allowedSensitiveSymbols.Contains(Canonical.SymbolId(method));
    }

    private void InspectSensitiveSymbol(ISymbol symbol, IMethodSymbol containingMethod)
    {
        var id = Canonical.SymbolId(symbol);
        var ns = symbol.ContainingNamespace?.ToDisplayString() ?? string.Empty;
        var containingTypeName = symbol.ContainingType is null ? string.Empty : Canonical.QualifiedName(symbol.ContainingType);
        var sensitive = ns.StartsWith("Autodesk.", StringComparison.Ordinal) ||
                        ns == "System.IO" || ns.StartsWith("System.IO.", StringComparison.Ordinal) ||
                        ns == "System.Net" || ns.StartsWith("System.Net.", StringComparison.Ordinal) ||
                        ns == "System.Reflection" || ns.StartsWith("System.Reflection.", StringComparison.Ordinal) ||
                        ns == "System.Linq.Expressions" || ns.StartsWith("System.Linq.Expressions.", StringComparison.Ordinal) ||
                        ns == "System.Runtime.Loader" || ns.StartsWith("System.Runtime.Loader.", StringComparison.Ordinal) ||
                        ns == "System.Runtime.InteropServices" || ns.StartsWith("System.Runtime.InteropServices.", StringComparison.Ordinal) ||
                        ns == "Microsoft.Win32" || ns.StartsWith("Microsoft.Win32.", StringComparison.Ordinal) ||
                        ns == "System.Threading" || ns.StartsWith("System.Threading.", StringComparison.Ordinal) ||
                        containingTypeName is "global::System.Environment" or "global::System.Console" or "global::System.Diagnostics.Process" or "global::System.Diagnostics.ProcessStartInfo" or "global::System.Activator" or "global::System.AppDomain" or "global::System.Type" ||
                        (containingTypeName == "global::System.Object" && string.Equals(symbol.Name, "GetType", StringComparison.Ordinal));
        if (!sensitive)
        {
            return;
        }
        if (ns == "System.IO" || ns.StartsWith("System.IO.", StringComparison.Ordinal))
        {
            Add("FILE_IO_FORBIDDEN", Canonical.SymbolId(containingMethod) + " binds file/I/O symbol " + id + ".");
            return;
        }
        if (ns == "System.Net" || ns.StartsWith("System.Net.", StringComparison.Ordinal))
        {
            Add("NETWORK_SYMBOL_FORBIDDEN", Canonical.SymbolId(containingMethod) + " binds network symbol " + id + ".");
            return;
        }
        if (!_allowedSensitiveSymbols.Contains(id))
        {
            Add("SENSITIVE_SYMBOL_FORBIDDEN", Canonical.SymbolId(containingMethod) + " binds non-allowlisted sensitive symbol " + id + ".");
            return;
        }

        var owner = Canonical.QualifiedName(containingMethod.ContainingType);
        if (ns.StartsWith("System.Reflection", StringComparison.Ordinal) ||
            ns.StartsWith("System.IO", StringComparison.Ordinal) ||
            ns.StartsWith("System.Linq.Expressions", StringComparison.Ordinal) ||
            ns.StartsWith("System.Runtime.Loader", StringComparison.Ordinal) ||
            ns.StartsWith("System.Runtime.InteropServices", StringComparison.Ordinal) ||
            ns.StartsWith("Microsoft.Win32", StringComparison.Ordinal) ||
            containingTypeName is "global::System.Environment" or "global::System.Console" or "global::System.Diagnostics.Process" or "global::System.Diagnostics.ProcessStartInfo" or "global::System.Activator" or "global::System.AppDomain" or "global::System.Type" ||
            (containingTypeName == "global::System.Object" && string.Equals(symbol.Name, "GetType", StringComparison.Ordinal)))
        {
            Add("SENSITIVE_ROLE_FORBIDDEN", "Reflection/I/O/process/environment sensitive symbol can never be allowlisted: " + id + ".");
        }
        else if (containingTypeName == "global::System.Threading.Interlocked")
        {
            if (!_manifest.Policy.Roles.AllowedInterlockedOwnerTypes.Contains(owner, StringComparer.Ordinal))
            {
                Add("INTERLOCKED_ROLE", "Interlocked is allowed only inside exact execution-state owner roles: " + id + ".");
            }
        }
        else if (ns.StartsWith("System.Threading", StringComparison.Ordinal))
        {
            Add("THREADING_ROLE", "Only exact Interlocked members are permitted from System.Threading: " + id + ".");
        }
        else if (ns.StartsWith("Autodesk.", StringComparison.Ordinal))
        {
            if (!string.Equals(owner, _manifest.Policy.EntryPointType, StringComparison.Ordinal))
            {
                Add("AUTODESK_KERNEL_ROLE", "Autodesk symbols are allowed only inside the exact certified entry-point type: " + id + ".");
            }
        }
    }

    private static IEnumerable<(string Role, ISymbol Symbol)> ReferencedSymbols(IOperation operation)
    {
        switch (operation)
        {
            case IInvocationOperation invocation:
                yield return ("invocation", invocation.TargetMethod);
                break;
            case IObjectCreationOperation creation when creation.Constructor is not null:
                yield return ("constructor", creation.Constructor);
                break;
            case IPropertyReferenceOperation property:
                yield return ("property", property.Property);
                if (IsWriteTarget(property) && property.Property.SetMethod is not null)
                {
                    yield return ("property-setter", property.Property.SetMethod);
                }
                else if (property.Property.GetMethod is not null)
                {
                    yield return ("property-getter", property.Property.GetMethod);
                }
                break;
            case IFieldReferenceOperation field:
                yield return ("field", field.Field);
                break;
            case IEventReferenceOperation @event:
                yield return ("event", @event.Event);
                break;
            case IMethodReferenceOperation method:
                yield return ("method-reference", method.Method);
                break;
            case IConversionOperation conversion when conversion.OperatorMethod is not null:
                yield return ("conversion-operator", conversion.OperatorMethod);
                break;
            case IBinaryOperation binary when binary.OperatorMethod is not null:
                yield return ("binary-operator", binary.OperatorMethod);
                break;
            case IUnaryOperation unary when unary.OperatorMethod is not null:
                yield return ("unary-operator", unary.OperatorMethod);
                break;
            case IIncrementOrDecrementOperation increment when increment.OperatorMethod is not null:
                yield return ("increment-operator", increment.OperatorMethod);
                break;
            case ITypeOfOperation typeOf:
                yield return ("typeof", typeOf.TypeOperand);
                break;
            case IIsTypeOperation isType:
                yield return ("is-type", isType.TypeOperand);
                break;
        }
    }

    private static IMethodSymbol? CalledSymbol(IOperation operation)
    {
        return operation switch
        {
            IInvocationOperation invocation => invocation.TargetMethod,
            IObjectCreationOperation creation => creation.Constructor,
            IPropertyReferenceOperation property when IsWriteTarget(property) => property.Property.SetMethod,
            IPropertyReferenceOperation property => property.Property.GetMethod,
            IConversionOperation conversion => conversion.OperatorMethod,
            IBinaryOperation binary => binary.OperatorMethod,
            IUnaryOperation unary => unary.OperatorMethod,
            IIncrementOrDecrementOperation increment => increment.OperatorMethod,
            _ => null,
        };
    }

    private static bool IsWriteTarget(IPropertyReferenceOperation property)
    {
        return property.Parent switch
        {
            ISimpleAssignmentOperation assignment => ReferenceEquals(assignment.Target, property),
            ICompoundAssignmentOperation assignment => ReferenceEquals(assignment.Target, property),
            IIncrementOrDecrementOperation increment => ReferenceEquals(increment.Target, property),
            IArgumentOperation argument when argument.Parameter?.RefKind is RefKind.Ref or RefKind.Out => true,
            _ => false,
        };
    }

    private static void AddSuccessor(List<string> lines, string methodId, int ordinal, string role, ControlFlowBranch? branch)
    {
        if (branch is null)
        {
            lines.Add("SUCCESSOR|" + methodId + "|from=" + ordinal + "|role=" + role + "|none");
            return;
        }
        lines.Add("SUCCESSOR|" + methodId + "|from=" + ordinal + "|role=" + role + "|to=" + (branch.Destination?.Ordinal.ToString() ?? "null") + "|semantics=" + branch.Semantics + "|conditional=" + branch.IsConditionalSuccessor + "|regions=" + BranchRegions(branch));
    }

    private static string BranchRegions(ControlFlowBranch branch)
    {
        return "enter=" + string.Join(",", branch.EnteringRegions.Select(RegionId)) +
               ";leave=" + string.Join(",", branch.LeavingRegions.Select(RegionId)) +
               ";finally=" + string.Join(",", branch.FinallyRegions.Select(RegionId));
    }

    private static string RegionId(ControlFlowRegion region)
    {
        return region.Kind + ":" + region.FirstBlockOrdinal + "-" + region.LastBlockOrdinal;
    }

    private static List<INamedTypeSymbol> GetSourceTypes(CSharpCompilation compilation)
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
                VisitType(type, result);
            }
        }
    }

    private static void VisitType(INamedTypeSymbol type, List<INamedTypeSymbol> result)
    {
        result.Add(type);
        foreach (var nested in type.GetTypeMembers())
        {
            VisitType(nested, result);
        }
    }

    private void Add(string code, string message)
    {
        _issues.Add(new ProofIssue(code, message));
    }
}
