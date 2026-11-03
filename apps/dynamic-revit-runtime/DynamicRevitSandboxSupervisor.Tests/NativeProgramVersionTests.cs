using RevitOperator.DynamicRevitSdk;
using RevitOperator.DynamicRevitWorker;
using Xunit;

namespace RevitOperator.DynamicRevitSandboxSupervisor.Tests;

public sealed class InstalledNativeVersionsTheoryAttribute : TheoryAttribute
{
    public InstalledNativeVersionsTheoryAttribute()
    {
        if (!OperatingSystem.IsWindows() || Enumerable.Range(2023, 5).Any(year =>
            !File.Exists(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Autodesk", "Revit " + year, "RevitAPI.dll"))))
            Skip = "Explicit multi-version compiler qualification requires installed Revit 2023–2027 APIs; this is not native execution proof.";
    }
}

public sealed class NativeProgramVersionTests
{
    [InstalledNativeVersionsTheory]
    [InlineData(2023)][InlineData(2024)][InlineData(2025)][InlineData(2026)][InlineData(2027)]
    public void ActualInstalledApiAndClrMetadataCompileReadAndWriteAndRejectWrongYear(int year)
    {
        var api=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),"Autodesk","Revit "+year,"RevitAPI.dll");
        Assert.True(File.Exists(api),"Installed API required for this explicit multi-version qualification: "+api);
        var major=DynamicNativeTargetProfile.FrameworkMajor(year);
        var framework=major==4 ? NativeProgramCompilerTests.Framework
            : Directory.GetDirectories(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),"dotnet","shared","Microsoft.NETCore.App"))
                .Where(p=>Path.GetFileName(p).StartsWith(major+".",StringComparison.Ordinal)).OrderByDescending(p=>Version.Parse(Path.GetFileName(p))).First();
        var references=DynamicNativeTargetProfile.ReferenceNames(year).Select(name=>{
            var bytes=File.ReadAllBytes(name=="RevitAPI"?api:Path.Combine(framework,name+".dll"));
            return new NativeCompilerReference(name,bytes,DynamicWire.Sha256(bytes));
        }).ToArray();
        foreach(var mode in new[]{"read","write"}) {
            var statement=mode=="read" ? "return doc.Title;" : "doc.ProjectInformation.Status=\"qualification\";return doc.ProjectInformation.Status;";
            var source="public static class NativeTask { public static string Execute(Autodesk.Revit.DB.Document doc) { "+statement+" } }";
            var result=NativeProgramCompiler.Compile(source,"NativeTask",mode,year,references);
            Assert.True(result.Artifact!=null,string.Join("; ",result.Diagnostics.Select(d=>d.Code+": "+d.Message)));
            Assert.Empty(result.Diagnostics);Assert.Equal(year,result.Artifact!.RevitYear);
            Assert.False(result.Artifact.ExecutionAuthorized);
            var actualVersion=System.Reflection.AssemblyName.GetAssemblyName(api).Version!;
            var wire=result.Artifact.ToWireArtifact();
            DynamicNativeProgramArtifactPolicyV1.ValidateHostApiVersion(wire,actualVersion);
            Assert.Throws<InvalidOperationException>(()=>DynamicNativeProgramArtifactPolicyV1.ValidateHostApiVersion(wire,new Version(actualVersion.Major+1,0,0,0)));
            Assert.Throws<InvalidOperationException>(()=>DynamicNativeProgramArtifactPolicyV1.ValidateHostApiVersion(wire,new Version(actualVersion.Major,actualVersion.Minor+1,0,0)));
            Assert.Throws<InvalidOperationException>(()=>DynamicNativeProgramArtifactPolicyV1.ValidateHostApiVersion(wire,null));
        }
        Assert.Null(NativeProgramCompiler.Compile("public class Query {}","Query","read",year==2027?2026:year+1,references).Artifact);
    }
}
