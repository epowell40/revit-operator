using System.Reflection;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using System.Text;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using RevitBridge.Common;
using RevitOperator.DynamicRevitSdk;

namespace RevitOperator.DynamicRevitWorker;

internal sealed record NativeCompilerReference(string Name, byte[] Image, string Sha256);
internal sealed record NativeCompilerReferenceIdentity(string Name, string Version, string Sha256);
internal sealed record NativeProgramMember(string Id, string DeclaringType, string Name, bool MutationHint);
internal sealed record NativeProgramArtifact(string Schema, int RevitYear, string Mode, string EntryType,
    string SourceHash, string AssemblyHash, byte[] Assembly,
    IReadOnlyList<NativeCompilerReferenceIdentity> References, IReadOnlyList<NativeProgramMember> DirectNativeMembers)
{
    // Compilation is not permission to load or execute this assembly. In particular,
    // this member list is not a proof of transitive effects or a sandbox boundary.
    public bool ExecutionAuthorized => false;
    public DynamicNativeProgramArtifactV1 ToWireArtifact() => new()
    {
        Schema = Schema, RevitYear = RevitYear, Mode = Mode, EntryType = EntryType,
        SourceHash = SourceHash, AssemblyHash = AssemblyHash, Assembly = Assembly.ToArray(),
        References = References.Select(r => new DynamicNativeReferenceV1 { Name = r.Name, Version = r.Version, Sha256 = r.Sha256 }).ToArray(),
        DirectNativeMembers = DirectNativeMembers.Select(m => new DynamicNativeMemberV1
            { Id = m.Id, DeclaringType = m.DeclaringType, Name = m.Name, MutationHint = m.MutationHint }).ToArray()
    };
}
internal sealed record NativeProgramCompilation(NativeProgramArtifact? Artifact, IReadOnlyList<WorkerDiagnostic> Diagnostics);

/// <summary>
/// Compile-only native-target boundary. The normal isolated worker keeps its
/// Autodesk-reference prohibition. The host must independently admit the exact artifact/source/reference set,
/// native member policy, current document/scope and transaction ownership.
/// </summary>
internal static class NativeProgramCompiler
{
    private static readonly string[] DocumentLifecycle = {
        "Save", "SaveAs", "SaveAsCloudModel", "SaveCloudModel", "Close", "Export", "Print", "SubmitPrint",
        "LoadFamily", "LoadFamilySymbol", "EditFamily", "SynchronizeWithCentral", "ReloadLatest",
        "GetWorksharingCentralModelPath", "EnableWorksharing", "ConvertToCloudModel", "GetCloudModelPath",
        "get_Application", "get_PrintManager"
    };
    private static readonly string[] OwnedLifecycleTypes = {
        "Autodesk.Revit.DB.Transaction", "Autodesk.Revit.DB.SubTransaction", "Autodesk.Revit.DB.TransactionGroup",
        "Autodesk.Revit.DB.FailureHandlingOptions", "Autodesk.Revit.DB.IFailuresPreprocessor",
        "Autodesk.Revit.DB.IUpdater", "Autodesk.Revit.DB.UpdaterRegistry"
    };

    public static NativeProgramCompilation Compile(string source, string entryType, string mode, int revitYear,
        IReadOnlyList<NativeCompilerReference> references)
    {
        NativeProgramCompilation Fail(string code, string message) => new(null, new[] { Diagnostic(code, message) });
        if (source == null || source.Length is < 1 or > 128_000 || string.IsNullOrWhiteSpace(entryType)
            || entryType.Length > 256 || mode is not ("read" or "write") || !DynamicNativeTargetProfile.Supports(revitYear))
            return Fail("NATIVE_COMPILE_INPUT_INVALID", "Native compile requires bounded source, one entry type, read/write mode and a supported Revit 2023–2027 target.");
        var requiredReferences = DynamicNativeTargetProfile.ReferenceNames(revitYear);
        if (references == null || references.Count != requiredReferences.Length || references.Any(r => r == null) ||
            !references.Select(r => r.Name).OrderBy(n => n, StringComparer.Ordinal).SequenceEqual(requiredReferences))
            return Fail("NATIVE_COMPILE_REFERENCES_INVALID", "Use the exact pinned framework and Revit reference set; no additional assemblies.");

        var identities = new List<NativeCompilerReferenceIdentity>();
        var metadata = new List<MetadataReference>();
        try
        {
            foreach (var reference in references.OrderBy(r => r.Name, StringComparer.Ordinal))
            {
                if (reference.Image == null || reference.Image.Length is < 1 or > 64 * 1024 * 1024)
                    return Fail("NATIVE_COMPILE_REFERENCE_INVALID", "A pinned reference image is missing or outside bounds.");
                var image = reference.Image.ToArray();
                if (DynamicWire.Sha256(image) != reference.Sha256)
                    return Fail("NATIVE_COMPILE_REFERENCE_HASH", "Pinned reference bytes differ from their supplied identity.");
                using var pe = new PEReader(new MemoryStream(image));
                var reader = pe.GetMetadataReader();
                var definition = reader.GetAssemblyDefinition();
                var name = reader.GetString(definition.Name);
                if (name != reference.Name || !DynamicNativeTargetProfile.MatchesAssembly(revitYear, name, definition.Version.ToString()))
                    return Fail("NATIVE_COMPILE_REFERENCE_TARGET", "Reference assembly name/version does not match the selected Revit version and its CLR framework.");
                identities.Add(new(name, definition.Version.ToString(), reference.Sha256));
                metadata.Add(MetadataReference.CreateFromImage(image));
            }
        }
        catch (Exception e) when (e is BadImageFormatException or InvalidOperationException or ArgumentException)
        { return Fail("NATIVE_COMPILE_REFERENCE_INVALID", "A pinned reference is not valid managed metadata."); }

        var normalized = source.Replace("\r\n", "\n").Replace("\r", "\n");
        // This explicit compile-only target references Autodesk and uses the native
        // entry signature checked below, not IDynamicRevitProgram. All other source
        // checks remain; the ordinary Compiler/Worker path is unchanged.
        var syntaxDiagnostics = StaticAdmission.Check(normalized).Where(d => d.Code != "REVIT_REFERENCE_FORBIDDEN"
            && d.Code != "PROGRAM_INTERFACE_REQUIRED").ToList();
        var tree = CSharpSyntaxTree.ParseText(normalized, new CSharpParseOptions(LanguageVersion.CSharp12),
            path: "GeneratedNativeProgram.cs", encoding: Encoding.UTF8);
        var compilation = CSharpCompilation.Create("DynamicNative_CheckpointV1_" + DynamicWire.Sha256(normalized).Substring(7, 24), new[] { tree }, metadata,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary, optimizationLevel: OptimizationLevel.Release,
                allowUnsafe: false, deterministic: true));
        var root = tree.GetRoot();
        var model = compilation.GetSemanticModel(tree);
        // A compile-time Revit element type passed directly to the pinned
        // collector is an ordinary API query, not general reflection. Resolve
        // both symbols so aliases work and caller-defined OfClass lookalikes do
        // not acquire an exception. The snapshot worker has no such exception.
        var typeLiterals = root.DescendantNodes().OfType<TypeOfExpressionSyntax>().ToArray();
        var collectorTypeSpans = typeLiterals.Where(node => IsCollectorTypeLiteral(node, model)).Select(node => node.Span).ToHashSet();
        if (typeLiterals.Length > 0 && collectorTypeSpans.Count == typeLiterals.Length)
            syntaxDiagnostics.RemoveAll(d => d.Code == "POLICY_SOURCE_FORBIDDEN" && d.Message == "Generated code may not use typeof.");
        syntaxDiagnostics.AddRange(StaticAdmission.CheckSemantic(compilation,
            node => node.SyntaxTree == tree && node is TypeOfExpressionSyntax && collectorTypeSpans.Contains(node.Span)));
        if (root.DescendantNodes().Any(n => n is ConstructorDeclarationSyntax c && c.Modifiers.Any(SyntaxKind.StaticKeyword)
            || n is FieldDeclarationSyntax f && f.Modifiers.Any(SyntaxKind.StaticKeyword) && !f.Modifiers.Any(SyntaxKind.ConstKeyword)
            || n is PropertyDeclarationSyntax p && p.Modifiers.Any(SyntaxKind.StaticKeyword) && p.Initializer != null
            || n is EventDeclarationSyntax or EventFieldDeclarationSyntax or DestructorDeclarationSyntax or AwaitExpressionSyntax or RefTypeSyntax)
            || root.DescendantTokens().Any(t => t.IsKind(SyntaxKind.AsyncKeyword)))
            syntaxDiagnostics.Add(Diagnostic("NATIVE_SOURCE_LIFECYCLE", "Source-owned static initialization, events, finalizers, async work and ref returns/locals are outside the synchronous native program contract."));
        if (root.DescendantTokens().Any(t => t.IsKind(SyntaxKind.IdentifierToken) && t.ValueText == "NativeExecutionBoundaryV1"))
            syntaxDiagnostics.Add(Diagnostic("NATIVE_RESERVED_BOUNDARY", "The execution boundary is compiler-owned and cannot be named by task source."));

        var entry = compilation.GetTypeByMetadataName(entryType);
        var methods = entry?.GetMembers("Execute").OfType<IMethodSymbol>().ToArray() ?? Array.Empty<IMethodSymbol>();
        if (entry == null || entry.DeclaredAccessibility != Accessibility.Public || entry.TypeKind != TypeKind.Class || entry.IsGenericType || methods.Length != 1 ||
            !methods[0].IsStatic || methods[0].DeclaredAccessibility != Accessibility.Public || methods[0].IsGenericMethod ||
            methods[0].ReturnType.SpecialType != SpecialType.System_String || methods[0].Parameters.Length != 1 ||
            methods[0].Parameters[0].RefKind != RefKind.None || methods[0].Parameters[0].Type.ToDisplayString() != "Autodesk.Revit.DB.Document")
            syntaxDiagnostics.Add(Diagnostic("NATIVE_ENTRY_INVALID", "Declare one public static string Execute(Autodesk.Revit.DB.Document) entry on the requested public class. The class may be static; the entry method must be static."));

        var members = new Dictionary<string, NativeProgramMember>(StringComparer.Ordinal);
        foreach (var node in root.DescendantNodes().OfType<ExpressionSyntax>())
        {
            var symbol = model.GetSymbolInfo(node).Symbol;
            var type = symbol is ITypeSymbol t ? t : symbol?.ContainingType;
            var typeName = type?.ToDisplayString() ?? "";
            if (!typeName.StartsWith("Autodesk.Revit.", StringComparison.Ordinal)) continue;
            var name = symbol?.MetadataName ?? "";
            if (OwnedLifecycleTypes.Any(prefix => typeName == prefix || typeName.StartsWith(prefix + ".", StringComparison.Ordinal)) ||
                typeName.StartsWith("Autodesk.Revit.ApplicationServices.", StringComparison.Ordinal) ||
                typeName.StartsWith("Autodesk.Revit.UI.", StringComparison.Ordinal) ||
                typeName == "Autodesk.Revit.DB.Document" && (DocumentLifecycle.Contains(name, StringComparer.Ordinal)
                    || DocumentLifecycle.Contains("get_" + name, StringComparer.Ordinal)))
                syntaxDiagnostics.Add(Diagnostic("NATIVE_HOST_OWNED_LIFECYCLE", "The host owns native document/application/file/transaction lifecycle: " + typeName + "." + name));
            if (symbol is not (IMethodSymbol or IPropertySymbol or IFieldSymbol)) continue;
            var id = symbol.GetDocumentationCommentId() ?? symbol.ToDisplayString();
            var mutation = symbol is IMethodSymbol && NativeApiMutationNames.IsMutating(name);
            // A native property setter is also a mutation; source assignment cannot
            // hide it behind a property rather than a Set* method.
            if (symbol is IPropertySymbol && (node.Parent is AssignmentExpressionSyntax a && a.Left == node
                || node.Parent is PrefixUnaryExpressionSyntax prefix && (prefix.IsKind(SyntaxKind.PreIncrementExpression) || prefix.IsKind(SyntaxKind.PreDecrementExpression))
                || node.Parent is PostfixUnaryExpressionSyntax postfix && (postfix.IsKind(SyntaxKind.PostIncrementExpression) || postfix.IsKind(SyntaxKind.PostDecrementExpression))))
                mutation = true;
            members[id] = new(id, typeName, name, mutation || members.TryGetValue(id, out var old) && old.MutationHint);
            if (mode == "read" && mutation)
                syntaxDiagnostics.Add(Diagnostic("NATIVE_READ_HAS_MUTATION", "Read-mode source references a native mutation: " + id));
        }
        if (syntaxDiagnostics.Count > 0)
            return new(null, syntaxDiagnostics.GroupBy(d => (d.Code, d.Message)).Select(g => g.First()).Take(32).ToArray());

        // Resolve the original program before adding the trusted bridge. Task
        // source cannot acquire access to injected host internals through an
        // otherwise unresolved name. Compiler-owned code is never user-edited.
        var sourceErrors = compilation.GetDiagnostics().Where(d => d.Severity == DiagnosticSeverity.Error).Take(32).ToArray();
        if (sourceErrors.Length > 0)
            return new(null, sourceErrors.Select(d => Diagnostic(d.Id, d.GetMessage())).ToArray());
        var instrumented = (CSharpSyntaxNode)new NativeProgramInstrumentation(model).Visit(root)!;
        var rewrittenTree = CSharpSyntaxTree.Create(instrumented, (CSharpParseOptions)tree.Options, tree.FilePath, Encoding.UTF8);
        var bridgeTree = CSharpSyntaxTree.ParseText(NativeProgramInstrumentation.Bridge(entry!.ToDisplayString()),
            (CSharpParseOptions)tree.Options, "NativeExecutionBoundary.g.cs", Encoding.UTF8);
        compilation = compilation.RemoveAllSyntaxTrees().AddSyntaxTrees(rewrittenTree, bridgeTree);

        using var stream = new MemoryStream();
        var emit = compilation.Emit(stream);
        if (!emit.Success) return new(null, emit.Diagnostics.Where(d => d.Severity == DiagnosticSeverity.Error).Take(32)
            .Select(d => Diagnostic(d.Id, d.GetMessage())).ToArray());
        var assembly = stream.ToArray();
        if (assembly.Length > 1024 * 1024) return Fail("NATIVE_ARTIFACT_SIZE", "Compiled native artifact exceeds one MiB.");
        using (var pe = new PEReader(new MemoryStream(assembly)))
        {
            var reader = pe.GetMetadataReader();
            foreach (var handle in reader.AssemblyReferences)
            {
                var actual = reader.GetAssemblyReference(handle);
                if (!identities.Any(i => i.Name == reader.GetString(actual.Name) && i.Version == actual.Version.ToString()))
                    return Fail("NATIVE_ARTIFACT_REFERENCE", "Compiled artifact references an unpinned assembly or a different target runtime.");
            }
            foreach (var handle in reader.MethodDefinitions)
                if ((reader.GetMethodDefinition(handle).Attributes & MethodAttributes.PinvokeImpl) != 0)
                    return Fail("PINVOKE_FORBIDDEN", "P/Invoke metadata is forbidden.");
        }
        return new(new("dynamic-revit-native-compile-artifact/v1", revitYear, mode, entryType,
            DynamicWire.Sha256(normalized), DynamicWire.Sha256(assembly), assembly, identities.ToArray(),
            members.Values.OrderBy(m => m.Id, StringComparer.Ordinal).ToArray()), Array.Empty<WorkerDiagnostic>());
    }

    private static WorkerDiagnostic Diagnostic(string code, string message) => new()
    { Code = code, Message = message, Phase = "native_compile", Severity = "error", RepairAction = "edit_source", Retryable = true };

    private static bool IsCollectorTypeLiteral(TypeOfExpressionSyntax node, SemanticModel model)
    {
        if (node.Parent is not ArgumentSyntax argument || argument.Parent is not ArgumentListSyntax arguments
            || arguments.Arguments.Count != 1 || arguments.Parent is not InvocationExpressionSyntax invocation
            || model.GetSymbolInfo(invocation).Symbol is not IMethodSymbol method || method.Name != "OfClass"
            || method.ContainingType?.ToDisplayString() != "Autodesk.Revit.DB.FilteredElementCollector"
            || method.ContainingAssembly?.Name != "RevitAPI"
            || model.GetTypeInfo(node.Type).Type is not INamedTypeSymbol type || type.ContainingAssembly?.Name != "RevitAPI") return false;
        for (var current = type; current != null; current = current.BaseType)
            if (current.ToDisplayString() == "Autodesk.Revit.DB.Element") return true;
        return false;
    }
}
