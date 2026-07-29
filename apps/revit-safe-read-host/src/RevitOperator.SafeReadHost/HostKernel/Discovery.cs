using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using RevitOperator.SafeReadCertifiedExecution;

namespace RevitOperator.SafeReadHost.HostKernel
{
    internal sealed class DiscoveryRecord
    {
        public DiscoveryRecord(InstanceIdentity identity,int pid,int year,string endpoint,RuntimeDeploymentAttestation attestation,DocumentBinding? document){Identity=identity;Pid=pid;Year=year;Endpoint=endpoint.TrimEnd('/');Attestation=attestation;Document=document;}
        public InstanceIdentity Identity{get;}public int Pid{get;}public int Year{get;}public string Endpoint{get;}public RuntimeDeploymentAttestation Attestation{get;}public DocumentBinding? Document{get;}
    }
    internal static class DiscoveryRecordFormatter
    {
        public static string Format(DiscoveryRecord r)
        {
            return DiscoveryWire.Format(r.Identity.HostInstanceId,r.Identity.StartupToken,r.Pid,r.Year,r.Endpoint,r.Attestation.Sha256,r.Attestation.RuntimeTuple,r.Document);
        }
    }
    internal sealed class DiscoveryPublisher
    {
        private readonly string _directory;private readonly InstanceIdentity _identity;private readonly int _year;private readonly string _endpoint;private readonly RuntimeDeploymentAttestation _attestation;private readonly object _sync=new object();private bool _removed;
        public DiscoveryPublisher(InstanceIdentity identity,int year,string endpoint,RuntimeDeploymentAttestation attestation){_identity=identity;_year=year;_endpoint=endpoint;_attestation=attestation;string local=Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);if(String.IsNullOrWhiteSpace(local))throw new InvalidOperationException("LOCALAPPDATA unavailable.");_directory=Path.Combine(local,"RevitOperator","SafeRead","instances");}
        public void Publish(DocumentBinding? document){lock(_sync){if(_removed)throw new InvalidOperationException();Directory.CreateDirectory(_directory);string target=Path.Combine(_directory,_identity.HostInstanceId+".json");string temp=target+"."+Guid.NewGuid().ToString("N")+".tmp";try{File.WriteAllText(temp,DiscoveryRecordFormatter.Format(new DiscoveryRecord(_identity,Process.GetCurrentProcess().Id,_year,_endpoint,_attestation,document)),new UTF8Encoding(false));if(File.Exists(target))File.Replace(temp,target,null);else File.Move(temp,target);}finally{if(File.Exists(temp))File.Delete(temp);}}}
        public void Remove(){lock(_sync){if(_removed)return;string target=Path.Combine(_directory,_identity.HostInstanceId+".json");if(File.Exists(target))File.Delete(target);_removed=true;}}
    }
}
