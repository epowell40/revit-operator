using System;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using RevitBridge.Common;

namespace RevitBridge.Operator
{
    internal sealed class OperatorJsonlLogger : IDisposable
    {
        private readonly SemaphoreSlim _lock = new SemaphoreSlim(1, 1);
        private readonly StreamWriter _writer;

        public OperatorJsonlLogger(string sessionId)
        {
            var dir = WorkspacePaths.EnsureDir("logs");
            var safeSession = SanitizeForFileName(sessionId);
            var path = Path.Combine(dir, $"session-{safeSession}.jsonl");

            _writer = new StreamWriter(new FileStream(path, FileMode.Append, FileAccess.Write, FileShare.ReadWrite))
            {
                AutoFlush = true
            };
        }

        public async Task LogAsync(string eventName, object data, CancellationToken cancellationToken)
        {
            var entry = new
            {
                ts = DateTime.UtcNow.ToString("o"),
                evt = eventName,
                data
            };

            var line = JsonSerializer.Serialize(entry, OperatorUiProtocol.JsonOptions);
            await _lock.WaitAsync(cancellationToken).ConfigureAwait(false);
            try
            {
                await _writer.WriteLineAsync(line).ConfigureAwait(false);
            }
            finally
            {
                _lock.Release();
            }
        }

        public void Dispose()
        {
            _writer.Dispose();
            _lock.Dispose();
        }

        private static string SanitizeForFileName(string input)
        {
            if (string.IsNullOrWhiteSpace(input)) return "unknown";
            var invalid = Path.GetInvalidFileNameChars();
            var cleaned = new string(input.Select(ch => invalid.Contains(ch) ? '_' : ch).ToArray());
            return cleaned.Length > 80 ? cleaned.Substring(0, 80) : cleaned;
        }
    }
}
