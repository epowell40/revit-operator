using System;
using System.Collections.Generic;
using System.Linq;

namespace RevitSafeReadProof;

/// <summary>
/// The security policy for the certified kernel is verifier-owned.  A candidate
/// manifest locks bytes and compiler inputs, but it never grants new Revit API
/// authority or changes the certified ABI.
/// </summary>
internal static class CertifiedKernelProfile
{
    public const string Id = "revit-safe-read-sheet-count-kernel/v1";
    public const string CertifiedAssemblyIdentity = "RevitOperator.SafeReadCertifiedExecution, Version=0.0.0.0, Culture=neutral, PublicKeyToken=null";
    public const string EntryPointType = "global::RevitOperator.SafeReadCertifiedExecution.CertifiedSheetCountKernel";
    public const string EntryPointMethod = "Method:global::RevitOperator.SafeReadCertifiedExecution.CertifiedSheetCountResult global::RevitOperator.SafeReadCertifiedExecution.CertifiedSheetCountKernel.Execute(global::Autodesk.Revit.DB.Document document)|assembly=" + CertifiedAssemblyIdentity;
    public const string ResultType = "RevitOperator.SafeReadCertifiedExecution.CertifiedSheetCountResult";

    public static readonly string[] AllowedOperationKinds =
    {
        "Argument", "Binary", "Branch", "Conversion", "DefaultValue", "ExpressionStatement",
        "FieldReference", "FlowCapture", "FlowCaptureReference", "InstanceReference", "Increment",
        "Invocation", "IsNull", "IsPattern", "IsType", "ConstantPattern", "Literal", "LocalReference",
        "ObjectCreation", "ParameterReference", "PropertyReference", "Return", "SimpleAssignment", "TypeOf",
        "Unary", "VariableDeclaration", "VariableDeclarationGroup", "VariableDeclarator",
    };

    public static readonly string[] AllowedImplicitOperationKinds =
    {
        "Argument", "Conversion", "DefaultValue", "ExpressionStatement", "FieldReference", "FlowCapture",
        "FlowCaptureReference", "InstanceReference", "Invocation", "IsNull", "IsType", "Literal",
        "LocalReference", "ParameterReference", "PropertyReference", "SimpleAssignment",
    };

    public static readonly string[] PublicAbi =
    {
        "PUBLIC_MEMBER|Method:bool global::RevitOperator.SafeReadCertifiedExecution.CertifiedSheetCountResult.Succeeded.get|assembly=" + CertifiedAssemblyIdentity,
        "PUBLIC_MEMBER|Method:global::RevitOperator.SafeReadCertifiedExecution.CertifiedSheetCountResult global::RevitOperator.SafeReadCertifiedExecution.CertifiedSheetCountKernel.Execute(global::Autodesk.Revit.DB.Document document)|assembly=" + CertifiedAssemblyIdentity,
        "PUBLIC_MEMBER|Method:int global::RevitOperator.SafeReadCertifiedExecution.CertifiedSheetCountResult.Count.get|assembly=" + CertifiedAssemblyIdentity,
        "PUBLIC_MEMBER|Method:int global::RevitOperator.SafeReadCertifiedExecution.CertifiedSheetCountResult.FailureCode.get|assembly=" + CertifiedAssemblyIdentity,
        "PUBLIC_MEMBER|Property:bool global::RevitOperator.SafeReadCertifiedExecution.CertifiedSheetCountResult.Succeeded { get; }|assembly=" + CertifiedAssemblyIdentity,
        "PUBLIC_MEMBER|Property:int global::RevitOperator.SafeReadCertifiedExecution.CertifiedSheetCountResult.Count { get; }|assembly=" + CertifiedAssemblyIdentity,
        "PUBLIC_MEMBER|Property:int global::RevitOperator.SafeReadCertifiedExecution.CertifiedSheetCountResult.FailureCode { get; }|assembly=" + CertifiedAssemblyIdentity,
        "PUBLIC_TYPE|NamedType:class global::RevitOperator.SafeReadCertifiedExecution.CertifiedSheetCountKernel|assembly=" + CertifiedAssemblyIdentity,
        "PUBLIC_TYPE|NamedType:class global::RevitOperator.SafeReadCertifiedExecution.CertifiedSheetCountResult|assembly=" + CertifiedAssemblyIdentity,
    };

    public static readonly string[] SerializationRoots = { ResultType };
    public static readonly string[] SerializationLeafTypes = { "bool", "int" };
    public static readonly string[] AllowedAttributeSymbols =
    {
        "NamedType:class global::System.Reflection.AssemblyMetadataAttribute|assembly=mscorlib, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089",
        "NamedType:class global::System.Runtime.Versioning.TargetFrameworkAttribute|assembly=mscorlib, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089",
        "NamedType:class global::System.Reflection.AssemblyMetadataAttribute|assembly=System.Runtime, Version=8.0.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a",
        "NamedType:class global::System.Runtime.Versioning.TargetFrameworkAttribute|assembly=System.Runtime, Version=8.0.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a",
    };

    private static readonly string[] RevitReadSymbolTemplates =
    {
        "Property:bool global::Autodesk.Revit.DB.APIObject.IsValidObject { get; }|assembly={ASSEMBLY}",
        "Method:bool global::Autodesk.Revit.DB.APIObject.IsValidObject.get|assembly={ASSEMBLY}",
        "Property:bool global::Autodesk.Revit.DB.Document.IsValidObject { get; }|assembly={ASSEMBLY}",
        "Method:bool global::Autodesk.Revit.DB.Document.IsValidObject.get|assembly={ASSEMBLY}",
        "Property:bool global::Autodesk.Revit.DB.Document.IsModifiable { get; }|assembly={ASSEMBLY}",
        "Method:bool global::Autodesk.Revit.DB.Document.IsModifiable.get|assembly={ASSEMBLY}",
        "Property:bool global::Autodesk.Revit.DB.Document.IsModified { get; }|assembly={ASSEMBLY}",
        "Method:bool global::Autodesk.Revit.DB.Document.IsModified.get|assembly={ASSEMBLY}",
        "Method:global::Autodesk.Revit.DB.FilteredElementCollector global::Autodesk.Revit.DB.FilteredElementCollector.OfClass(global::System.Type type)|assembly={ASSEMBLY}",
        "Method:global::Autodesk.Revit.DB.FilteredElementIterator global::Autodesk.Revit.DB.FilteredElementCollector.GetElementIterator()|assembly={ASSEMBLY}",
        "Method:global::Autodesk.Revit.DB.FilteredElementCollector.FilteredElementCollector(global::Autodesk.Revit.DB.Document document)|assembly={ASSEMBLY}",
        "Method:bool global::Autodesk.Revit.DB.FilteredElementIterator.MoveNext()|assembly={ASSEMBLY}",
        "Property:global::Autodesk.Revit.DB.Element global::Autodesk.Revit.DB.FilteredElementIterator.Current { get; }|assembly={ASSEMBLY}",
        "Method:global::Autodesk.Revit.DB.Element global::Autodesk.Revit.DB.FilteredElementIterator.Current.get|assembly={ASSEMBLY}",
        "Property:bool global::Autodesk.Revit.DB.ViewSheet.IsPlaceholder { get; }|assembly={ASSEMBLY}",
        "Method:bool global::Autodesk.Revit.DB.ViewSheet.IsPlaceholder.get|assembly={ASSEMBLY}",
        "Method:void global::Autodesk.Revit.DB.APIObject.Dispose()|assembly={ASSEMBLY}",
        "NamedType:class global::Autodesk.Revit.DB.ViewSheet|assembly={ASSEMBLY}",
    };

    public static HashSet<string> AllowedSensitiveSymbols(VariantLock variant)
    {
        var revitApi = variant.RevitReferences.FirstOrDefault(static reference =>
            reference.Identity.StartsWith("RevitAPI, Version=", StringComparison.Ordinal));
        var result = new HashSet<string>(StringComparer.Ordinal);
        if (revitApi is not null)
        {
            foreach (var template in RevitReadSymbolTemplates)
            {
                result.Add(template.Replace("{ASSEMBLY}", revitApi.Identity, StringComparison.Ordinal));
            }
        }
        var runtimeIdentity = variant.RevitYear is "2023" or "2024"
            ? "mscorlib, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089"
            : "System.Runtime, Version=8.0.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a";
        result.Add("Method:void global::System.IDisposable.Dispose()|assembly=" + runtimeIdentity);
        return result;
    }

    public static string Sha256()
    {
        var lines = new List<string>
        {
            Id,
            EntryPointType,
            EntryPointMethod,
            ResultType,
        };
        lines.AddRange(AllowedOperationKinds.Select(static value => "operation:" + value));
        lines.AddRange(AllowedImplicitOperationKinds.Select(static value => "implicit:" + value));
        lines.AddRange(PublicAbi.Select(static value => "abi:" + value));
        lines.AddRange(SerializationRoots.Select(static value => "serialization-root:" + value));
        lines.AddRange(SerializationLeafTypes.Select(static value => "serialization-leaf:" + value));
        lines.AddRange(AllowedAttributeSymbols.Select(static value => "attribute:" + value));
        lines.Add("mutable-fields:<empty>");
        lines.Add("route-literals:<empty>");
        lines.Add("listener-prefixes:<empty>");
        lines.Add("serialization-callsites:<empty>");
        lines.Add("roles:<empty>");
        lines.AddRange(RevitReadSymbolTemplates.Select(static value => "revit-symbol-template:" + value));
        return Canonical.Sha256Text(string.Join("\n", lines));
    }
}
