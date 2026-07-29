using System;
using System.Globalization;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace RevitOperator.SafeReadHost.HostKernel
{
    internal sealed class FixedBackendOrigin
    {
        private FixedBackendOrigin(Uri value){Value=value;}
        public Uri Value{get;}
        public static bool TryCreate(string? raw,out FixedBackendOrigin? origin){origin=null;if(String.IsNullOrEmpty(raw)||!String.Equals(raw,raw!.Trim(),StringComparison.Ordinal))return false;Uri? uri;if(!Uri.TryCreate(raw,UriKind.Absolute,out uri)||uri==null||uri.UserInfo.Length!=0||uri.Query.Length!=0||uri.Fragment.Length!=0||(uri.AbsolutePath.Length!=0&&uri.AbsolutePath!="/"))return false;bool https=uri.Scheme==Uri.UriSchemeHttps;bool loopback=uri.Scheme==Uri.UriSchemeHttp&&uri.Host=="127.0.0.1";if(!https&&!loopback)return false;origin=new FixedBackendOrigin(new Uri(uri.GetLeftPart(UriPartial.Authority),UriKind.Absolute));return true;}
    }
    internal sealed class BackendCredentials
    {
        private BackendCredentials(string? bearer,string? token){Bearer=bearer;Token=token;}
        public string? Bearer{get;}public string? Token{get;}
        public static BackendCredentials? Create(string? bearer,string? token){bool b=!String.IsNullOrWhiteSpace(bearer),t=!String.IsNullOrWhiteSpace(token);if(b==t)return null;if((b&&bearer!=bearer!.Trim())||(t&&token!=token!.Trim()))return null;return new BackendCredentials(b?bearer:null,t?token:null);}
    }
    internal sealed class Preauthorization
    {
        public Preauthorization(string capability,string bindings,string issued,string expires){CapabilityId=capability;BindingsHash=bindings;IssuedAtUtc=issued;ExpiresAtUtc=expires;}
        public string CapabilityId{get;}public string BindingsHash{get;}public string IssuedAtUtc{get;}public string ExpiresAtUtc{get;}
    }
    internal sealed class BackendAuthorizationFailure
    {
        public BackendAuthorizationFailure(string error,bool retryable,bool requestDispatched,bool outcomeUnknown){Error=error;Retryable=retryable;RequestDispatched=requestDispatched;OutcomeUnknown=outcomeUnknown;}
        public string Error{get;}public bool Retryable{get;}public bool RequestDispatched{get;}public bool OutcomeUnknown{get;}
        public static BackendAuthorizationFailure Unavailable()=>new BackendAuthorizationFailure("Backend final authorization was unavailable or invalid.",true,false,false);
    }
    internal sealed class BackendAuthorizationResult
    {
        private BackendAuthorizationResult(VerifiedFinalAuthorizationToken? token,BackendAuthorizationFailure? failure){Token=token;Failure=failure;}
        public VerifiedFinalAuthorizationToken? Token{get;}public BackendAuthorizationFailure? Failure{get;}
        public static BackendAuthorizationResult Authorized(VerifiedFinalAuthorizationToken token)=>new BackendAuthorizationResult(token,null);
        public static BackendAuthorizationResult Denied(BackendAuthorizationFailure failure)=>new BackendAuthorizationResult(null,failure);
    }
    internal sealed class BackendAuthorizationFailureException:Exception
    {
        public BackendAuthorizationFailureException(BackendAuthorizationFailure failure){Failure=failure;}
        public BackendAuthorizationFailure Failure{get;}
    }
    internal sealed class SafeReadBackendAuthorizer:IDisposable
    {
        private readonly HttpClient _http;private readonly FinalReceiptVerifier _verifier;private readonly FixedBackendOrigin _origin;
        public SafeReadBackendAuthorizer(FixedBackendOrigin origin,BackendCredentials credentials,FinalReceiptVerifier verifier)
        {
            _origin=origin;_verifier=verifier;HttpClientHandler handler=new HttpClientHandler{AllowAutoRedirect=false,UseCookies=false,UseProxy=false,AutomaticDecompression=DecompressionMethods.None};_http=new HttpClient(handler){BaseAddress=origin.Value,Timeout=Timeout.InfiniteTimeSpan};
            _http.DefaultRequestHeaders.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
            if(credentials.Bearer!=null)_http.DefaultRequestHeaders.Authorization=new AuthenticationHeaderValue("Bearer",credentials.Bearer);else _http.DefaultRequestHeaders.Add("x-operator-token",credentials.Token!);
        }
        public async Task<BackendAuthorizationResult> AuthorizeAsync(AuthorizationBindings bindings,byte[] nonce,CancellationToken cancellation)
        {
            if(bindings==null||nonce==null||nonce.Length!=32)return BackendAuthorizationResult.Denied(BackendAuthorizationFailure.Unavailable());
            try
            {
                string nonceText=Protocol.Base64Url(nonce);string nonceHash=Protocol.Sha256(nonce);
                Preauthorization? pre=await PostPreauthorization(bindings,nonceHash,cancellation).ConfigureAwait(false);
                if(pre==null||!ValidatePreauthorization(pre,DateTimeOffset.UtcNow))return BackendAuthorizationResult.Denied(BackendAuthorizationFailure.Unavailable());
                FinalAuthorizationReceipt? receipt=await PostFinal(bindings,pre.CapabilityId,nonceText,cancellation).ConfigureAwait(false);
                VerifiedFinalAuthorizationToken? token=_verifier.Verify(receipt,bindings,pre.CapabilityId,pre.BindingsHash,nonce,DateTimeOffset.UtcNow);
                return token==null?BackendAuthorizationResult.Denied(BackendAuthorizationFailure.Unavailable()):BackendAuthorizationResult.Authorized(token);
            }
            catch(BackendAuthorizationFailureException failure){return BackendAuthorizationResult.Denied(failure.Failure);}
        }
        private async Task<Preauthorization?> PostPreauthorization(AuthorizationBindings b,string nonceHash,CancellationToken cancellation)
        {
            string body=CreatePreauthorizationJson(b,nonceHash);
            JsonElement? root=await Post(SafeReadContract.PreauthorizationPath,body,cancellation).ConfigureAwait(false);if(root==null)return null;
            JsonElement envelope=root.Value;if(!Exact(envelope,"ok","authorization")||!True(envelope,"ok")||!envelope.TryGetProperty("authorization",out JsonElement a)||!Exact(a,"schema","capability_id","bindings_hash","issued_at_utc","expires_at_utc")||!Eq(a,"schema",SafeReadContract.PreauthorizationResponseSchema))return null;
            return new Preauthorization(Text(a,"capability_id"),Text(a,"bindings_hash"),Text(a,"issued_at_utc"),Text(a,"expires_at_utc"));
        }
        private async Task<FinalAuthorizationReceipt?> PostFinal(AuthorizationBindings b,string capability,string nonce,CancellationToken cancellation)
        {
            string body=CreateFinalAuthorizationJson(b,capability,nonce);
            JsonElement? root=await Post(SafeReadContract.FinalAuthorizationPath,body,cancellation).ConfigureAwait(false);if(root==null)return null;
            JsonElement envelope=root.Value;if(!Exact(envelope,"ok","receipt")||!True(envelope,"ok")||!envelope.TryGetProperty("receipt",out JsonElement r)||!Exact(r,"schema","route_id","host_instance_id","executor_id","runtime_attestation_sha256","runtime_tuple","document","client_session_id","request_id","attempt_id","capability_id","bindings_hash","receipt_id","issued_at_utc","expires_at_utc","hmac_sha256"))return null;
            AuthorizationBindings parsed;if(!TryBindings(r,out parsed)||!Eq(r,"schema",SafeReadContract.FinalReceiptSchema))return null;
            string canonical=CanonicalReceiptPayload(r);
            return new FinalAuthorizationReceipt(Text(r,"schema"),parsed,Text(r,"capability_id"),Text(r,"bindings_hash"),Text(r,"receipt_id"),Text(r,"issued_at_utc"),Text(r,"expires_at_utc"),Text(r,"hmac_sha256"),canonical);
        }
        private async Task<JsonElement?> Post(string path,string body,CancellationToken cancellation)
        {
            try
            {
                using(HttpRequestMessage request=new HttpRequestMessage(HttpMethod.Post,path)){request.Content=new StringContent(body,new UTF8Encoding(false),"application/json");using(HttpResponseMessage response=await _http.SendAsync(request,HttpCompletionOption.ResponseHeadersRead,cancellation).ConfigureAwait(false)){if(response.Content.Headers.ContentLength>SafeReadContract.MaximumBackendResponseBytes)return null;using(Stream stream=await response.Content.ReadAsStreamAsync().ConfigureAwait(false))using(MemoryStream copy=new MemoryStream()){byte[] buffer=new byte[4096];int total=0;while(true){int read=await stream.ReadAsync(buffer,0,Math.Min(buffer.Length,SafeReadContract.MaximumBackendResponseBytes-total),cancellation).ConfigureAwait(false);if(read<=0)break;total+=read;if(total>=SafeReadContract.MaximumBackendResponseBytes)return null;copy.Write(buffer,0,read);}using(JsonDocument doc=JsonDocument.Parse(copy.ToArray(),new JsonDocumentOptions{AllowTrailingCommas=false,CommentHandling=JsonCommentHandling.Disallow,MaxDepth=8})){JsonElement root=doc.RootElement.Clone();if(response.StatusCode!=HttpStatusCode.OK){BackendAuthorizationFailure? failure=ParseFailure(root);if(failure!=null)throw new BackendAuthorizationFailureException(failure);return null;}return root;}}}}
            }
            catch(OperationCanceledException) when(cancellation.IsCancellationRequested){throw;}
            catch{return null;}
        }
        private static string BindingsJson(AuthorizationBindings b)=>",\"route_id\":"+Protocol.Quote(b.RouteId)+",\"host_instance_id\":"+Protocol.Quote(b.HostInstanceId)+",\"executor_id\":"+Protocol.Quote(b.ExecutorId)+",\"runtime_attestation_sha256\":"+Protocol.Quote(b.RuntimeAttestationSha256)+",\"runtime_tuple\":"+RuntimeJson(b.RuntimeTuple)+",\"document\":{\"project_fingerprint\":"+Protocol.Quote(b.ProjectFingerprint)+",\"document_session_id\":"+Protocol.Quote(b.DocumentSessionId)+"},\"client_session_id\":"+Protocol.Quote(b.ClientSessionId)+",\"request_id\":"+Protocol.Quote(b.RequestId)+",\"attempt_id\":"+Protocol.Quote(b.AttemptId);
        internal static string CreatePreauthorizationJson(AuthorizationBindings b,string nonceHash)=>"{\"schema\":"+Protocol.Quote(SafeReadContract.PreauthorizationSchema)+BindingsJson(b)+",\"capability_nonce_sha256\":"+Protocol.Quote(nonceHash)+"}";
        internal static string CreateFinalAuthorizationJson(AuthorizationBindings b,string capability,string nonce)=>"{\"schema\":"+Protocol.Quote(SafeReadContract.FinalAuthorizationSchema)+BindingsJson(b)+",\"capability_id\":"+Protocol.Quote(capability)+",\"capability_nonce\":"+Protocol.Quote(nonce)+"}";
        private static string RuntimeJson(RuntimeTuple t)=>"{\"host_content_sha256\":"+Protocol.Quote(t.HostContentSha256)+",\"host_mvid\":"+Protocol.Quote(t.HostMvid)+",\"revit_api_content_sha256\":"+Protocol.Quote(t.RevitApiContentSha256)+",\"revit_api_mvid\":"+Protocol.Quote(t.RevitApiMvid)+",\"revit_version\":"+Protocol.Quote(t.RevitVersion)+"}";
        private static bool ValidatePreauthorization(Preauthorization p,DateTimeOffset now){DateTimeOffset issued,expires;return p.CapabilityId.Length==48&&p.CapabilityId.StartsWith("src1_",StringComparison.Ordinal)&&Protocol.IsHash(p.BindingsHash)&&ParseTime(p.IssuedAtUtc,out issued)&&ParseTime(p.ExpiresAtUtc,out expires)&&issued<=now.AddSeconds(5)&&expires>now&&expires>issued&&expires-issued<=TimeSpan.FromSeconds(30);}
        private static bool TryBindings(JsonElement r,out AuthorizationBindings b){b=null!;JsonElement t,d;if(!r.TryGetProperty("runtime_tuple",out t)||!Exact(t,"host_content_sha256","host_mvid","revit_api_content_sha256","revit_api_mvid","revit_version")||!r.TryGetProperty("document",out d)||!Exact(d,"project_fingerprint","document_session_id"))return false;RuntimeTuple tuple=new RuntimeTuple(Text(t,"host_content_sha256"),Text(t,"host_mvid"),Text(t,"revit_api_content_sha256"),Text(t,"revit_api_mvid"),Text(t,"revit_version"));b=new AuthorizationBindings(Text(r,"route_id"),Text(r,"host_instance_id"),Text(r,"executor_id"),Text(r,"runtime_attestation_sha256"),tuple,Text(d,"project_fingerprint"),Text(d,"document_session_id"),Text(r,"client_session_id"),Text(r,"request_id"),Text(r,"attempt_id"));return true;}
        private static string CanonicalReceiptPayload(JsonElement r){JsonElement t=r.GetProperty("runtime_tuple"),d=r.GetProperty("document");return "{\"attempt_id\":"+Protocol.Quote(Text(r,"attempt_id"))+",\"bindings_hash\":"+Protocol.Quote(Text(r,"bindings_hash"))+",\"capability_id\":"+Protocol.Quote(Text(r,"capability_id"))+",\"client_session_id\":"+Protocol.Quote(Text(r,"client_session_id"))+",\"document\":{\"document_session_id\":"+Protocol.Quote(Text(d,"document_session_id"))+",\"project_fingerprint\":"+Protocol.Quote(Text(d,"project_fingerprint"))+"},\"executor_id\":"+Protocol.Quote(Text(r,"executor_id"))+",\"expires_at_utc\":"+Protocol.Quote(Text(r,"expires_at_utc"))+",\"host_instance_id\":"+Protocol.Quote(Text(r,"host_instance_id"))+",\"issued_at_utc\":"+Protocol.Quote(Text(r,"issued_at_utc"))+",\"receipt_id\":"+Protocol.Quote(Text(r,"receipt_id"))+",\"request_id\":"+Protocol.Quote(Text(r,"request_id"))+",\"route_id\":"+Protocol.Quote(Text(r,"route_id"))+",\"runtime_attestation_sha256\":"+Protocol.Quote(Text(r,"runtime_attestation_sha256"))+",\"runtime_tuple\":"+RuntimeJson(new RuntimeTuple(Text(t,"host_content_sha256"),Text(t,"host_mvid"),Text(t,"revit_api_content_sha256"),Text(t,"revit_api_mvid"),Text(t,"revit_version")))+",\"schema\":"+Protocol.Quote(Text(r,"schema"))+"}";}
        private static bool Exact(JsonElement e,params string[] names){if(e.ValueKind!=JsonValueKind.Object)return false;int i=0;foreach(JsonProperty p in e.EnumerateObject()){if(i>=names.Length||p.Name!=names[i])return false;i++;}return i==names.Length;}
        private static bool True(JsonElement e,string name){JsonElement v;return e.TryGetProperty(name,out v)&&v.ValueKind==JsonValueKind.True;}
        private static bool Eq(JsonElement e,string name,string expected)=>String.Equals(Text(e,name),expected,StringComparison.Ordinal);
        private static string Text(JsonElement e,string name){JsonElement v;return e.TryGetProperty(name,out v)&&v.ValueKind==JsonValueKind.String?v.GetString()??String.Empty:String.Empty;}
        private static bool ParseTime(string value,out DateTimeOffset parsed)=>DateTimeOffset.TryParseExact(value,"yyyy-MM-dd'T'HH:mm:ss.fff'Z'",CultureInfo.InvariantCulture,DateTimeStyles.AssumeUniversal|DateTimeStyles.AdjustToUniversal,out parsed);
        private static BackendAuthorizationFailure? ParseFailure(JsonElement root)
        {
            if(!Exact(root,"ok","code","error","retryable","request_dispatched","outcome_unknown"))return null;
            JsonElement ok,retryable,dispatched,unknown;if(!root.TryGetProperty("ok",out ok)||ok.ValueKind!=JsonValueKind.False||!root.TryGetProperty("retryable",out retryable)||(retryable.ValueKind!=JsonValueKind.True&&retryable.ValueKind!=JsonValueKind.False)||!root.TryGetProperty("request_dispatched",out dispatched)||(dispatched.ValueKind!=JsonValueKind.True&&dispatched.ValueKind!=JsonValueKind.False)||!root.TryGetProperty("outcome_unknown",out unknown)||(unknown.ValueKind!=JsonValueKind.True&&unknown.ValueKind!=JsonValueKind.False))return null;
            string error=Text(root,"error");if(!SafeFailureText(error))return null;bool isUnknown=unknown.GetBoolean(),isDispatched=dispatched.GetBoolean(),isRetryable=retryable.GetBoolean();if(isUnknown){isDispatched=true;isRetryable=false;}
            return new BackendAuthorizationFailure(error,isRetryable,isDispatched,isUnknown);
        }
        private static bool SafeFailureText(string value){if(String.IsNullOrEmpty(value)||value.Length>512)return false;for(int i=0;i<value.Length;i++)if(value[i]<32||value[i]==127)return false;return true;}
        public void Dispose()=>_http.Dispose();
    }
}
