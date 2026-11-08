using System;
using System.IO;
using System.Text;
using System.Threading.Tasks;

namespace RevitBridge.Common
{
    // Drain the launcher pipes continuously, retaining only bounded diagnostics.
    // Supervisor stdout duplicates evidence.json and is not a second result store.
    public sealed class OperatorNativeProgramCourierOutput
    {
        private readonly object _gate = new object();
        private readonly StringBuilder _prefix = new StringBuilder();
        private readonly int _maximumChars;
        private long _observedChars;
        private bool _complete;
        private string? _readError;

        public OperatorNativeProgramCourierOutput(int maximumChars)
        {
            if (maximumChars < 0 || maximumChars > 4096) throw new ArgumentOutOfRangeException(nameof(maximumChars));
            _maximumChars = maximumChars;
        }

        public object Snapshot()
        {
            lock (_gate)
                return new { captured_prefix = _prefix.ToString(), observed_chars = _observedChars,
                    truncated = _observedChars > _prefix.Length, complete = _complete,
                    read_error = _readError, authority = "diagnostic_only" };
        }

        public async Task DrainAsync(TextReader reader)
        {
            var buffer = new char[2048];
            try
            {
                int count;
                while ((count = await reader.ReadAsync(buffer, 0, buffer.Length).ConfigureAwait(false)) > 0)
                {
                    lock (_gate)
                    {
                        _observedChars += count;
                        var retain = Math.Min(count, _maximumChars - _prefix.Length);
                        if (retain > 0) _prefix.Append(buffer, 0, retain);
                    }
                }
                lock (_gate) _complete = true;
            }
            catch (IOException) { lock (_gate) _readError = "IOException"; }
            catch (ObjectDisposedException) { lock (_gate) _readError = "ObjectDisposedException"; }
        }
    }
}
