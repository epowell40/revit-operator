using System;
using System.Linq;

namespace RevitBridge.Common
{
    // Conservative method-name hint, not authorization. Detached geometry factory
    // exceptions, document ownership and native settlement remain separate gates.
    public static class NativeApiMutationNames
    {
        private static readonly string[] Prefixes = { "set", "add", "create", "new", "delete", "remove", "insert", "move", "rotate", "copy", "open", "save", "load", "sync", "purge", "regenerate", "commit", "rollback", "apply", "rename", "change", "modify", "post" };
        public static bool IsMutating(string? name)
            => Prefixes.Any(prefix => (name ?? "").StartsWith(prefix, StringComparison.OrdinalIgnoreCase));
    }
}
