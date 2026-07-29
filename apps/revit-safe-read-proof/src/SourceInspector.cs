using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace RevitSafeReadProof;

internal sealed class SourceInspection
{
    public List<SyntaxTree> Trees { get; set; } = new();
    public InventoryExpectation Syntax { get; set; } = new();
    public InventoryExpectation Types { get; set; } = new();
    public InventoryExpectation Members { get; set; } = new();
    public InventoryExpectation SerializationClosure { get; set; } = new();
}

internal sealed class SourceInspector
{
    private static readonly UTF8Encoding StrictUtf8 = new(false, true);

    private readonly ProofManifest _manifest;
    private readonly LockedInputs _inputs;
    private readonly List<ProofIssue> _issues;

    public SourceInspector(ProofManifest manifest, LockedInputs inputs, List<ProofIssue> issues)
    {
        _manifest = manifest;
        _inputs = inputs;
        _issues = issues;
    }

    public List<SyntaxTree> Parse(VariantLock variant)
    {
        var parseOptions = new CSharpParseOptions(
            languageVersion: LanguageVersion.CSharp13,
            documentationMode: DocumentationMode.None,
            kind: SourceCodeKind.Regular,
            preprocessorSymbols: variant.PreprocessorSymbols);
        var trees = new List<SyntaxTree>();
        foreach (var source in _inputs.Sources.OrderBy(static source => source.LogicalPath, StringComparer.Ordinal))
        {
            string text;
            try
            {
                text = StrictUtf8.GetString(source.Bytes);
            }
            catch (DecoderFallbackException exception)
            {
                Add("SOURCE_ENCODING", source.LogicalPath + " is not strict UTF-8: " + exception.Message);
                continue;
            }
            if (text.Length > 0 && text[0] == '\uFEFF')
            {
                Add("SOURCE_BOM", source.LogicalPath + " must use UTF-8 without a BOM.");
                text = text.Substring(1);
            }
            var tree = CSharpSyntaxTree.ParseText(text, parseOptions, source.LogicalPath, StrictUtf8);
            trees.Add(tree);
        }
        return trees;
    }

    public InventoryExpectation InspectSyntax(IReadOnlyList<SyntaxTree> trees)
    {
        var inventory = new List<string>();
        foreach (var tree in trees.OrderBy(static tree => tree.FilePath, StringComparer.Ordinal))
        {
            var root = tree.GetRoot();
            foreach (var item in root.DescendantNodesAndTokensAndSelf(descendIntoTrivia: true))
            {
                if (item.IsNode)
                {
                    var node = item.AsNode()!;
                    inventory.Add("NODE|" + tree.FilePath + "|" + node.Kind() + "|span=" + node.SpanStart + ":" + node.Span.Length + "|full=" + node.FullSpan.Start + ":" + node.FullSpan.Length);
                    InspectSyntaxNode(node, tree.FilePath);
                }
                else
                {
                    var token = item.AsToken();
                    inventory.Add("TOKEN|" + tree.FilePath + "|" + token.Kind() + "|span=" + token.SpanStart + ":" + token.Span.Length + "|text=" + Base64(token.Text) + "|value=" + Base64(token.ValueText));
                }
            }
            foreach (var trivia in root.DescendantTrivia(descendIntoTrivia: true))
            {
                inventory.Add("TRIVIA|" + tree.FilePath + "|" + trivia.Kind() + "|span=" + trivia.SpanStart + ":" + trivia.Span.Length + "|text=" + Base64(trivia.ToFullString()));
                if (trivia.IsDirective)
                {
                    Add("DIRECTIVE_FORBIDDEN", tree.FilePath + ":" + trivia.SpanStart + " contains directive " + trivia.Kind() + ".");
                }
                if (trivia.IsKind(SyntaxKind.SkippedTokensTrivia) || trivia.IsKind(SyntaxKind.DisabledTextTrivia))
                {
                    Add("HIDDEN_SYNTAX", tree.FilePath + ":" + trivia.SpanStart + " contains hidden or skipped syntax " + trivia.Kind() + ".");
                }
            }
        }
        return Canonical.Inventory(inventory);
    }

    public (InventoryExpectation Types, InventoryExpectation Members) InspectDeclarations(CSharpCompilation compilation)
    {
        var types = GetSourceTypes(compilation).OrderBy(Canonical.QualifiedName, StringComparer.Ordinal).ToList();
        var typeInventory = new List<string>();
        var memberInventory = new List<string>();

        InspectAttributes(compilation.Assembly.GetAttributes(), "assembly");
        InspectAttributes(compilation.SourceModule.GetAttributes(), "module");

        foreach (var type in types)
        {
            var interfaceIds = type.Interfaces.Select(Canonical.TypeId).OrderBy(static value => value, StringComparer.Ordinal);
            typeInventory.Add(
                "TYPE|" + Canonical.SymbolId(type) +
                "|access=" + type.DeclaredAccessibility +
                "|static=" + type.IsStatic +
                "|sealed=" + type.IsSealed +
                "|abstract=" + type.IsAbstract +
                "|readonly=" + type.IsReadOnly +
                "|refLike=" + type.IsRefLikeType +
                "|base=" + Canonical.TypeId(type.BaseType) +
                "|interfaces=" + string.Join(",", interfaceIds) +
                "|locations=" + Locations(type));
            InspectTypePolicy(type);
            InspectAttributes(type.GetAttributes(), Canonical.QualifiedName(type));

            foreach (var member in type.GetMembers().OrderBy(Canonical.SymbolId, StringComparer.Ordinal))
            {
                memberInventory.Add(MemberDescriptor(member));
                InspectMemberPolicy(member);
                InspectAttributes(member.GetAttributes(), Canonical.SymbolId(member));
            }
        }

        return (Canonical.Inventory(typeInventory), Canonical.Inventory(memberInventory));
    }

    public InventoryExpectation InspectSerializationClosure(CSharpCompilation compilation)
    {
        var lines = new List<string>();
        var visited = new HashSet<ITypeSymbol>(SymbolEqualityComparer.Default);
        foreach (var rootName in _manifest.Policy.SerializationRoots.OrderBy(static value => value, StringComparer.Ordinal))
        {
            var root = compilation.GetTypeByMetadataName(rootName);
            if (root is null)
            {
                Add("SERIALIZATION_ROOT", "Serialization root was not found: " + rootName);
                continue;
            }
            TraverseSerializationType(root, "root:" + rootName, visited, lines, new HashSet<ITypeSymbol>(SymbolEqualityComparer.Default));
        }
        return Canonical.Inventory(lines, preserveOrder: false);
    }

    private void TraverseSerializationType(
        ITypeSymbol type,
        string path,
        HashSet<ITypeSymbol> visited,
        List<string> lines,
        HashSet<ITypeSymbol> active)
    {
        type = UnwrapNullable(type);
        var qualified = Canonical.QualifiedName(type);
        if (_manifest.Policy.AllowedSerializationLeafTypes.Contains(qualified, StringComparer.Ordinal))
        {
            lines.Add("LEAF|" + path + "|" + Canonical.TypeId(type));
            return;
        }
        if (type is IArrayTypeSymbol array)
        {
            lines.Add("ARRAY|" + path + "|rank=" + array.Rank + "|" + Canonical.TypeId(array));
            if (array.Rank != 1 || !array.IsSZArray)
            {
                Add("SERIALIZATION_ARRAY", "Only one-dimensional zero-based arrays are allowed in serialization closure: " + path);
            }
            TraverseSerializationType(array.ElementType, path + "[]", visited, lines, active);
            return;
        }
        if (type.TypeKind is TypeKind.Dynamic or TypeKind.Delegate or TypeKind.Interface or TypeKind.Pointer or TypeKind.FunctionPointer ||
            type.SpecialType == SpecialType.System_Object)
        {
            Add("SERIALIZATION_UNSAFE_TYPE", path + " reaches unsupported serialization type " + Canonical.TypeId(type) + ".");
            lines.Add("UNSAFE|" + path + "|" + Canonical.TypeId(type));
            return;
        }
        if (type is not INamedTypeSymbol named || named.DeclaringSyntaxReferences.Length == 0)
        {
            Add("SERIALIZATION_NONLEAF", path + " reaches a non-leaf external type not explicitly allowed: " + Canonical.TypeId(type) + ".");
            lines.Add("EXTERNAL|" + path + "|" + Canonical.TypeId(type));
            return;
        }
        if (named.IsGenericType || named.TypeParameters.Length != 0)
        {
            Add("SERIALIZATION_GENERIC", path + " reaches generic source type " + Canonical.TypeId(named) + ".");
        }
        if (!active.Add(named))
        {
            Add("SERIALIZATION_CYCLE", path + " creates a serialization cycle at " + Canonical.TypeId(named) + ".");
            lines.Add("CYCLE|" + path + "|" + Canonical.TypeId(named));
            return;
        }
        if (!visited.Add(named))
        {
            lines.Add("REUSE|" + path + "|" + Canonical.TypeId(named));
            active.Remove(named);
            return;
        }

        lines.Add("OBJECT|" + path + "|" + Canonical.TypeId(named));
        if (!named.IsSealed || named.TypeKind != TypeKind.Class)
        {
            Add("SERIALIZATION_POLYMORPHISM", path + " must be a sealed source class: " + Canonical.TypeId(named) + ".");
        }
        var serializableMembers = named.GetMembers()
            .Where(static member => member is IPropertySymbol { IsStatic: false, DeclaredAccessibility: Accessibility.Public, GetMethod: not null } ||
                                     member is IFieldSymbol { IsStatic: false, DeclaredAccessibility: Accessibility.Public })
            .OrderBy(static member => member.Name, StringComparer.Ordinal)
            .ToList();
        if (serializableMembers.Count == 0)
        {
            Add("SERIALIZATION_EMPTY", path + " has no public readable serialization members.");
        }
        foreach (var member in serializableMembers)
        {
            var memberType = member switch
            {
                IPropertySymbol property => property.Type,
                IFieldSymbol field => field.Type,
                _ => throw new InvalidOperationException("Unexpected serialization member kind."),
            };
            lines.Add("MEMBER|" + path + "." + member.Name + "|" + Canonical.SymbolId(member));
            TraverseSerializationType(memberType, path + "." + member.Name, visited, lines, active);
        }
        active.Remove(named);
    }

    private static ITypeSymbol UnwrapNullable(ITypeSymbol type)
    {
        if (type is INamedTypeSymbol { OriginalDefinition.SpecialType: SpecialType.System_Nullable_T } named && named.TypeArguments.Length == 1)
        {
            return named.TypeArguments[0];
        }
        return type;
    }

    private void InspectSyntaxNode(SyntaxNode node, string path)
    {
        switch (node)
        {
            case DestructorDeclarationSyntax:
                Add("FINALIZER_FORBIDDEN", Location(path, node) + " declares a finalizer.");
                break;
            case ConstructorDeclarationSyntax constructor when constructor.Initializer is not null:
                Add("BASE_CHAIN_FORBIDDEN", Location(path, node) + " declares a constructor initializer.");
                break;
            case BaseExpressionSyntax:
                Add("BASE_CHAIN_FORBIDDEN", Location(path, node) + " uses base.");
                break;
            case DelegateDeclarationSyntax:
            case AnonymousFunctionExpressionSyntax:
            case LocalFunctionStatementSyntax:
                Add("DELEGATE_FORBIDDEN", Location(path, node) + " uses delegate/lambda/local-function syntax " + node.Kind() + ".");
                break;
            case OperatorDeclarationSyntax:
            case ConversionOperatorDeclarationSyntax:
                Add("OPERATOR_FORBIDDEN", Location(path, node) + " declares an operator or conversion.");
                break;
            case InterfaceDeclarationSyntax:
                Add("SOURCE_INTERFACE_FORBIDDEN", Location(path, node) + " declares a source interface.");
                break;
            case UnsafeStatementSyntax:
            case PointerTypeSyntax:
            case FunctionPointerTypeSyntax:
            case StackAllocArrayCreationExpressionSyntax:
            case FixedStatementSyntax:
                Add("UNSAFE_FORBIDDEN", Location(path, node) + " uses unsafe syntax " + node.Kind() + ".");
                break;
            case TypeOfExpressionSyntax:
                Add("REFLECTION_FORBIDDEN", Location(path, node) + " uses typeof.");
                break;
            case IdentifierNameSyntax identifier when string.Equals(identifier.Identifier.ValueText, "dynamic", StringComparison.Ordinal):
                Add("DYNAMIC_FORBIDDEN", Location(path, node) + " uses dynamic.");
                break;
            case LockStatementSyntax:
            case AwaitExpressionSyntax:
            case YieldStatementSyntax:
                Add("THREADING_FORBIDDEN", Location(path, node) + " uses lock/await/yield syntax " + node.Kind() + ".");
                break;
            case QueryExpressionSyntax:
            case AnonymousObjectCreationExpressionSyntax:
                Add("IMPLICIT_DELEGATE_FORBIDDEN", Location(path, node) + " uses query/anonymous-object syntax " + node.Kind() + ".");
                break;
            case InitializerExpressionSyntax:
            case WithExpressionSyntax:
            case ImplicitObjectCreationExpressionSyntax:
                Add("INITIALIZER_FORBIDDEN", Location(path, node) + " uses initializer/with/implicit-creation syntax " + node.Kind() + ".");
                break;
            case EqualsValueClauseSyntax equalsValue when IsMemberInitializer(equalsValue):
                Add("INITIALIZER_FORBIDDEN", Location(path, node) + " declares a member initializer.");
                break;
            case RecordDeclarationSyntax:
                Add("SOURCE_POLYMORPHISM", Location(path, node) + " declares a record.");
                break;
            case EventDeclarationSyntax:
            case EventFieldDeclarationSyntax:
                Add("EVENT_STATE_FORBIDDEN", Location(path, node) + " declares event state.");
                break;
            case MethodDeclarationSyntax method when method.ExpressionBody is not null:
            case ConstructorDeclarationSyntax { ExpressionBody: not null }:
            case AccessorDeclarationSyntax { ExpressionBody: not null }:
                Add("EXPRESSION_BODY_FORBIDDEN", Location(path, node) + " uses an expression body; proof v1 requires an explicit block CFG root.");
                break;
        }

        if (node is LiteralExpressionSyntax literal && literal.IsKind(SyntaxKind.StringLiteralExpression))
        {
            var value = literal.Token.ValueText;
            if (value.StartsWith("/", StringComparison.Ordinal) && !_manifest.Policy.AllowedRouteLiterals.Contains(value, StringComparer.Ordinal))
            {
                Add("ROUTE_LITERAL_FORBIDDEN", Location(path, node) + " contains unapproved route literal " + value + ".");
            }
            if (value.StartsWith("http://", StringComparison.OrdinalIgnoreCase) && !_manifest.Policy.AllowedListenerPrefixes.Contains(value, StringComparer.Ordinal))
            {
                Add("LISTENER_PREFIX_FORBIDDEN", Location(path, node) + " contains unapproved listener prefix " + value + ".");
            }
            if (value.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
            {
                Add("OUTBOUND_NETWORK_FORBIDDEN", Location(path, node) + " contains an HTTPS address.");
            }
        }
    }

    private void InspectTypePolicy(INamedTypeSymbol type)
    {
        var qualified = Canonical.QualifiedName(type);
        if (qualified.StartsWith("global::Autodesk.", StringComparison.Ordinal))
        {
            Add("AUTODESK_SOURCE_SHADOW", "Source declares an Autodesk type: " + qualified + ".");
        }
        if (type.TypeKind is TypeKind.Delegate or TypeKind.Interface)
        {
            Add("SOURCE_POLYMORPHISM", "Source type kind is forbidden: " + Canonical.TypeId(type) + ".");
        }
        if (type.TypeKind == TypeKind.Class && !type.IsSealed && !type.IsStatic)
        {
            Add("SOURCE_POLYMORPHISM", "Every source class must be sealed or static: " + Canonical.TypeId(type) + ".");
        }
        if (type.TypeParameters.Length != 0)
        {
            Add("SOURCE_GENERIC", "Source generic types are forbidden: " + Canonical.TypeId(type) + ".");
        }
        if (type.BaseType is not null && type.BaseType.SpecialType is not (SpecialType.System_Object or SpecialType.System_ValueType))
        {
            Add("BASE_CHAIN_FORBIDDEN", "Source type has a non-object/value-type base: " + Canonical.TypeId(type) + " -> " + Canonical.TypeId(type.BaseType) + ".");
        }
        foreach (var @interface in type.Interfaces)
        {
            var allowedOwner = string.Equals(qualified, _manifest.Policy.Roles.ExternalEventHandlerType, StringComparison.Ordinal);
            var interfaceName = Canonical.QualifiedName(@interface);
            if (!allowedOwner || !string.Equals(interfaceName, "global::Autodesk.Revit.UI.IExternalEventHandler", StringComparison.Ordinal))
            {
                Add("SOURCE_INTERFACE_IMPLEMENTATION", Canonical.TypeId(type) + " implements unapproved interface " + Canonical.TypeId(@interface) + ".");
            }
        }
    }

    private void InspectMemberPolicy(ISymbol member)
    {
        if (member is IMethodSymbol method)
        {
            InspectSignatureType(method.ReturnType, Canonical.SymbolId(method));
            foreach (var parameter in method.Parameters)
            {
                InspectSignatureType(parameter.Type, Canonical.SymbolId(method) + " parameter " + parameter.Name);
            }
            if (method.MethodKind is MethodKind.UserDefinedOperator or MethodKind.Conversion)
            {
                Add("OPERATOR_FORBIDDEN", "Source declares operator/conversion " + Canonical.SymbolId(method) + ".");
            }
            if (method.IsVirtual || method.IsAbstract || method.IsOverride)
            {
                Add("SOURCE_POLYMORPHISM", "Virtual/abstract/override source member is forbidden: " + Canonical.SymbolId(method) + ".");
            }
            if (method.IsExtern)
            {
                Add("PINVOKE_FORBIDDEN", "Extern source method is forbidden: " + Canonical.SymbolId(method) + ".");
            }
            if (method.IsImplicitlyDeclared)
            {
                Add("IMPLICIT_METHOD_FORBIDDEN", "Every method/accessor/constructor must have explicit source and a CFG: " + Canonical.SymbolId(method) + ".");
            }
            if (method.Arity != 0)
            {
                Add("SOURCE_GENERIC", "Generic source methods are forbidden: " + Canonical.SymbolId(method) + ".");
            }
        }
        else if (member is IFieldSymbol field)
        {
            InspectSignatureType(field.Type, Canonical.SymbolId(field));
            if (field.IsVolatile)
            {
                Add("VOLATILE_STATE_FORBIDDEN", "Volatile state is forbidden: " + Canonical.SymbolId(field) + ".");
            }
            if (!field.IsReadOnly && !field.IsConst && !_manifest.Policy.AllowedMutableFields.Contains(Canonical.SymbolId(field), StringComparer.Ordinal))
            {
                Add("MUTABLE_STATE_FORBIDDEN", "Mutable field is not the exact ExternalEvent handoff state allowlist entry: " + Canonical.SymbolId(field) + ".");
            }
            if (field.Type.TypeKind is TypeKind.Dynamic or TypeKind.Delegate or TypeKind.Pointer or TypeKind.FunctionPointer)
            {
                Add("UNSAFE_STATE_TYPE", "Field has forbidden dynamic/delegate/pointer type: " + Canonical.SymbolId(field) + ".");
            }
        }
        else if (member is IPropertySymbol property)
        {
            InspectSignatureType(property.Type, Canonical.SymbolId(property));
            foreach (var parameter in property.Parameters)
            {
                InspectSignatureType(parameter.Type, Canonical.SymbolId(property) + " parameter " + parameter.Name);
            }
        }
        else if (member is IEventSymbol)
        {
            Add("EVENT_STATE_FORBIDDEN", "Source event is forbidden: " + Canonical.SymbolId(member) + ".");
        }
    }

    private void InspectSignatureType(ITypeSymbol type, string owner)
    {
        if (type is IArrayTypeSymbol array)
        {
            InspectSignatureType(array.ElementType, owner);
            return;
        }
        if (type is IPointerTypeSymbol or IFunctionPointerTypeSymbol || type.TypeKind is TypeKind.Dynamic or TypeKind.Delegate)
        {
            Add("UNSAFE_SIGNATURE_TYPE", owner + " uses dynamic/delegate/pointer signature type " + Canonical.TypeId(type) + ".");
            return;
        }
        if (type is not INamedTypeSymbol named)
        {
            return;
        }
        foreach (var argument in named.TypeArguments)
        {
            InspectSignatureType(argument, owner);
        }
        var ns = named.ContainingNamespace?.ToDisplayString() ?? string.Empty;
        var qualified = Canonical.QualifiedName(named);
        if (ns == "System.IO" || ns.StartsWith("System.IO.", StringComparison.Ordinal) ||
            ns == "System.Reflection" || ns.StartsWith("System.Reflection.", StringComparison.Ordinal) ||
            ns == "System.Runtime.InteropServices" || ns.StartsWith("System.Runtime.InteropServices.", StringComparison.Ordinal) ||
            qualified is "global::System.Environment" or "global::System.Diagnostics.Process" or "global::System.Activator" or "global::System.AppDomain" or "global::System.Type")
        {
            Add("SENSITIVE_SIGNATURE_TYPE", owner + " uses forbidden reflection/I/O/native/process/environment type " + Canonical.TypeId(named) + ".");
        }
        if (ns == "System.Threading" || ns.StartsWith("System.Threading.", StringComparison.Ordinal))
        {
            Add("THREADING_SIGNATURE_TYPE", owner + " uses a threading signature type; only exact Interlocked calls are permitted: " + Canonical.TypeId(named) + ".");
        }
        if (ns == "System.Net" || ns.StartsWith("System.Net.", StringComparison.Ordinal))
        {
            if (!qualified.StartsWith("global::System.Net.HttpListener", StringComparison.Ordinal))
            {
                Add("NETWORK_SIGNATURE_TYPE", owner + " uses a non-HttpListener network type " + Canonical.TypeId(named) + ".");
            }
        }
        if (ns.StartsWith("Autodesk.", StringComparison.Ordinal) &&
            !owner.Contains(_manifest.Policy.Roles.ExternalEventOwnerType, StringComparison.Ordinal) &&
            !owner.Contains(_manifest.Policy.Roles.ExternalEventHandlerType, StringComparison.Ordinal))
        {
            Add("AUTODESK_SIGNATURE_ROLE", owner + " uses an Autodesk type outside the exact ExternalEvent owner/handler roles: " + Canonical.TypeId(named) + ".");
        }
    }

    private void InspectAttributes(IEnumerable<AttributeData> attributes, string owner)
    {
        foreach (var attribute in attributes)
        {
            var id = Canonical.SymbolId(attribute.AttributeClass);
            if (!_manifest.Policy.AllowedAttributeSymbols.Contains(id, StringComparer.Ordinal))
            {
                Add("ATTRIBUTE_FORBIDDEN", owner + " has unapproved attribute " + id + ".");
            }
            var name = attribute.AttributeClass?.ToDisplayString(SymbolDisplayFormat.FullyQualifiedFormat) ?? string.Empty;
            if (name is "global::System.Runtime.InteropServices.DllImportAttribute" or
                "global::System.Runtime.InteropServices.UnmanagedCallersOnlyAttribute" or
                "global::System.Runtime.CompilerServices.ModuleInitializerAttribute")
            {
                Add("PINVOKE_OR_MODULE_INITIALIZER", owner + " has forbidden native/module-initializer attribute " + name + ".");
            }
        }
    }

    private static bool IsMemberInitializer(EqualsValueClauseSyntax node)
    {
        return node.Parent is VariableDeclaratorSyntax { Parent.Parent: FieldDeclarationSyntax or EventFieldDeclarationSyntax } or
               PropertyDeclarationSyntax or
               ParameterSyntax;
    }

    private static List<INamedTypeSymbol> GetSourceTypes(CSharpCompilation compilation)
    {
        var result = new List<INamedTypeSymbol>();
        VisitNamespace(compilation.Assembly.GlobalNamespace, result, compilation.Assembly);
        return result;
    }

    private static void VisitNamespace(INamespaceSymbol @namespace, List<INamedTypeSymbol> result, IAssemblySymbol sourceAssembly)
    {
        foreach (var member in @namespace.GetMembers())
        {
            if (member is INamespaceSymbol childNamespace)
            {
                VisitNamespace(childNamespace, result, sourceAssembly);
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

    private static string MemberDescriptor(ISymbol member)
    {
        var details = member switch
        {
            IMethodSymbol method => "methodKind=" + method.MethodKind + "|static=" + method.IsStatic + "|implicit=" + method.IsImplicitlyDeclared + "|virtual=" + method.IsVirtual + "|abstract=" + method.IsAbstract + "|override=" + method.IsOverride + "|extern=" + method.IsExtern,
            IFieldSymbol field => "static=" + field.IsStatic + "|readonly=" + field.IsReadOnly + "|const=" + field.IsConst + "|volatile=" + field.IsVolatile + "|implicit=" + field.IsImplicitlyDeclared,
            IPropertySymbol property => "static=" + property.IsStatic + "|readonly=" + property.IsReadOnly + "|writeonly=" + property.IsWriteOnly + "|implicit=" + property.IsImplicitlyDeclared,
            IEventSymbol @event => "static=" + @event.IsStatic + "|implicit=" + @event.IsImplicitlyDeclared,
            INamedTypeSymbol nested => "nested=true|typeKind=" + nested.TypeKind,
            _ => "kind=" + member.Kind,
        };
        return "MEMBER|" + Canonical.SymbolId(member) + "|access=" + member.DeclaredAccessibility + "|" + details + "|locations=" + Locations(member);
    }

    private static string Locations(ISymbol symbol)
    {
        return string.Join(",", symbol.Locations
            .Where(static location => location.IsInSource)
            .Select(static location => location.SourceTree!.FilePath + ":" + location.SourceSpan.Start + ":" + location.SourceSpan.Length)
            .OrderBy(static value => value, StringComparer.Ordinal));
    }

    private static string Location(string path, SyntaxNode node)
    {
        return path + ":" + node.SpanStart;
    }

    private static string Base64(string value)
    {
        return Convert.ToBase64String(StrictUtf8.GetBytes(value));
    }

    private void Add(string code, string message)
    {
        _issues.Add(new ProofIssue(code, message));
    }
}
