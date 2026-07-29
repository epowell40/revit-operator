using System;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Events;
using Autodesk.Revit.UI;
using Autodesk.Revit.UI.Events;
using RevitOperator.SafeReadHost.HostKernel;

namespace RevitOperator.SafeReadHost
{
    public sealed class App:IExternalApplication
    {
        private UIControlledApplication? _application;private InstanceIdentity? _identity;private DocumentSessionTracker? _tracker;private CertifiedExternalWorkSlot? _slot;private ExternalEvent? _externalEvent;private CertifiedSafeReadHttpHost? _host;private DiscoveryPublisher? _discovery;private SafeReadBackendAuthorizer? _authorizer;
        public Result OnStartup(UIControlledApplication application)
        {
            try
            {
                bool hasPort;int port;if(!PortPolicy.TryReadOverride(Environment.GetEnvironmentVariable("REVIT_OPERATOR_SAFE_READ_PORT"),out hasPort,SafeReadContract.MinimumPort,out port))return Result.Failed;
                FixedBackendOrigin? origin;if(!FixedBackendOrigin.TryCreate(Environment.GetEnvironmentVariable("REVIT_OPERATOR_SAFE_READ_AUTH_ORIGIN"),out origin)||origin==null)return Result.Failed;
                BackendCredentials? credentials=BackendCredentials.Create(Environment.GetEnvironmentVariable("REVIT_OPERATOR_SAFE_READ_AUTH_BEARER"),Environment.GetEnvironmentVariable("REVIT_OPERATOR_SAFE_READ_AUTH_TOKEN"));if(credentials==null)return Result.Failed;
                int revitYear;if(!Int32.TryParse(application.ControlledApplication.VersionNumber,out revitYear)||revitYear<2023||revitYear>2025)return Result.Failed;
                RuntimeDeploymentAttestation attestation=RuntimeDeploymentAttestation.Load(revitYear);
                _application=application;_identity=InstanceIdentity.Create();_tracker=new DocumentSessionTracker();_slot=new CertifiedExternalWorkSlot();
                CertifiedSheetsCountExternalEventHandler handler=new CertifiedSheetsCountExternalEventHandler(_slot,_tracker);_externalEvent=ExternalEvent.Create(handler);
                _authorizer=new SafeReadBackendAuthorizer(origin,credentials,new FinalReceiptVerifier());
                _host=new CertifiedSafeReadHttpHost(_identity,_tracker,_slot,_externalEvent,_authorizer,attestation);
                if(!_host.Start(hasPort,port)||_host.Endpoint==null){Stop();return Result.Failed;}
                _discovery=new DiscoveryPublisher(_identity,revitYear,_host.Endpoint,attestation);_discovery.Publish(null);
                application.ViewActivated+=OnViewActivated;application.ControlledApplication.DocumentClosing+=OnDocumentClosing;return Result.Succeeded;
            }
            catch{Stop();return Result.Failed;}
        }
        public Result OnShutdown(UIControlledApplication application){Stop();return Result.Succeeded;}
        private void OnViewActivated(object? sender,ViewActivatedEventArgs e){if(_tracker==null||_discovery==null)return;try{View? view=e.CurrentActiveView;_discovery.Publish(RevitDocumentAccess.Observe(view==null?null:view.Document,_tracker));}catch{_tracker.Clear();TryPublishNull();}}
        private void OnDocumentClosing(object? sender,DocumentClosingEventArgs e){if(_tracker==null)return;try{_tracker.ClearIfCurrent(e.Document);_discovery?.Publish(_tracker.Current);}catch{_tracker.Clear();TryPublishNull();}}
        private void TryPublishNull(){try{_discovery?.Publish(null);}catch{}}
        private void Stop()
        {
            if(_application!=null){try{_application.ViewActivated-=OnViewActivated;_application.ControlledApplication.DocumentClosing-=OnDocumentClosing;}catch{}}
            try{_host?.Stop();}catch{}try{_discovery?.Remove();}catch{}try{_externalEvent?.Dispose();}catch{}try{_authorizer?.Dispose();}catch{}
            _host=null;_discovery=null;_externalEvent=null;_authorizer=null;_slot=null;_tracker=null;_identity=null;_application=null;
        }
    }
}
