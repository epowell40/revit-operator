using System;
using RevitOperator.SafeReadCertifiedExecution;

namespace RevitOperator.SafeReadHost.HostKernel
{
    internal static class DiscoveryWire
    {
        public static string Format(string hostId,string token,int pid,int year,string endpoint,string attestationSha256,RuntimeTuple runtime,DocumentBinding? document)
        {
            if(!Protocol.IsCanonicalGuid(hostId)||!Protocol.IsSecret(token)||pid<1||year<2023||year>2025||!Protocol.IsHash(attestationSha256))throw new ArgumentException("Invalid discovery record.");
            Uri? uri;if(!Uri.TryCreate(endpoint,UriKind.Absolute,out uri)||uri==null||uri.Scheme!="http"||uri.Host!="127.0.0.1"||!PortPolicy.IsAllowed(uri.Port)||(uri.AbsolutePath!="/"&&uri.AbsolutePath!=String.Empty)||uri.Query.Length!=0||uri.Fragment.Length!=0)throw new ArgumentException("Invalid endpoint.");
            string tuple="{\"host_content_sha256\":"+Protocol.Quote(runtime.HostContentSha256)+",\"host_mvid\":"+Protocol.Quote(runtime.HostMvid)+",\"revit_api_content_sha256\":"+Protocol.Quote(runtime.RevitApiContentSha256)+",\"revit_api_mvid\":"+Protocol.Quote(runtime.RevitApiMvid)+",\"revit_version\":"+Protocol.Quote(runtime.RevitVersion)+"}";
            string doc=document==null?"null":"{\"project_fingerprint\":"+Protocol.Quote(document.ProjectFingerprint)+",\"document_session_id\":"+Protocol.Quote(document.DocumentSessionId)+"}";
            return "{\"schema\":"+Protocol.Quote(SafeReadContract.DiscoverySchema)+",\"product_id\":"+Protocol.Quote(SafeReadContract.ProductId)+",\"host_instance_id\":"+Protocol.Quote(hostId)+",\"executor_id\":"+Protocol.Quote(SafeReadContract.ExecutorId)+",\"pid\":"+pid.ToString(System.Globalization.CultureInfo.InvariantCulture)+",\"revit_year\":"+year.ToString(System.Globalization.CultureInfo.InvariantCulture)+",\"route_id\":"+Protocol.Quote(SafeReadContract.RouteId)+",\"route\":"+Protocol.Quote(SafeReadContract.Route)+",\"endpoint\":"+Protocol.Quote(endpoint.TrimEnd('/'))+",\"startup_token\":"+Protocol.Quote(token)+",\"runtime_attestation_sha256\":"+Protocol.Quote(attestationSha256)+",\"runtime_tuple\":"+tuple+",\"document\":"+doc+"}";
        }
    }
}
