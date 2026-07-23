using System.Security.Cryptography;

namespace RevitOperator.Deployment;

public static class FileIntegrity
{
    public static string Sha256(string path)
    {
        using var stream = File.OpenRead(path);
        return Convert.ToHexString(SHA256.HashData(stream));
    }

    public static string ResolveUnder(string root, string relative, int exitCode = ExitCodes.ManifestInvalid)
    {
        var fullRoot = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        var full = Path.GetFullPath(Path.Combine(fullRoot, relative.Replace('/', Path.DirectorySeparatorChar)));
        if (!full.StartsWith(fullRoot + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
            throw new DeploymentException(exitCode, $"Path escapes the allowed root: {relative}");
        return full;
    }

    public static void VerifyComponent(string bundleRoot, ReleaseComponent component)
    {
        var payloadRoot = ResolveUnder(bundleRoot, component.PayloadPath);
        foreach (var file in component.Files)
        {
            var path = ResolveUnder(payloadRoot, file.Path);
            if (!File.Exists(path)) throw new DeploymentException(ExitCodes.HashMismatch, $"Required payload is missing: {component.Id}/{file.Path}");
            var info = new FileInfo(path);
            if (info.Length != file.Size) throw new DeploymentException(ExitCodes.HashMismatch, $"Payload size mismatch: {component.Id}/{file.Path}");
            var actual = Sha256(path);
            if (!actual.Equals(file.Sha256, StringComparison.OrdinalIgnoreCase))
                throw new DeploymentException(ExitCodes.HashMismatch, $"Payload SHA-256 mismatch: {component.Id}/{file.Path}");
        }
    }
}
