using System;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using RevitOperator.SafeReadHost.HostKernel;
using Xunit;

namespace RevitOperator.SafeReadHost.Tests
{
    public sealed class CertifiedBoundaryTests
    {
        [Fact] public void Certified_project_has_no_host_network_file_environment_or_json_dependency()
        {
            string root=FindRoot(),cert=Path.Combine(root,"src","RevitOperator.SafeReadCertifiedExecution");string source=File.ReadAllText(Path.Combine(cert,"RevitCertifiedExecution.cs"));
            foreach(string forbidden in new[]{"RevitOperator.SafeReadHost","RevitBridge","System.Net","System.IO","System.Threading","System.Security","Environment.","Json","HttpClient","HttpListener","Task","ExternalEvent","UIApplication"})Assert.DoesNotContain(forbidden,source,StringComparison.Ordinal);
            string project=File.ReadAllText(Path.Combine(cert,"RevitOperator.SafeReadCertifiedExecution.csproj"));Assert.DoesNotContain("PackageReference",project,StringComparison.Ordinal);Assert.DoesNotContain("ProjectReference",project,StringComparison.Ordinal);
            Assert.DoesNotContain("RevitAPIUI",project,StringComparison.Ordinal);Assert.Contains("<Compile Include=\"RevitCertifiedExecution.cs\" />",project,StringComparison.Ordinal);
        }
        [Fact] public void Host_references_certified_one_way_and_only_explicit_sources_compile()
        {
            string project=File.ReadAllText(Path.Combine(FindRoot(),"src","RevitOperator.SafeReadHost","RevitOperator.SafeReadHost.csproj"));Assert.Contains("RevitOperator.SafeReadCertifiedExecution.csproj",project);Assert.Contains("<EnableDefaultCompileItems>false</EnableDefaultCompileItems>",project);
        }
        [Fact] public async Task Pending_event_deadline_cancels_and_releases_capacity()
        {
            object identity=new object();DocumentBinding binding=new DocumentBinding(identity,"sha256:"+new string('c',64),"22222222-2222-2222-2222-222222222222",false);CertifiedExternalWorkSlot slot=new CertifiedExternalWorkSlot();CertifiedExternalWorkItem first=CertifiedExternalWorkItem.Capture(binding);Assert.True(slot.TryQueue(first));Assert.True(slot.TryCancelPending(first));CertifiedExecutionResult result=await first.Completion;Assert.Equal(CertifiedExecutionOutcome.Cancelled,result.Outcome);Assert.True(slot.TryQueue(CertifiedExternalWorkItem.Capture(binding)));
        }
        [Fact] public void Static_attestation_source_excludes_dynamic_host_and_document_ids()
        {
            string source=File.ReadAllText(Path.Combine(FindRoot(),"src","RevitOperator.SafeReadHost","HostKernel","RuntimeAttestation.cs"));Assert.DoesNotContain("host_instance_id",source,StringComparison.Ordinal);Assert.DoesNotContain("document_session_id",source,StringComparison.Ordinal);Assert.Contains("executor_id",source,StringComparison.Ordinal);Assert.Contains("safe_read_runtime_attestation.v1.json",source,StringComparison.Ordinal);Assert.Contains("safe_read_runtime_attestation.v1.sha256",source,StringComparison.Ordinal);Assert.Contains("ReadRegularFile",source,StringComparison.Ordinal);Assert.Contains("ReparsePoint",source,StringComparison.Ordinal);Assert.Contains("RuntimeDeploymentAttestation.Load",File.ReadAllText(Path.Combine(FindRoot(),"src","RevitOperator.SafeReadHost","HostApplication.cs")),StringComparison.Ordinal);
        }
        [Fact] public async Task Claim_cancel_race_has_one_terminal_owner_and_recovers_capacity()
        {
            for(int round=0;round<200;round++)
            {
                DocumentBinding binding=new DocumentBinding(new object(),"sha256:"+new string('c',64),"22222222-2222-2222-2222-222222222222",false);CertifiedExternalWorkSlot slot=new CertifiedExternalWorkSlot();CertifiedExternalWorkItem item=CertifiedExternalWorkItem.Capture(binding);Assert.True(slot.TryQueue(item));ManualResetEventSlim start=new ManualResetEventSlim(false);CertifiedExternalWorkItem? claimed=null;bool cancelled=false;
                Thread take=new Thread(()=>{start.Wait();claimed=slot.Take();});Thread cancel=new Thread(()=>{start.Wait();cancelled=slot.TryCancelPending(item);});take.Start();cancel.Start();start.Set();take.Join();cancel.Join();Assert.NotEqual(cancelled,claimed!=null);
                if(claimed!=null){claimed.Complete(CertifiedExecutionResult.Captured(binding));slot.Release(claimed);}CertifiedExecutionResult result=await item.Completion;Assert.True(result.Succeeded||result.Outcome==CertifiedExecutionOutcome.Cancelled);Assert.True(slot.TryQueue(CertifiedExternalWorkItem.Capture(binding)));
            }
        }
        [Fact] public void Host_deadlines_are_explicit_and_bounded(){Assert.Equal(TimeSpan.FromSeconds(10),SafeReadContract.RequestDeadline);Assert.Equal(TimeSpan.FromSeconds(3),SafeReadContract.AuthorizationDeadline);Assert.Equal(TimeSpan.FromSeconds(3),SafeReadContract.ExternalEventDeadline);}
        [Fact] public void Discovery_ports_are_frozen_to_5040_through_5050(){Assert.Equal(5040,RevitOperator.SafeReadHost.HostKernel.SafeReadContract.MinimumPort);Assert.Equal(5050,RevitOperator.SafeReadHost.HostKernel.SafeReadContract.MaximumPort);}
        private static string FindRoot(){DirectoryInfo? d=new DirectoryInfo(AppContext.BaseDirectory);while(d!=null){if(File.Exists(Path.Combine(d.FullName,"RevitSafeReadHost.sln")))return d.FullName;d=d.Parent;}throw new DirectoryNotFoundException();}
    }
}
