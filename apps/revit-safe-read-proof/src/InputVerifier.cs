using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;

namespace RevitSafeReadProof;

internal sealed class InputVerifier
{
    private readonly string _manifestPath;
    private readonly ProofManifest _manifest;
    private readonly List<ProofIssue> _issues;

    public InputVerifier(string manifestPath, ProofManifest manifest, List<ProofIssue> issues)
    {
        _manifestPath = manifestPath;
        _manifest = manifest;
        _issues = issues;
    }

    public LockedInputs Verify()
    {
        var inputs = new LockedInputs
        {
            ManifestDirectory = Path.GetDirectoryName(_manifestPath) ?? throw new InvalidDataException("Manifest has no parent directory."),
        };

        VerifyManifestHeader();
        VerifySdk();
        VerifyFramework(inputs);
        VerifySource(inputs);
        VerifyVariants(inputs);
        return inputs;
    }

    private void VerifyManifestHeader()
    {
        Check(_manifest.SchemaVersion == 1, "MANIFEST_SCHEMA", "schemaVersion must be exactly 1.");
        Check(string.Equals(_manifest.ProofKind, Constants.ProofKind, StringComparison.Ordinal), "MANIFEST_KIND", "proofKind must be exactly " + Constants.ProofKind + ".");
        Check(string.Equals(_manifest.TrustBoundary, Constants.TrustBoundary, StringComparison.Ordinal), "TRUST_BOUNDARY", "The explicit local-admin/OS/Revit trust boundary is missing or changed.");
        Check(!string.IsNullOrWhiteSpace(_manifest.Source.AssemblyName), "ASSEMBLY_NAME", "source.assemblyName is required.");
        Check(IsSimpleAssemblyName(_manifest.Source.AssemblyName), "ASSEMBLY_NAME", "source.assemblyName must contain only ASCII letters, digits, period, underscore, or hyphen.");
        Check(_manifest.Policy.AllowedOperationKinds.Count > 0, "POLICY_EMPTY", "allowedOperationKinds must be explicit and non-empty.");
        Check(_manifest.Policy.AllowedImplicitOperationKinds.Count > 0, "POLICY_EMPTY", "allowedImplicitOperationKinds must be explicit and non-empty.");
        RejectDuplicates(_manifest.Policy.AllowedOperationKinds, "POLICY_DUPLICATE", "allowedOperationKinds");
        RejectDuplicates(_manifest.Policy.AllowedImplicitOperationKinds, "POLICY_DUPLICATE", "allowedImplicitOperationKinds");
        RejectDuplicates(_manifest.Policy.AllowedSensitiveSymbols, "POLICY_DUPLICATE", "allowedSensitiveSymbols");
        RejectDuplicates(_manifest.Policy.AllowedMutableFields, "POLICY_DUPLICATE", "allowedMutableFields");
        RejectDuplicates(_manifest.Policy.SerializationRoots, "POLICY_DUPLICATE", "serializationRoots");
    }

    private void VerifySdk()
    {
        var sdk = _manifest.Sdk;
        Check(string.Equals(sdk.Version, "9.0.304", StringComparison.Ordinal), "SDK_VERSION", "SDK version must be exactly 9.0.304 for proof v1.");
        Check(string.Equals(sdk.LanguageVersion, "13.0", StringComparison.Ordinal), "LANGUAGE_VERSION", "Language version must be exactly 13.0.");
        VerifyAbsoluteLockedFile(sdk.CompilerPath, sdk.CompilerSha256, "COMPILER_LOCK");
        VerifyAbsoluteLockedFile(sdk.CodeAnalysisPath, sdk.CodeAnalysisSha256, "ROSLYN_LOCK");
        VerifyAbsoluteLockedFile(sdk.CodeAnalysisCSharpPath, sdk.CodeAnalysisCSharpSha256, "ROSLYN_LOCK");

        if (Path.IsPathFullyQualified(sdk.SdkPath))
        {
            var expectedCompiler = Path.GetFullPath(Path.Combine(sdk.SdkPath, "Roslyn", "bincore", "csc.dll"));
            Check(PathEquals(expectedCompiler, sdk.CompilerPath), "COMPILER_PATH", "compilerPath must be the csc.dll beneath the exact sdkPath.");
            Check(string.Equals(new DirectoryInfo(sdk.SdkPath).Name, sdk.Version, StringComparison.Ordinal), "SDK_PATH", "sdkPath leaf must equal the exact SDK version.");
        }
        else
        {
            Add("SDK_PATH", "sdkPath must be absolute.");
        }

        if (File.Exists(sdk.CompilerPath))
        {
            var actualVersion = FileVersionInfo.GetVersionInfo(sdk.CompilerPath).FileVersion ?? string.Empty;
            Check(string.Equals(actualVersion, sdk.CompilerFileVersion, StringComparison.Ordinal), "COMPILER_VERSION", "csc.dll file version did not match compilerFileVersion.");
        }

        var runningCodeAnalysis = typeof(Microsoft.CodeAnalysis.Compilation).Assembly.Location;
        var runningCSharp = typeof(Microsoft.CodeAnalysis.CSharp.CSharpCompilation).Assembly.Location;
        if (File.Exists(runningCodeAnalysis))
        {
            Check(string.Equals(Canonical.Sha256File(runningCodeAnalysis), sdk.CodeAnalysisSha256, StringComparison.Ordinal), "ROSLYN_RUNTIME", "Loaded Microsoft.CodeAnalysis.dll does not match the manifest lock.");
        }
        if (File.Exists(runningCSharp))
        {
            Check(string.Equals(Canonical.Sha256File(runningCSharp), sdk.CodeAnalysisCSharpSha256, StringComparison.Ordinal), "ROSLYN_RUNTIME", "Loaded Microsoft.CodeAnalysis.CSharp.dll does not match the manifest lock.");
        }
    }

    private void VerifyFramework(LockedInputs inputs)
    {
        var framework = _manifest.Framework;
        Check(string.Equals(framework.Name, "Microsoft.NETCore.App.Ref", StringComparison.Ordinal), "FRAMEWORK_NAME", "framework.name must be Microsoft.NETCore.App.Ref.");
        Check(string.Equals(framework.Version, "9.0.8", StringComparison.Ordinal), "FRAMEWORK_VERSION", "framework.version must be exactly 9.0.8 for proof v1.");
        Check(string.Equals(framework.TargetFramework, "net9.0", StringComparison.Ordinal), "FRAMEWORK_TFM", "framework.targetFramework must be net9.0.");
        if (!Path.IsPathFullyQualified(framework.ReferenceRoot) || !Directory.Exists(framework.ReferenceRoot))
        {
            Add("FRAMEWORK_ROOT", "framework.referenceRoot must be an existing absolute directory.");
            return;
        }

        RejectDuplicates(framework.Files.Select(static file => Canonical.NormalizeRelativePath(file.Path)), "FRAMEWORK_DUPLICATE", "framework.files paths");
        var lockedRelative = new List<string>();
        var inventoryLines = new List<string>();
        var identities = new HashSet<string>(StringComparer.Ordinal);
        foreach (var file in framework.Files.OrderBy(static file => Canonical.NormalizeRelativePath(file.Path), StringComparer.Ordinal))
        {
            var resolved = ResolveRelative(framework.ReferenceRoot, file.Path, "FRAMEWORK_PATH");
            if (resolved is null)
            {
                continue;
            }
            var relative = Canonical.NormalizeRelativePath(Path.GetRelativePath(framework.ReferenceRoot, resolved));
            lockedRelative.Add(relative);
            if (VerifyLockedAssembly(resolved, file, "FRAMEWORK_FILE"))
            {
                inputs.FrameworkReferences.Add(resolved);
                inventoryLines.Add(relative + "|sha256=" + file.Sha256 + "|identity=" + file.Identity);
                if (!identities.Add(file.Identity))
                {
                    Add("DUPLICATE_REFERENCE_IDENTITY", "Duplicate framework assembly identity: " + file.Identity);
                }
            }
        }

        var actualRelative = Directory.EnumerateFiles(framework.ReferenceRoot, "*.dll", SearchOption.TopDirectoryOnly)
            .Select(path => Canonical.NormalizeRelativePath(Path.GetRelativePath(framework.ReferenceRoot, path)))
            .OrderBy(static value => value, StringComparer.Ordinal)
            .ToList();
        lockedRelative.Sort(StringComparer.Ordinal);
        if (!lockedRelative.SequenceEqual(actualRelative, StringComparer.Ordinal))
        {
            Add("FRAMEWORK_EXACT_SET", "Framework DLL set differs from the exact locked file set. locked=[" + string.Join(",", lockedRelative) + "] actual=[" + string.Join(",", actualRelative) + "]");
        }
        var inventoryHash = Canonical.Sha256Text(string.Join("\n", inventoryLines));
        Check(string.Equals(inventoryHash, framework.InventorySha256, StringComparison.Ordinal), "FRAMEWORK_INVENTORY", "Framework inventory hash mismatch.");
    }

    private void VerifySource(LockedInputs inputs)
    {
        if (string.IsNullOrWhiteSpace(_manifest.Source.Root))
        {
            Add("SOURCE_ROOT", "source.root must be non-empty.");
            return;
        }
        var sourceRoot = ResolvePath(Path.GetDirectoryName(_manifestPath) ?? string.Empty, _manifest.Source.Root);
        inputs.SourceRoot = sourceRoot;
        if (!Directory.Exists(sourceRoot))
        {
            Add("SOURCE_ROOT", "source.root does not exist: " + sourceRoot);
            return;
        }
        RejectReparsePoint(sourceRoot, "SOURCE_REPARSE_POINT");
        foreach (var directory in Directory.EnumerateDirectories(sourceRoot, "*", SearchOption.AllDirectories))
        {
            RejectReparsePoint(directory, "SOURCE_REPARSE_POINT");
        }

        var declared = new List<string>();
        var seenLogical = new HashSet<string>(StringComparer.Ordinal);
        foreach (var file in _manifest.Source.Files.OrderBy(static file => Canonical.NormalizeRelativePath(file.Path), StringComparer.Ordinal))
        {
            var resolved = ResolveRelative(sourceRoot, file.Path, "SOURCE_PATH");
            if (resolved is null)
            {
                continue;
            }
            var logical = Canonical.NormalizeRelativePath(Path.GetRelativePath(sourceRoot, resolved));
            if (!seenLogical.Add(logical))
            {
                Add("SOURCE_DUPLICATE", "Duplicate source path: " + logical);
                continue;
            }
            declared.Add(logical);
            if (!logical.EndsWith(".cs", StringComparison.Ordinal))
            {
                Add("SOURCE_EXTENSION", "Source path must end with lowercase .cs: " + logical);
            }
            if (!File.Exists(resolved))
            {
                Add("SOURCE_MISSING", "Locked source file is missing: " + logical);
                continue;
            }
            RejectReparsePoint(resolved, "SOURCE_REPARSE_POINT");
            var bytes = File.ReadAllBytes(resolved);
            Check(string.Equals(Canonical.Sha256(bytes), file.Sha256, StringComparison.Ordinal), "SOURCE_HASH", "Source SHA-256 mismatch: " + logical);
            inputs.Sources.Add(new LockedSourceFile { LogicalPath = logical, FullPath = resolved, Bytes = bytes });
        }

        RejectDuplicates(_manifest.Source.Resources.Select(static resource => resource.LogicalName), "RESOURCE_DUPLICATE_NAME", "resource logical names");
        foreach (var resource in _manifest.Source.Resources.OrderBy(static file => Canonical.NormalizeRelativePath(file.Path), StringComparer.Ordinal))
        {
            var resolved = ResolveRelative(sourceRoot, resource.Path, "RESOURCE_PATH");
            if (resolved is null)
            {
                continue;
            }
            var logical = Canonical.NormalizeRelativePath(Path.GetRelativePath(sourceRoot, resolved));
            if (!seenLogical.Add(logical))
            {
                Add("RESOURCE_DUPLICATE", "Source/resource path appears more than once: " + logical);
                continue;
            }
            declared.Add(logical);
            if (string.IsNullOrWhiteSpace(resource.LogicalName))
            {
                Add("RESOURCE_NAME", "Resource logicalName is required: " + logical);
            }
            if (!File.Exists(resolved))
            {
                Add("RESOURCE_MISSING", "Locked resource is missing: " + logical);
                continue;
            }
            RejectReparsePoint(resolved, "SOURCE_REPARSE_POINT");
            var bytes = File.ReadAllBytes(resolved);
            Check(string.Equals(Canonical.Sha256(bytes), resource.Sha256, StringComparison.Ordinal), "RESOURCE_HASH", "Resource SHA-256 mismatch: " + logical);
            inputs.Resources.Add(new LockedResourceFile
            {
                LogicalPath = logical,
                LogicalName = resource.LogicalName,
                IsPublic = resource.IsPublic,
                Bytes = bytes,
            });
        }

        declared.Sort(StringComparer.Ordinal);
        var actual = Directory.EnumerateFiles(sourceRoot, "*", SearchOption.AllDirectories)
            .Select(path => Canonical.NormalizeRelativePath(Path.GetRelativePath(sourceRoot, path)))
            .OrderBy(static value => value, StringComparer.Ordinal)
            .ToList();
        if (!declared.SequenceEqual(actual, StringComparer.Ordinal))
        {
            Add("SOURCE_EXACT_SET", "Source root file set differs from the exact source/resource locks. locked=[" + string.Join(",", declared) + "] actual=[" + string.Join(",", actual) + "]");
        }
    }

    private void VerifyVariants(LockedInputs inputs)
    {
        var expectedYears = new[] { "2023", "2024", "2025" };
        var actualYears = _manifest.Variants.Select(static variant => variant.RevitYear).OrderBy(static year => year, StringComparer.Ordinal).ToArray();
        if (!expectedYears.SequenceEqual(actualYears, StringComparer.Ordinal))
        {
            Add("REVIT_YEAR_SET", "Variants must contain exactly one lock for Revit 2023, 2024, and 2025.");
        }

        foreach (var variant in _manifest.Variants.OrderBy(static variant => variant.RevitYear, StringComparer.Ordinal))
        {
            var expectedSymbol = "REVIT" + variant.RevitYear;
            if (variant.PreprocessorSymbols.Count != 1 || !string.Equals(variant.PreprocessorSymbols[0], expectedSymbol, StringComparison.Ordinal))
            {
                Add("PREPROCESSOR_SYMBOLS", "Revit " + variant.RevitYear + " must define exactly " + expectedSymbol + ".");
            }
            if (variant.RevitReferences.Count == 0)
            {
                Add("REVIT_REFERENCE_EMPTY", "Revit " + variant.RevitYear + " has no locked reference.");
            }

            var paths = new List<string>();
            var identities = new HashSet<string>(StringComparer.Ordinal);
            foreach (var reference in variant.RevitReferences)
            {
                var resolved = ResolvePath(Path.GetDirectoryName(_manifestPath) ?? string.Empty, reference.Path);
                if (!Path.IsPathFullyQualified(resolved))
                {
                    Add("REVIT_REFERENCE_PATH", "Revit reference path must resolve absolutely: " + reference.Path);
                    continue;
                }
                if (VerifyLockedAssembly(resolved, reference, "REVIT_REFERENCE"))
                {
                    paths.Add(resolved);
                    if (!identities.Add(reference.Identity))
                    {
                        Add("DUPLICATE_REFERENCE_IDENTITY", "Duplicate Revit reference identity for " + variant.RevitYear + ": " + reference.Identity);
                    }
                    RejectForwarders(resolved, variant.RevitYear);
                }
            }
            if (!variant.RevitReferences.Any(static reference => reference.Identity.StartsWith("RevitAPI, Version=", StringComparison.Ordinal)))
            {
                Add("REVIT_API_IDENTITY", "Revit " + variant.RevitYear + " must lock a RevitAPI assembly identity.");
            }
            inputs.RevitReferences[variant.RevitYear] = paths;
        }
    }

    private void RejectForwarders(string path, string year)
    {
        try
        {
            using var stream = File.OpenRead(path);
            using var pe = new PEReader(stream);
            var reader = pe.GetMetadataReader();
            foreach (var handle in reader.ExportedTypes)
            {
                var exported = reader.GetExportedType(handle);
                if ((exported.Attributes & (System.Reflection.TypeAttributes)0x00200000) != 0)
                {
                    Add("REVIT_TYPE_FORWARDER", "Revit " + year + " reference contains a type forwarder: " + reader.GetString(exported.Namespace) + "." + reader.GetString(exported.Name));
                }
            }
        }
        catch (Exception exception) when (exception is BadImageFormatException or IOException)
        {
            Add("REVIT_METADATA", "Could not inspect Revit reference metadata: " + exception.Message);
        }
    }

    private bool VerifyLockedAssembly(string path, AssemblyFileLock file, string code)
    {
        if (!File.Exists(path))
        {
            Add(code, "Locked assembly is missing: " + path);
            return false;
        }
        RejectReparsePoint(path, code + "_REPARSE_POINT");
        var hash = Canonical.Sha256File(path);
        Check(string.Equals(hash, file.Sha256, StringComparison.Ordinal), code + "_HASH", "Assembly SHA-256 mismatch: " + path);
        try
        {
            var identity = Canonical.ReadAssemblyIdentity(path);
            Check(string.Equals(identity, file.Identity, StringComparison.Ordinal), code + "_IDENTITY", "Assembly identity mismatch for " + path + ". Expected " + file.Identity + "; actual " + identity + ".");
            return true;
        }
        catch (Exception exception) when (exception is BadImageFormatException or IOException or InvalidDataException)
        {
            Add(code + "_METADATA", "Assembly metadata could not be read for " + path + ": " + exception.Message);
            return false;
        }
    }

    private void VerifyAbsoluteLockedFile(string path, string sha256, string code)
    {
        if (!Path.IsPathFullyQualified(path) || !File.Exists(path))
        {
            Add(code, "Locked file must be an existing absolute path: " + path);
            return;
        }
        var actual = Canonical.Sha256File(path);
        Check(string.Equals(actual, sha256, StringComparison.Ordinal), code, "SHA-256 mismatch for " + path + ".");
    }

    private static bool IsSimpleAssemblyName(string value)
    {
        return value.Length > 0 && value.All(static character =>
            (character >= 'a' && character <= 'z') ||
            (character >= 'A' && character <= 'Z') ||
            (character >= '0' && character <= '9') ||
            character is '.' or '_' or '-');
    }

    private static string ResolvePath(string basePath, string value)
    {
        return Path.GetFullPath(Path.IsPathFullyQualified(value) ? value : Path.Combine(basePath, value));
    }

    private string? ResolveRelative(string root, string relative, string code)
    {
        if (Path.IsPathFullyQualified(relative))
        {
            Add(code, "Path must be relative to its locked root: " + relative);
            return null;
        }
        var full = Path.GetFullPath(Path.Combine(root, relative));
        var rootWithSeparator = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar) + Path.DirectorySeparatorChar;
        if (!full.StartsWith(rootWithSeparator, StringComparison.OrdinalIgnoreCase))
        {
            Add(code, "Path escapes its locked root: " + relative);
            return null;
        }
        return full;
    }

    private void RejectReparsePoint(string path, string code)
    {
        if ((File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0)
        {
            Add(code, "Reparse points are not accepted for locked inputs: " + path);
        }
    }

    private static bool PathEquals(string left, string right)
    {
        return string.Equals(Path.GetFullPath(left), Path.GetFullPath(right), StringComparison.OrdinalIgnoreCase);
    }

    private void RejectDuplicates(IEnumerable<string> values, string code, string label)
    {
        var set = new HashSet<string>(StringComparer.Ordinal);
        foreach (var value in values)
        {
            if (!set.Add(value))
            {
                Add(code, "Duplicate " + label + " entry: " + value);
            }
        }
    }

    private void Check(bool condition, string code, string message)
    {
        if (!condition)
        {
            Add(code, message);
        }
    }

    private void Add(string code, string message)
    {
        _issues.Add(new ProofIssue(code, message));
    }
}
