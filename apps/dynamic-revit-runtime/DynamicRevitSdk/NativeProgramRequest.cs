using System;
using System.Collections.Generic;
using System.Linq;

namespace RevitOperator.DynamicRevitSdk;

// One general native program, not an API-specific operation vocabulary. This
// describes requested scope only; it never grants native execution authority.
public sealed class DynamicNativeProgramRequestV1
{
    public string EntryType { get; set; } = "";
    public string Mode { get; set; } = "";
    // Explicit opt-in; old callers retain their listed-element restrictions.
    public string EffectScope { get; set; } = "listed_elements";
    public string[] AllowedExistingUniqueIds { get; set; } = Array.Empty<string>();
    public bool AllowCreate { get; set; }
    public int MaxAffectedElements { get; set; }
    public int DeadlineMs { get; set; } = 5000;
    public void Validate()
    {
        if(string.IsNullOrWhiteSpace(EntryType) || EntryType.Length>256 || EntryType.Any(char.IsControl) ||
            (Mode!="read" && Mode!="write") || (EffectScope!="listed_elements" && EffectScope!="active_document") || DeadlineMs<250 || DeadlineMs>10000 ||
            AllowedExistingUniqueIds==null || AllowedExistingUniqueIds.Length>64 ||
            AllowedExistingUniqueIds.Any(id=>string.IsNullOrWhiteSpace(id)||id.Length>512||id.Any(char.IsControl)) ||
            AllowedExistingUniqueIds.Distinct(StringComparer.Ordinal).Count()!=AllowedExistingUniqueIds.Length ||
            Mode=="read" && (EffectScope!="listed_elements" || AllowCreate || MaxAffectedElements!=0 || AllowedExistingUniqueIds.Length!=0) ||
            Mode=="write" && EffectScope=="listed_elements" && (MaxAffectedElements<1 || MaxAffectedElements>64 || !AllowCreate && AllowedExistingUniqueIds.Length==0) ||
            EffectScope=="active_document" && (Mode!="write" || AllowCreate || MaxAffectedElements!=0 || AllowedExistingUniqueIds.Length!=0))
            throw new InvalidOperationException("Native program request has an invalid entry, mode or bounded effect scope.");
    }
}

// Issued by the authenticated native host. Reference paths stay in trusted
// local launcher plumbing; generated source receives only metadata identities.
public sealed class DynamicNativeProgramPreparationV1
{
    public string Schema { get; set; } = "dynamic-revit-native-preparation/v1";
    public string PreparationId { get; set; } = "";
    public string SourceHash { get; set; } = "";
    public DynamicNativeProgramScopeV1 Scope { get; set; } = new DynamicNativeProgramScopeV1();
    public DynamicDocumentDto Document { get; set; } = new DynamicDocumentDto();
    public IReadOnlyList<DynamicNativeReferenceV1> References { get; set; } = Array.Empty<DynamicNativeReferenceV1>();
    public Dictionary<string,string> ReferencePaths { get; set; } = new Dictionary<string,string>(StringComparer.Ordinal);
    public string WorkerRuntimePackageHash { get; set; } = "";
}
