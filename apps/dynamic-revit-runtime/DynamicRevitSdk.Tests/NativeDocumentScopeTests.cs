using RevitOperator.DynamicRevitSdk;
using Xunit;

namespace RevitOperator.DynamicRevitSdk.Tests;

public sealed class NativeDocumentScopeTests
{
    [Fact] public void DocumentScopeIsExplicitWriteOnlyAndCannotMixLegacyRestrictions()
    {
        var request=new DynamicNativeProgramRequestV1{EntryType="Build",Mode="write",EffectScope="active_document"};
        request.Validate();request.Mode="read";Assert.Throws<InvalidOperationException>(request.Validate);
        request.Mode="write";request.AllowCreate=true;Assert.Throws<InvalidOperationException>(request.Validate);
        request.AllowCreate=false;request.MaxAffectedElements=32;Assert.Throws<InvalidOperationException>(request.Validate);
        request.MaxAffectedElements=0;request.AllowedExistingUniqueIds=new[]{"target"};Assert.Throws<InvalidOperationException>(request.Validate);
        request.AllowedExistingUniqueIds=Array.Empty<string>();request.EffectScope="other";Assert.Throws<InvalidOperationException>(request.Validate);
        request.EffectScope="listed_elements";Assert.Throws<InvalidOperationException>(request.Validate);
        request.AllowCreate=true;request.MaxAffectedElements=10;request.Validate();
    }
    [Fact] public void DocumentScopeChangesTheAuthenticatedBindingAndRetainsDocumentCurrentness()
    {
        string H(string s)=>DynamicWire.Sha256(s);
        var bytes=new byte[]{1,2,3};
        var a=new DynamicNativeProgramArtifactV1{Mode="write",RevitYear=2024,EntryType="Build",SourceHash=H("source"),Assembly=bytes,AssemblyHash=DynamicWire.Sha256(bytes),
            References=new[]{"RevitAPI","System","System.Core","mscorlib"}.Select(n=>new DynamicNativeReferenceV1{Name=n,Version="1.0",Sha256=H(n)}).ToArray()};
        var s=new DynamicNativeProgramScopeV1{DocumentFingerprint=H("doc"),DocumentSessionId="session",DocumentRevision=1,NativeScopeHash=H("scope"),DeadlineMs=5000,AllowCreate=true,MaxAffectedElements=32};
        var legacy=DynamicNativeProgramArtifactPolicyV1.BindingHash(a,s);
        s.EffectScope="active_document";s.AllowCreate=false;s.MaxAffectedElements=0;
        var active=DynamicNativeProgramArtifactPolicyV1.BindingHash(a,s);Assert.NotEqual(legacy,active);
        Assert.Equal(active,DynamicNativeProgramArtifactPolicyV1.ValidateCurrentBinding(a,s,a.References,H("source"),H("doc"),"session",1,H("scope")));
        Assert.Throws<InvalidOperationException>(()=>DynamicNativeProgramArtifactPolicyV1.ValidateCurrentBinding(a,s,a.References,H("source"),H("other"),"session",1,H("scope")));
        Assert.Throws<InvalidOperationException>(()=>DynamicNativeProgramArtifactPolicyV1.ValidateCurrentBinding(a,s,a.References,H("source"),H("doc"),"session",2,H("scope")));
        a.Mode="read";Assert.Throws<InvalidOperationException>(()=>DynamicNativeProgramArtifactPolicyV1.BindingHash(a,s));
    }
}
