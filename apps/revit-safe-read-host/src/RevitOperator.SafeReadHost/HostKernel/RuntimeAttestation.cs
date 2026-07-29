using System;
using System.IO;
using System.Reflection;
using RevitOperator.SafeReadCertifiedExecution;

namespace RevitOperator.SafeReadHost.HostKernel
{
    internal sealed class RuntimeDeploymentAttestation
    {
        private RuntimeDeploymentAttestation(RuntimeTuple tuple,string canonical,string digest){RuntimeTuple=tuple;CanonicalJson=canonical;Sha256=digest;}
        public RuntimeTuple RuntimeTuple{get;} public string CanonicalJson{get;} public string Sha256{get;}
        public static RuntimeDeploymentAttestation Create(int revitYear)
        {
            Assembly certified=typeof(FinalReceiptVerifier).Assembly;
            Assembly revit=typeof(Autodesk.Revit.DB.Document).Assembly;
            if(revitYear<2023||revitYear>2025)throw new ArgumentOutOfRangeException(nameof(revitYear));
            RuntimeTuple tuple=new RuntimeTuple(HashFile(certified.Location),certified.ManifestModule.ModuleVersionId.ToString("D"),HashFile(revit.Location),revit.ManifestModule.ModuleVersionId.ToString("D"),revitYear.ToString(System.Globalization.CultureInfo.InvariantCulture));
            string json="{\"executor_id\":"+Protocol.Quote(SafeReadContract.ExecutorId)+",\"runtime_tuple\":{\"host_content_sha256\":"+Protocol.Quote(tuple.HostContentSha256)+",\"host_mvid\":"+Protocol.Quote(tuple.HostMvid)+",\"revit_api_content_sha256\":"+Protocol.Quote(tuple.RevitApiContentSha256)+",\"revit_api_mvid\":"+Protocol.Quote(tuple.RevitApiMvid)+",\"revit_version\":"+Protocol.Quote(tuple.RevitVersion)+"},\"schema\":"+Protocol.Quote(SafeReadContract.RuntimeAttestationSchema)+"}";
            return new RuntimeDeploymentAttestation(tuple,json,Protocol.Sha256(json));
        }
        private static string HashFile(string path){using(Stream stream=File.OpenRead(path))using(System.Security.Cryptography.SHA256 sha=System.Security.Cryptography.SHA256.Create())return "sha256:"+Protocol.Hex(sha.ComputeHash(stream));}
    }
}
