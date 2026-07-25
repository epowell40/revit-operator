using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace RevitBridge.Common
{
    public sealed class OperatorCourierCompletionRecord
    {
        [JsonPropertyName("version")]
        public string Version { get; set; } = OperatorCourierCompletionOutbox.RecordVersion;

        [JsonPropertyName("session_id")]
        public string SessionId { get; set; } = "";

        [JsonPropertyName("job_id")]
        public string JobId { get; set; } = "";

        [JsonPropertyName("executor_id")]
        public string ExecutorId { get; set; } = "";

        [JsonPropertyName("completed_at")]
        public string CompletedAt { get; set; } = "";

        [JsonPropertyName("result")]
        public JsonElement Result { get; set; }
    }

    public sealed class OperatorCourierCompletionOutbox
    {
        public const string RecordVersion = "revit-operator.courier-completion-outbox.v1";
        private readonly string _root;

        public OperatorCourierCompletionOutbox(string? root = null)
        {
            _root = string.IsNullOrWhiteSpace(root)
                ? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "RevitOperator", "CourierCompletionOutbox")
                : Path.GetFullPath(root!);
        }

        public OperatorCourierCompletionRecord Save(string sessionId, string jobId, string executorId, object? result)
        {
            ValidateId(sessionId, nameof(sessionId));
            ValidateId(jobId, nameof(jobId));
            ValidateId(executorId, nameof(executorId));
            Directory.CreateDirectory(_root);
            var record = new OperatorCourierCompletionRecord
            {
                SessionId = sessionId,
                JobId = jobId,
                ExecutorId = executorId,
                CompletedAt = DateTime.UtcNow.ToString("o"),
                Result = JsonSerializer.SerializeToElement(result)
            };
            var target = RecordPath(jobId);
            var temp = target + "." + Guid.NewGuid().ToString("N") + ".tmp";
            File.WriteAllText(temp, JsonSerializer.Serialize(record, new JsonSerializerOptions { WriteIndented = true }));
            if (File.Exists(target)) File.Replace(temp, target, null);
            else File.Move(temp, target);
            return record;
        }

        public IReadOnlyList<OperatorCourierCompletionRecord> ReadPending(int maxCount = 10)
        {
            if (maxCount <= 0 || !Directory.Exists(_root)) return Array.Empty<OperatorCourierCompletionRecord>();
            var records = new List<OperatorCourierCompletionRecord>();
            foreach (var file in Directory.GetFiles(_root, "*.json").OrderBy(path => path, StringComparer.OrdinalIgnoreCase))
            {
                try
                {
                    var record = JsonSerializer.Deserialize<OperatorCourierCompletionRecord>(File.ReadAllText(file));
                    if (record == null || record.Version != RecordVersion) continue;
                    ValidateId(record.SessionId, nameof(record.SessionId));
                    ValidateId(record.JobId, nameof(record.JobId));
                    ValidateId(record.ExecutorId, nameof(record.ExecutorId));
                    records.Add(record);
                    if (records.Count >= maxCount) break;
                }
                catch
                {
                    // Preserve unreadable evidence for diagnosis; do not delete or execute it.
                }
            }
            return records;
        }

        public bool HasUnresolvedEntries => Directory.Exists(_root) && Directory.EnumerateFiles(_root, "*.json").Any();

        public void Acknowledge(string jobId)
        {
            ValidateId(jobId, nameof(jobId));
            var target = RecordPath(jobId);
            if (File.Exists(target)) File.Delete(target);
        }

        private string RecordPath(string jobId) => Path.Combine(_root, jobId + ".json");

        private static void ValidateId(string value, string field)
        {
            if (string.IsNullOrWhiteSpace(value) || value.Length > 200 || value.Any(ch => !(char.IsLetterOrDigit(ch) || ch == '.' || ch == '_' || ch == ':' || ch == '-')))
                throw new ArgumentException(field + " is invalid.");
        }
    }
}
