using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.IO;
using System.Linq;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.Emit;

namespace RevitSafeReadProof;

internal sealed class CompilationObservation
{
    public CSharpCompilation Compilation { get; set; } = null!;
    public byte[] EmittedBytes { get; set; } = Array.Empty<byte>();
    public InventoryExpectation References { get; set; } = new();
}

internal sealed class DirectCompiler
{
    private readonly ProofManifest _manifest;
    private readonly LockedInputs _inputs;
    private readonly List<ProofIssue> _issues;

    public DirectCompiler(ProofManifest manifest, LockedInputs inputs, List<ProofIssue> issues)
    {
        _manifest = manifest;
        _inputs = inputs;
        _issues = issues;
    }

    public CompilationObservation Compile(VariantLock variant, IReadOnlyList<SyntaxTree> trees)
    {
        var referencePaths = (_inputs.FrameworkReferences.TryGetValue(variant.RevitYear, out var framework) ? framework : Enumerable.Empty<string>())
            .Concat(_inputs.RevitReferences.TryGetValue(variant.RevitYear, out var revit) ? revit : Enumerable.Empty<string>())
            .ToList();
        var duplicatePath = referencePaths
            .GroupBy(static path => Path.GetFullPath(path), StringComparer.OrdinalIgnoreCase)
            .FirstOrDefault(static group => group.Count() > 1);
        if (duplicatePath is not null)
        {
            Add("DUPLICATE_REFERENCE_PATH", "Reference path occurs more than once: " + duplicatePath.Key);
        }

        var metadataReferences = new List<MetadataReference>();
        var referenceLines = new List<string>();
        var identities = new HashSet<string>(StringComparer.Ordinal);
        foreach (var path in referencePaths)
        {
            try
            {
                metadataReferences.Add(MetadataReference.CreateFromFile(path, MetadataReferenceProperties.Assembly));
                var identity = Canonical.ReadAssemblyIdentity(path);
                referenceLines.Add("REFERENCE|" + Path.GetFileName(path) + "|sha256=" + Canonical.Sha256File(path) + "|identity=" + identity);
                if (!identities.Add(identity))
                {
                    Add("DUPLICATE_REFERENCE_IDENTITY", "Compilation reference identity occurs more than once for Revit " + variant.RevitYear + ": " + identity);
                }
            }
            catch (Exception exception) when (exception is IOException or BadImageFormatException)
            {
                Add("REFERENCE_LOAD", "Could not create metadata reference for " + path + ": " + exception.Message);
            }
        }

        var options = new CSharpCompilationOptions(
            outputKind: OutputKind.DynamicallyLinkedLibrary,
            moduleName: _manifest.Source.AssemblyName + ".dll",
            mainTypeName: null,
            scriptClassName: null,
            usings: ImmutableArray<string>.Empty,
            optimizationLevel: OptimizationLevel.Release,
            checkOverflow: true,
            allowUnsafe: false,
            cryptoKeyContainer: null,
            cryptoKeyFile: null,
            cryptoPublicKey: ImmutableArray<byte>.Empty,
            delaySign: null,
            platform: string.Equals(variant.Platform, "x64", StringComparison.Ordinal) ? Platform.X64 : Platform.AnyCpu,
            generalDiagnosticOption: ReportDiagnostic.Error,
            warningLevel: 9999,
            specificDiagnosticOptions: null,
            concurrentBuild: false,
            deterministic: true,
            xmlReferenceResolver: null,
            sourceReferenceResolver: null,
            metadataReferenceResolver: null,
            assemblyIdentityComparer: DesktopAssemblyIdentityComparer.Default,
            strongNameProvider: null,
            publicSign: false,
            metadataImportOptions: MetadataImportOptions.All,
            nullableContextOptions: NullableContextOptions.Enable,
            reportSuppressedDiagnostics: true);

        var compilation = CSharpCompilation.Create(
            _manifest.Source.AssemblyName,
            trees,
            metadataReferences,
            options);

        RejectDiagnostics(compilation.GetDiagnostics(), "COMPILER_DIAGNOSTIC");
        var first = Emit(compilation, "EMIT_DIAGNOSTIC");
        var second = Emit(compilation, "SECOND_EMIT_DIAGNOSTIC");
        if (!first.SequenceEqual(second))
        {
            Add("NONDETERMINISTIC_EMIT", "Two in-memory deterministic Roslyn emits differed for Revit " + variant.RevitYear + ".");
        }

        foreach (var referencedIdentity in compilation.ReferencedAssemblyNames)
        {
            var canonical = Canonical.AssemblyIdentity(referencedIdentity);
            if (!identities.Contains(canonical))
            {
                Add("REFERENCE_BINDING_UNKNOWN", "Compilation bound an assembly identity outside the exact reference inventory: " + canonical);
            }
        }

        return new CompilationObservation
        {
            Compilation = compilation,
            EmittedBytes = first,
            References = Canonical.Inventory(referenceLines, preserveOrder: false),
        };
    }

    private byte[] Emit(CSharpCompilation compilation, string diagnosticCode)
    {
        using var stream = new MemoryStream();
        var resources = _inputs.Resources.Select(resource => new ResourceDescription(
            resource.LogicalName,
            () => new MemoryStream(resource.Bytes, writable: false),
            resource.IsPublic));
        var result = compilation.Emit(
            peStream: stream,
            pdbStream: null,
            xmlDocumentationStream: null,
            win32Resources: null,
            manifestResources: resources,
            options: new EmitOptions(),
            cancellationToken: default);
        RejectDiagnostics(result.Diagnostics, diagnosticCode);
        if (!result.Success)
        {
            Add("EMIT_FAILED", "Direct Roslyn emit failed.");
        }
        return stream.ToArray();
    }

    private void RejectDiagnostics(ImmutableArray<Diagnostic> diagnostics, string code)
    {
        foreach (var diagnostic in diagnostics)
        {
            var location = diagnostic.Location.IsInSource
                ? diagnostic.Location.SourceTree?.FilePath + ":" + diagnostic.Location.SourceSpan.Start
                : diagnostic.Location.Kind.ToString();
            Add(code, diagnostic.Id + "|severity=" + diagnostic.Severity + "|warningAsError=" + diagnostic.IsWarningAsError + "|suppressed=" + diagnostic.IsSuppressed + "|location=" + location + "|message=" + diagnostic.GetMessage(System.Globalization.CultureInfo.InvariantCulture));
        }
    }

    private void Add(string code, string message)
    {
        _issues.Add(new ProofIssue(code, message));
    }
}
