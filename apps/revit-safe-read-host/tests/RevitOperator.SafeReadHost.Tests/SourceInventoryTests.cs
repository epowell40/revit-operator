using System;
using System.Collections.Generic;
using System.IO;
using RevitOperator.SafeReadHost.Kernel;
using Xunit;

namespace RevitOperator.SafeReadHost.Tests
{
    public sealed class SourceInventoryTests
    {
        [Fact]
        public void Runtime_source_has_no_forbidden_coupling_or_dispatch_primitives()
        {
            string tree = FindProjectTree();
            List<string> hostFiles = SourceFiles(Path.Combine(tree, "src", "RevitOperator.SafeReadHost", "HostKernel"));
            hostFiles.Add(Path.Combine(tree, "src", "RevitOperator.SafeReadHost", "HostApplication.cs"));
            hostFiles.Add(Path.Combine(tree, "src", "RevitOperator.SafeReadHost", "CertifiedSafeReadHttpHost.cs"));
            List<string> certifiedFiles = new List<string> { Path.Combine(tree, "src", "RevitOperator.SafeReadCertifiedExecution", "RevitCertifiedExecution.cs") };
            Assert.NotEmpty(hostFiles);
            Assert.NotEmpty(certifiedFiles);

            string combined = string.Empty;
            for (int index = 0; index < hostFiles.Count; index++)
            {
                string text = File.ReadAllText(hostFiles[index]);
                combined += text;
                Assert.DoesNotContain("RevitBridge", text, StringComparison.Ordinal);
                Assert.DoesNotContain("dynamic ", text, StringComparison.Ordinal);
                Assert.DoesNotContain("Courier", text, StringComparison.OrdinalIgnoreCase);
                Assert.DoesNotContain("bridge_url", text, StringComparison.OrdinalIgnoreCase);
                Assert.DoesNotContain("operator_token", text, StringComparison.OrdinalIgnoreCase);
                Assert.DoesNotContain("new Transaction", text, StringComparison.Ordinal);
                Assert.DoesNotContain("SubTransaction", text, StringComparison.Ordinal);
            }
            string certified = string.Join("\n", certifiedFiles.ConvertAll(File.ReadAllText));
            foreach (string forbidden in new[] { "RevitOperator.SafeReadHost", "RevitBridge", "System.Net", "System.IO", "System.Threading", "System.Security", "Environment.", "Json", "HttpClient", "HttpListener", "Task", "ExternalEvent", "UIApplication" })
                Assert.DoesNotContain(forbidden, certified, StringComparison.Ordinal);
            Assert.Equal(1, Count(combined, ":IExternalApplication"));
            Assert.Equal(1, Count(combined, ": IExternalEventHandler"));
            Assert.Equal(1, Count(certified, "public static CertifiedSheetCountResult Execute(Document document)"));
            Assert.Contains("FilteredElementIterator", certified, StringComparison.Ordinal);
            Assert.Contains("GetElementIterator()", certified, StringComparison.Ordinal);
            Assert.Contains("sheet.IsPlaceholder", certified, StringComparison.Ordinal);
            Assert.Contains("<EnableDefaultCompileItems>false</EnableDefaultCompileItems>", File.ReadAllText(Path.Combine(tree, "src", "RevitOperator.SafeReadCertifiedExecution", "RevitOperator.SafeReadCertifiedExecution.csproj")), StringComparison.Ordinal);
            Assert.Contains("<Compile Include=\"RevitCertifiedExecution.cs\" />", File.ReadAllText(Path.Combine(tree, "src", "RevitOperator.SafeReadCertifiedExecution", "RevitOperator.SafeReadCertifiedExecution.csproj")), StringComparison.Ordinal);
        }

        [Fact]
        public void Host_project_has_only_direct_Revit_API_references()
        {
            string tree = FindProjectTree();
            string projectPath = Path.Combine(
                tree,
                "src",
                "RevitOperator.SafeReadHost",
                "RevitOperator.SafeReadHost.csproj");
            string project = File.ReadAllText(projectPath);

            Assert.Equal(1, Count(project, "ProjectReference"));
            Assert.Contains("RevitOperator.SafeReadCertifiedExecution.csproj", project, StringComparison.Ordinal);
            Assert.Equal(1, Count(project, "PackageReference"));
            Assert.Contains("System.Text.Json", project, StringComparison.Ordinal);
            Assert.Contains("<EnableDefaultCompileItems>false</EnableDefaultCompileItems>", project, StringComparison.Ordinal);
            Assert.DoesNotContain("RevitBridge", project, StringComparison.Ordinal);
            Assert.Equal(3, Count(project, "<Reference Include="));
            Assert.Contains("<Reference Include=\"RevitAPI\">", project, StringComparison.Ordinal);
            Assert.Contains("<Reference Include=\"RevitAPIUI\">", project, StringComparison.Ordinal);
            Assert.Contains("<TargetFrameworks>net48;net8.0-windows</TargetFrameworks>", project, StringComparison.Ordinal);
            Assert.Contains("<OutputPath>bin\\Revit$(RevitYear)\\$(Configuration)\\</OutputPath>", project, StringComparison.Ordinal);
            Assert.Contains("<IntermediateOutputPath>obj\\Revit$(RevitYear)\\$(Configuration)\\$(TargetFramework)\\</IntermediateOutputPath>", project, StringComparison.Ordinal);
            Assert.Contains("RevitYear)'!='2023", project, StringComparison.Ordinal);
            Assert.Contains("RevitYear)'!='2024", project, StringComparison.Ordinal);
            Assert.Contains("RevitYear)'!='2025", project, StringComparison.Ordinal);
        }

        [Fact]
        public void Addin_template_freezes_the_distinct_product_identity()
        {
            string tree = FindProjectTree();
            string manifest = File.ReadAllText(Path.Combine(
                tree,
                "addin",
                "RevitOperator.SafeReadHost.addin.template"));

            Assert.Contains("<AddInId>" + SafeReadContract.ProductId + "</AddInId>", manifest, StringComparison.Ordinal);
            Assert.Contains("<FullClassName>RevitOperator.SafeReadHost.App</FullClassName>", manifest, StringComparison.Ordinal);
            Assert.DoesNotContain("RevitBridge", manifest, StringComparison.Ordinal);
            Assert.Equal(1, Count(manifest, "<AddIn Type=\"Application\">"));
        }

        private static List<string> SourceFiles(string root)
        {
            string[] all = Directory.GetFiles(root, "*.cs", SearchOption.AllDirectories);
            List<string> files = new List<string>();
            for (int index = 0; index < all.Length; index++)
            {
                string normalized = all[index].Replace('/', '\\');
                if (normalized.IndexOf("\\obj\\", StringComparison.OrdinalIgnoreCase) >= 0 ||
                    normalized.IndexOf("\\bin\\", StringComparison.OrdinalIgnoreCase) >= 0)
                    continue;
                files.Add(all[index]);
            }
            return files;
        }

        private static string FindProjectTree()
        {
            string[] starts = { Directory.GetCurrentDirectory(), AppContext.BaseDirectory };
            for (int startIndex = 0; startIndex < starts.Length; startIndex++)
            {
                DirectoryInfo? cursor = new DirectoryInfo(starts[startIndex]);
                for (int depth = 0; cursor != null && depth < 12; depth++)
                {
                    if (string.Equals(cursor.Name, "revit-safe-read-host", StringComparison.OrdinalIgnoreCase) &&
                        Directory.Exists(Path.Combine(cursor.FullName, "src")))
                        return cursor.FullName;
                    string candidate = Path.Combine(cursor.FullName, "apps", "revit-safe-read-host");
                    if (Directory.Exists(Path.Combine(candidate, "src")))
                        return candidate;
                    cursor = cursor.Parent;
                }
            }
            throw new DirectoryNotFoundException("apps/revit-safe-read-host was not found.");
        }

        private static int Count(string text, string value)
        {
            int count = 0;
            int offset = 0;
            while (true)
            {
                int found = text.IndexOf(value, offset, StringComparison.Ordinal);
                if (found < 0)
                    return count;
                count++;
                offset = found + value.Length;
            }
        }
    }
}
