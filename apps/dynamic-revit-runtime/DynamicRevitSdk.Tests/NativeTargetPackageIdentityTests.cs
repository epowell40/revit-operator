using System.Reflection;
using RevitOperator.DynamicRevitSdk;
using Xunit;

namespace DynamicRevitSdk.Tests;

public sealed class NativeTargetPackageIdentityTests : IDisposable
{
    private readonly string root = Path.Combine(Path.GetTempPath(), "native-target-identity", Guid.NewGuid().ToString("N"));
    private readonly Dictionary<string,string> references = new(StringComparer.Ordinal);
    private string Package => Path.Combine(root,"base");
    public NativeTargetPackageIdentityTests()
    {
        Directory.CreateDirectory(Package);
        File.WriteAllText(Path.Combine(Package,"worker.exe"),"original worker");
        File.WriteAllText(Path.Combine(Package,"policy.json"),"original policy");
        Directory.CreateDirectory(Path.Combine(root,"refs"));
        foreach(var name in new[]{"mscorlib","System","System.Core","RevitAPI"})
        {
            var path=Path.Combine(root,"refs",name+".dll");File.WriteAllText(path,"reference "+name);references.Add(name,path);
        }
    }
    private string Expected(string pin, IReadOnlyDictionary<string,string>? files=null)
    {
        // Reflection retains an executable feature-before fixture against the old SDK.
        var method=typeof(DynamicRuntimePackageDirectoryIdentity).GetMethod("ComputeWithNativeTarget2024");
        Assert.NotNull(method);
        try {return (string)method!.Invoke(null,new object[]{Package,pin,files??references})!;}
        catch(TargetInvocationException ex) when(ex.InnerException!=null)
        {System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(ex.InnerException).Throw();throw;}
    }
    [Fact]
    public void ExpectedPackageEqualsActualStageAndKeepsBaseIdentityUnchanged()
    {
        var pin=DynamicRuntimePackageDirectoryIdentity.Compute(Package);var expected=Expected(pin);
        var staged=Path.Combine(root,"staged");Directory.CreateDirectory(staged);
        foreach(var file in Directory.GetFiles(Package))File.Copy(file,Path.Combine(staged,Path.GetFileName(file)));
        var target=Path.Combine(staged,"native-target","2024");Directory.CreateDirectory(target);
        foreach(var pair in references)File.Copy(pair.Value,Path.Combine(target,pair.Key+".dll"));
        Assert.NotEqual(pin,expected);
        Assert.Equal(expected,DynamicRuntimePackageDirectoryIdentity.Compute(staged));
        Assert.Equal(pin,DynamicRuntimePackageDirectoryIdentity.Compute(Package));
        File.AppendAllText(Path.Combine(staged,"native-target","2024","RevitAPI.dll"),"changed");
        Assert.NotEqual(expected,DynamicRuntimePackageDirectoryIdentity.Compute(staged));
    }
    [Fact]
    public void ChangedBaseOrForgedPinCannotBecomeTrustedByAddingReferences()
    {
        var pin=DynamicRuntimePackageDirectoryIdentity.Compute(Package);
        Assert.Throws<InvalidDataException>(()=>Expected("sha256:"+new string('0',64)));
        File.AppendAllText(Path.Combine(Package,"policy.json"),"changed");
        Assert.Throws<InvalidDataException>(()=>Expected(pin));
    }
    [Fact]
    public void EveryReferenceByteParticipatesAndInputOrderDoesNotMatter()
    {
        var pin=DynamicRuntimePackageDirectoryIdentity.Compute(Package);var original=Expected(pin);
        Assert.Equal(original,Expected(pin,references.Reverse().ToDictionary(p=>p.Key,p=>p.Value)));
        foreach(var path in references.Values)
        {
            var text=File.ReadAllText(path);File.AppendAllText(path,"changed");
            Assert.NotEqual(original,Expected(pin));File.WriteAllText(path,text);
        }
    }
    [Fact]
    public void MissingExtraTraversalAndAlreadyStagedReferenceSetsReject()
    {
        var pin=DynamicRuntimePackageDirectoryIdentity.Compute(Package);
        var missing=new Dictionary<string,string>(references);missing.Remove("System");
        var extra=new Dictionary<string,string>(references){["Injected"]=references["System"]};
        var traversal=new Dictionary<string,string>(references);traversal.Remove("System");traversal.Add("../System",references["System"]);
        foreach(var set in new[]{missing,extra,traversal})Assert.Throws<InvalidDataException>(()=>Expected(pin,set));
        Directory.CreateDirectory(Path.Combine(Package,"native-target"));
        Assert.Throws<InvalidDataException>(()=>Expected(pin));
    }
    [Fact]
    public void OverlayStillCountsAgainstPackageFileLimit()
    {
        for(var i=2;i<254;i++)File.WriteAllText(Path.Combine(Package,$"file-{i}.json"),"x");
        var pin=DynamicRuntimePackageDirectoryIdentity.Compute(Package);
        Assert.Throws<InvalidDataException>(()=>Expected(pin));
    }
    [Fact]
    public void EmptyOrOversizedReferenceRejects()
    {
        var pin=DynamicRuntimePackageDirectoryIdentity.Compute(Package);var path=references["System"];
        File.WriteAllBytes(path,Array.Empty<byte>());
        Assert.Throws<InvalidDataException>(()=>Expected(pin));
        using(var stream=File.OpenWrite(path))stream.SetLength(64L*1024*1024+1);
        Assert.Throws<InvalidDataException>(()=>Expected(pin));
    }
    public void Dispose(){if(Directory.Exists(root))Directory.Delete(root,true);}
}
