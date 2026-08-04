using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using RevitBridge.Common;

namespace RevitBridge.Operator
{
    internal sealed class OperatorBackendClient : IOperatorNativeHttpAuthorizer
    {
        private const long MaxAttachmentUploadBytes = 40L * 1024L * 1024L;

        private readonly HttpClient _http;
        private readonly string? _sharedToken;
        private readonly string? _devToken;

        public OperatorBackendClient(Uri baseUri, OperatorAuthSession authSession)
        {
            _http = new HttpClient
            {
                BaseAddress = baseUri,
                Timeout = GetHttpTimeout()
            };

            _sharedToken = OperatorSecurity.GetOrCreateOperatorToken();
            _devToken = OperatorSecurity.GetDevAgentToken();
        }

        private static TimeSpan GetHttpTimeout()
        {
            // Large redline/vision turns can exceed 60s end-to-end.
            // Allow host tuning while keeping a safe default/high cap.
            const int defaultMs = 10 * 60 * 1000; // 10 minutes
            const int minMs = 1_000;
            const int maxMs = 60 * 60 * 1000; // 60 minutes

            var raw = Environment.GetEnvironmentVariable("OPERATOR_BACKEND_HTTP_TIMEOUT_MS");
            if (string.IsNullOrWhiteSpace(raw)) return TimeSpan.FromMilliseconds(defaultMs);
            if (!int.TryParse(raw.Trim(), out var parsed)) return TimeSpan.FromMilliseconds(defaultMs);
            if (parsed < minMs) parsed = minMs;
            if (parsed > maxMs) parsed = maxMs;
            return TimeSpan.FromMilliseconds(parsed);
        }

        private static string? ExtractErrorMessage(string? json)
        {
            var text = json ?? "";
            if (string.IsNullOrWhiteSpace(text)) return null;
            try
            {
                using var doc = JsonDocument.Parse(text);
                if (doc.RootElement.ValueKind != JsonValueKind.Object) return null;
                if (doc.RootElement.TryGetProperty("error", out var e) && e.ValueKind == JsonValueKind.String)
                    return e.GetString();
                if (doc.RootElement.TryGetProperty("message", out var m) && m.ValueKind == JsonValueKind.String)
                    return m.GetString();
            }
            catch
            {
                // ignore parse failures and fall back to raw text
            }

            var trimmed = text.Trim();
            if (trimmed.Length <= 512) return trimmed;
            return trimmed.Substring(0, 512) + "...";
        }

        private static void EnsureSuccessOrThrow(HttpResponseMessage resp, string responseJson, string operation)
        {
            if (resp.IsSuccessStatusCode) return;
            var extracted = ExtractErrorMessage(responseJson);
            if (!string.IsNullOrWhiteSpace(extracted)) throw new Exception(extracted);
            throw new Exception($"{operation} failed ({(int)resp.StatusCode} {resp.ReasonPhrase}).");
        }

        private async Task ApplyAuthHeadersAsync(HttpRequestMessage request, bool forceRefresh, CancellationToken cancellationToken)
        {
            await Task.CompletedTask.ConfigureAwait(false);
            if (!string.IsNullOrWhiteSpace(_sharedToken))
            {
                request.Headers.TryAddWithoutValidation("X-Operator-Token", _sharedToken);
            }

            if (!string.IsNullOrWhiteSpace(_devToken))
                request.Headers.TryAddWithoutValidation("X-Operator-Dev-Agent-Token", _devToken);
        }

        private async Task<HttpResponseMessage> SendWithAuthAsync(
            Func<HttpRequestMessage> requestFactory,
            CancellationToken cancellationToken,
            HttpCompletionOption completionOption = HttpCompletionOption.ResponseContentRead)
        {
            var first = requestFactory();
            await ApplyAuthHeadersAsync(first, forceRefresh: false, cancellationToken).ConfigureAwait(false);
            var response = await _http.SendAsync(first, completionOption, cancellationToken).ConfigureAwait(false);
            first.Dispose();

            if (response.StatusCode != HttpStatusCode.Unauthorized ||
                !OperatorAuthRetryPolicy.ShouldRetryOnUnauthorized(OperatorClientAuthMode.None, attemptNumber: 1))
                return response;

            response.Dispose();

            var retry = requestFactory();
            await ApplyAuthHeadersAsync(retry, forceRefresh: true, cancellationToken).ConfigureAwait(false);
            var retryResponse = await _http.SendAsync(retry, completionOption, cancellationToken).ConfigureAwait(false);
            retry.Dispose();
            return retryResponse;
        }

        public sealed class OperatorAuthStatusResponse
        {
            [JsonPropertyName("ok")]
            public bool Ok { get; set; }

            [JsonPropertyName("ready")]
            public bool Ready { get; set; }

            [JsonPropertyName("required")]
            public bool Required { get; set; }

            [JsonPropertyName("mode")]
            public string Mode { get; set; } = "";

            [JsonPropertyName("has_codex_auth")]
            public bool HasCodexAuth { get; set; }

            [JsonPropertyName("has_openai_api_key")]
            public bool HasOpenAiApiKey { get; set; }

            [JsonPropertyName("reason")]
            public string? Reason { get; set; }

            [JsonPropertyName("message")]
            public string? Message { get; set; }

            [JsonPropertyName("error")]
            public string? Error { get; set; }

            [JsonPropertyName("instructions")]
            public List<string>? Instructions { get; set; }
        }

        public async Task<OperatorAuthStatusResponse> GetAuthStatusAsync(CancellationToken cancellationToken)
        {
            using var resp = await SendWithAuthAsync(
                () => new HttpRequestMessage(HttpMethod.Get, "auth/status"),
                cancellationToken).ConfigureAwait(false);
            var json = await resp.Content.ReadAsStringAsync().ConfigureAwait(false);

            // 428 is expected when setup is required; parse and return it instead of throwing.
            if (!resp.IsSuccessStatusCode && (int)resp.StatusCode != 428)
                EnsureSuccessOrThrow(resp, json, "Backend /auth/status");

            var parsed = JsonSerializer.Deserialize<OperatorAuthStatusResponse>(json, OperatorUiProtocol.JsonOptions)
                ?? new OperatorAuthStatusResponse();
            if (string.IsNullOrWhiteSpace(parsed.Error))
                parsed.Error = ExtractErrorMessage(json);
            return parsed;
        }

        public async Task<string> CreateSessionAsync(CancellationToken cancellationToken)
        {
            using var resp = await SendWithAuthAsync(
                () => new HttpRequestMessage(HttpMethod.Post, "session/new"),
                cancellationToken).ConfigureAwait(false);
            var json = await resp.Content.ReadAsStringAsync().ConfigureAwait(false);
            EnsureSuccessOrThrow(resp, json, "Backend /session/new");

            using var doc = JsonDocument.Parse(json);
            if (!doc.RootElement.TryGetProperty("session_id", out var sid) || sid.ValueKind != JsonValueKind.String)
            {
                throw new Exception("Backend /session/new response missing session_id");
            }

            return sid.GetString()!;
        }

        public async Task<OperatorChatResponse> ChatAsync(string sessionId, string messageId, string userText, CancellationToken cancellationToken)
            => await ChatAsync(sessionId, messageId, userText, context: null, toolResults: null, userAttachments: null, cancellationToken).ConfigureAwait(false);

        public async Task<OperatorChatResponse> ChatAsync(string sessionId, string messageId, string userText, object? context, CancellationToken cancellationToken)
            => await ChatAsync(sessionId, messageId, userText, context, toolResults: null, userAttachments: null, cancellationToken).ConfigureAwait(false);

        public async Task<OperatorChatResponse> ChatAsync(
            string sessionId,
            string messageId,
            string userText,
            object? context,
            List<OperatorToolResult>? toolResults,
            List<OperatorUserAttachment>? userAttachments,
            CancellationToken cancellationToken)
        {
            var payload = new OperatorChatRequest
            {
                Version = OperatorBackendProtocol.Version,
                SessionId = sessionId,
                MessageId = messageId,
                UserText = userText,
                Context = context,
                ToolResults = toolResults,
                UserAttachments = userAttachments
            };

            var body = JsonSerializer.Serialize(payload, OperatorUiProtocol.JsonOptions);
            using var resp = await SendWithAuthAsync(
                () => new HttpRequestMessage(HttpMethod.Post, "chat")
                {
                    Content = new StringContent(body, Encoding.UTF8, "application/json")
                },
                cancellationToken).ConfigureAwait(false);
            var json = await resp.Content.ReadAsStringAsync().ConfigureAwait(false);
            EnsureSuccessOrThrow(resp, json, "Backend /chat");

            var parsed = JsonSerializer.Deserialize<OperatorChatResponse>(json, OperatorUiProtocol.JsonOptions);
            if (parsed == null)
            {
                throw new Exception("Backend /chat response was empty");
            }

            if (!string.Equals(parsed.Version, OperatorBackendProtocol.Version, StringComparison.Ordinal))
            {
                throw new Exception($"Backend contract version mismatch. Expected {OperatorBackendProtocol.Version}, got {parsed.Version}.");
            }

            return parsed;
        }

        public async Task<List<OperatorUserAttachment>> UploadUserAttachmentsAsync(
            List<OperatorUserAttachment>? attachments,
            string sessionId,
            CancellationToken cancellationToken)
        {
            var output = new List<OperatorUserAttachment>();
            if (attachments == null || attachments.Count == 0) return output;

            foreach (var a in attachments)
            {
                cancellationToken.ThrowIfCancellationRequested();
                if (a == null) continue;

                // External references are intentionally passed through as metadata-only pointers.
                if (!string.IsNullOrWhiteSpace(a.ExternalPath) && string.IsNullOrWhiteSpace(a.RelativePath))
                {
                    output.Add(a);
                    continue;
                }

                var rel = (a.RelativePath ?? "").Trim();
                if (string.IsNullOrWhiteSpace(rel))
                {
                    output.Add(a);
                    continue;
                }

                string fullPath;
                try
                {
                    fullPath = WorkspacePaths.ResolveFileUnderWorkspace(rel);
                }
                catch
                {
                    throw new Exception($"Attachment path is outside workspace: {rel}");
                }

                if (!File.Exists(fullPath))
                    throw new Exception($"Attachment file not found in workspace: {rel}");

                var fi = new FileInfo(fullPath);
                if (fi.Length <= 0)
                    throw new Exception($"Attachment is empty: {rel}");
                if (fi.Length > MaxAttachmentUploadBytes)
                    throw new Exception($"Attachment is too large ({fi.Length} bytes). Max {MaxAttachmentUploadBytes} bytes per file.");

                var ext = (Path.GetExtension(fullPath) ?? "").Trim();
                if (string.IsNullOrWhiteSpace(ext))
                    throw new Exception($"Attachment type is not supported: {rel}");

                var fileBytes = File.ReadAllBytes(fullPath);
                var payload = new OperatorAttachmentUploadRequest
                {
                    SessionId = string.IsNullOrWhiteSpace(sessionId) ? null : sessionId.Trim(),
                    Id = string.IsNullOrWhiteSpace(a.Id) ? Guid.NewGuid().ToString("N") : a.Id,
                    RelativePath = rel,
                    Filename = string.IsNullOrWhiteSpace(a.Filename) ? Path.GetFileName(fullPath) : a.Filename,
                    Sha256 = string.IsNullOrWhiteSpace(a.Sha256) ? null : a.Sha256,
                    Mime = string.IsNullOrWhiteSpace(a.Mime) ? GuessMimeFromExtension(ext) : a.Mime,
                    CreatedAt = string.IsNullOrWhiteSpace(a.CreatedAt) ? DateTime.UtcNow.ToString("o") : a.CreatedAt,
                    DataBase64 = Convert.ToBase64String(fileBytes)
                };

                var body = JsonSerializer.Serialize(payload, OperatorUiProtocol.JsonOptions);
                using var resp = await SendWithAuthAsync(
                    () => new HttpRequestMessage(HttpMethod.Post, "attachments/upload")
                    {
                        Content = new StringContent(body, Encoding.UTF8, "application/json")
                    },
                    cancellationToken).ConfigureAwait(false);
                var json = await resp.Content.ReadAsStringAsync().ConfigureAwait(false);
                EnsureSuccessOrThrow(resp, json, "Backend /attachments/upload");

                var parsed = JsonSerializer.Deserialize<OperatorAttachmentUploadResponse>(json, OperatorUiProtocol.JsonOptions);
                if (parsed == null) throw new Exception("Backend /attachments/upload response was empty.");
                if (!parsed.Ok)
                    throw new Exception(string.IsNullOrWhiteSpace(parsed.Error) ? "Attachment upload failed." : parsed.Error!);
                if (parsed.Attachment == null || string.IsNullOrWhiteSpace(parsed.Attachment.RelativePath))
                    throw new Exception("Attachment upload failed: backend did not return attachment path.");

                output.Add(parsed.Attachment);
            }

            return output;
        }

        public sealed class StreamEvent
        {
            public StreamEvent(string eventName, string dataJson)
            {
                EventName = eventName;
                DataJson = dataJson;
            }

            public string EventName { get; }
            public string DataJson { get; }
        }

        public async Task<List<StreamEvent>> ChatStreamAsync(string sessionId, string messageId, string userText, CancellationToken cancellationToken)
            => await ChatStreamAsync(sessionId, messageId, userText, context: null, toolResults: null, userAttachments: null, cancellationToken).ConfigureAwait(false);

        public async Task<List<StreamEvent>> ChatStreamAsync(string sessionId, string messageId, string userText, object? context, CancellationToken cancellationToken)
            => await ChatStreamAsync(sessionId, messageId, userText, context, toolResults: null, userAttachments: null, cancellationToken).ConfigureAwait(false);

        public async Task<List<StreamEvent>> ChatStreamAsync(
            string sessionId,
            string messageId,
            string userText,
            object? context,
            List<OperatorToolResult>? toolResults,
            List<OperatorUserAttachment>? userAttachments,
            CancellationToken cancellationToken)
        {
            var events = new List<StreamEvent>();
            await ChatStreamToCallbacksAsync(
                sessionId,
                messageId,
                userText,
                context,
                toolResults,
                userAttachments,
                onEvent: ev => events.Add(ev),
                cancellationToken).ConfigureAwait(false);
            return events;
        }

        public async Task ChatStreamToCallbacksAsync(
            string sessionId,
            string messageId,
            string userText,
            object? context,
            List<OperatorToolResult>? toolResults,
            List<OperatorUserAttachment>? userAttachments,
            Action<StreamEvent> onEvent,
            CancellationToken cancellationToken)
        {
            var payload = new OperatorChatRequest
            {
                Version = OperatorBackendProtocol.Version,
                SessionId = sessionId,
                MessageId = messageId,
                UserText = userText,
                Context = context,
                ToolResults = toolResults,
                UserAttachments = userAttachments
            };

            var body = JsonSerializer.Serialize(payload, OperatorUiProtocol.JsonOptions);
            using var resp = await SendWithAuthAsync(
                () =>
                {
                    var req = new HttpRequestMessage(HttpMethod.Post, "chat/stream")
                    {
                        Content = new StringContent(body, Encoding.UTF8, "application/json")
                    };
                    req.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("text/event-stream"));
                    return req;
                },
                cancellationToken,
                HttpCompletionOption.ResponseHeadersRead).ConfigureAwait(false);
            if (!resp.IsSuccessStatusCode)
            {
                var errorJson = await resp.Content.ReadAsStringAsync().ConfigureAwait(false);
                EnsureSuccessOrThrow(resp, errorJson, "Backend /chat/stream");
            }

            using var stream = await resp.Content.ReadAsStreamAsync().ConfigureAwait(false);
            using var reader = new StreamReader(stream, Encoding.UTF8);

            string? line;
            string eventName = "message";
            var dataLines = new List<string>();

            while ((line = await reader.ReadLineAsync().ConfigureAwait(false)) != null)
            {
                cancellationToken.ThrowIfCancellationRequested();

                if (line.Length == 0)
                {
                    if (dataLines.Count > 0)
                    {
                        var dataJson = string.Join("\n", dataLines);
                        onEvent?.Invoke(new StreamEvent(eventName, dataJson));
                        dataLines.Clear();
                        eventName = "message";
                    }
                    continue;
                }

                if (line.StartsWith("event:", StringComparison.OrdinalIgnoreCase))
                {
                    eventName = line.Substring("event:".Length).Trim();
                    continue;
                }

                if (line.StartsWith("data:", StringComparison.OrdinalIgnoreCase))
                {
                    dataLines.Add(line.Substring("data:".Length).Trim());
                    continue;
                }
            }

            // Flush any trailing event without a final blank line.
            if (dataLines.Count > 0)
            {
                var dataJson = string.Join("\n", dataLines);
                onEvent?.Invoke(new StreamEvent(eventName, dataJson));
            }
        }

        private static string? GuessMimeFromExtension(string ext)
        {
            var e = (ext ?? "").Trim().ToLowerInvariant();
            if (e == ".pdf") return "application/pdf";
            if (e == ".docx") return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
            if (e == ".xlsx") return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
            if (e == ".xls") return "application/vnd.ms-excel";
            if (e == ".txt") return "text/plain";
            if (e == ".csv") return "text/csv";
            if (e == ".jpg" || e == ".jpeg") return "image/jpeg";
            if (e == ".png") return "image/png";
            if (e == ".json") return "application/json";
            return null;
        }

        public async Task<string> GetRevitBatchTemplatesJsonAsync(CancellationToken cancellationToken)
        {
            using var resp = await SendWithAuthAsync(
                () => new HttpRequestMessage(HttpMethod.Get, "api/revit-batch/templates"),
                cancellationToken).ConfigureAwait(false);
            var json = await resp.Content.ReadAsStringAsync().ConfigureAwait(false);
            EnsureSuccessOrThrow(resp, json, "Backend /api/revit-batch/templates");
            return json ?? "";
        }

        public async Task<string> PlanDelegatedRevitBatchJsonAsync(object payload, CancellationToken cancellationToken)
        {
            var body = JsonSerializer.Serialize(payload ?? new object(), OperatorUiProtocol.JsonOptions);
            using var resp = await SendWithAuthAsync(
                () => new HttpRequestMessage(HttpMethod.Post, "api/revit-batch/plan-delegated")
                {
                    Content = new StringContent(body, Encoding.UTF8, "application/json")
                },
                cancellationToken).ConfigureAwait(false);
            var json = await resp.Content.ReadAsStringAsync().ConfigureAwait(false);
            EnsureSuccessOrThrow(resp, json, "Backend /api/revit-batch/plan-delegated");
            return json ?? "";
        }

        public async Task<string> ListRevitBatchJobsJsonAsync(int limit, OperatorRevitBatchBinding binding, CancellationToken cancellationToken)
        {
            if (limit < 1) limit = 1;
            if (limit > 50) limit = 50;
            using var resp = await SendWithAuthAsync(
                () => new HttpRequestMessage(HttpMethod.Get, $"api/revit-batch/jobs?limit={limit}&{BatchBindingQuery(binding)}"),
                cancellationToken).ConfigureAwait(false);
            var json = await resp.Content.ReadAsStringAsync().ConfigureAwait(false);
            EnsureSuccessOrThrow(resp, json, "Backend /api/revit-batch/jobs");
            return json ?? "";
        }

        public async Task<string> CreateRevitBatchJobJsonAsync(object payload, OperatorRevitBatchBinding binding, CancellationToken cancellationToken)
        {
            var body = SerializeBatchBoundPayload(payload, binding);
            using var resp = await SendWithAuthAsync(
                () => new HttpRequestMessage(HttpMethod.Post, "api/revit-batch/jobs")
                {
                    Content = new StringContent(body, Encoding.UTF8, "application/json")
                },
                cancellationToken).ConfigureAwait(false);
            var json = await resp.Content.ReadAsStringAsync().ConfigureAwait(false);
            EnsureSuccessOrThrow(resp, json, "Backend /api/revit-batch/jobs");
            return json ?? "";
        }

        public async Task<string> GetRevitBatchJobJsonAsync(string jobId, OperatorRevitBatchBinding binding, CancellationToken cancellationToken)
        {
            if (string.IsNullOrWhiteSpace(jobId)) throw new ArgumentException("jobId is required.");
            using var resp = await SendWithAuthAsync(
                () => new HttpRequestMessage(HttpMethod.Get, $"api/revit-batch/jobs/{Uri.EscapeDataString(jobId)}?{BatchBindingQuery(binding)}"),
                cancellationToken).ConfigureAwait(false);
            var json = await resp.Content.ReadAsStringAsync().ConfigureAwait(false);
            EnsureSuccessOrThrow(resp, json, "Backend /api/revit-batch/jobs/:id");
            return json ?? "";
        }

        public async Task<string> ControlRevitBatchJobJsonAsync(string jobId, string operation, OperatorRevitBatchBinding binding, CancellationToken cancellationToken)
        {
            if (string.IsNullOrWhiteSpace(jobId)) throw new ArgumentException("jobId is required.");
            var normalized = (operation ?? "").Trim().ToLowerInvariant();
            if (normalized != "approve" && normalized != "pause" && normalized != "resume" && normalized != "cancel" && normalized != "retry-failed")
                throw new ArgumentException("operation must be approve|pause|resume|cancel|retry-failed");

            var body = SerializeBatchBoundPayload(new object(), binding);
            using var resp = await SendWithAuthAsync(
                () => new HttpRequestMessage(HttpMethod.Post, $"api/revit-batch/jobs/{Uri.EscapeDataString(jobId)}/{normalized}")
                {
                    Content = new StringContent(body, Encoding.UTF8, "application/json")
                },
                cancellationToken).ConfigureAwait(false);
            var json = await resp.Content.ReadAsStringAsync().ConfigureAwait(false);
            EnsureSuccessOrThrow(resp, json, "Backend /api/revit-batch/jobs/:id/control");
            return json ?? "";
        }

        public async Task<string> ClaimNextRevitBatchItemJsonAsync(OperatorRevitBatchBinding binding, string executorKind, string? jobId, CancellationToken cancellationToken)
        {
            if (binding == null) throw new ArgumentNullException(nameof(binding));
            var payload = new Dictionary<string, object?>(binding.ToWireValues(), StringComparer.OrdinalIgnoreCase)
            {
                ["executor_id"] = binding.TargetExecutorId,
                ["executor_kind"] = string.IsNullOrWhiteSpace(executorKind) ? "revit_delegate" : executorKind
            };
            if (!string.IsNullOrWhiteSpace(jobId)) payload["job_id"] = jobId;

            var body = JsonSerializer.Serialize(payload, OperatorUiProtocol.JsonOptions);
            using var resp = await SendWithAuthAsync(
                () => new HttpRequestMessage(HttpMethod.Post, "api/revit-batch/claim-next")
                {
                    Content = new StringContent(body, Encoding.UTF8, "application/json")
                },
                cancellationToken).ConfigureAwait(false);
            var json = await resp.Content.ReadAsStringAsync().ConfigureAwait(false);
            EnsureSuccessOrThrow(resp, json, "Backend /api/revit-batch/claim-next");
            return json ?? "";
        }

        public async Task<string> ClaimNextRevitCourierJobJsonAsync(string? sessionId, string executorId, CancellationToken cancellationToken)
        {
            if (string.IsNullOrWhiteSpace(executorId)) throw new ArgumentException("executorId is required.");
            var body = JsonSerializer.Serialize(new
            {
                session_id = string.IsNullOrWhiteSpace(sessionId) ? null : sessionId,
                executor_id = executorId,
                wait_ms = 10000
            }, OperatorUiProtocol.JsonOptions);
            using var resp = await SendWithAuthAsync(
                () => new HttpRequestMessage(HttpMethod.Post, "api/revit-courier/claim-next")
                {
                    Content = new StringContent(body, Encoding.UTF8, "application/json")
                },
                cancellationToken).ConfigureAwait(false);
            var json = await resp.Content.ReadAsStringAsync().ConfigureAwait(false);
            EnsureSuccessOrThrow(resp, json, "Backend /api/revit-courier/claim-next");
            return json ?? "";
        }

        /// <summary>
        /// Obtains one short-lived, request-bound native HTTP admission receipt
        /// from the fixed backend endpoint. The caller supplies only the exact
        /// request identity; channel, policy, evidence, and effect bindings are
        /// always selected by the backend's current trusted policy.
        /// </summary>
        public async Task<OperatorNativeHttpAuthorizationReceipt> AuthorizeAsync(
            OperatorNativeHttpRequest request,
            CancellationToken cancellationToken)
        {
            if (request == null) throw new ArgumentNullException(nameof(request));
            var body = JsonSerializer.Serialize(new
            {
                schema = "revit-operator.revit-direct-admission-request.v1",
                request_id = request.RequestId,
                method = request.Method,
                path = request.Path,
                body_present = request.BodyPresent,
                body_json = request.BodyJson,
                channel = request.Channel,
                alias = request.Alias
            }, OperatorUiProtocol.JsonOptions);

            using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            deadline.CancelAfter(TimeSpan.FromSeconds(3));
            var roundTrip = Stopwatch.StartNew();
            try
            {
                using var resp = await SendWithAuthAsync(
                    () => new HttpRequestMessage(HttpMethod.Post, "api/revit-direct/authorize-execution")
                    {
                        Content = new StringContent(body, Encoding.UTF8, "application/json")
                    },
                    deadline.Token,
                    HttpCompletionOption.ResponseHeadersRead).ConfigureAwait(false);
                var responseByteLimit = resp.IsSuccessStatusCode
                    ? OperatorNativeHttpAuthorizationVerifier.MaximumSuccessResponseUtf8Bytes
                    : OperatorNativeHttpAuthorizationVerifier.MaximumFailureResponseUtf8Bytes;
                OperatorNativeHttpBoundedResponseReader.EnsureContentLengthWithinLimit(
                    resp.Content.Headers.ContentLength,
                    responseByteLimit);
                using var responseStream = await resp.Content.ReadAsStreamAsync().ConfigureAwait(false);
                var responseBytes = await OperatorNativeHttpBoundedResponseReader.ReadAsync(
                    responseStream,
                    responseByteLimit,
                    deadline.Token).ConfigureAwait(false);
                if (!resp.IsSuccessStatusCode)
                {
                    if (resp.StatusCode == HttpStatusCode.Unauthorized)
                    {
                        throw new OperatorNativeHttpAdmissionException(
                            "CERTIFICATION_DIRECT_BACKEND_AUTH_REJECTED",
                            "Native Revit authorization backend rejected its configured authentication.",
                            503,
                            false,
                            "unavailable",
                            true);
                    }
                    throw OperatorNativeHttpAuthorizationVerifier.ParseFailure((int)resp.StatusCode, responseBytes);
                }
                return OperatorNativeHttpAuthorizationVerifier.VerifySuccess(
                    responseBytes,
                    request,
                    Environment.GetEnvironmentVariable("REVIT_OPERATOR_MODE"),
                    DateTimeOffset.UtcNow,
                    roundTrip.Elapsed);
            }
            catch (OperatorNativeHttpAdmissionException)
            {
                throw;
            }
            catch (OperationCanceledException)
            {
                throw OperatorNativeHttpAdmissionException.Unavailable(
                    "Native Revit authorization did not complete before its bounded pre-dispatch deadline.");
            }
            catch (HttpRequestException)
            {
                throw OperatorNativeHttpAdmissionException.Unavailable(
                    "Native Revit authorization backend is unavailable.");
            }
            catch (Exception error)
            {
                throw OperatorNativeHttpAdmissionException.Protocol(
                    "CERTIFICATION_DIRECT_AUTHORIZATION_FAILED",
                    "Native Revit authorization failed before dispatch: " + error.Message);
            }
        }

        /// <summary>
        /// Requests a fresh final-execution receipt for an already claimed v2
        /// courier job. The URL, authentication, and request shape are fixed;
        /// no job-provided endpoint, key, policy location, or digest is ever
        /// used to authorize a workstation action.
        /// </summary>
        public async Task<string> AuthorizeRevitCourierExecutionJsonAsync(
            string sessionId,
            string jobId,
            string executorId,
            CancellationToken cancellationToken)
        {
            if (string.IsNullOrWhiteSpace(sessionId)) throw new ArgumentException("sessionId is required.");
            if (string.IsNullOrWhiteSpace(jobId)) throw new ArgumentException("jobId is required.");
            if (string.IsNullOrWhiteSpace(executorId)) throw new ArgumentException("executorId is required.");
            var body = JsonSerializer.Serialize(new { session_id = sessionId, executor_id = executorId }, OperatorUiProtocol.JsonOptions);
            using var resp = await SendWithAuthAsync(
                () => new HttpRequestMessage(HttpMethod.Post, $"api/revit-courier/jobs/{Uri.EscapeDataString(jobId)}/authorize-execution")
                {
                    Content = new StringContent(body, Encoding.UTF8, "application/json")
                },
                cancellationToken).ConfigureAwait(false);
            var json = await resp.Content.ReadAsStringAsync().ConfigureAwait(false);
            EnsureSuccessOrThrow(resp, json, "Backend /api/revit-courier/jobs/:id/authorize-execution");
            return json ?? "";
        }

        public async Task<string> CompleteRevitCourierJobJsonAsync(string sessionId, string jobId, string executorId, object? result, CancellationToken cancellationToken)
        {
            if (string.IsNullOrWhiteSpace(sessionId)) throw new ArgumentException("sessionId is required.");
            if (string.IsNullOrWhiteSpace(jobId)) throw new ArgumentException("jobId is required.");
            if (string.IsNullOrWhiteSpace(executorId)) throw new ArgumentException("executorId is required.");
            var body = JsonSerializer.Serialize(new { session_id = sessionId, executor_id = executorId, result }, OperatorUiProtocol.JsonOptions);
            using var resp = await SendWithAuthAsync(
                () => new HttpRequestMessage(HttpMethod.Post, $"api/revit-courier/jobs/{Uri.EscapeDataString(jobId)}/complete")
                {
                    Content = new StringContent(body, Encoding.UTF8, "application/json")
                },
                cancellationToken).ConfigureAwait(false);
            var json = await resp.Content.ReadAsStringAsync().ConfigureAwait(false);
            var error = ExtractErrorMessage(json);
            if (!resp.IsSuccessStatusCode && string.Equals(
                    error,
                    "Revit courier job is already terminally failed; refusing a contradictory completion.",
                    StringComparison.Ordinal))
            {
                throw new OperatorCourierTerminalConflictException(error!);
            }
            EnsureSuccessOrThrow(resp, json, "Backend /api/revit-courier/jobs/:id/complete");
            return json ?? "";
        }

        public async Task<string> FailRevitCourierJobJsonAsync(string sessionId, string jobId, string executorId, string error, object? result, bool retryable, CancellationToken cancellationToken)
        {
            if (string.IsNullOrWhiteSpace(sessionId)) throw new ArgumentException("sessionId is required.");
            if (string.IsNullOrWhiteSpace(jobId)) throw new ArgumentException("jobId is required.");
            if (string.IsNullOrWhiteSpace(executorId)) throw new ArgumentException("executorId is required.");
            var body = JsonSerializer.Serialize(new
            {
                session_id = sessionId,
                executor_id = executorId,
                error = string.IsNullOrWhiteSpace(error) ? "Revit courier execution failed." : error,
                result,
                retryable
            }, OperatorUiProtocol.JsonOptions);
            using var resp = await SendWithAuthAsync(
                () => new HttpRequestMessage(HttpMethod.Post, $"api/revit-courier/jobs/{Uri.EscapeDataString(jobId)}/fail")
                {
                    Content = new StringContent(body, Encoding.UTF8, "application/json")
                },
                cancellationToken).ConfigureAwait(false);
            var json = await resp.Content.ReadAsStringAsync().ConfigureAwait(false);
            EnsureSuccessOrThrow(resp, json, "Backend /api/revit-courier/jobs/:id/fail");
            return json ?? "";
        }

        public async Task<string> CompleteRevitBatchItemJsonAsync(string jobId, string itemId, OperatorRevitBatchBinding binding, string claimToken, object? result, CancellationToken cancellationToken)
        {
            if (string.IsNullOrWhiteSpace(jobId)) throw new ArgumentException("jobId is required.");
            if (string.IsNullOrWhiteSpace(itemId)) throw new ArgumentException("itemId is required.");
            if (binding == null) throw new ArgumentNullException(nameof(binding));
            if (string.IsNullOrWhiteSpace(claimToken)) throw new ArgumentException("claimToken is required.");

            var body = SerializeBatchBoundPayload(new
            {
                executor_id = binding.TargetExecutorId,
                claim_token = claimToken,
                result = result
            }, binding);
            using var resp = await SendWithAuthAsync(
                () => new HttpRequestMessage(HttpMethod.Post, $"api/revit-batch/jobs/{Uri.EscapeDataString(jobId)}/items/{Uri.EscapeDataString(itemId)}/complete")
                {
                    Content = new StringContent(body, Encoding.UTF8, "application/json")
                },
                cancellationToken).ConfigureAwait(false);
            var json = await resp.Content.ReadAsStringAsync().ConfigureAwait(false);
            EnsureSuccessOrThrow(resp, json, "Backend /api/revit-batch/jobs/:id/items/:id/complete");
            return json ?? "";
        }

        public async Task<string> FailRevitBatchItemJsonAsync(string jobId, string itemId, OperatorRevitBatchBinding binding, string claimToken, string error, object? result, CancellationToken cancellationToken)
        {
            if (string.IsNullOrWhiteSpace(jobId)) throw new ArgumentException("jobId is required.");
            if (string.IsNullOrWhiteSpace(itemId)) throw new ArgumentException("itemId is required.");
            if (binding == null) throw new ArgumentNullException(nameof(binding));
            if (string.IsNullOrWhiteSpace(claimToken)) throw new ArgumentException("claimToken is required.");

            var body = SerializeBatchBoundPayload(new
            {
                executor_id = binding.TargetExecutorId,
                claim_token = claimToken,
                error = string.IsNullOrWhiteSpace(error) ? "Batch item failed." : error,
                result = result
            }, binding);
            using var resp = await SendWithAuthAsync(
                () => new HttpRequestMessage(HttpMethod.Post, $"api/revit-batch/jobs/{Uri.EscapeDataString(jobId)}/items/{Uri.EscapeDataString(itemId)}/fail")
                {
                    Content = new StringContent(body, Encoding.UTF8, "application/json")
                },
                cancellationToken).ConfigureAwait(false);
            var json = await resp.Content.ReadAsStringAsync().ConfigureAwait(false);
            EnsureSuccessOrThrow(resp, json, "Backend /api/revit-batch/jobs/:id/items/:id/fail");
            return json ?? "";
        }

        private static string SerializeBatchBoundPayload(object? payload, OperatorRevitBatchBinding binding)
        {
            if (binding == null) throw new ArgumentNullException(nameof(binding));
            var json = JsonSerializer.Serialize(payload ?? new object(), OperatorUiProtocol.JsonOptions);
            var root = JsonNode.Parse(json) as JsonObject ?? new JsonObject();
            foreach (var pair in binding.ToWireValues())
                root[pair.Key] = JsonSerializer.SerializeToNode(pair.Value, OperatorUiProtocol.JsonOptions);
            return root.ToJsonString(OperatorUiProtocol.JsonOptions);
        }

        private static string BatchBindingQuery(OperatorRevitBatchBinding binding)
        {
            if (binding == null) throw new ArgumentNullException(nameof(binding));
            return "session_id=" + Uri.EscapeDataString(binding.SessionId) +
                   "&target_executor_id=" + Uri.EscapeDataString(binding.TargetExecutorId) +
                   "&project_fingerprint=" + Uri.EscapeDataString(binding.ProjectFingerprint);
        }

        public async Task<string> VoiceTranscribeAsync(string audioBase64, string format, CancellationToken cancellationToken)
        {
            if (string.IsNullOrWhiteSpace(audioBase64)) throw new ArgumentException("audioBase64 is required.");
            format = (format ?? "").Trim().ToLowerInvariant();
            if (format != "wav" && format != "mp3") throw new ArgumentException("format must be 'wav' or 'mp3'.");

            var payload = new
            {
                audio_base64 = audioBase64,
                format = format
            };

            var body = JsonSerializer.Serialize(payload, OperatorUiProtocol.JsonOptions);
            using var resp = await SendWithAuthAsync(
                () => new HttpRequestMessage(HttpMethod.Post, "voice/transcribe")
                {
                    Content = new StringContent(body, Encoding.UTF8, "application/json")
                },
                cancellationToken).ConfigureAwait(false);
            var json = await resp.Content.ReadAsStringAsync().ConfigureAwait(false);
            EnsureSuccessOrThrow(resp, json, "Backend /voice/transcribe");

            using var doc = JsonDocument.Parse(json);
            if (!doc.RootElement.TryGetProperty("text", out var t) || t.ValueKind != JsonValueKind.String)
            {
                throw new Exception("Backend /voice/transcribe response missing text.");
            }

            return t.GetString() ?? "";
        }

        public sealed class VoiceSpeakResponse
        {
            [JsonPropertyName("audio_base64")]
            public string? AudioBase64 { get; set; }

            [JsonPropertyName("format")]
            public string? Format { get; set; }

            [JsonPropertyName("model")]
            public string? Model { get; set; }

            [JsonPropertyName("voice")]
            public string? Voice { get; set; }

            [JsonPropertyName("error")]
            public string? Error { get; set; }
        }

        public async Task<VoiceSpeakResponse> VoiceSpeakAsync(string text, string? format, string? voice, CancellationToken cancellationToken)
        {
            if (string.IsNullOrWhiteSpace(text)) throw new ArgumentException("text is required.");
            format = (format ?? "mp3").Trim().ToLowerInvariant();
            if (format != "mp3" && format != "wav" && format != "opus" && format != "aac" && format != "flac" && format != "pcm")
                throw new ArgumentException("format must be one of: mp3|opus|aac|flac|wav|pcm");

            var payload = new
            {
                text = text,
                format = format,
                voice = string.IsNullOrWhiteSpace(voice) ? null : voice
            };

            var body = JsonSerializer.Serialize(payload, OperatorUiProtocol.JsonOptions);
            using var resp = await SendWithAuthAsync(
                () => new HttpRequestMessage(HttpMethod.Post, "voice/speak")
                {
                    Content = new StringContent(body, Encoding.UTF8, "application/json")
                },
                cancellationToken).ConfigureAwait(false);
            var json = await resp.Content.ReadAsStringAsync().ConfigureAwait(false);
            EnsureSuccessOrThrow(resp, json, "Backend /voice/speak");

            var parsed = JsonSerializer.Deserialize<VoiceSpeakResponse>(json, OperatorUiProtocol.JsonOptions);
            if (parsed == null) throw new Exception("Backend /voice/speak response was empty.");
            return parsed;
        }

        public async Task NotifyLoopStopAsync(string sessionId, string messageId, string stopReason, CancellationToken cancellationToken)
        {
            if (string.IsNullOrWhiteSpace(sessionId)) throw new ArgumentException("sessionId is required.");
            if (string.IsNullOrWhiteSpace(messageId)) throw new ArgumentException("messageId is required.");
            if (string.IsNullOrWhiteSpace(stopReason)) throw new ArgumentException("stopReason is required.");

            var payload = new
            {
                session_id = sessionId,
                message_id = messageId,
                stop_reason = stopReason
            };
            var body = JsonSerializer.Serialize(payload, OperatorUiProtocol.JsonOptions);
            using var resp = await SendWithAuthAsync(
                () => new HttpRequestMessage(HttpMethod.Post, "loop/stop")
                {
                    Content = new StringContent(body, Encoding.UTF8, "application/json")
                },
                cancellationToken).ConfigureAwait(false);
            var json = await resp.Content.ReadAsStringAsync().ConfigureAwait(false);
            EnsureSuccessOrThrow(resp, json, "Backend /loop/stop");
        }

        public async Task PostEventAsync(string sessionId, string type, object? payload, CancellationToken cancellationToken)
        {
            if (string.IsNullOrWhiteSpace(sessionId)) throw new ArgumentException("sessionId is required.");
            if (string.IsNullOrWhiteSpace(type)) throw new ArgumentException("type is required.");

            var bodyObj = new
            {
                session_id = sessionId,
                type = type,
                ts = DateTime.UtcNow.ToString("o"),
                payload = payload
            };

            var body = JsonSerializer.Serialize(bodyObj, OperatorUiProtocol.JsonOptions);
            using var resp = await SendWithAuthAsync(
                () => new HttpRequestMessage(HttpMethod.Post, "event")
                {
                    Content = new StringContent(body, Encoding.UTF8, "application/json")
                },
                cancellationToken).ConfigureAwait(false);
            var json = await resp.Content.ReadAsStringAsync().ConfigureAwait(false);
            EnsureSuccessOrThrow(resp, json, "Backend /event");
        }

        public async Task<string> PostFeedbackAsync(
            string sessionId,
            string chatId,
            string rating,
            string? note,
            bool rememberPreference,
            bool queueUpload,
            bool devApplyRepoChanges,
            CancellationToken cancellationToken)
        {
            if (string.IsNullOrWhiteSpace(sessionId)) throw new ArgumentException("sessionId is required.");
            if (string.IsNullOrWhiteSpace(rating)) throw new ArgumentException("rating is required.");

            var payload = new
            {
                session_id = sessionId,
                chat_id = string.IsNullOrWhiteSpace(chatId) ? null : chatId,
                rating = rating,
                note = string.IsNullOrWhiteSpace(note) ? null : note,
                remember_preference = rememberPreference,
                queue_upload = queueUpload,
                dev_apply_repo_changes = devApplyRepoChanges
            };

            var body = JsonSerializer.Serialize(payload, OperatorUiProtocol.JsonOptions);
            using var resp = await SendWithAuthAsync(
                () => new HttpRequestMessage(HttpMethod.Post, "feedback")
                {
                    Content = new StringContent(body, Encoding.UTF8, "application/json")
                },
                cancellationToken).ConfigureAwait(false);
            var json = await resp.Content.ReadAsStringAsync().ConfigureAwait(false);
            EnsureSuccessOrThrow(resp, json, "Backend /feedback");
            return json ?? "";
        }

        public async Task<string> GetCloudUploadConfigAsync(CancellationToken cancellationToken)
        {
            using var resp = await SendWithAuthAsync(
                () => new HttpRequestMessage(HttpMethod.Get, "config/cloud-upload"),
                cancellationToken).ConfigureAwait(false);
            var json = await resp.Content.ReadAsStringAsync().ConfigureAwait(false);
            EnsureSuccessOrThrow(resp, json, "Backend /config/cloud-upload");
            return json ?? "";
        }

        public async Task<string> PostCloudUploadConfigAsync(
            string? uploadUrl,
            string? mode,
            bool uploadTokenProvided,
            string? uploadToken,
            CancellationToken cancellationToken)
        {
            var payload = new Dictionary<string, object?>();
            if (uploadUrl != null) payload["upload_url"] = string.IsNullOrWhiteSpace(uploadUrl) ? "" : uploadUrl;
            if (mode != null) payload["mode"] = string.IsNullOrWhiteSpace(mode) ? "off" : mode;
            if (uploadTokenProvided) payload["upload_token"] = uploadToken; // null clears token; string sets token

            var body = JsonSerializer.Serialize(payload, OperatorUiProtocol.JsonOptions);
            using var resp = await SendWithAuthAsync(
                () => new HttpRequestMessage(HttpMethod.Post, "config/cloud-upload")
                {
                    Content = new StringContent(body, Encoding.UTF8, "application/json")
                },
                cancellationToken).ConfigureAwait(false);
            var json = await resp.Content.ReadAsStringAsync().ConfigureAwait(false);
            EnsureSuccessOrThrow(resp, json, "Backend /config/cloud-upload");
            return json ?? "";
        }

        public sealed class OperatorNotification
        {
            [JsonPropertyName("id")]
            public long Id { get; set; }

            [JsonPropertyName("ts")]
            public string Ts { get; set; } = "";

            [JsonPropertyName("type")]
            public string Type { get; set; } = "";

            [JsonPropertyName("text")]
            public string Text { get; set; } = "";

            [JsonPropertyName("payload")]
            public JsonElement Payload { get; set; }
        }

        public sealed class OperatorNotificationsResponse
        {
            [JsonPropertyName("notifications")]
            public List<OperatorNotification> Notifications { get; set; } = new List<OperatorNotification>();

            [JsonPropertyName("next_after_id")]
            public long NextAfterId { get; set; }
        }

        public async Task<OperatorNotificationsResponse> GetNotificationsAsync(string sessionId, long afterId, CancellationToken cancellationToken)
        {
            if (string.IsNullOrWhiteSpace(sessionId)) throw new ArgumentException("sessionId is required.");
            if (afterId < 0) afterId = 0;

            var path = $"notifications?session_id={Uri.EscapeDataString(sessionId)}&after_id={afterId}";
            using var resp = await SendWithAuthAsync(
                () => new HttpRequestMessage(HttpMethod.Get, path),
                cancellationToken).ConfigureAwait(false);
            var json = await resp.Content.ReadAsStringAsync().ConfigureAwait(false);
            EnsureSuccessOrThrow(resp, json, "Backend /notifications");

            var parsed = JsonSerializer.Deserialize<OperatorNotificationsResponse>(json, OperatorUiProtocol.JsonOptions);
            return parsed ?? new OperatorNotificationsResponse { NextAfterId = afterId };
        }
    }

    internal sealed class OperatorCourierTerminalConflictException : InvalidOperationException
    {
        public OperatorCourierTerminalConflictException(string message) : base(message) { }
    }
}
