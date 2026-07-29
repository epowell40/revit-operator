using System;
using System.Collections.Specialized;
using System.Net;
using System.Net.Sockets;
using System.Threading;
using System.Threading.Tasks;
using RevitOperator.SafeReadCertifiedExecution;

namespace RevitOperator.SafeReadHost.HostKernel
{
    internal sealed class RequestFacts
    {
        public string Method=String.Empty, RawTarget=String.Empty, ContentType=String.Empty, Token=String.Empty, HostInstance=String.Empty, DocumentSession=String.Empty, ClientSession=String.Empty, RequestId=String.Empty, AttemptId=String.Empty;
        public bool Loopback, HasTransferEncoding, HasContentEncoding, DuplicateHeader, UnknownHeader; public long ContentLength; public byte[]? Body;
    }
    internal static class RequestFactsReader
    {
        public static async Task<RequestFacts> ReadAsync(HttpListenerRequest request,CancellationToken cancellation)
        {
            RequestFacts f=new RequestFacts{Method=request.HttpMethod??String.Empty,RawTarget=request.RawUrl??String.Empty,ContentType=request.ContentType??String.Empty,ContentLength=request.ContentLength64,HasTransferEncoding=!String.IsNullOrEmpty(request.Headers["Transfer-Encoding"]),HasContentEncoding=!String.IsNullOrEmpty(request.Headers["Content-Encoding"])};
            IPEndPoint? remote=request.RemoteEndPoint;f.Loopback=remote!=null&&remote.Address.AddressFamily==AddressFamily.InterNetwork&&IPAddress.IsLoopback(remote.Address);
            f.Token=One(request.Headers,SafeReadContract.TokenHeader,f);f.HostInstance=One(request.Headers,SafeReadContract.HostInstanceHeader,f);f.DocumentSession=One(request.Headers,SafeReadContract.DocumentSessionHeader,f);f.ClientSession=One(request.Headers,SafeReadContract.ClientSessionHeader,f);f.RequestId=One(request.Headers,SafeReadContract.RequestIdHeader,f);f.AttemptId=One(request.Headers,SafeReadContract.AttemptIdHeader,f);
            foreach(string? name in request.Headers.AllKeys??new string?[0])if(name!=null&&name.StartsWith(SafeReadContract.HeaderPrefix,StringComparison.OrdinalIgnoreCase)&&!SafeReadContract.IsRequiredHeader(name))f.UnknownHeader=true;
            if(f.ContentLength==SafeReadContract.RequestBytes.Length){byte[] body=new byte[SafeReadContract.RequestBytes.Length];int offset=0;while(offset<body.Length){cancellation.ThrowIfCancellationRequested();int read=await request.InputStream.ReadAsync(body,offset,body.Length-offset).ConfigureAwait(false);if(read<=0)break;offset+=read;}if(offset==body.Length)f.Body=body;}
            return f;
        }
        private static string One(NameValueCollection headers,string name,RequestFacts facts){string[]? values=headers.GetValues(name);if(values==null||values.Length!=1){if(values!=null)facts.DuplicateHeader=true;return String.Empty;}return values[0]??String.Empty;}
    }
    internal static class RequestAdmission
    {
        public static CertifiedFailureCode Evaluate(RequestFacts f,InstanceIdentity identity,DocumentBinding? document)
        {
            if(!f.Loopback||!String.Equals(f.Method,SafeReadContract.Method,StringComparison.Ordinal)||!String.Equals(f.RawTarget,SafeReadContract.Route,StringComparison.Ordinal)||f.HasTransferEncoding||f.HasContentEncoding||f.ContentLength!=SafeReadContract.RequestBytes.Length||!String.Equals(f.ContentType,"application/json",StringComparison.OrdinalIgnoreCase)||f.DuplicateHeader||f.UnknownHeader||f.Body==null||!Equal(f.Body,SafeReadContract.RequestBytes))return CertifiedFailureCode.BadRequest;
            if(!identity.TokenMatches(f.Token)||!String.Equals(identity.HostInstanceId,f.HostInstance,StringComparison.Ordinal))return CertifiedFailureCode.Unauthorized;
            if(document==null)return CertifiedFailureCode.NoActiveDocument;
            if(!String.Equals(document.DocumentSessionId,f.DocumentSession,StringComparison.Ordinal)||!Protocol.IsCanonicalGuid(f.ClientSession)||!Protocol.IsCanonicalGuid(f.RequestId)||!Protocol.IsCanonicalGuid(f.AttemptId))return CertifiedFailureCode.Unauthorized;
            return CertifiedFailureCode.None;
        }
        private static bool Equal(byte[] a,byte[] b){if(a.Length!=b.Length)return false;int d=0;for(int i=0;i<a.Length;i++)d|=a[i]^b[i];return d==0;}
    }
    internal sealed class SingleFlightGate{private int _held;public bool TryEnter()=>Interlocked.CompareExchange(ref _held,1,0)==0;public void Exit(){if(Interlocked.CompareExchange(ref _held,0,1)!=1)throw new InvalidOperationException();}}
}
