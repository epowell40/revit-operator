using System.Threading;
using Autodesk.Revit.UI;

namespace SafeReadCertifiedExecution;

internal sealed class SafeReadExecutor
{
    private readonly ReadTitleHandler _handler;
    private readonly ExternalEvent _externalEvent;

    internal SafeReadExecutor()
    {
        _handler = new ReadTitleHandler();
        _externalEvent = ExternalEvent.Create(_handler);
    }

    internal bool TrySubmit(ReadTitleRequest request)
    {
        if (!_handler.TryPrepare(request))
        {
            return false;
        }
        ExternalEventRequest result = _externalEvent.Raise();
        return result == ExternalEventRequest.Accepted;
    }
}

internal sealed class ReadTitleHandler : IExternalEventHandler
{
    private ReadTitleRequest? _pending;

    internal ReadTitleHandler()
    {
        _pending = null;
    }

    internal bool TryPrepare(ReadTitleRequest request)
    {
        ReadTitleRequest? prior = Interlocked.CompareExchange(ref _pending, request, null);
        return prior is null;
    }

    public void Execute(UIApplication application)
    {
        ReadTitleRequest? request = Interlocked.Exchange(ref _pending, null);
        if (request is null)
        {
            return;
        }

        string title = application.ActiveUIDocument.Document.Title;
        request.Complete(new ReadTitleResponse(true, title, null));
    }

    public string GetName()
    {
        return "RevitOperator Safe Read Title";
    }
}

internal sealed class ReadTitleRequest
{
    private ReadTitleResponse? _result;

    internal ReadTitleRequest()
    {
        _result = null;
    }

    internal void Complete(ReadTitleResponse response)
    {
        Interlocked.Exchange(ref _result, response);
    }

    internal ReadTitleResponse? TakeResult()
    {
        return Interlocked.Exchange(ref _result, null);
    }
}

internal sealed class ReadTitleResponse
{
    private readonly bool _ok;
    private readonly string? _title;
    private readonly string? _error;

    internal ReadTitleResponse(bool ok, string? title, string? error)
    {
        _ok = ok;
        _title = title;
        _error = error;
    }

    public bool Ok
    {
        get { return _ok; }
    }

    public string? Title
    {
        get { return _title; }
    }

    public string? Error
    {
        get { return _error; }
    }
}
