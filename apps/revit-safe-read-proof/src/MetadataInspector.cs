using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Reflection.Emit;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using System.Reflection.PortableExecutable;

namespace RevitSafeReadProof;

internal sealed class MetadataInspection
{
    public InventoryExpectation Metadata { get; set; } = new();
    public InventoryExpectation Il { get; set; } = new();
}

internal sealed class MetadataInspector
{
    private static readonly IReadOnlyDictionary<ushort, OpCode> OpCodesByValue = BuildOpCodeMap();

    private readonly List<ProofIssue> _issues;

    public MetadataInspector(List<ProofIssue> issues)
    {
        _issues = issues;
    }

    public MetadataInspection Inspect(byte[] peBytes)
    {
        var metadata = new List<string>();
        var il = new List<string>();
        if (peBytes.Length == 0)
        {
            Add("EMIT_METADATA_MISSING", "Direct emit produced no PE bytes.");
            return new MetadataInspection
            {
                Metadata = Canonical.Inventory(metadata),
                Il = Canonical.Inventory(il),
            };
        }
        using var stream = new MemoryStream(peBytes, writable: false);
        using var pe = new PEReader(stream, PEStreamOptions.LeaveOpen);
        if (!pe.HasMetadata)
        {
            Add("EMIT_METADATA_MISSING", "Emitted PE has no metadata.");
            return new MetadataInspection
            {
                Metadata = Canonical.Inventory(metadata),
                Il = Canonical.Inventory(il),
            };
        }
        var reader = pe.GetMetadataReader();
        var headers = pe.PEHeaders;
        metadata.Add("PE|machine=" + headers.CoffHeader.Machine + "|timestamp=" + headers.CoffHeader.TimeDateStamp + "|characteristics=" + headers.CoffHeader.Characteristics + "|corflags=" + headers.CorHeader!.Flags + "|entry=" + headers.CorHeader.EntryPointTokenOrRelativeVirtualAddress);
        metadata.Add("ASSEMBLY|" + Canonical.AssemblyIdentity(reader));
        var module = reader.GetModuleDefinition();
        metadata.Add("MODULE|name=" + reader.GetString(module.Name) + "|mvid=" + reader.GetGuid(module.Mvid).ToString("D", CultureInfo.InvariantCulture) + "|generation=" + module.Generation);

        foreach (var table in Enum.GetValues<TableIndex>().OrderBy(static value => (int)value))
        {
            int count;
            try
            {
                count = reader.GetTableRowCount(table);
            }
            catch (ArgumentOutOfRangeException)
            {
                continue;
            }
            metadata.Add("TABLE|" + table + "|rows=" + count);
        }

        foreach (var handle in reader.AssemblyReferences)
        {
            var reference = reader.GetAssemblyReference(handle);
            metadata.Add("ASSEMBLY_REF|token=" + Token(handle) + "|" + AssemblyReferenceIdentity(reader, reference));
        }
        foreach (var handle in Handles(reader.GetTableRowCount(TableIndex.ModuleRef), MetadataTokens.ModuleReferenceHandle))
        {
            var reference = reader.GetModuleReference(handle);
            var name = reader.GetString(reference.Name);
            metadata.Add("MODULE_REF|token=" + Token(handle) + "|name=" + name);
            Add("MODULE_REFERENCE_FORBIDDEN", "Emitted assembly references native/secondary module " + name + ".");
        }
        foreach (var handle in reader.ExportedTypes)
        {
            var exported = reader.GetExportedType(handle);
            var name = reader.GetString(exported.Namespace) + "." + reader.GetString(exported.Name);
            metadata.Add("EXPORTED_TYPE|token=" + Token(handle) + "|name=" + name + "|attributes=" + exported.Attributes + "|implementation=" + Handle(exported.Implementation));
            Add("EXPORTED_TYPE_FORBIDDEN", "Emitted assembly contains exported/forwarded type " + name + ".");
        }
        foreach (var handle in reader.ManifestResources)
        {
            var resource = reader.GetManifestResource(handle);
            metadata.Add("RESOURCE|token=" + Token(handle) + "|name=" + reader.GetString(resource.Name) + "|attributes=" + resource.Attributes + "|offset=" + resource.Offset + "|implementation=" + Handle(resource.Implementation));
        }
        foreach (var handle in reader.TypeReferences)
        {
            var type = reader.GetTypeReference(handle);
            metadata.Add("TYPE_REF|token=" + Token(handle) + "|name=" + reader.GetString(type.Namespace) + "." + reader.GetString(type.Name) + "|scope=" + Handle(type.ResolutionScope));
        }
        foreach (var handle in Handles(reader.GetTableRowCount(TableIndex.TypeSpec), MetadataTokens.TypeSpecificationHandle))
        {
            var type = reader.GetTypeSpecification(handle);
            metadata.Add("TYPE_SPEC|token=" + Token(handle) + "|signature=" + Blob(reader, type.Signature));
        }

        foreach (var typeHandle in reader.TypeDefinitions)
        {
            var type = reader.GetTypeDefinition(typeHandle);
            var typeName = reader.GetString(type.Namespace) + "." + reader.GetString(type.Name);
            metadata.Add("TYPE_DEF|token=" + Token(typeHandle) + "|name=" + typeName + "|attributes=" + type.Attributes + "|base=" + Handle(type.BaseType));
            foreach (var interfaceHandle in type.GetInterfaceImplementations())
            {
                var implementation = reader.GetInterfaceImplementation(interfaceHandle);
                metadata.Add("INTERFACE_IMPL|owner=" + Token(typeHandle) + "|token=" + Token(interfaceHandle) + "|interface=" + Handle(implementation.Interface));
            }
            foreach (var fieldHandle in type.GetFields())
            {
                var field = reader.GetFieldDefinition(fieldHandle);
                metadata.Add("FIELD_DEF|owner=" + Token(typeHandle) + "|token=" + Token(fieldHandle) + "|name=" + reader.GetString(field.Name) + "|attributes=" + field.Attributes + "|signature=" + Blob(reader, field.Signature));
            }
            foreach (var propertyHandle in type.GetProperties())
            {
                var property = reader.GetPropertyDefinition(propertyHandle);
                var accessors = property.GetAccessors();
                metadata.Add("PROPERTY_DEF|owner=" + Token(typeHandle) + "|token=" + Token(propertyHandle) + "|name=" + reader.GetString(property.Name) + "|attributes=" + property.Attributes + "|signature=" + Blob(reader, property.Signature) + "|getter=" + TokenOrNil(accessors.Getter) + "|setter=" + TokenOrNil(accessors.Setter) + "|others=" + string.Join(",", accessors.Others.Select(static handle => Token(handle))));
            }
            foreach (var eventHandle in type.GetEvents())
            {
                var @event = reader.GetEventDefinition(eventHandle);
                metadata.Add("EVENT_DEF|owner=" + Token(typeHandle) + "|token=" + Token(eventHandle) + "|name=" + reader.GetString(@event.Name) + "|attributes=" + @event.Attributes + "|type=" + Handle(@event.Type));
                Add("EVENT_METADATA_FORBIDDEN", "Emitted source contains event metadata " + typeName + "." + reader.GetString(@event.Name) + ".");
            }
            foreach (var methodHandle in type.GetMethods())
            {
                InspectMethod(pe, reader, typeHandle, typeName, methodHandle, metadata, il);
            }
        }

        foreach (var handle in reader.MemberReferences)
        {
            var member = reader.GetMemberReference(handle);
            metadata.Add("MEMBER_REF|token=" + Token(handle) + "|parent=" + Handle(member.Parent) + "|name=" + reader.GetString(member.Name) + "|signature=" + Blob(reader, member.Signature));
        }
        foreach (var handle in Handles(reader.GetTableRowCount(TableIndex.MethodSpec), MetadataTokens.MethodSpecificationHandle))
        {
            var method = reader.GetMethodSpecification(handle);
            metadata.Add("METHOD_SPEC|token=" + Token(handle) + "|method=" + Handle(method.Method) + "|signature=" + Blob(reader, method.Signature));
        }
        foreach (var handle in Handles(reader.GetTableRowCount(TableIndex.StandAloneSig), MetadataTokens.StandaloneSignatureHandle))
        {
            var signature = reader.GetStandaloneSignature(handle);
            metadata.Add("STANDALONE_SIG|token=" + Token(handle) + "|signature=" + Blob(reader, signature.Signature));
        }
        foreach (var handle in reader.CustomAttributes)
        {
            var attribute = reader.GetCustomAttribute(handle);
            metadata.Add("CUSTOM_ATTRIBUTE|token=" + Token(handle) + "|parent=" + Handle(attribute.Parent) + "|ctor=" + Handle(attribute.Constructor) + "|value=" + Blob(reader, attribute.Value));
        }

        return new MetadataInspection
        {
            Metadata = Canonical.Inventory(metadata),
            Il = Canonical.Inventory(il),
        };
    }

    private void InspectMethod(
        PEReader pe,
        MetadataReader reader,
        TypeDefinitionHandle owner,
        string typeName,
        MethodDefinitionHandle handle,
        List<string> metadata,
        List<string> il)
    {
        var method = reader.GetMethodDefinition(handle);
        var name = reader.GetString(method.Name);
        metadata.Add("METHOD_DEF|owner=" + Token(owner) + "|token=" + Token(handle) + "|name=" + name + "|attributes=" + method.Attributes + "|impl=" + method.ImplAttributes + "|rva=" + method.RelativeVirtualAddress + "|signature=" + Blob(reader, method.Signature));
        if ((method.Attributes & MethodAttributes.PinvokeImpl) != 0)
        {
            Add("PINVOKE_METADATA_FORBIDDEN", "Emitted method is P/Invoke: " + typeName + "." + name + ".");
        }
        if (name == ".cctor")
        {
            Add("MODULE_OR_TYPE_INITIALIZER", "Emitted static/type initializer is forbidden: " + typeName + ".cctor.");
        }
        if (name == "Finalize")
        {
            Add("FINALIZER_METADATA_FORBIDDEN", "Emitted finalizer is forbidden: " + typeName + ".Finalize.");
        }
        foreach (var parameterHandle in method.GetParameters())
        {
            var parameter = reader.GetParameter(parameterHandle);
            metadata.Add("PARAM_DEF|owner=" + Token(handle) + "|token=" + Token(parameterHandle) + "|sequence=" + parameter.SequenceNumber + "|name=" + reader.GetString(parameter.Name) + "|attributes=" + parameter.Attributes);
        }

        if (method.RelativeVirtualAddress == 0)
        {
            Add("METHOD_BODY_METADATA_MISSING", "Method has no IL body: " + typeName + "." + name + ".");
            il.Add("METHOD_IL|token=" + Token(handle) + "|name=" + typeName + "." + name + "|missing");
            return;
        }

        var body = pe.GetMethodBody(method.RelativeVirtualAddress);
        var bytes = body.GetILBytes() ?? Array.Empty<byte>();
        il.Add("METHOD_IL|token=" + Token(handle) + "|name=" + typeName + "." + name + "|maxStack=" + body.MaxStack + "|initLocals=" + body.LocalVariablesInitialized + "|localSig=" + TokenOrNil(body.LocalSignature) + "|size=" + bytes.Length + "|sha256=" + Canonical.Sha256(bytes));
        foreach (var region in body.ExceptionRegions)
        {
            il.Add("EH|method=" + Token(handle) + "|kind=" + region.Kind + "|try=" + region.TryOffset + ":" + region.TryLength + "|handler=" + region.HandlerOffset + ":" + region.HandlerLength + "|filter=" + region.FilterOffset + "|catch=" + Handle(region.CatchType));
        }
        DecodeIl(reader, handle, bytes, il);
    }

    private void DecodeIl(MetadataReader reader, MethodDefinitionHandle method, byte[] bytes, List<string> il)
    {
        var offset = 0;
        while (offset < bytes.Length)
        {
            var instructionOffset = offset;
            ushort value = bytes[offset++];
            if (value == 0xFE)
            {
                if (offset >= bytes.Length)
                {
                    Add("IL_DECODE", "Truncated two-byte opcode in method " + Token(method) + ".");
                    break;
                }
                value = (ushort)(0xFE00 | bytes[offset++]);
            }
            if (!OpCodesByValue.TryGetValue(value, out var opcode))
            {
                Add("IL_OPCODE_UNKNOWN", "Unknown IL opcode 0x" + value.ToString("X4", CultureInfo.InvariantCulture) + " in method " + Token(method) + ".");
                break;
            }
            string operand;
            try
            {
                operand = ReadOperand(reader, opcode.OperandType, bytes, ref offset);
            }
            catch (InvalidDataException exception)
            {
                Add("IL_DECODE", Token(method) + " at IL_" + instructionOffset.ToString("X4", CultureInfo.InvariantCulture) + ": " + exception.Message);
                break;
            }
            il.Add("IL|method=" + Token(method) + "|offset=" + instructionOffset.ToString("X4", CultureInfo.InvariantCulture) + "|opcode=" + opcode.Name + "|operand=" + operand);
        }
        if (offset != bytes.Length)
        {
            Add("IL_DECODE_LENGTH", "IL decoder did not consume the exact body for method " + Token(method) + ".");
        }
    }

    private static string ReadOperand(MetadataReader reader, OperandType type, byte[] bytes, ref int offset)
    {
        switch (type)
        {
            case OperandType.InlineNone:
                return "none";
            case OperandType.ShortInlineI:
                Ensure(bytes, offset, 1);
                return ((sbyte)bytes[offset++]).ToString(CultureInfo.InvariantCulture);
            case OperandType.ShortInlineVar:
                Ensure(bytes, offset, 1);
                return bytes[offset++].ToString(CultureInfo.InvariantCulture);
            case OperandType.InlineVar:
                Ensure(bytes, offset, 2);
                var variable = BitConverter.ToUInt16(bytes, offset);
                offset += 2;
                return variable.ToString(CultureInfo.InvariantCulture);
            case OperandType.InlineI:
                Ensure(bytes, offset, 4);
                var integer = BitConverter.ToInt32(bytes, offset);
                offset += 4;
                return integer.ToString(CultureInfo.InvariantCulture);
            case OperandType.InlineI8:
                Ensure(bytes, offset, 8);
                var longInteger = BitConverter.ToInt64(bytes, offset);
                offset += 8;
                return longInteger.ToString(CultureInfo.InvariantCulture);
            case OperandType.ShortInlineR:
                Ensure(bytes, offset, 4);
                var single = BitConverter.ToSingle(bytes, offset);
                offset += 4;
                return single.ToString("R", CultureInfo.InvariantCulture);
            case OperandType.InlineR:
                Ensure(bytes, offset, 8);
                var @double = BitConverter.ToDouble(bytes, offset);
                offset += 8;
                return @double.ToString("R", CultureInfo.InvariantCulture);
            case OperandType.ShortInlineBrTarget:
                Ensure(bytes, offset, 1);
                var shortDelta = (sbyte)bytes[offset++];
                return "IL_" + (offset + shortDelta).ToString("X4", CultureInfo.InvariantCulture);
            case OperandType.InlineBrTarget:
                Ensure(bytes, offset, 4);
                var delta = BitConverter.ToInt32(bytes, offset);
                offset += 4;
                return "IL_" + (offset + delta).ToString("X4", CultureInfo.InvariantCulture);
            case OperandType.InlineSwitch:
                Ensure(bytes, offset, 4);
                var count = BitConverter.ToInt32(bytes, offset);
                offset += 4;
                if (count < 0 || count > 1_000_000)
                {
                    throw new InvalidDataException("Invalid switch target count " + count + ".");
                }
                if (count < 0 || count > (bytes.Length - offset) / 4)
                {
                    throw new InvalidDataException("Invalid InlineSwitch operand length.");
                }
                Ensure(bytes, offset, count * 4);
                var baseOffset = offset + count * 4;
                var targets = new string[count];
                for (var index = 0; index < count; index++)
                {
                    var switchDelta = BitConverter.ToInt32(bytes, offset);
                    offset += 4;
                    targets[index] = "IL_" + (baseOffset + switchDelta).ToString("X4", CultureInfo.InvariantCulture);
                }
                return string.Join(",", targets);
            case OperandType.InlineField:
            case OperandType.InlineMethod:
            case OperandType.InlineSig:
            case OperandType.InlineString:
            case OperandType.InlineTok:
            case OperandType.InlineType:
                Ensure(bytes, offset, 4);
                var token = BitConverter.ToInt32(bytes, offset);
                offset += 4;
                return ResolveToken(reader, token);
            default:
                throw new InvalidDataException("Unsupported operand type " + type + ".");
        }
    }

    private static string ResolveToken(MetadataReader reader, int token)
    {
        var handle = MetadataTokens.Handle(token);
        if (handle.Kind == HandleKind.UserString)
        {
            var text = reader.GetUserString((UserStringHandle)handle);
            return "0x" + token.ToString("X8", CultureInfo.InvariantCulture) + ":UserString:" + Convert.ToBase64String(System.Text.Encoding.UTF8.GetBytes(text));
        }
        return "0x" + token.ToString("X8", CultureInfo.InvariantCulture) + ":" + handle.Kind;
    }

    private static void Ensure(byte[] bytes, int offset, int count)
    {
        if (offset < 0 || count < 0 || offset > bytes.Length || count > bytes.Length - offset)
        {
            throw new InvalidDataException("Truncated IL operand.");
        }
    }

    private static string AssemblyReferenceIdentity(MetadataReader reader, AssemblyReference reference)
    {
        var tokenBytes = reference.PublicKeyOrToken.IsNil ? Array.Empty<byte>() : reader.GetBlobBytes(reference.PublicKeyOrToken);
        var token = tokenBytes.Length == 0 ? "null" : Convert.ToHexString(tokenBytes).ToLowerInvariant();
        var culture = reference.Culture.IsNil ? "neutral" : reader.GetString(reference.Culture);
        return reader.GetString(reference.Name) + ", Version=" + reference.Version + ", Culture=" + culture + ", PublicKeyToken=" + token;
    }

    private static string Blob(MetadataReader reader, BlobHandle handle)
    {
        return handle.IsNil ? "nil" : Convert.ToHexString(reader.GetBlobBytes(handle)).ToLowerInvariant();
    }

    private static string Handle(EntityHandle handle)
    {
        return handle.IsNil ? "nil" : Token(handle) + ":" + handle.Kind;
    }

    private static string Token(EntityHandle handle)
    {
        return "0x" + MetadataTokens.GetToken(handle).ToString("X8", CultureInfo.InvariantCulture);
    }

    private static string TokenOrNil(EntityHandle handle)
    {
        return handle.IsNil ? "nil" : Token(handle);
    }

    private static IReadOnlyDictionary<ushort, OpCode> BuildOpCodeMap()
    {
        var result = new Dictionary<ushort, OpCode>();
        foreach (var field in typeof(OpCodes).GetFields(BindingFlags.Public | BindingFlags.Static))
        {
            if (field.GetValue(null) is OpCode opcode)
            {
                result[unchecked((ushort)opcode.Value)] = opcode;
            }
        }
        return result;
    }

    private static IEnumerable<THandle> Handles<THandle>(int count, Func<int, THandle> factory)
    {
        for (var row = 1; row <= count; row++)
        {
            yield return factory(row);
        }
    }

    private void Add(string code, string message)
    {
        _issues.Add(new ProofIssue(code, message));
    }
}
