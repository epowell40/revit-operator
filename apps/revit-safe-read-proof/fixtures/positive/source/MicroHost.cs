using System;
using System.Net;
using System.Text.Json;
using System.Threading;
using Autodesk.Revit.UI;

namespace RevitSafeReadFixture;

internal sealed class SafeReadHost
{
    private readonly HttpListener _listener;
    private readonly ReadTitleHandler _handler;
    private readonly ExternalEvent _externalEvent;

    internal SafeReadHost()
    {
        _listener = new HttpListener();
        _listener.Prefixes.Add("http://127.0.0.1:47831/");
        _handler = new ReadTitleHandler();
        _externalEvent = ExternalEvent.Create(_handler);
    }

    internal void Start()
    {
        _listener.Start();
    }

    internal void Stop()
    {
        _listener.Stop();
    }

    internal void ProcessOne()
    {
        HttpListenerContext context = _listener.GetContext();
        Uri? requestUri = context.Request.Url;
        if (requestUri is null || requestUri.AbsolutePath != "/v1/read-title")
        {
            WriteResponse(context.Response, 404, new ReadTitleResponse(false, null, "not_found"));
            return;
        }

        if (!_handler.TryPrepare(context))
        {
            WriteResponse(context.Response, 409, new ReadTitleResponse(false, null, "busy"));
            return;
        }

        _externalEvent.Raise();
    }

    internal static void WriteResponse(HttpListenerResponse response, int statusCode, ReadTitleResponse payload)
    {
        byte[] content = JsonSerializer.SerializeToUtf8Bytes(payload);
        response.StatusCode = statusCode;
        response.ContentType = "application/json; charset=utf-8";
        response.ContentLength64 = content.LongLength;
        response.Close(content, false);
    }
}

internal sealed class ReadTitleHandler : IExternalEventHandler
{
    private HttpListenerContext? _pending;

    internal ReadTitleHandler()
    {
        _pending = null;
    }

    internal bool TryPrepare(HttpListenerContext context)
    {
        HttpListenerContext? prior = Interlocked.CompareExchange(ref _pending, context, null);
        return prior is null;
    }

    public void Execute(UIApplication application)
    {
        HttpListenerContext? context = Interlocked.Exchange(ref _pending, null);
        if (context is null)
        {
            return;
        }

        string title = application.ActiveUIDocument.Document.Title;
        ReadTitleResponse response = new ReadTitleResponse(true, title, null);
        SafeReadHost.WriteResponse(context.Response, 200, response);
    }

    public string GetName()
    {
        return "RevitOperator Safe Read Title";
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
        get
        {
            return _ok;
        }
    }

    public string? Title
    {
        get
        {
            return _title;
        }
    }

    public string? Error
    {
        get
        {
            return _error;
        }
    }
}
