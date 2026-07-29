using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace RevitSafeReadProof;

internal static class Program
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        AllowTrailingCommas = false,
        PropertyNameCaseInsensitive = false,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        ReadCommentHandling = JsonCommentHandling.Disallow,
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
        WriteIndented = true,
    };

    public static int Main(string[] args)
    {
        try
        {
            return Run(args);
        }
        catch (Exception exception)
        {
            Console.Error.WriteLine("PROOF_TOOL_FATAL: " + exception.GetType().FullName + ": " + exception.Message);
            return 70;
        }
    }

    private static int Run(string[] args)
    {
        if (args.Length == 0 || args[0] is not ("check" or "inventory" or "fingerprint" or "equivalence"))
        {
            Console.Error.WriteLine("Usage: RevitSafeReadProof <check|inventory> --manifest <abs> --output-dir <empty abs> | fingerprint --artifact <abs> --output-dir <empty abs> | equivalence --unsigned-artifact <abs> --candidate-artifact <abs> --proof-receipt <abs> --revit-year <2023|2024|2025> --output-dir <empty abs>");
            return 64;
        }

        var mode = args[0];
        var options = ParseOptions(args.Skip(1).ToArray());
        if (mode == "fingerprint")
        {
            return RunFingerprint(options);
        }
        if (mode == "equivalence")
        {
            return RunEquivalence(options);
        }
        if (!options.TryGetValue("--manifest", out var manifestArgument) ||
            !options.TryGetValue("--output-dir", out var outputArgument))
        {
            Console.Error.WriteLine("Both --manifest and --output-dir are required.");
            return 64;
        }

        if (!Path.IsPathFullyQualified(manifestArgument) || !Path.IsPathFullyQualified(outputArgument))
        {
            Console.Error.WriteLine("Manifest and output directory paths must be absolute.");
            return 64;
        }

        var manifestPath = Path.GetFullPath(manifestArgument);
        var outputRoot = Path.GetFullPath(outputArgument);
        if (!File.Exists(manifestPath))
        {
            Console.Error.WriteLine("Manifest does not exist: " + manifestPath);
            return 66;
        }
        if (File.Exists(outputRoot))
        {
            Console.Error.WriteLine("Output directory resolves to a file: " + outputRoot);
            return 73;
        }

        Directory.CreateDirectory(outputRoot);
        if (Directory.EnumerateFileSystemEntries(outputRoot).Any())
        {
            Console.Error.WriteLine("Output directory must be empty: " + outputRoot);
            return 73;
        }

        var manifestBytes = File.ReadAllBytes(manifestPath);
        var manifest = DeserializeStrict(manifestBytes);
        var verifier = new WholeAssemblyVerifier(manifestPath, manifest, mode == "check");
        var result = verifier.Run();

        var receipt = new ProofReceipt
        {
            Mode = mode,
            Status = result.Issues.Count == 0 ? (mode == "check" ? "verified" : "observed") : "rejected",
            Certified = mode == "check" && result.Issues.Count == 0,
            ManifestSha256 = Canonical.Sha256(manifestBytes),
            VerifierProfileId = CertifiedKernelProfile.Id,
            VerifierProfileSha256 = CertifiedKernelProfile.Sha256(),
            VerifierBundleSha256 = ProofIdentity.VerifierBundleSha256(),
            SourceLockSha256 = ProofIdentity.SourceLockSha256(manifest),
            ApiLockSha256 = ProofIdentity.ApiLockSha256(manifest),
            SdkLockSha256 = ProofIdentity.SdkLockSha256(manifest),
            TrustBoundary = manifest.TrustBoundary,
            CompilerOptions = Constants.CompilerOptions.ToList(),
            Issues = result.Issues
                .OrderBy(static issue => issue.Code, StringComparer.Ordinal)
                .ThenBy(static issue => issue.Message, StringComparer.Ordinal)
                .ToList(),
            Observation = result.Observation,
        };

        if (mode == "check" && result.Issues.Count == 0)
        {
            foreach (var pair in result.Observation.Variants)
            {
                var fileName = manifest.Source.AssemblyName + ".Revit" + pair.Key + ".dll";
                var path = Path.Combine(outputRoot, fileName);
                File.WriteAllBytes(path, pair.Value.EmittedBytes);
                receipt.Artifacts.Add(pair.Key, new ArtifactReceipt
                {
                    FileName = fileName,
                    Sha256 = Canonical.Sha256(pair.Value.EmittedBytes),
                    Length = pair.Value.EmittedBytes.LongLength,
                    ManagedCodeSha256 = pair.Value.ManagedCodeSha256,
                    AssemblyIdentity = pair.Value.AssemblyIdentity,
                    TargetFramework = pair.Value.TargetFramework,
                    Platform = pair.Value.Platform,
                });
            }
        }

        if (mode == "inventory")
        {
            var expectedPath = Path.Combine(outputRoot, "observed.expected.json");
            WriteJson(expectedPath, result.Observation.ToExpected());
        }

        var receiptPath = Path.Combine(outputRoot, "proof.receipt.json");
        WriteJson(receiptPath, receipt);

        if (receipt.Certified)
        {
            Console.WriteLine("VERIFIED " + receipt.ManifestSha256);
            return 0;
        }
        if (mode == "inventory" && result.Issues.Count == 0)
        {
            Console.WriteLine("OBSERVED_NOT_CERTIFIED " + receipt.ManifestSha256);
            return 0;
        }

        foreach (var issue in receipt.Issues)
        {
            Console.Error.WriteLine(issue.Code + ": " + issue.Message);
        }
        return 1;
    }

    private static int RunFingerprint(IReadOnlyDictionary<string, string> options)
    {
        if (!options.TryGetValue("--artifact", out var artifactArgument) ||
            !options.TryGetValue("--output-dir", out var outputArgument) ||
            !Path.IsPathFullyQualified(artifactArgument) ||
            !Path.IsPathFullyQualified(outputArgument))
        {
            Console.Error.WriteLine("fingerprint requires absolute --artifact and --output-dir paths.");
            return 64;
        }
        var artifactPath = Path.GetFullPath(artifactArgument);
        var outputRoot = Path.GetFullPath(outputArgument);
        if (!File.Exists(artifactPath))
        {
            Console.Error.WriteLine("Artifact does not exist: " + artifactPath);
            return 66;
        }
        if (File.Exists(outputRoot))
        {
            Console.Error.WriteLine("Output directory resolves to a file: " + outputRoot);
            return 73;
        }
        Directory.CreateDirectory(outputRoot);
        if (Directory.EnumerateFileSystemEntries(outputRoot).Any())
        {
            Console.Error.WriteLine("Output directory must be empty: " + outputRoot);
            return 73;
        }

        var bytes = File.ReadAllBytes(artifactPath);
        var issues = new List<ProofIssue>();
        MetadataInspection inspection;
        try
        {
            inspection = new MetadataInspector(issues).Inspect(bytes);
        }
        catch (Exception exception) when (exception is InvalidDataException or BadImageFormatException or OverflowException or ArgumentOutOfRangeException or IndexOutOfRangeException)
        {
            issues.Add(new ProofIssue("ARTIFACT_INSPECTION", "Artifact inspection failed closed: " + exception.GetType().Name + ": " + exception.Message));
            inspection = new MetadataInspection();
        }
        var receipt = new ArtifactFingerprintReceipt
        {
            Status = issues.Count == 0 ? "verified" : "rejected",
            Sha256 = Canonical.Sha256(bytes),
            Length = bytes.LongLength,
            ManagedCodeSha256 = Canonical.Sha256Text("metadata:" + inspection.Metadata.Sha256 + "\nil:" + inspection.Il.Sha256),
            AssemblyIdentity = inspection.AssemblyIdentity,
            Issues = issues.OrderBy(static issue => issue.Code, StringComparer.Ordinal).ThenBy(static issue => issue.Message, StringComparer.Ordinal).ToList(),
            Metadata = inspection.Metadata,
            Il = inspection.Il,
        };
        WriteJson(Path.Combine(outputRoot, "artifact.fingerprint.json"), receipt);
        if (issues.Count == 0)
        {
            Console.WriteLine("FINGERPRINTED " + receipt.ManagedCodeSha256);
            return 0;
        }
        foreach (var issue in receipt.Issues)
        {
            Console.Error.WriteLine(issue.Code + ": " + issue.Message);
        }
        return 1;
    }

    private static int RunEquivalence(IReadOnlyDictionary<string, string> options)
    {
        var required = new[] { "--unsigned-artifact", "--candidate-artifact", "--proof-receipt", "--revit-year", "--output-dir" };
        if (required.Any(option => !options.ContainsKey(option)) ||
            !Path.IsPathFullyQualified(options["--unsigned-artifact"]) ||
            !Path.IsPathFullyQualified(options["--candidate-artifact"]) ||
            !Path.IsPathFullyQualified(options["--proof-receipt"]) ||
            !Path.IsPathFullyQualified(options["--output-dir"]) ||
            options["--revit-year"] is not ("2023" or "2024" or "2025"))
        {
            Console.Error.WriteLine("equivalence requires absolute --unsigned-artifact, --candidate-artifact, --proof-receipt, --output-dir and --revit-year 2023|2024|2025.");
            return 64;
        }

        var unsignedPath = Path.GetFullPath(options["--unsigned-artifact"]);
        var candidatePath = Path.GetFullPath(options["--candidate-artifact"]);
        var proofReceiptPath = Path.GetFullPath(options["--proof-receipt"]);
        var outputRoot = Path.GetFullPath(options["--output-dir"]);
        foreach (var path in new[] { unsignedPath, candidatePath, proofReceiptPath })
        {
            if (!File.Exists(path))
            {
                Console.Error.WriteLine("Required equivalence input does not exist: " + path);
                return 66;
            }
        }
        if (File.Exists(outputRoot))
        {
            Console.Error.WriteLine("Output directory resolves to a file: " + outputRoot);
            return 73;
        }
        Directory.CreateDirectory(outputRoot);
        if (Directory.EnumerateFileSystemEntries(outputRoot).Any())
        {
            Console.Error.WriteLine("Output directory must be empty: " + outputRoot);
            return 73;
        }

        var unsignedBytes = File.ReadAllBytes(unsignedPath);
        var candidateBytes = File.ReadAllBytes(candidatePath);
        var proofReceiptBytes = File.ReadAllBytes(proofReceiptPath);
        var issues = new List<ProofIssue>();
        var lockInfo = ReadReceiptArtifactLock(proofReceiptBytes, options["--revit-year"], issues);
        var unsignedSha256 = Canonical.Sha256(unsignedBytes);
        if (!string.Equals(lockInfo.Sha256, unsignedSha256, StringComparison.Ordinal) || lockInfo.Length != unsignedBytes.LongLength)
        {
            issues.Add(new ProofIssue("UNSIGNED_RECEIPT_MISMATCH", "Unsigned artifact bytes do not match the selected certified proof-receipt artifact lock."));
        }
        if (!string.Equals(lockInfo.FileName, Path.GetFileName(unsignedPath), StringComparison.Ordinal))
        {
            issues.Add(new ProofIssue("UNSIGNED_FILENAME_MISMATCH", "Unsigned artifact filename does not match the certified proof receipt."));
        }

        var peResult = PeAuthenticodeEquivalence.Verify(unsignedBytes, candidateBytes, issues);
        var receipt = new ArtifactEquivalenceReceipt
        {
            Status = issues.Count == 0 ? "verified" : "rejected",
            Equivalent = issues.Count == 0,
            ProofReceiptSha256 = Canonical.Sha256(proofReceiptBytes),
            RevitYear = options["--revit-year"],
            ArtifactFileName = lockInfo.FileName,
            UnsignedSha256 = unsignedSha256,
            UnsignedLength = unsignedBytes.LongLength,
            CandidateSha256 = Canonical.Sha256(candidateBytes),
            CandidateLength = candidateBytes.LongLength,
            CanonicalPeSha256 = peResult.CanonicalPeSha256,
            VerifierProfileId = CertifiedKernelProfile.Id,
            VerifierProfileSha256 = CertifiedKernelProfile.Sha256(),
            VerifierBundleSha256 = ProofIdentity.VerifierBundleSha256(),
            AllowedDifferences = peResult.AllowedDifferences,
            Issues = issues.OrderBy(static issue => issue.Code, StringComparer.Ordinal).ThenBy(static issue => issue.Message, StringComparer.Ordinal).ToList(),
        };
        WriteJson(Path.Combine(outputRoot, "artifact.equivalence.json"), receipt);
        if (receipt.Equivalent)
        {
            Console.WriteLine("EQUIVALENT " + receipt.CanonicalPeSha256);
            return 0;
        }
        foreach (var issue in receipt.Issues)
        {
            Console.Error.WriteLine(issue.Code + ": " + issue.Message);
        }
        return 1;
    }

    private static ReceiptArtifactLock ReadReceiptArtifactLock(byte[] bytes, string revitYear, List<ProofIssue> issues)
    {
        try
        {
            using var document = JsonDocument.Parse(bytes, new JsonDocumentOptions
            {
                AllowTrailingCommas = false,
                CommentHandling = JsonCommentHandling.Disallow,
            });
            RejectDuplicateProperties(document.RootElement, "$", new List<string>());
            var root = document.RootElement;
            if (!root.TryGetProperty("certified", out var certified) || certified.ValueKind != JsonValueKind.True ||
                !root.TryGetProperty("status", out var status) || !string.Equals(status.GetString(), "verified", StringComparison.Ordinal) ||
                !root.TryGetProperty("proofKind", out var kind) || !string.Equals(kind.GetString(), Constants.ProofKind, StringComparison.Ordinal))
            {
                issues.Add(new ProofIssue("PROOF_RECEIPT_INVALID", "Proof receipt is not a verified certified-kernel receipt."));
            }
            var expectedProfileSha = CertifiedKernelProfile.Sha256();
            if (!root.TryGetProperty("verifierProfileId", out var profileId) || !string.Equals(profileId.GetString(), CertifiedKernelProfile.Id, StringComparison.Ordinal) ||
                !root.TryGetProperty("verifierProfileSha256", out var profileSha) || !string.Equals(profileSha.GetString(), expectedProfileSha, StringComparison.Ordinal) ||
                !root.TryGetProperty("verifierBundleSha256", out var bundleSha) || !string.Equals(bundleSha.GetString(), ProofIdentity.VerifierBundleSha256(), StringComparison.Ordinal))
            {
                issues.Add(new ProofIssue("VERIFIER_IDENTITY_MISMATCH", "Proof receipt was not produced by this exact verifier bundle/profile."));
            }
            if (!root.TryGetProperty("artifacts", out var artifacts) || artifacts.ValueKind != JsonValueKind.Object ||
                !artifacts.TryGetProperty(revitYear, out var artifact) || artifact.ValueKind != JsonValueKind.Object)
            {
                issues.Add(new ProofIssue("PROOF_ARTIFACT_MISSING", "Proof receipt has no artifact lock for Revit " + revitYear + "."));
                return new ReceiptArtifactLock();
            }
            return new ReceiptArtifactLock
            {
                FileName = artifact.TryGetProperty("fileName", out var fileName) ? fileName.GetString() ?? string.Empty : string.Empty,
                Sha256 = artifact.TryGetProperty("sha256", out var sha256) ? sha256.GetString() ?? string.Empty : string.Empty,
                Length = artifact.TryGetProperty("length", out var length) && length.TryGetInt64(out var parsedLength) ? parsedLength : -1,
            };
        }
        catch (Exception exception) when (exception is JsonException or InvalidDataException or InvalidOperationException)
        {
            issues.Add(new ProofIssue("PROOF_RECEIPT_INVALID", "Proof receipt parsing failed closed: " + exception.GetType().Name + ": " + exception.Message));
            return new ReceiptArtifactLock();
        }
    }

    private static ProofManifest DeserializeStrict(byte[] bytes)
    {
        using var document = JsonDocument.Parse(bytes, new JsonDocumentOptions
        {
            AllowTrailingCommas = false,
            CommentHandling = JsonCommentHandling.Disallow,
        });
        RejectDuplicateProperties(document.RootElement, "$", new List<string>());
        var manifest = JsonSerializer.Deserialize<ProofManifest>(bytes, JsonOptions);
        return manifest ?? throw new InvalidDataException("Manifest deserialized to null.");
    }

    private static void RejectDuplicateProperties(JsonElement element, string path, List<string> scratch)
    {
        if (element.ValueKind == JsonValueKind.Object)
        {
            scratch.Clear();
            foreach (var property in element.EnumerateObject())
            {
                if (scratch.Contains(property.Name, StringComparer.Ordinal))
                {
                    throw new InvalidDataException("Duplicate JSON property at " + path + ": " + property.Name);
                }
                scratch.Add(property.Name);
            }
            foreach (var property in element.EnumerateObject())
            {
                RejectDuplicateProperties(property.Value, path + "." + property.Name, new List<string>());
            }
        }
        else if (element.ValueKind == JsonValueKind.Array)
        {
            var index = 0;
            foreach (var item in element.EnumerateArray())
            {
                RejectDuplicateProperties(item, path + "[" + index + "]", new List<string>());
                index++;
            }
        }
    }

    private static Dictionary<string, string> ParseOptions(string[] args)
    {
        if (args.Length % 2 != 0)
        {
            throw new ArgumentException("Options must be name/value pairs.");
        }
        var result = new Dictionary<string, string>(StringComparer.Ordinal);
        for (var index = 0; index < args.Length; index += 2)
        {
            if (args[index] is not ("--manifest" or "--artifact" or "--unsigned-artifact" or "--candidate-artifact" or "--proof-receipt" or "--revit-year" or "--output-dir"))
            {
                throw new ArgumentException("Unknown option: " + args[index]);
            }
            if (!result.TryAdd(args[index], args[index + 1]))
            {
                throw new ArgumentException("Duplicate option: " + args[index]);
            }
        }
        return result;
    }

    private sealed class ReceiptArtifactLock
    {
        public string FileName { get; set; } = string.Empty;
        public string Sha256 { get; set; } = string.Empty;
        public long Length { get; set; } = -1;
    }

    private static void WriteJson<T>(string path, T value)
    {
        var json = JsonSerializer.Serialize(value, JsonOptions);
        File.WriteAllText(path, json + "\n", new UTF8Encoding(false));
    }
}
