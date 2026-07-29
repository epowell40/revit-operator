using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;

namespace RevitSafeReadProof;

internal static class ProofIdentity
{
    public static string VerifierBundleSha256()
    {
        var files = new[]
        {
            typeof(ProofIdentity).Assembly.Location,
            typeof(Microsoft.CodeAnalysis.Compilation).Assembly.Location,
            typeof(Microsoft.CodeAnalysis.CSharp.CSharpCompilation).Assembly.Location,
        };
        return Canonical.Sha256Text(string.Join("\n", files
            .Select(static path => Path.GetFileName(path) + ":" + Canonical.Sha256File(path))
            .OrderBy(static value => value, StringComparer.Ordinal)));
    }

    public static string SourceLockSha256(ProofManifest manifest)
    {
        var lines = new List<string>
        {
            "assembly:" + manifest.Source.AssemblyName,
            "normalization:" + manifest.Source.TextNormalization,
        };
        lines.AddRange(manifest.Source.Files
            .OrderBy(static file => file.Path, StringComparer.Ordinal)
            .Select(static file => "source:" + Canonical.NormalizeRelativePath(file.Path) + ":" + file.Sha256));
        lines.AddRange(manifest.Source.Resources
            .OrderBy(static file => file.Path, StringComparer.Ordinal)
            .Select(static file => "resource:" + Canonical.NormalizeRelativePath(file.Path) + ":" + file.Sha256 + ":" + file.LogicalName + ":" + file.IsPublic));
        return Canonical.Sha256Text(string.Join("\n", lines));
    }

    public static string ApiLockSha256(ProofManifest manifest)
    {
        var lines = new List<string>();
        foreach (var variant in manifest.Variants.OrderBy(static value => value.RevitYear, StringComparer.Ordinal))
        {
            lines.Add("variant:" + variant.RevitYear + ":" + variant.TargetFramework + ":" + variant.Platform);
            lines.AddRange(variant.RevitReferences
                .OrderBy(static reference => reference.Identity, StringComparer.Ordinal)
                .Select(static reference => "api:" + reference.Identity + ":" + reference.Sha256));
        }
        return Canonical.Sha256Text(string.Join("\n", lines));
    }

    public static string SdkLockSha256(ProofManifest manifest)
    {
        var sdk = manifest.Sdk;
        var lines = new List<string>
        {
            sdk.Version,
            sdk.CompilerSha256,
            sdk.CompilerFileVersion,
            sdk.CodeAnalysisSha256,
            sdk.CodeAnalysisCSharpSha256,
            sdk.LanguageVersion,
        };
        foreach (var variant in manifest.Variants.OrderBy(static value => value.RevitYear, StringComparer.Ordinal))
        {
            foreach (var framework in variant.Frameworks.OrderBy(static value => value.Name, StringComparer.Ordinal))
            {
                lines.Add("framework:" + variant.RevitYear + ":" + framework.Name + ":" + framework.Version + ":" + framework.TargetFramework + ":" + framework.InventorySha256);
                lines.AddRange(framework.Files.OrderBy(static file => file.Identity, StringComparer.Ordinal)
                    .Select(static file => "framework-file:" + file.Identity + ":" + file.Sha256));
            }
        }
        return Canonical.Sha256Text(string.Join("\n", lines));
    }
}
