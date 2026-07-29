using System;
using System.Buffers.Binary;
using System.Collections.Generic;

namespace RevitSafeReadProof;

internal sealed class PeEquivalenceResult
{
    public string CanonicalPeSha256 { get; set; } = string.Empty;
    public List<string> AllowedDifferences { get; set; } = new();
}

internal static class PeAuthenticodeEquivalence
{
    public static PeEquivalenceResult Verify(byte[] unsignedBytes, byte[] candidateBytes, List<ProofIssue> issues)
    {
        var result = new PeEquivalenceResult();
        if (!TryReadLayout(unsignedBytes, "unsigned", issues, out var unsignedLayout) ||
            !TryReadLayout(candidateBytes, "candidate", issues, out var candidateLayout))
        {
            return result;
        }

        if (unsignedLayout.ChecksumOffset != candidateLayout.ChecksumOffset ||
            unsignedLayout.SecurityDirectoryOffset != candidateLayout.SecurityDirectoryOffset)
        {
            issues.Add(new ProofIssue("PE_LAYOUT_CHANGED", "Candidate PE header layout differs from the receipted unsigned artifact."));
            return result;
        }
        if (unsignedLayout.CertificateOffset != 0 || unsignedLayout.CertificateSize != 0)
        {
            issues.Add(new ProofIssue("UNSIGNED_HAS_CERTIFICATE", "Receipted unsigned artifact already contains an Authenticode certificate table."));
        }
        if (candidateLayout.CertificateOffset == 0 || candidateLayout.CertificateSize == 0)
        {
            issues.Add(new ProofIssue("AUTHENTICODE_MISSING", "Candidate artifact has no PE certificate table."));
            return result;
        }
        var certificateEnd = (long)candidateLayout.CertificateOffset + candidateLayout.CertificateSize;
        if (certificateEnd != candidateBytes.LongLength)
        {
            issues.Add(new ProofIssue("PE_OVERLAY_FORBIDDEN", "Certificate table must end exactly at EOF; arbitrary overlay bytes are forbidden."));
        }
        if (candidateLayout.CertificateOffset < unsignedBytes.Length)
        {
            issues.Add(new ProofIssue("CERTIFICATE_OVERLAP", "Certificate table overlaps the receipted unsigned PE bytes."));
            return result;
        }
        var alignmentGap = checked((int)(candidateLayout.CertificateOffset - unsignedBytes.Length));
        if (alignmentGap > 7 || candidateLayout.CertificateOffset % 8 != 0)
        {
            issues.Add(new ProofIssue("CERTIFICATE_ALIGNMENT", "Only the required zero padding to the next 8-byte certificate-table boundary is permitted."));
        }
        for (var index = unsignedBytes.Length; index < Math.Min(candidateBytes.Length, candidateLayout.CertificateOffset); index++)
        {
            if (candidateBytes[index] != 0)
            {
                issues.Add(new ProofIssue("CERTIFICATE_ALIGNMENT", "Certificate alignment padding contains non-zero data."));
                break;
            }
        }

        if (candidateBytes.Length < unsignedBytes.Length)
        {
            issues.Add(new ProofIssue("PE_TRUNCATED", "Candidate artifact is shorter than the receipted unsigned artifact."));
            return result;
        }
        for (var index = 0; index < unsignedBytes.Length; index++)
        {
            if (InRange(index, unsignedLayout.ChecksumOffset, 4) ||
                InRange(index, unsignedLayout.SecurityDirectoryOffset, 8))
            {
                continue;
            }
            if (unsignedBytes[index] != candidateBytes[index])
            {
                issues.Add(new ProofIssue("PE_CONTENT_CHANGED", "Candidate changes a non-Authenticode PE byte at offset 0x" + index.ToString("x") + "."));
                break;
            }
        }

        ValidateCertificateTable(candidateBytes, candidateLayout.CertificateOffset, candidateLayout.CertificateSize, issues);

        var canonical = (byte[])unsignedBytes.Clone();
        Array.Clear(canonical, unsignedLayout.ChecksumOffset, 4);
        Array.Clear(canonical, unsignedLayout.SecurityDirectoryOffset, 8);
        result.CanonicalPeSha256 = Canonical.Sha256(canonical);
        result.AllowedDifferences.Add("pe-checksum:" + unsignedLayout.ChecksumOffset + ":4");
        result.AllowedDifferences.Add("security-directory-entry:" + unsignedLayout.SecurityDirectoryOffset + ":8");
        result.AllowedDifferences.Add("certificate-alignment-padding:" + unsignedBytes.Length + ":" + Math.Max(0, alignmentGap));
        result.AllowedDifferences.Add("certificate-table:" + candidateLayout.CertificateOffset + ":" + candidateLayout.CertificateSize);
        return result;
    }

    private static void ValidateCertificateTable(byte[] bytes, int offset, int size, List<ProofIssue> issues)
    {
        if (size < 8 || size % 8 != 0 || offset < 0 || size < 0 || offset > bytes.Length || size > bytes.Length - offset)
        {
            issues.Add(new ProofIssue("AUTHENTICODE_TABLE_INVALID", "PE certificate table range or alignment is invalid."));
            return;
        }
        var cursor = offset;
        var end = offset + size;
        while (cursor < end)
        {
            if (end - cursor < 8)
            {
                issues.Add(new ProofIssue("AUTHENTICODE_TABLE_INVALID", "Truncated WIN_CERTIFICATE header."));
                return;
            }
            var length = BinaryPrimitives.ReadUInt32LittleEndian(bytes.AsSpan(cursor, 4));
            var revision = BinaryPrimitives.ReadUInt16LittleEndian(bytes.AsSpan(cursor + 4, 2));
            var certificateType = BinaryPrimitives.ReadUInt16LittleEndian(bytes.AsSpan(cursor + 6, 2));
            if (length < 8 || length > int.MaxValue || length > end - cursor)
            {
                issues.Add(new ProofIssue("AUTHENTICODE_TABLE_INVALID", "WIN_CERTIFICATE length is invalid."));
                return;
            }
            if (revision is not (0x0100 or 0x0200) || certificateType != 0x0002)
            {
                issues.Add(new ProofIssue("AUTHENTICODE_TABLE_INVALID", "WIN_CERTIFICATE revision/type is not Authenticode PKCS#7."));
            }
            var paddedLengthLong = ((long)length + 7L) & ~7L;
            if (paddedLengthLong > int.MaxValue || paddedLengthLong > end - cursor)
            {
                issues.Add(new ProofIssue("AUTHENTICODE_TABLE_INVALID", "WIN_CERTIFICATE padded length exceeds the certificate table."));
                return;
            }
            var paddedLength = (int)paddedLengthLong;
            for (var index = cursor + (int)length; index < cursor + paddedLength; index++)
            {
                if (bytes[index] != 0)
                {
                    issues.Add(new ProofIssue("AUTHENTICODE_TABLE_INVALID", "WIN_CERTIFICATE alignment padding contains non-zero data."));
                    break;
                }
            }
            cursor += paddedLength;
        }
        if (cursor != end)
        {
            issues.Add(new ProofIssue("AUTHENTICODE_TABLE_INVALID", "Certificate table was not consumed exactly."));
        }
    }

    private static bool TryReadLayout(byte[] bytes, string label, List<ProofIssue> issues, out PeLayout layout)
    {
        layout = default;
        try
        {
            if (bytes.Length < 0x40 || bytes[0] != (byte)'M' || bytes[1] != (byte)'Z')
            {
                throw new InvalidOperationException("missing DOS header");
            }
            var peOffset = ReadInt32(bytes, 0x3c);
            Ensure(bytes, peOffset, 24);
            if (bytes[peOffset] != (byte)'P' || bytes[peOffset + 1] != (byte)'E' || bytes[peOffset + 2] != 0 || bytes[peOffset + 3] != 0)
            {
                throw new InvalidOperationException("missing PE signature");
            }
            var optionalSize = ReadUInt16(bytes, peOffset + 20);
            var optionalOffset = checked(peOffset + 24);
            Ensure(bytes, optionalOffset, optionalSize);
            var magic = ReadUInt16(bytes, optionalOffset);
            var directoryCountOffset = magic switch
            {
                0x10b => optionalOffset + 92,
                0x20b => optionalOffset + 108,
                _ => throw new InvalidOperationException("unsupported optional-header magic"),
            };
            var directoryOffset = magic == 0x10b ? optionalOffset + 96 : optionalOffset + 112;
            Ensure(bytes, directoryCountOffset, 4);
            if (ReadUInt32(bytes, directoryCountOffset) <= 4)
            {
                throw new InvalidOperationException("security data directory is absent");
            }
            var securityOffset = checked(directoryOffset + (4 * 8));
            var checksumOffset = checked(optionalOffset + 64);
            Ensure(bytes, checksumOffset, 4);
            Ensure(bytes, securityOffset, 8);
            var certificateOffset = ReadUInt32(bytes, securityOffset);
            var certificateSize = ReadUInt32(bytes, securityOffset + 4);
            if (certificateOffset > int.MaxValue || certificateSize > int.MaxValue)
            {
                throw new InvalidOperationException("certificate table exceeds supported file size");
            }
            layout = new PeLayout(checksumOffset, securityOffset, (int)certificateOffset, (int)certificateSize);
            return true;
        }
        catch (Exception exception) when (exception is InvalidOperationException or OverflowException or ArgumentOutOfRangeException)
        {
            issues.Add(new ProofIssue("PE_LAYOUT_INVALID", label + " artifact PE layout is invalid: " + exception.Message + "."));
            return false;
        }
    }

    private static bool InRange(int value, int start, int count) => value >= start && value < start + count;

    private static ushort ReadUInt16(byte[] bytes, int offset)
    {
        Ensure(bytes, offset, 2);
        return BinaryPrimitives.ReadUInt16LittleEndian(bytes.AsSpan(offset, 2));
    }

    private static uint ReadUInt32(byte[] bytes, int offset)
    {
        Ensure(bytes, offset, 4);
        return BinaryPrimitives.ReadUInt32LittleEndian(bytes.AsSpan(offset, 4));
    }

    private static int ReadInt32(byte[] bytes, int offset)
    {
        Ensure(bytes, offset, 4);
        return BinaryPrimitives.ReadInt32LittleEndian(bytes.AsSpan(offset, 4));
    }

    private static void Ensure(byte[] bytes, int offset, int count)
    {
        if (offset < 0 || count < 0 || offset > bytes.Length || count > bytes.Length - offset)
        {
            throw new InvalidOperationException("truncated header");
        }
    }

    private readonly record struct PeLayout(int ChecksumOffset, int SecurityDirectoryOffset, int CertificateOffset, int CertificateSize);
}
