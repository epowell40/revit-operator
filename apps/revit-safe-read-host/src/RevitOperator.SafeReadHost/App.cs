using System;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Events;
using Autodesk.Revit.UI;
using Autodesk.Revit.UI.Events;
using RevitOperator.SafeReadHost.Kernel;

namespace RevitOperator.SafeReadHost
{
    public sealed class App : IExternalApplication
    {
        private UIControlledApplication? _controlledApplication;
        private InstanceIdentity? _identity;
        private DocumentSessionTracker? _documentTracker;
        private CertifiedExternalWorkSlot? _workSlot;
        private CertifiedSheetsCountExternalEventHandler? _handler;
        private ExternalEvent? _externalEvent;
        private SafeReadHttpHost? _host;
        private DiscoveryPublisher? _discovery;

        public Result OnStartup(UIControlledApplication application)
        {
            try
            {
                bool hasPortOverride;
                int portOverride;
                if (!PortPolicy.TryReadOverride(
                        Environment.GetEnvironmentVariable("REVIT_OPERATOR_SAFE_READ_PORT"),
                        out hasPortOverride,
                        out portOverride))
                    return Result.Failed;

                FixedBackendOrigin? configuredOrigin;
                FixedBackendOrigin.TryCreate(
                    Environment.GetEnvironmentVariable("REVIT_OPERATOR_SAFE_READ_AUTH_ORIGIN"),
                    out configuredOrigin);

                _controlledApplication = application;
                _identity = InstanceIdentity.Create();
                _documentTracker = new DocumentSessionTracker();
                _workSlot = new CertifiedExternalWorkSlot();
                _handler = new CertifiedSheetsCountExternalEventHandler(_workSlot, _documentTracker);
                _externalEvent = ExternalEvent.Create(_handler);
                ISafeReadAuthorizationClient authorizer = new DenyAllSafeReadAuthorizationClient(configuredOrigin);
                SafeReadAuthorizationGate authorizationGate = new SafeReadAuthorizationGate(
                    configuredOrigin,
                    authorizer,
                    new SystemAuthorizationClock(),
                    new ReceiptReplayGuard());
                _host = new SafeReadHttpHost(
                    _identity,
                    _documentTracker,
                    _workSlot,
                    _externalEvent,
                    authorizationGate,
                    null,
                    null);
                if (!_host.Start(hasPortOverride, portOverride) || _host.BaseUrl == null)
                {
                    StopRuntime();
                    return Result.Failed;
                }

                _discovery = new DiscoveryPublisher(
                    new LocalAppDataDiscoveryStore(),
                    _identity,
                    _host.BaseUrl);
                _discovery.Publish(null);
                application.ViewActivated += OnViewActivated;
                application.ControlledApplication.DocumentClosing += OnDocumentClosing;
                return Result.Succeeded;
            }
            catch
            {
                StopRuntime();
                return Result.Failed;
            }
        }

        public Result OnShutdown(UIControlledApplication application)
        {
            StopRuntime();
            return Result.Succeeded;
        }

        private void OnViewActivated(object? sender, ViewActivatedEventArgs arguments)
        {
            DocumentSessionTracker? tracker = _documentTracker;
            DiscoveryPublisher? discovery = _discovery;
            if (tracker == null || discovery == null)
                return;
            try
            {
                View? view = arguments.CurrentActiveView;
                DocumentBinding? binding = RevitDocumentAccess.Observe(view == null ? null : view.Document, tracker);
                discovery.Publish(binding);
            }
            catch
            {
                tracker.Clear();
                TryPublishNoDocument(discovery);
            }
        }

        private void OnDocumentClosing(object? sender, DocumentClosingEventArgs arguments)
        {
            DocumentSessionTracker? tracker = _documentTracker;
            DiscoveryPublisher? discovery = _discovery;
            if (tracker == null || discovery == null)
                return;
            try
            {
                Document document = arguments.Document;
                tracker.ClearIfCurrent(document);
                discovery.Publish(tracker.Current);
            }
            catch
            {
                tracker.Clear();
                TryPublishNoDocument(discovery);
            }
        }

        private static void TryPublishNoDocument(DiscoveryPublisher discovery)
        {
            try
            {
                discovery.Publish(null);
            }
            catch
            {
            }
        }

        private void StopRuntime()
        {
            UIControlledApplication? application = _controlledApplication;
            if (application != null)
            {
                try
                {
                    application.ViewActivated -= OnViewActivated;
                    application.ControlledApplication.DocumentClosing -= OnDocumentClosing;
                }
                catch
                {
                }
            }

            if (_host != null)
                _host.Stop();
            if (_discovery != null)
            {
                try
                {
                    _discovery.Remove();
                }
                catch
                {
                }
            }
            if (_externalEvent != null)
            {
                try
                {
                    _externalEvent.Dispose();
                }
                catch
                {
                }
            }

            _host = null;
            _discovery = null;
            _externalEvent = null;
            _handler = null;
            _workSlot = null;
            _documentTracker = null;
            _identity = null;
            _controlledApplication = null;
        }
    }
}
