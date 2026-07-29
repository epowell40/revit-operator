using System;
using System.Globalization;
using System.IO;
using System.Reflection;
using System.Text.Json;
using RevitOperator.SafeReadCertifiedExecution;

namespace RevitOperator.SafeReadHost.HostKernel
{
    internal sealed class RuntimeDeploymentAttestation
    {
        private const string ManifestName = "safe_read_runtime_attestation.v1.json";
        private const string PinName = "safe_read_runtime_attestation.v1.sha256";
        private const string RouteContractSha256 = "sha256:cc80c231ba289396516164cb0fdbc3c71779ac018e717085f07a544530e68874";
        private const string PolicySha256 = "sha256:23692b21a7e728e9c1ce5eec9580dcec4f3ac7f25d3d95059899c680a17aad67";
        private static readonly string[] AttestationKeys = { "schema", "state", "issued_at_utc", "expires_at_utc", "route_id", "route_contract_sha256", "policy_sha256", "proof_sha256", "executor_id", "runtime_tuple" };
        private static readonly string[] RuntimeKeys = { "host_content_sha256", "host_mvid", "revit_api_content_sha256", "revit_api_mvid", "revit_version" };

        internal RuntimeDeploymentAttestation(RuntimeTuple tuple,string json,string digest){RuntimeTuple=tuple;CanonicalJson=json;Sha256=digest;}
        public RuntimeTuple RuntimeTuple{get;} public string CanonicalJson{get;} public string Sha256{get;}

        public static RuntimeDeploymentAttestation Load(int revitYear)
        {
            if(revitYear<2023||revitYear>2025)throw new ArgumentOutOfRangeException(nameof(revitYear));
            string? directory=Path.GetDirectoryName(typeof(RevitOperator.SafeReadHost.App).Assembly.Location);
            if(String.IsNullOrEmpty(directory))throw new InvalidOperationException("SafeRead host assembly directory is unavailable.");
            string manifestPath=Path.Combine(directory,ManifestName),pinPath=Path.Combine(directory,PinName);
            byte[] bytes=ReadRegularFile(manifestPath,2,65536),pinBytes=ReadRegularFile(pinPath,71,73);
            string pin=new System.Text.UTF8Encoding(false,true).GetString(pinBytes).TrimEnd('\r','\n');
            if(!Protocol.IsHash(pin)||pinBytes.Length-pin.Length>2)throw new InvalidOperationException("SafeRead runtime attestation pin is invalid.");
            string measured=Protocol.Sha256(bytes);
            if(!Protocol.SecretEquals(pin,measured))throw new InvalidOperationException("SafeRead runtime attestation pin mismatch.");
            string json=new System.Text.UTF8Encoding(false,true).GetString(bytes);
            RuntimeTuple tuple=Parse(json,revitYear,DateTimeOffset.UtcNow);

            Assembly certified=typeof(CertifiedSheetCountKernel).Assembly;
            Assembly revit=typeof(Autodesk.Revit.DB.Document).Assembly;
            if(!String.Equals(tuple.HostContentSha256,HashFile(certified.Location),StringComparison.Ordinal)||
               !String.Equals(tuple.HostMvid,certified.ManifestModule.ModuleVersionId.ToString("D"),StringComparison.Ordinal)||
               !String.Equals(tuple.RevitApiContentSha256,HashFile(revit.Location),StringComparison.Ordinal)||
               !String.Equals(tuple.RevitApiMvid,revit.ManifestModule.ModuleVersionId.ToString("D"),StringComparison.Ordinal))
                throw new InvalidOperationException("SafeRead runtime tuple does not match loaded assemblies.");
            return new RuntimeDeploymentAttestation(tuple,json,measured);
        }

        internal static RuntimeTuple Parse(string json,int revitYear,DateTimeOffset now)
        {
            using(JsonDocument document=JsonDocument.Parse(json,new JsonDocumentOptions{AllowTrailingCommas=false,CommentHandling=JsonCommentHandling.Disallow,MaxDepth=4}))
            {
                JsonElement root=document.RootElement;
                if(!Exact(root,AttestationKeys)||Text(root,"schema")!=SafeReadContract.RuntimeAttestationSchema||Text(root,"state")!="active"||
                   Text(root,"route_id")!=SafeReadContract.RouteId||Text(root,"executor_id")!=SafeReadContract.ExecutorId||
                   Text(root,"route_contract_sha256")!=RouteContractSha256||Text(root,"policy_sha256")!=PolicySha256||!Protocol.IsHash(Text(root,"proof_sha256")))
                    throw new InvalidOperationException("SafeRead runtime attestation contract is invalid.");
                DateTimeOffset issued,expires;
                if(!ParseUtc(Text(root,"issued_at_utc"),out issued)||!ParseUtc(Text(root,"expires_at_utc"),out expires)||issued>now||expires<=now||expires<=issued)
                    throw new InvalidOperationException("SafeRead runtime attestation is not currently active.");
                JsonElement runtime;if(!root.TryGetProperty("runtime_tuple",out runtime)||!Exact(runtime,RuntimeKeys))throw new InvalidOperationException("SafeRead runtime tuple is invalid.");
                string hostHash=Text(runtime,"host_content_sha256"),hostMvid=Text(runtime,"host_mvid"),apiHash=Text(runtime,"revit_api_content_sha256"),apiMvid=Text(runtime,"revit_api_mvid"),version=Text(runtime,"revit_version");
                if(!Protocol.IsHash(hostHash)||!Protocol.IsCanonicalGuid(hostMvid)||!Protocol.IsHash(apiHash)||!Protocol.IsCanonicalGuid(apiMvid)||
                   !(version==revitYear.ToString(CultureInfo.InvariantCulture)||version.StartsWith(revitYear.ToString(CultureInfo.InvariantCulture)+".",StringComparison.Ordinal)))
                    throw new InvalidOperationException("SafeRead runtime tuple fields are invalid.");
                return new RuntimeTuple(hostHash,hostMvid,apiHash,apiMvid,version);
            }
        }

        private static bool Exact(JsonElement element,string[] names){if(element.ValueKind!=JsonValueKind.Object)return false;int index=0;foreach(JsonProperty property in element.EnumerateObject()){if(index>=names.Length||property.Name!=names[index])return false;index++;}return index==names.Length;}
        private static string Text(JsonElement element,string name){JsonElement value;return element.TryGetProperty(name,out value)&&value.ValueKind==JsonValueKind.String?value.GetString()??String.Empty:String.Empty;}
        private static bool ParseUtc(string value,out DateTimeOffset parsed){return DateTimeOffset.TryParseExact(value,"yyyy-MM-dd'T'HH:mm:ss.fff'Z'",CultureInfo.InvariantCulture,DateTimeStyles.AssumeUniversal|DateTimeStyles.AdjustToUniversal,out parsed)&&parsed.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'",CultureInfo.InvariantCulture)==value;}
        private static byte[] ReadRegularFile(string path,int minimum,int maximum){FileInfo file=new FileInfo(path);if(!file.Exists||(file.Attributes&FileAttributes.ReparsePoint)!=0||file.Length<minimum||file.Length>maximum)throw new InvalidOperationException("SafeRead runtime attestation file is unavailable or unsafe.");SecureLocalStorage.VerifyPrivateFile(path);return File.ReadAllBytes(path);}
        private static string HashFile(string path){using(Stream stream=File.OpenRead(path))using(System.Security.Cryptography.SHA256 sha=System.Security.Cryptography.SHA256.Create())return "sha256:"+Protocol.Hex(sha.ComputeHash(stream));}
    }
}
