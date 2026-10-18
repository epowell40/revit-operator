using System;
using System.Linq;

namespace RevitBridge.Common
{
    /// <summary>Keeps native parent wrappers alive while a borrowed child is in use.</summary>
    public sealed class OperatorNativeOwnedValue<T> where T : class
    {
        private readonly object[] owners;
        public T Value { get; }

        public OperatorNativeOwnedValue(T value, params object[] owners)
        {
            Value = value ?? throw new ArgumentNullException(nameof(value));
            if (owners == null || owners.Length == 0 || owners.Any(owner => owner == null))
                throw new ArgumentException("At least one native owner is required.", nameof(owners));
            this.owners = owners.ToArray();
        }

        public TResult Use<TResult>(Func<T, TResult> action)
        {
            if (action == null) throw new ArgumentNullException(nameof(action));
            try { return action(Value); }
            finally
            {
                // Native children can hold weak unmanaged parent pointers. Keeping
                // only the child wrapper does not keep its native owners alive.
                GC.KeepAlive(owners);
                GC.KeepAlive(Value);
            }
        }
    }
}
