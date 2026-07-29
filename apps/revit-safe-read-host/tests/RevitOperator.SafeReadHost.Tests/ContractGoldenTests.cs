using System;
using System.IO;
using System.Linq;
using System.Text.Json;
using RevitOperator.SafeReadCertifiedExecution;
using RevitOperator.SafeReadHost.HostKernel;
using Xunit;

namespace RevitOperator.SafeReadHost.Tests
{
    public sealed class ContractGoldenTests
    {
        private static string Fixture(string name)=>File.ReadAllText(Path.Combine(AppContext.BaseDirectory,"fixtures",name)).TrimEnd('\r','\n');
        [Fact] public void External_route_body_and_headers_are_exact()
        {
            Assert.Equal("POST",SafeReadContract.Method);Assert.Equal("/revit/certified/sheets/count",SafeReadContract.Route);Assert.Equal(SafeReadContract.RequestJson,Fixture("external-request.json"));
            Assert.Equal(new[]{"X-RevitOperator-SafeRead-Token","X-RevitOperator-SafeRead-HostInstance","X-RevitOperator-SafeRead-DocumentSession","X-RevitOperator-SafeRead-ClientSession","X-RevitOperator-SafeRead-RequestId","X-RevitOperator-SafeRead-AttemptId"},new[]{SafeReadContract.TokenHeader,SafeReadContract.HostInstanceHeader,SafeReadContract.DocumentSessionHeader,SafeReadContract.ClientSessionHeader,SafeReadContract.RequestIdHeader,SafeReadContract.AttemptIdHeader});
            Assert.DoesNotContain("Nonce",String.Join("|",new[]{SafeReadContract.TokenHeader,SafeReadContract.HostInstanceHeader,SafeReadContract.DocumentSessionHeader,SafeReadContract.ClientSessionHeader,SafeReadContract.RequestIdHeader,SafeReadContract.AttemptIdHeader}));
        }
        [Fact] public void Golden_backend_requests_have_exact_order_and_flat_snake_case_contract()
        {
            RuntimeTuple tuple=new RuntimeTuple("sha256:"+new string('b',64),"66666666-6666-6666-6666-666666666666","sha256:"+new string('e',64),"77777777-7777-7777-7777-777777777777","2024");AuthorizationBindings bindings=new AuthorizationBindings(SafeReadContract.RouteId,"11111111-1111-1111-1111-111111111111",SafeReadContract.ExecutorId,"sha256:"+new string('a',64),tuple,"sha256:"+new string('c',64),"22222222-2222-2222-2222-222222222222","33333333-3333-3333-3333-333333333333","44444444-4444-4444-4444-444444444444","55555555-5555-5555-5555-555555555555");
            string pre=Fixture("preauthorization-request.json"),final=Fixture("final-authorization-request.json");Assert.Equal(pre,SafeReadBackendAuthorizer.CreatePreauthorizationJson(bindings,"sha256:630dcd2966c4336691125448bbb25b4ff412a49c732db2c8abf5dd047f6c7a61"));Assert.Equal(final,SafeReadBackendAuthorizer.CreateFinalAuthorizationJson(bindings,"src1_"+new string('A',43),"AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"));
            Assert.Equal(new[]{"schema","route_id","host_instance_id","executor_id","runtime_attestation_sha256","runtime_tuple","document","client_session_id","request_id","attempt_id","capability_nonce_sha256"},Names(pre));Assert.Equal(new[]{"schema","route_id","host_instance_id","executor_id","runtime_attestation_sha256","runtime_tuple","document","client_session_id","request_id","attempt_id","capability_id","capability_nonce"},Names(final));
        }
        [Fact] public void Golden_discovery_has_only_canonical_top_level_shape()
        {
            string json=Fixture("discovery.json");RuntimeTuple tuple=new RuntimeTuple("sha256:"+new string('b',64),"66666666-6666-6666-6666-666666666666","sha256:"+new string('e',64),"77777777-7777-7777-7777-777777777777","2024");DocumentBinding document=new DocumentBinding(new object(),"sha256:"+new string('c',64),"22222222-2222-2222-2222-222222222222",false);Assert.Equal(json,DiscoveryWire.Format("11111111-1111-1111-1111-111111111111",new string('A',43),4242,2024,"http://127.0.0.1:5040","sha256:"+new string('a',64),tuple,document));Assert.Equal(new[]{"schema","product_id","host_instance_id","executor_id","pid","revit_year","route_id","route","endpoint","startup_token","runtime_attestation_sha256","runtime_tuple","document"},Names(json));
            using(JsonDocument doc=JsonDocument.Parse(json)){Assert.Equal("aafaa2c0-43f1-42a0-a6b4-d9a0c5f5ce0e",doc.RootElement.GetProperty("product_id").GetString());Assert.Equal(5040,new Uri(doc.RootElement.GetProperty("endpoint").GetString()!).Port);}
        }
        [Fact] public void Golden_receipt_hmac_creates_one_use_certified_token()
        {
            string payload=Fixture("final-receipt-payload.json");using(JsonDocument doc=JsonDocument.Parse(payload)){JsonElement r=doc.RootElement,t=r.GetProperty("runtime_tuple"),d=r.GetProperty("document");RuntimeTuple tuple=new RuntimeTuple(t.GetProperty("host_content_sha256").GetString()!,t.GetProperty("host_mvid").GetString()!,t.GetProperty("revit_api_content_sha256").GetString()!,t.GetProperty("revit_api_mvid").GetString()!,t.GetProperty("revit_version").GetString()!);AuthorizationBindings bindings=new AuthorizationBindings(r.GetProperty("route_id").GetString()!,r.GetProperty("host_instance_id").GetString()!,r.GetProperty("executor_id").GetString()!,r.GetProperty("runtime_attestation_sha256").GetString()!,tuple,d.GetProperty("project_fingerprint").GetString()!,d.GetProperty("document_session_id").GetString()!,r.GetProperty("client_session_id").GetString()!,r.GetProperty("request_id").GetString()!,r.GetProperty("attempt_id").GetString()!);FinalAuthorizationReceipt receipt=new FinalAuthorizationReceipt(r.GetProperty("schema").GetString()!,bindings,r.GetProperty("capability_id").GetString()!,r.GetProperty("bindings_hash").GetString()!,r.GetProperty("receipt_id").GetString()!,r.GetProperty("issued_at_utc").GetString()!,r.GetProperty("expires_at_utc").GetString()!,"sha256:2da71a2047d6c6eb767a6e9c5cd1fc7a94133770271a9ea54cb5d6a6833d50a5",payload);byte[] nonce=Enumerable.Range(0,32).Select(i=>(byte)i).ToArray();VerifiedFinalAuthorizationToken? token=new FinalReceiptVerifier().Verify(receipt,bindings,receipt.CapabilityId,receipt.BindingsHash,nonce,new DateTimeOffset(2035,1,2,3,4,5,500,TimeSpan.Zero));Assert.NotNull(token);Assert.Null(new FinalReceiptVerifier().Verify(new FinalAuthorizationReceipt(receipt.Schema,bindings,receipt.CapabilityId,receipt.BindingsHash,receipt.ReceiptId,receipt.IssuedAtUtc,receipt.ExpiresAtUtc,"sha256:"+new string('0',64),payload),bindings,receipt.CapabilityId,receipt.BindingsHash,nonce,new DateTimeOffset(2035,1,2,3,4,5,500,TimeSpan.Zero)));}
        }
        [Fact] public void Golden_backend_envelopes_are_exact_and_flat()
        {
            using(JsonDocument pre=JsonDocument.Parse(Fixture("preauthorization-response.json"))){Assert.Equal(new[]{"ok","authorization"},pre.RootElement.EnumerateObject().Select(p=>p.Name));Assert.Equal(new[]{"schema","capability_id","bindings_hash","issued_at_utc","expires_at_utc"},pre.RootElement.GetProperty("authorization").EnumerateObject().Select(p=>p.Name));}
            using(JsonDocument final=JsonDocument.Parse(Fixture("final-receipt-response.json"))){Assert.Equal(new[]{"ok","receipt"},final.RootElement.EnumerateObject().Select(p=>p.Name));Assert.Equal(new[]{"schema","route_id","host_instance_id","executor_id","runtime_attestation_sha256","runtime_tuple","document","client_session_id","request_id","attempt_id","capability_id","bindings_hash","receipt_id","issued_at_utc","expires_at_utc","hmac_sha256"},final.RootElement.GetProperty("receipt").EnumerateObject().Select(p=>p.Name));}
        }
        [Fact] public void Strict_responses_preserve_phase_outcome_and_ids()
        {
            const string req="44444444-4444-4444-4444-444444444444",attempt="55555555-5555-5555-5555-555555555555";using(JsonDocument ok=JsonDocument.Parse(ResponsePayload.Success(12,req,attempt).Body)){Assert.Equal(new[]{"schema","count","phase","outcome","request_id","attempt_id"},ok.RootElement.EnumerateObject().Select(p=>p.Name));}using(JsonDocument fail=JsonDocument.Parse(ResponsePayload.Failure(CertifiedFailureCode.DeadlineExceeded,CertifiedExecutionPhase.CountSheets,CertifiedExecutionOutcome.Cancelled,req,attempt).Body)){Assert.Equal(new[]{"schema","code","phase","outcome","request_id","attempt_id"},fail.RootElement.EnumerateObject().Select(p=>p.Name));Assert.Equal("cancelled",fail.RootElement.GetProperty("outcome").GetString());}
        }
        private static string[] Names(string json){using(JsonDocument doc=JsonDocument.Parse(json))return doc.RootElement.EnumerateObject().Select(p=>p.Name).ToArray();}
    }
}
