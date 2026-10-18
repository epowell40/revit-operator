using System;
using System.Runtime.CompilerServices;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class OperatorNativeOwnedValueTests
    {
        private sealed class NativeParent { }
        private sealed class BorrowedChild
        {
            public readonly WeakReference Parent;
            public BorrowedChild(object parent) { Parent = new WeakReference(parent); }
            public bool Read() => Parent.IsAlive ? true : throw new InvalidOperationException("Native parent is invalid.");
        }
        [MethodImpl(MethodImplOptions.NoInlining)]
        private static BorrowedChild BorrowOnly() => new BorrowedChild(new NativeParent());
        [MethodImpl(MethodImplOptions.NoInlining)]
        private static OperatorNativeOwnedValue<BorrowedChild> RetainOwners()
        {
            var parent = new NativeParent();
            return new OperatorNativeOwnedValue<BorrowedChild>(new BorrowedChild(parent), parent);
        }
        [MethodImpl(MethodImplOptions.NoInlining)]
        private static void CensusAllocationsAndCollection()
        {
            GC.Collect(); GC.WaitForPendingFinalizers(); GC.Collect();
        }

        [Fact]
        public void AChildWrapperAloneDoesNotKeepItsNativeParentAlive()
        {
            var child = BorrowOnly(); CensusAllocationsAndCollection();
            Assert.Throws<InvalidOperationException>(() => child.Read());
            GC.KeepAlive(child);
        }

        [Fact]
        public void OwnersSurviveCollectionAcrossPreflightAndInsertion()
        {
            var owned = RetainOwners();
            var result = owned.Use(child => {
                CensusAllocationsAndCollection(); Assert.True(child.Read());
                CensusAllocationsAndCollection(); return child.Read();
            });
            Assert.True(result);
        }

        [Fact]
        public void AUseFailureIsRethrownWithoutSubstitution()
        {
            var expected = new InvalidOperationException("native failure");
            var owned = RetainOwners();
            var actual = Assert.Throws<InvalidOperationException>(() => owned.Use<bool>(child => {
                CensusAllocationsAndCollection(); Assert.True(child.Read()); throw expected;
            }));
            Assert.Same(expected, actual);
        }

        [Fact]
        public void OwnerArrayIsRetainedPrivatelyRatherThanBorrowingMutableCallerState()
        {
            object[] owners = { new NativeParent() };
            var child = new BorrowedChild(owners[0]);
            var owned = new OperatorNativeOwnedValue<BorrowedChild>(child, owners);
            owners[0] = new NativeParent();
            Assert.True(owned.Use(value => { CensusAllocationsAndCollection(); return value.Read(); }));
        }
    }
}
