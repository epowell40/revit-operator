using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using System.Text.Json.Serialization;
using RevitBridge.Common;

namespace RevitBridge.Operator
{
    public static class OperatorBackendProtocol
    {
        public const string Version = "operator.backend.v1";
    }

    public sealed class OperatorActionCall
    {
        [JsonPropertyName("action_id")]
        public string ActionId { get; set; } = "";

        [JsonPropertyName("correlation_id")]
        public string CorrelationId { get; set; } = "";

        [JsonPropertyName("method")]
        public string Method { get; set; } = "";

        [JsonPropertyName("path")]
        public string Path { get; set; } = "";

        [JsonPropertyName("body")]
        public object? Body { get; set; }

        [JsonIgnore]
        public string ExpectedDocumentTitle { get; set; } = "";

        [JsonIgnore]
        public string ExpectedDocumentPath { get; set; } = "";

        // Courier v2 metadata is runtime-only. It is never accepted from a
        // sidecar/chat payload and is attached only after the fixed backend
        // final-execution authorization endpoint binds it to a verified claim.
        [JsonIgnore]
        public OperatorCourierFinalExecutionAuthorization? CourierFinalExecutionAuthorization { get; internal set; }

        [JsonIgnore]
        public DateTimeOffset? CourierJobExpiresAtUtc { get; internal set; }

        // These fields are populated only by the local courier worker after a
        // v2 claim and prequeue receipt both verify. JsonIgnore is deliberate:
        // neither a sidecar payload nor a persisted action may inject a final
        // authorization refresh path, original claim, or executor identity.
        [JsonIgnore]
        public OperatorCourierCertificationEnvelopeValidationResult? CourierVerifiedClaim { get; internal set; }

        [JsonIgnore]
        public string? CourierLocalExecutorId { get; internal set; }

        [JsonIgnore]
        public Func<CancellationToken, Task<OperatorCourierFinalExecutionAuthorization>>? CourierFinalExecutionRefreshAsync { get; internal set; }

        // Evidence-only courier metadata is parsed from the immutable claimed
        // job by the local worker. JsonIgnore prevents any chat/action payload
        // from manufacturing this authority.
        [JsonIgnore]
        public OperatorLaboratoryEvidenceDispatch? LaboratoryEvidenceDispatch { get; internal set; }

        [JsonIgnore]
        public OperatorLaboratoryMoveEvidenceAdmission? LaboratoryMoveEvidenceAdmission { get; internal set; }
    }

    public sealed class OperatorChatRequest
    {
        [JsonPropertyName("version")]
        public string Version { get; set; } = OperatorBackendProtocol.Version;

        [JsonPropertyName("session_id")]
        public string SessionId { get; set; } = "";

        [JsonPropertyName("message_id")]
        public string MessageId { get; set; } = "";

        [JsonPropertyName("user_text")]
        public string? UserText { get; set; }

        [JsonPropertyName("context")]
        public object? Context { get; set; }

        [JsonPropertyName("tool_results")]
        public List<OperatorToolResult>? ToolResults { get; set; }

        [JsonPropertyName("user_attachments")]
        public List<OperatorUserAttachment>? UserAttachments { get; set; }
    }

    public sealed class OperatorChatResponse
    {
        [JsonPropertyName("version")]
        public string Version { get; set; } = "";

        [JsonPropertyName("assistant_message")]
        public string AssistantMessage { get; set; } = "";

        [JsonPropertyName("actions")]
        public List<OperatorActionCall> Actions { get; set; } = new List<OperatorActionCall>();
    }

    public sealed class OperatorToolAttachment
    {
        [JsonPropertyName("kind")]
        public string Kind { get; set; } = "";

        [JsonPropertyName("mime")]
        public string Mime { get; set; } = "";

        [JsonPropertyName("filename")]
        public string? Filename { get; set; }

        [JsonPropertyName("data_base64")]
        public string? DataBase64 { get; set; }

        [JsonPropertyName("local_path")]
        public string? LocalPath { get; set; }
    }

    public sealed class OperatorToolResult
    {
        [JsonPropertyName("action_id")]
        public string ActionId { get; set; } = "";

        [JsonPropertyName("method")]
        public string Method { get; set; } = "";

        [JsonPropertyName("path")]
        public string Path { get; set; } = "";

        [JsonPropertyName("request_effect")]
        [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
        public string? RequestEffect { get; set; }

        [JsonPropertyName("status")]
        public string Status { get; set; } = "";

        [JsonPropertyName("result_json")]
        public object? ResultJson { get; set; }

        [JsonPropertyName("error")]
        public string? Error { get; set; }

        [JsonPropertyName("failure_kind")]
        public string? FailureKind { get; set; }

        [JsonPropertyName("failure_code")]
        public string? FailureCode { get; set; }

        [JsonPropertyName("duration_ms")]
        public double? DurationMs { get; set; }

        [JsonPropertyName("attachments")]
        public List<OperatorToolAttachment>? Attachments { get; set; }
    }

    public sealed class OperatorUserAttachment
    {
        [JsonPropertyName("id")]
        public string Id { get; set; } = "";

        [JsonPropertyName("relative_path")]
        public string RelativePath { get; set; } = "";

        [JsonPropertyName("filename")]
        public string? Filename { get; set; }

        [JsonPropertyName("bytes")]
        public long Bytes { get; set; }

        [JsonPropertyName("sha256")]
        public string? Sha256 { get; set; }

        [JsonPropertyName("mime")]
        public string? Mime { get; set; }

        [JsonPropertyName("created_at")]
        public string? CreatedAt { get; set; }

        // Optional: if this "attachment" is an approved external reference (e.g., DWG link on network drive),
        // RelativePath may be empty and external_path will be set.
        [JsonPropertyName("external_path")]
        public string? ExternalPath { get; set; }
    }

    public sealed class OperatorAttachmentUploadRequest
    {
        [JsonPropertyName("session_id")]
        public string? SessionId { get; set; }

        [JsonPropertyName("id")]
        public string Id { get; set; } = "";

        [JsonPropertyName("relative_path")]
        public string? RelativePath { get; set; }

        [JsonPropertyName("filename")]
        public string? Filename { get; set; }

        [JsonPropertyName("sha256")]
        public string? Sha256 { get; set; }

        [JsonPropertyName("mime")]
        public string? Mime { get; set; }

        [JsonPropertyName("created_at")]
        public string? CreatedAt { get; set; }

        [JsonPropertyName("data_base64")]
        public string DataBase64 { get; set; } = "";
    }

    public sealed class OperatorAttachmentUploadResponse
    {
        [JsonPropertyName("ok")]
        public bool Ok { get; set; }

        [JsonPropertyName("error")]
        public string? Error { get; set; }

        [JsonPropertyName("attachment")]
        public OperatorUserAttachment? Attachment { get; set; }
    }
}
