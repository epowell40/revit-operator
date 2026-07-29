using System;
using System.Buffers.Binary;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using System.Security.Cryptography;
using System.Text;
using Microsoft.CodeAnalysis;

namespace RevitSafeReadProof;

internal static class Canonical
{
    internal static readonly SymbolDisplayFormat SymbolFormat = new(
        globalNamespaceStyle: SymbolDisplayGlobalNamespaceStyle.Included,
        typeQualificationStyle: SymbolDisplayTypeQualificationStyle.NameAndContainingTypesAndNamespaces,
        genericsOptions: SymbolDisplayGenericsOptions.IncludeTypeParameters | SymbolDisplayGenericsOptions.IncludeVariance,
        memberOptions: SymbolDisplayMemberOptions.IncludeContainingType |
                       SymbolDisplayMemberOptions.IncludeExplicitInterface |
                       SymbolDisplayMemberOptions.IncludeParameters |
                       SymbolDisplayMemberOptions.IncludeRef |
                       SymbolDisplayMemberOptions.IncludeType,
        delegateStyle: SymbolDisplayDelegateStyle.NameAndSignature,
        extensionMethodStyle: SymbolDisplayExtensionMethodStyle.StaticMethod,
        parameterOptions: SymbolDisplayParameterOptions.IncludeExtensionThis |
                          SymbolDisplayParameterOptions.IncludeParamsRefOut |
                          SymbolDisplayParameterOptions.IncludeType |
                          SymbolDisplayParameterOptions.IncludeName |
                          SymbolDisplayParameterOptions.IncludeDefaultValue |
                          SymbolDisplayParameterOptions.IncludeOptionalBrackets,
        propertyStyle: SymbolDisplayPropertyStyle.ShowReadWriteDescriptor,
        localOptions: SymbolDisplayLocalOptions.IncludeType | SymbolDisplayLocalOptions.IncludeConstantValue,
        kindOptions: SymbolDisplayKindOptions.IncludeMemberKeyword | SymbolDisplayKindOptions.IncludeNamespaceKeyword | SymbolDisplayKindOptions.IncludeTypeKeyword,
        miscellaneousOptions: SymbolDisplayMiscellaneousOptions.EscapeKeywordIdentifiers |
                              SymbolDisplayMiscellaneousOptions.IncludeNullableReferenceTypeModifier |
                              SymbolDisplayMiscellaneousOptions.UseSpecialTypes);

    public static string Sha256(byte[] bytes)
    {
        return Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
    }

    public static string Sha256File(string path)
    {
        using var stream = File.OpenRead(path);
        return Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant();
    }

    public static string Sha256Text(string text)
    {
        return Sha256(Encoding.UTF8.GetBytes(text));
    }

    public static InventoryExpectation Inventory(IEnumerable<string> items, bool preserveOrder = true)
    {
        var list = preserveOrder
            ? items.ToList()
            : items.OrderBy(static item => item, StringComparer.Ordinal).ToList();
        var canonical = string.Join("\n", list);
        return new InventoryExpectation
        {
            Count = list.Count,
            Sha256 = Sha256Text(canonical),
            Items = list,
        };
    }

    public static string AssemblyIdentity(IAssemblySymbol? assembly)
    {
        if (assembly is null)
        {
            return "<none>";
        }
        return AssemblyIdentity(assembly.Identity);
    }

    public static string AssemblyIdentity(AssemblyIdentity identity)
    {
        var token = identity.PublicKeyToken.IsDefaultOrEmpty
            ? "null"
            : Convert.ToHexString(identity.PublicKeyToken.ToArray()).ToLowerInvariant();
        var culture = string.IsNullOrEmpty(identity.CultureName) ? "neutral" : identity.CultureName;
        return string.Format(
            CultureInfo.InvariantCulture,
            "{0}, Version={1}, Culture={2}, PublicKeyToken={3}",
            identity.Name,
            identity.Version,
            culture,
            token);
    }

    public static string AssemblyIdentity(MetadataReader reader)
    {
        var definition = reader.GetAssemblyDefinition();
        var name = reader.GetString(definition.Name);
        var culture = definition.Culture.IsNil ? "neutral" : reader.GetString(definition.Culture);
        var key = definition.PublicKey.IsNil ? Array.Empty<byte>() : reader.GetBlobBytes(definition.PublicKey);
        string token;
        if (key.Length == 0)
        {
            token = "null";
        }
        else
        {
            var hash = SHA1.HashData(key);
            Array.Reverse(hash);
            token = Convert.ToHexString(hash.AsSpan(0, 8)).ToLowerInvariant();
        }
        return string.Format(
            CultureInfo.InvariantCulture,
            "{0}, Version={1}, Culture={2}, PublicKeyToken={3}",
            name,
            definition.Version,
            culture,
            token);
    }

    public static string ReadAssemblyIdentity(string path)
    {
        using var stream = File.OpenRead(path);
        using var pe = new PEReader(stream);
        if (!pe.HasMetadata)
        {
            throw new InvalidDataException($"Reference has no metadata: {path}");
        }
        return AssemblyIdentity(pe.GetMetadataReader());
    }

    public static string SymbolId(ISymbol? symbol)
    {
        if (symbol is null)
        {
            return "<null-symbol>";
        }
        var assembly = symbol.Kind == SymbolKind.Assembly
            ? (IAssemblySymbol)symbol
            : symbol.ContainingAssembly;
        return symbol.Kind + ":" + symbol.ToDisplayString(SymbolFormat) + "|assembly=" + AssemblyIdentity(assembly);
    }

    public static string TypeId(ITypeSymbol? type)
    {
        if (type is null)
        {
            return "<null-type>";
        }
        return type.ToDisplayString(SymbolFormat) + "|assembly=" + AssemblyIdentity(type.ContainingAssembly);
    }

    public static string QualifiedName(ISymbol symbol)
    {
        return symbol.ToDisplayString(SymbolDisplayFormat.FullyQualifiedFormat);
    }

    public static string NormalizeRelativePath(string value)
    {
        return value.Replace('\\', '/');
    }

    public static string ConstantValue(Optional<object?> constant)
    {
        if (!constant.HasValue)
        {
            return "<none>";
        }
        if (constant.Value is null)
        {
            return "null";
        }
        if (constant.Value is string text)
        {
            return "string:" + Convert.ToBase64String(Encoding.UTF8.GetBytes(text));
        }
        if (constant.Value is char character)
        {
            return "char:" + ((int)character).ToString(CultureInfo.InvariantCulture);
        }
        if (constant.Value is bool boolean)
        {
            return boolean ? "bool:true" : "bool:false";
        }
        if (constant.Value is IFormattable formattable)
        {
            return constant.Value.GetType().FullName + ":" + formattable.ToString(null, CultureInfo.InvariantCulture);
        }
        return constant.Value.GetType().FullName + ":" + constant.Value;
    }

    public static int ReadInt32(byte[] bytes, int offset)
    {
        return BinaryPrimitives.ReadInt32LittleEndian(bytes.AsSpan(offset, 4));
    }
}
