using System;
using System.IO;

namespace RevitOperator.DynamicRevitSdk;

/// <summary>
/// Cross-process, restart-durable one-use authority for an already validated core-operation
/// apply authorization. The caller supplies the signed authorization expiry that was checked
/// immediately before consumption; the ledger persists first use before returning true.
/// </summary>
public sealed class DurableCoreOperationApplyAuthorizationLedgerV1 : IDynamicCoreOperationApplyAuthorizationLedgerV1
{
    private const string Namespace = "dynamic-core-operation-apply-authorization/v1";
    private readonly string _directory;
    private readonly long _expiresUnixSeconds;

    public DurableCoreOperationApplyAuthorizationLedgerV1(string directory, long expiresUnixSeconds)
    {
        if (string.IsNullOrWhiteSpace(directory) || expiresUnixSeconds <= 0)
            throw new ArgumentException("Core-operation apply ledger input is invalid.");
        var root = Path.GetFullPath(directory);
        if (Directory.GetParent(root) == null)
            throw new ArgumentException("Core-operation apply ledger cannot use a filesystem root.", nameof(directory));
        _directory = root;
        _expiresUnixSeconds = expiresUnixSeconds;
    }

    public bool TryConsume(string authorizationHash)
    {
        if (!DynamicCanonical.Hash(authorizationHash))
            throw new ArgumentException("Core-operation apply authorization hash is invalid.", nameof(authorizationHash));
        var replayKey = DynamicWire.Sha256(Namespace + "\n" + authorizationHash);
        return DurableAdmissionReplayLedgerV1.TryConsume(_directory, replayKey, _expiresUnixSeconds);
    }
}
