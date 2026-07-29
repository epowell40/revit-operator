using System;
using System.IO;
using System.Security.AccessControl;
using System.Security.Principal;

namespace RevitOperator.SafeReadHost.HostKernel
{
    internal static class SecureLocalStorage
    {
        private static readonly SecurityIdentifier LocalSystem = new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null);
        private static readonly SecurityIdentifier Administrators = new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null);

        public static void EnsurePrivateDirectory(string trustedRoot, string directory)
        {
            string root = CanonicalDirectory(trustedRoot);
            string target = CanonicalDirectory(directory);
            EnsureContained(root, target);
            RejectReparseChain(root, target);
            Directory.CreateDirectory(target);
            ApplyDirectoryAcl(target);
            VerifyDirectory(target);
        }

        public static void SecurePublishedFile(string trustedRoot, string path)
        {
            string full = Path.GetFullPath(path);
            string? parent = Path.GetDirectoryName(full);
            if (String.IsNullOrEmpty(parent)) throw new InvalidOperationException("Secure file parent is unavailable.");
            EnsureContained(CanonicalDirectory(trustedRoot), CanonicalDirectory(parent));
            RejectReparseChain(CanonicalDirectory(trustedRoot), CanonicalDirectory(parent));
            RejectReparse(full);
            ApplyFileAcl(full);
            VerifyFile(full);
        }

        public static void VerifyPrivateFile(string path)
        {
            string full = Path.GetFullPath(path);
            string? parent = Path.GetDirectoryName(full);
            if (String.IsNullOrEmpty(parent)) throw new InvalidOperationException("Secure file parent is unavailable.");
            VerifyPrivateFile(parent, full);
        }

        public static void VerifyPrivateFile(string trustedRoot, string path)
        {
            string root = CanonicalDirectory(trustedRoot);
            string full = Path.GetFullPath(path);
            string? parent = Path.GetDirectoryName(full);
            if (String.IsNullOrEmpty(parent)) throw new InvalidOperationException("Secure file parent is unavailable.");
            string canonicalParent = CanonicalDirectory(parent);
            EnsureContained(root, canonicalParent);
            RejectReparseChain(root, canonicalParent);
            RejectReparse(full);
            VerifyDirectory(parent);
            VerifyFile(full);
        }

        internal static bool IsAllowedPrincipal(SecurityIdentifier identity, SecurityIdentifier owner) =>
            identity.Equals(owner) || identity.Equals(LocalSystem) || identity.Equals(Administrators);

        internal static void ValidateRule(SecurityIdentifier identity, AccessControlType type, bool inherited, SecurityIdentifier owner)
        {
            if (type != AccessControlType.Allow || inherited || !IsAllowedPrincipal(identity, owner))
                throw new UnauthorizedAccessException("SafeRead storage contains an unsafe access-control entry.");
        }

        internal static void RejectReparse(bool exists, FileAttributes attributes)
        {
            if (exists && (attributes & FileAttributes.ReparsePoint) != 0)
                throw new UnauthorizedAccessException("SafeRead storage must not traverse a reparse point.");
        }

        private static void ApplyDirectoryAcl(string path)
        {
            SecurityIdentifier owner = CurrentOwner();
            DirectorySecurity security = new DirectorySecurity();
            security.SetAccessRuleProtection(true, false);
            security.SetOwner(owner);
            InheritanceFlags inheritance = InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit;
            security.AddAccessRule(new FileSystemAccessRule(owner, FileSystemRights.FullControl, inheritance, PropagationFlags.None, AccessControlType.Allow));
            security.AddAccessRule(new FileSystemAccessRule(LocalSystem, FileSystemRights.FullControl, inheritance, PropagationFlags.None, AccessControlType.Allow));
            security.AddAccessRule(new FileSystemAccessRule(Administrators, FileSystemRights.FullControl, inheritance, PropagationFlags.None, AccessControlType.Allow));
            new DirectoryInfo(path).SetAccessControl(security);
        }

        private static void ApplyFileAcl(string path)
        {
            SecurityIdentifier owner = CurrentOwner();
            FileSecurity security = new FileSecurity();
            security.SetAccessRuleProtection(true, false);
            security.SetOwner(owner);
            security.AddAccessRule(new FileSystemAccessRule(owner, FileSystemRights.FullControl, AccessControlType.Allow));
            security.AddAccessRule(new FileSystemAccessRule(LocalSystem, FileSystemRights.FullControl, AccessControlType.Allow));
            security.AddAccessRule(new FileSystemAccessRule(Administrators, FileSystemRights.FullControl, AccessControlType.Allow));
            new FileInfo(path).SetAccessControl(security);
        }

        private static void VerifyDirectory(string path) => Verify(new DirectoryInfo(path).GetAccessControl(AccessControlSections.Owner | AccessControlSections.Access), path);
        private static void VerifyFile(string path) => Verify(new FileInfo(path).GetAccessControl(AccessControlSections.Owner | AccessControlSections.Access), path);

        private static void Verify(FileSystemSecurity security, string path)
        {
            SecurityIdentifier expectedOwner = CurrentOwner();
            SecurityIdentifier? owner = security.GetOwner(typeof(SecurityIdentifier)) as SecurityIdentifier;
            if (owner == null || !owner.Equals(expectedOwner) || !security.AreAccessRulesProtected)
                throw new UnauthorizedAccessException("SafeRead storage owner or inheritance is unsafe: " + path);
            AuthorizationRuleCollection rules = security.GetAccessRules(true, true, typeof(SecurityIdentifier));
            bool ownerRule = false, systemRule = false, administratorsRule = false;
            foreach (AuthorizationRule raw in rules)
            {
                FileSystemAccessRule rule = (FileSystemAccessRule)raw;
                SecurityIdentifier identity = (SecurityIdentifier)rule.IdentityReference;
                ValidateRule(identity, rule.AccessControlType, rule.IsInherited, expectedOwner);
                if (identity.Equals(expectedOwner)) ownerRule = true;
                if (identity.Equals(LocalSystem)) systemRule = true;
                if (identity.Equals(Administrators)) administratorsRule = true;
            }
            if (!ownerRule || !systemRule || !administratorsRule)
                throw new UnauthorizedAccessException("SafeRead storage ACL is incomplete: " + path);
        }

        private static SecurityIdentifier CurrentOwner()
        {
            using (WindowsIdentity identity = WindowsIdentity.GetCurrent(TokenAccessLevels.Query))
                return identity.User ?? throw new UnauthorizedAccessException("Current Windows owner SID is unavailable.");
        }

        private static string CanonicalDirectory(string path) => Path.GetFullPath(path).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);

        private static void EnsureContained(string root, string target)
        {
            if (!target.Equals(root, StringComparison.OrdinalIgnoreCase) && !target.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
                throw new UnauthorizedAccessException("SafeRead storage escaped its trusted root.");
        }

        private static void RejectReparseChain(string root, string target)
        {
            RejectReparse(root);
            if (target.Equals(root, StringComparison.OrdinalIgnoreCase)) return;
            string relative = target.Substring(root.Length).TrimStart(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            string cursor = root;
            foreach (string component in relative.Split(new[] { Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar }, StringSplitOptions.RemoveEmptyEntries))
            {
                cursor = Path.Combine(cursor, component);
                RejectReparse(cursor);
            }
        }

        private static void RejectReparse(string path)
        {
            bool exists = File.Exists(path) || Directory.Exists(path);
            RejectReparse(exists, exists ? File.GetAttributes(path) : default(FileAttributes));
        }
    }
}
