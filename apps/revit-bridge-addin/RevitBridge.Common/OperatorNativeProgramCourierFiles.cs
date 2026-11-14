using System;
using System.IO;

namespace RevitBridge.Common
{
    // Evidence must outlive the launcher until the existing durable courier
    // outbox owns the result. Exit, cancellation and a returned object are not
    // acknowledgements of that handoff, nor proof of rollback.
    public sealed class OperatorNativeProgramCourierFiles : IDisposable
    {
        private readonly string _directory;
        private bool _started;
        private bool _exited = true;
        private bool _completionRetained;

        public OperatorNativeProgramCourierFiles(string directory)
        {
            _directory = Path.GetFullPath(directory);
        }

        public void LauncherStarted() { _started = true; _exited = false; }
        public void LauncherExited() { _exited = true; }
        public void CompletionRetained() { _completionRetained = true; Dispose(); }

        public void Dispose()
        {
            if (!_exited || (_started && !_completionRetained)) return;
            try
            {
                for (var directory = new DirectoryInfo(_directory); directory != null; directory = directory.Parent)
                    if (directory.Exists && (directory.Attributes & FileAttributes.ReparsePoint) != 0) return;
            }
            catch (IOException) { return; }
            catch (UnauthorizedAccessException) { return; }
            // Never recurse or remove unknown files/models. A failed cleanup
            // preserves evidence and must not turn a retained result into failure.
            foreach (var name in new[] { "program.cs", "task.json", "evidence.json", "launcher-diagnostics.json" })
            {
                try
                {
                    var file = Path.Combine(_directory, name);
                    if (File.Exists(file) && (File.GetAttributes(file) & FileAttributes.ReparsePoint) == 0)
                        File.Delete(file);
                }
                catch (IOException) { }
                catch (UnauthorizedAccessException) { }
            }
            try { Directory.Delete(_directory, false); }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
        }
    }
}
