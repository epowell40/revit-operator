using System;
using System.Threading;
using RevitOperator.SafeReadHost.Kernel;
using Xunit;

namespace RevitOperator.SafeReadHost.Tests
{
    public sealed class SingleFlightStateMachineTests
    {
        [Fact]
        public void Capacity_one_gate_has_exactly_one_winner_under_race()
        {
            const int contenderCount = 24;
            SingleFlightGate gate = new SingleFlightGate();
            ManualResetEventSlim start = new ManualResetEventSlim(false);
            CountdownEvent attempted = new CountdownEvent(contenderCount);
            Thread[] contenders = new Thread[contenderCount];
            int winners = 0;
            for (int index = 0; index < contenders.Length; index++)
            {
                contenders[index] = new Thread(() =>
                {
                    start.Wait();
                    bool won = gate.TryEnter();
                    if (won)
                        Interlocked.Increment(ref winners);
                    attempted.Signal();
                    if (won)
                    {
                        attempted.Wait();
                        gate.Exit();
                    }
                });
                contenders[index].Start();
            }

            start.Set();
            for (int index = 0; index < contenders.Length; index++)
                contenders[index].Join();

            Assert.Equal(1, winners);
            Assert.False(gate.IsOccupied);
            Assert.True(gate.TryEnter());
            gate.Exit();
        }

        [Fact]
        public void Gate_cannot_be_released_twice()
        {
            SingleFlightGate gate = new SingleFlightGate();
            Assert.True(gate.TryEnter());
            gate.Exit();
            Assert.Throws<InvalidOperationException>(() => gate.Exit());
        }

        [Fact]
        public void External_work_slot_is_capacity_one_CAS()
        {
            CertifiedExternalWorkSlot slot = new CertifiedExternalWorkSlot();
            DocumentBinding binding = TestFacts.Binding();
            CertifiedExternalWorkItem first = CertifiedExternalWorkItem.Capture(binding);
            CertifiedExternalWorkItem second = CertifiedExternalWorkItem.Count(binding, DateTimeOffset.UtcNow.AddSeconds(1));

            Assert.True(slot.TryQueue(first));
            Assert.False(slot.TryQueue(second));
            Assert.Same(first, slot.Take());
            Assert.Null(slot.Take());
            Assert.True(slot.TryQueue(second));
        }

        [Fact]
        public void External_work_slot_has_exactly_one_winner_under_race()
        {
            const int contenderCount = 24;
            CertifiedExternalWorkSlot slot = new CertifiedExternalWorkSlot();
            DocumentBinding binding = TestFacts.Binding();
            ManualResetEventSlim start = new ManualResetEventSlim(false);
            Thread[] contenders = new Thread[contenderCount];
            int winners = 0;
            for (int index = 0; index < contenders.Length; index++)
            {
                contenders[index] = new Thread(() =>
                {
                    CertifiedExternalWorkItem item = CertifiedExternalWorkItem.Capture(binding);
                    start.Wait();
                    if (slot.TryQueue(item))
                        Interlocked.Increment(ref winners);
                });
                contenders[index].Start();
            }

            start.Set();
            for (int index = 0; index < contenders.Length; index++)
                contenders[index].Join();

            Assert.Equal(1, winners);
            Assert.NotNull(slot.Take());
            Assert.Null(slot.Take());
        }

        [Fact]
        public void Request_state_machine_accepts_only_the_fixed_sequence()
        {
            CertifiedRequestStateMachine state = new CertifiedRequestStateMachine();

            Assert.False(state.TryAdvance(CertifiedRequestState.CountQueued));
            Assert.True(state.TryAdvance(CertifiedRequestState.WireAdmitted));
            Assert.True(state.TryAdvance(CertifiedRequestState.SlotAcquired));
            Assert.True(state.TryAdvance(CertifiedRequestState.CaptureQueued));
            Assert.True(state.TryAdvance(CertifiedRequestState.BindingCaptured));
            Assert.True(state.TryAdvance(CertifiedRequestState.AuthorizationVerified));
            Assert.True(state.TryAdvance(CertifiedRequestState.CountQueued));
            Assert.True(state.TryAdvance(CertifiedRequestState.Completed));
            Assert.False(state.TryFail());
            Assert.True(state.TryAdvance(CertifiedRequestState.Released));
            Assert.False(state.TryAdvance(CertifiedRequestState.Completed));
        }

        [Fact]
        public void Failure_can_release_from_every_nonterminal_phase()
        {
            CertifiedRequestState[] phases =
            {
                CertifiedRequestState.Created,
                CertifiedRequestState.WireAdmitted,
                CertifiedRequestState.SlotAcquired,
                CertifiedRequestState.CaptureQueued,
                CertifiedRequestState.BindingCaptured,
                CertifiedRequestState.AuthorizationVerified,
                CertifiedRequestState.CountQueued
            };
            for (int index = 0; index < phases.Length; index++)
            {
                CertifiedRequestStateMachine state = new CertifiedRequestStateMachine();
                AdvanceTo(state, phases[index]);
                Assert.True(state.TryFail());
                Assert.Equal(CertifiedRequestState.Failed, state.State);
                Assert.True(state.TryAdvance(CertifiedRequestState.Released));
            }
        }

        private static void AdvanceTo(CertifiedRequestStateMachine state, CertifiedRequestState target)
        {
            CertifiedRequestState[] sequence =
            {
                CertifiedRequestState.WireAdmitted,
                CertifiedRequestState.SlotAcquired,
                CertifiedRequestState.CaptureQueued,
                CertifiedRequestState.BindingCaptured,
                CertifiedRequestState.AuthorizationVerified,
                CertifiedRequestState.CountQueued
            };
            for (int index = 0; index < sequence.Length; index++)
            {
                if ((int)sequence[index] > (int)target)
                    return;
                Assert.True(state.TryAdvance(sequence[index]));
            }
        }
    }
}
