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
        if (args.Length == 0 || args[0] is not ("check" or "inventory" or "fingerprint"))
        {
            Console.Error.WriteLine("Usage: RevitSafeReadProof <check|inventory> --manifest <absolute path> --output-dir <absolute path> | fingerprint --artifact <absolute path> --output-dir <absolute path>");
            return 64;
        }

        var mode = args[0];
        var options = ParseOptions(args.Skip(1).ToArray());
        if (mode == "fingerprint")
        {
            return RunFingerprint(options);
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
            if (args[index] is not ("--manifest" or "--artifact" or "--output-dir"))
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

    private static void WriteJson<T>(string path, T value)
    {
        var json = JsonSerializer.Serialize(value, JsonOptions);
        File.WriteAllText(path, json + "\n", new UTF8Encoding(false));
    }
}
