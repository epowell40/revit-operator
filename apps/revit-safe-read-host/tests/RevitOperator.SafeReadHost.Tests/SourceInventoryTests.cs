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
            string sourceRoot = Path.Combine(tree, "src", "RevitOperator.SafeReadHost");
            List<string> files = SourceFiles(sourceRoot);
            Assert.NotEmpty(files);

            string combined = string.Empty;
            for (int index = 0; index < files.Count; index++)
            {
                string text = File.ReadAllText(files[index]);
                combined += text;
                Assert.DoesNotContain("RevitBridge", text, StringComparison.Ordinal);
                Assert.DoesNotContain("System.Linq", text, StringComparison.Ordinal);
                Assert.DoesNotContain("System.Reflection", text, StringComparison.Ordinal);
                Assert.DoesNotContain("Dictionary<", text, StringComparison.Ordinal);
                Assert.DoesNotContain("Func<", text, StringComparison.Ordinal);
                Assert.DoesNotContain("Action<", text, StringComparison.Ordinal);
                Assert.DoesNotContain(" delegate ", text, StringComparison.OrdinalIgnoreCase);
                Assert.DoesNotContain("dynamic ", text, StringComparison.Ordinal);
                Assert.DoesNotContain("HttpClient", text, StringComparison.Ordinal);
                Assert.DoesNotContain("Courier", text, StringComparison.OrdinalIgnoreCase);
                Assert.DoesNotContain("bridge_url", text, StringComparison.OrdinalIgnoreCase);
                Assert.DoesNotContain("operator_token", text, StringComparison.OrdinalIgnoreCase);
                Assert.DoesNotContain("new Transaction", text, StringComparison.Ordinal);
                Assert.DoesNotContain("SubTransaction", text, StringComparison.Ordinal);
                if (text.Contains("File.Write", StringComparison.Ordinal) ||
                    text.Contains("File.Move", StringComparison.Ordinal) ||
                    text.Contains("File.Replace", StringComparison.Ordinal) ||
                    text.Contains("File.Delete", StringComparison.Ordinal))
                    Assert.Equal("Discovery.cs", Path.GetFileName(files[index]));
            }

            Assert.Equal(1, Count(combined, ": IExternalApplication"));
            Assert.Equal(1, Count(combined, ": IExternalEventHandler"));
            Assert.Equal(1, Count(combined, "public void Execute(UIApplication"));
            Assert.Equal(1, Count(combined, "FilteredElementIterator"));
            Assert.Contains("GetElementIterator()", combined, StringComparison.Ordinal);
            Assert.Contains("sheet.IsPlaceholder", combined, StringComparison.Ordinal);
            Assert.Contains("document.IsModifiable", combined, StringComparison.Ordinal);
            Assert.Contains("document.IsModified", combined, StringComparison.Ordinal);
            Assert.Equal(1, Count(combined, SafeReadContract.Path));
            Assert.Equal(1, Count(combined, SafeReadContract.RequestJson.Replace("\"", "\\\"")));
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

            Assert.DoesNotContain("ProjectReference", project, StringComparison.Ordinal);
            Assert.DoesNotContain("PackageReference", project, StringComparison.Ordinal);
            Assert.DoesNotContain("Compile Include", project, StringComparison.Ordinal);
            Assert.DoesNotContain("RevitBridge", project, StringComparison.Ordinal);
            Assert.Equal(2, Count(project, "<Reference Include="));
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
