using RevitOperator.DynamicRevitSdk;
using RevitOperator.DynamicRevitWorker;
using Xunit;

namespace RevitOperator.DynamicRevitSandboxSupervisor.Tests;

public sealed class NativeCompileFactAttribute : FactAttribute
{
    public NativeCompileFactAttribute()
    {
        if (!File.Exists(NativeProgramCompilerTests.RevitApi) || !File.Exists(Path.Combine(NativeProgramCompilerTests.Framework, "mscorlib.dll")))
            Skip = "Compile-only Revit2024 metadata check requires the installed API and NET48 reference pack; no native execution.";
    }
}

public sealed class NativeProgramCompilerTests
{
    [NativeCompileFact]
    public void DocumentedPublicClassWithStaticEntryCompilesWithoutInstanceConstruction()
    {
        var result = Compile(Read.Replace("public static class NativeTask", "public class NativeTask"));
        Assert.Empty(result.Diagnostics);
        Assert.NotNull(result.Artifact);
        Assert.False(result.Artifact!.ExecutionAuthorized);
    }

    [NativeCompileFact]
    public void OrdinaryPinnedCollectorTypeLiteralCompilesButIsNotReflectionAuthority()
    {
        foreach (var source in new[] {
            Program("return new FilteredElementCollector(doc).OfClass(typeof(Autodesk.Revit.DB.Mechanical.Duct)).WhereElementIsNotElementType().Count().ToString();"),
            "using D=Autodesk.Revit.DB.FamilyInstance;" + Program("return new FilteredElementCollector(doc).OfClass(typeof(D)).WhereElementIsNotElementType().Count().ToString();") })
        {
            var result = Compile(source);
            Assert.Empty(result.Diagnostics);
            Assert.NotNull(result.Artifact);
            Assert.Contains(result.Artifact!.DirectNativeMembers, m => m.Name == "OfClass" && !m.MutationHint);
            Assert.False(result.Artifact.ExecutionAuthorized);
            Assert.Contains(StaticAdmission.Check(source), d => d.Code == "POLICY_SOURCE_FORBIDDEN");
        }
    }

    [NativeCompileFact]
    public void CollectorExceptionDoesNotAllowOtherTypeObjectsSpoofingReflectionOrReadMutations()
    {
        foreach (var body in new[] {
            "var t=typeof(FamilyInstance);return t.ToString();",
            "return typeof(FamilyInstance).Assembly.FullName;",
            "return new FilteredElementCollector(doc).OfClass(typeof(string)).Count().ToString();",
            "var c=new FilteredElementCollector(doc).OfClass(typeof(FamilyInstance));var t=typeof(string);return c.Count().ToString();",
            "return new FilteredElementCollector(doc).OfClass(typeof(System.IO.File)).Count().ToString();" })
            Assert.Null(Compile(Program(body)).Artifact);
        Assert.Null(Compile("public class Fake{public static object OfClass(object t){return t;}}" + Program("return Fake.OfClass(typeof(FamilyInstance)).ToString();")).Artifact);
        Reject(Program("var c=new FilteredElementCollector(doc).OfClass(typeof(FamilyInstance));doc.ActiveView.Name=\"x\";return c.Count().ToString();"), "NATIVE_READ_HAS_MUTATION", "read");
        Reject(Read.Replace("public static string Execute", "public string Execute"), "NATIVE_ENTRY_INVALID");
    }
    internal const string RevitApi = @"C:\Program Files\Autodesk\Revit 2024\RevitAPI.dll";
    internal const string Framework = @"C:\Program Files (x86)\Reference Assemblies\Microsoft\Framework\.NETFramework\v4.8";
    private static IReadOnlyList<NativeCompilerReference> References() => new[] { "mscorlib", "System", "System.Core", "RevitAPI" }
        .Select(name => { var bytes = File.ReadAllBytes(name == "RevitAPI" ? RevitApi : Path.Combine(Framework, name + ".dll"));
            return new NativeCompilerReference(name, bytes, DynamicWire.Sha256(bytes)); }).ToArray();
    private static string Program(string body) => "using System; using System.Linq; using Autodesk.Revit.DB; " +
        "public static class NativeTask { public static string Execute(Document doc) { " + body + " } }";
    private static readonly string Read = Program("using(var c=new FilteredElementCollector(doc)){return c.OfCategory(BuiltInCategory.OST_Rooms).WhereElementIsNotElementType().Count().ToString();}");
    private static readonly string Write = Program("var p=new CurveArray(); var a=new XYZ(0,0,0);var b=new XYZ(2,0,0);var c=new XYZ(2,3,0);var d=new XYZ(0,3,0);" +
        "p.Append(Line.CreateBound(a,b));p.Append(Line.CreateBound(b,c));p.Append(Line.CreateBound(c,d));p.Append(Line.CreateBound(d,a));" +
        "var plane=Plane.CreateByNormalAndOrigin(XYZ.BasisZ,a);var s=SketchPlane.Create(doc,plane);return doc.Create.NewSpaceBoundaryLines(s,p,doc.ActiveView).Size.ToString();");
    private static NativeProgramCompilation Compile(string source, string mode = "read", IReadOnlyList<NativeCompilerReference>? references = null, int year = 2024)
        => NativeProgramCompiler.Compile(source, "NativeTask", mode, year, references ?? References());
    private static void Reject(string source, string code, string mode = "write")
    {
        var result = Compile(source, mode);
        Assert.Null(result.Artifact);
        Assert.Contains(result.Diagnostics, d => d.Code == code);
    }

    [NativeCompileFact]
    public void ActualNativeReadCompilesToPinnedFrameworkArtifactButDoesNotGrantExecution()
    {
        Assert.Contains(StaticAdmission.Check(Read), d => d.Code == "REVIT_REFERENCE_FORBIDDEN");
        var result = Compile(Read);
        Assert.Empty(result.Diagnostics); Assert.NotNull(result.Artifact);
        var artifact = result.Artifact!;
        Assert.False(artifact.ExecutionAuthorized);
        Assert.Equal("read", artifact.Mode); Assert.Equal(2024, artifact.RevitYear);
        Assert.Equal(DynamicWire.Sha256(Read), artifact.SourceHash);
        Assert.Equal(DynamicWire.Sha256(artifact.Assembly), artifact.AssemblyHash);
        Assert.Equal(4, artifact.References.Count);
        Assert.Contains(artifact.References, r => r.Name == "mscorlib" && r.Version == "4.0.0.0");
        Assert.Contains(artifact.DirectNativeMembers, m => m.Name == "OfCategory" && !m.MutationHint);
        Assert.DoesNotContain(artifact.DirectNativeMembers, m => m.MutationHint);
        var wire = artifact.ToWireArtifact();
        Assert.NotEmpty(DynamicNativeProgramArtifactPolicyV1.ArtifactHash(wire));
        Assert.False(wire.ExecutionAuthorized);
        wire.Assembly[0] ^= 1;
        Assert.Throws<InvalidOperationException>(() => DynamicNativeProgramArtifactPolicyV1.ArtifactHash(wire));
        Assert.Equal(artifact.AssemblyHash, DynamicWire.Sha256(artifact.Assembly));
    }

    [NativeCompileFact]
    public void MissingSpaceBoundaryApiCompilesAsWriteAndReadModeRefusesTheMutation()
    {
        var result = Compile(Write, "write");
        Assert.Empty(result.Diagnostics); Assert.NotNull(result.Artifact);
        Assert.False(result.Artifact!.ExecutionAuthorized);
        Assert.Contains(result.Artifact.DirectNativeMembers, m => m.Name == "NewSpaceBoundaryLines" && m.MutationHint);
        Reject(Write, "NATIVE_READ_HAS_MUTATION", "read");
    }

    [NativeCompileFact]
    public void ArtifactIsDeterministicAcrossLineEndingsAndSourceChangesChangeIdentity()
    {
        var lf = Read.Replace(";", ";\n");
        var first = Compile(lf).Artifact!; var second = Compile(lf.Replace("\n", "\r\n")).Artifact!;
        Assert.Equal(first.SourceHash, second.SourceHash); Assert.Equal(first.AssemblyHash, second.AssemblyHash);
        var changed = Compile(lf.Replace("OST_Rooms", "OST_MEPSpaces")).Artifact!;
        Assert.NotEqual(first.SourceHash, changed.SourceHash); Assert.NotEqual(first.AssemblyHash, changed.AssemblyHash);
    }

    [NativeCompileFact]
    public void WrongYearReferenceHashNameFrameworkAndExtraReferencesReject()
    {
        var refs = References().ToArray();
        Assert.Null(Compile(Read, references: refs, year: 2025).Artifact);
        var wrongHash = refs.ToArray(); wrongHash[0] = wrongHash[0] with { Sha256 = "sha256:" + new string('0',64) };
        Assert.Contains(Compile(Read, references: wrongHash).Diagnostics, d => d.Code == "NATIVE_COMPILE_REFERENCE_HASH");
        var wrongName = refs.ToArray(); wrongName[0] = wrongName[0] with { Name = "NotCore" };
        Assert.Contains(Compile(Read, references: wrongName).Diagnostics, d => d.Code == "NATIVE_COMPILE_REFERENCES_INVALID");
        var coreClr = File.ReadAllBytes(typeof(object).Assembly.Location);
        var wrongTarget = refs.ToArray(); wrongTarget[0] = new("mscorlib",coreClr,DynamicWire.Sha256(coreClr));
        Assert.Contains(Compile(Read, references: wrongTarget).Diagnostics, d => d.Code == "NATIVE_COMPILE_REFERENCE_TARGET");
        Assert.Null(Compile(Read, references: refs.Concat(new[] { refs[0] }).ToArray()).Artifact);
    }

    [NativeCompileFact]
    public void HostOwnedDocumentAndTransactionActionsRejectIncludingAliasesAndMethodGroups()
    {
        foreach(var body in new[] { "doc.SaveAs(\"C:/never.rvt\");return \"\";", "doc.Close(false);return \"\";",
            "Action<string> save=doc.SaveAs;return \"\";", "var app=doc.Application;return \"\";",
            "using(var t=new Transaction(doc,\"x\")){t.Start();t.Commit();}return \"\";" })
            Reject(Program(body), "NATIVE_HOST_OWNED_LIFECYCLE");
        Reject("using Tx=Autodesk.Revit.DB.Transaction;"+Program("using(var t=new Tx(doc,\"x\")){t.Start();}return \"\";"), "NATIVE_HOST_OWNED_LIFECYCLE");
    }

    [NativeCompileFact]
    public void NativePropertyAssignmentAndIncrementAreNotReadOnly()
    {
        Reject(Program("doc.ActiveView.Name=\"x\";return \"\";"), "NATIVE_READ_HAS_MUTATION", "read");
        Reject(Program("doc.ActiveView.Scale++;return \"\";"), "NATIVE_READ_HAS_MUTATION", "read");
    }

    [NativeCompileFact]
    public void ExternalIoReflectionStaticInitializationAndWrongEntryDoNotProduceAnArtifact()
    {
        Assert.Null(Compile("using F=System.IO.File;"+Program("F.WriteAllText(\"C:/never.txt\",\"x\");return \"\";")).Artifact);
        Assert.Null(Compile(Program("return doc.GetType().Assembly.FullName;")).Artifact);
        Reject(Read.Replace("public static string Execute", "static NativeTask(){} public static string Execute"), "NATIVE_SOURCE_LIFECYCLE");
        Reject(Read.Replace("public static string Execute", "public static string Cached {get;}=\"x\"; public static string Execute"), "NATIVE_SOURCE_LIFECYCLE");
        Reject(Read.Replace("public static string Execute", "private static string Execute"), "NATIVE_ENTRY_INVALID");
    }

    [NativeCompileFact]
    public void ExceptionAfterModelWriteCompilesButIsNotRollbackEvidenceAndLegacyAdmissionStillRejects()
    {
        var source = Program("doc.GetElement(new ElementId(1L)).get_Parameter(BuiltInParameter.ALL_MODEL_INSTANCE_COMMENTS).Set(\"x\");throw new InvalidOperationException(\"after-write\");");
        var result=Compile(source,"write");
        Assert.Empty(result.Diagnostics); Assert.NotNull(result.Artifact); Assert.False(result.Artifact!.ExecutionAuthorized);
        Assert.Contains(StaticAdmission.Check(source), d => d.Code == "REVIT_REFERENCE_FORBIDDEN");
        Assert.Contains(StaticAdmission.CheckMetadata(result.Artifact.Assembly), d => d.Code == "METADATA_REFERENCE_FORBIDDEN");
    }
}
