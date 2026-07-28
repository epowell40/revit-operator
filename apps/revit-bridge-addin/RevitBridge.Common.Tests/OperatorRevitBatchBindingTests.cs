using System;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class OperatorRevitBatchBindingTests
    {
        [Fact]
        public void Fingerprint_is_stable_for_equivalent_windows_paths()
        {
            var first = OperatorRevitBatchBinding.FromLiveDocument("session-a", "executor-a", "Model", @"C:\Models\Project.rvt");
            var second = OperatorRevitBatchBinding.FromLiveDocument("session-a", "executor-a", "Renamed title", @"c:/models/project.rvt");

            Assert.True(first.Matches(second));
            Assert.Matches("^[a-f0-9]{64}$", first.ProjectFingerprint);
        }

        [Fact]
        public void Project_unique_id_survives_a_save_as_path_change()
        {
            var first = OperatorRevitBatchBinding.FromLiveDocument("session-a", "executor-a", "Model", @"C:\Models\Before.rvt", "project-unique-id");
            var afterSaveAs = OperatorRevitBatchBinding.FromLiveDocument("session-a", "executor-a", "Model Copy", @"D:\Issue\After.rvt", "project-unique-id");

            Assert.True(first.Matches(afterSaveAs));
        }

        [Fact]
        public void Executor_session_and_project_are_all_part_of_the_binding()
        {
            var baseline = OperatorRevitBatchBinding.FromLiveDocument("session-a", "executor-a", "Model A", "");
            Assert.False(baseline.Matches(OperatorRevitBatchBinding.FromLiveDocument("session-b", "executor-a", "Model A", "")));
            Assert.False(baseline.Matches(OperatorRevitBatchBinding.FromLiveDocument("session-a", "executor-b", "Model A", "")));
            Assert.False(baseline.Matches(OperatorRevitBatchBinding.FromLiveDocument("session-a", "executor-a", "Model B", "")));
        }

        [Fact]
        public void Wire_values_repeat_the_same_trusted_target()
        {
            var binding = OperatorRevitBatchBinding.FromLiveDocument("session-a", "executor-a", "Model", @"C:\Models\Project.rvt");
            var wire = binding.ToWireValues();
            var target = Assert.IsAssignableFrom<System.Collections.Generic.IDictionary<string, object?>>(wire["target_context"]);

            Assert.Equal("session-a", wire["session_id"]);
            Assert.Equal("executor-a", wire["target_executor_id"]);
            Assert.Equal(binding.ProjectFingerprint, wire["project_fingerprint"]);
            Assert.Equal(wire["target_executor_id"], target["executor_id"]);
            Assert.Equal(wire["project_fingerprint"], target["project_fingerprint"]);
        }

        [Fact]
        public void Missing_live_document_or_malformed_hash_is_rejected()
        {
            Assert.Throws<InvalidOperationException>(() => OperatorRevitBatchBinding.FromLiveDocument("session-a", "executor-a", "", ""));
            Assert.Throws<ArgumentException>(() => new OperatorRevitBatchBinding("session-a", "executor-a", "bad"));
        }
    }
}
