using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class OperatorEmbeddedNavigationTests
    {
        [Theory]
        [InlineData("http://127.0.0.1:3907/")]
        [InlineData("http://127.0.0.1:3907/?session=example#message")]
        [InlineData("http://127.0.0.1:3907/api/download/one")]
        public void OnlyTheApplicationOriginCanReplaceTheConversation(string value)
            => Assert.True(OperatorEmbeddedNavigation.IsApplication(value));

        [Theory]
        [InlineData(null)]
        [InlineData("http://127.0.0.1:3908/")]
        [InlineData("http://127.0.0.1:3907.attacker.example/")]
        [InlineData("http://127.0.0.1:3907@attacker.example/")]
        [InlineData("http://user@127.0.0.1:3907/")]
        [InlineData("https://127.0.0.1:3907/")]
        [InlineData("http://localhost:3907/")]
        [InlineData("file:///C:/example.html")]
        [InlineData("javascript:alert(1)")]
        [InlineData("data:text/html,hello")]
        public void ForeignOrPrivilegedNavigationIsRejected(string? value)
            => Assert.False(OperatorEmbeddedNavigation.IsApplication(value));

        [Theory]
        [InlineData("https://www.manufacturer.example/manual.pdf", true)]
        [InlineData("http://www.manufacturer.example/manual.pdf", true)]
        [InlineData("file:///C:/example.exe", false)]
        [InlineData("ms-settings:privacy", false)]
        [InlineData("javascript:alert(1)", false)]
        [InlineData("http://127.0.0.1:7007/admin", false)]
        [InlineData("https://user:password@manufacturer.example/", false)]
        public void ExternalReferencesRequireAnExplicitClickAndWebScheme(string value, bool permitted)
        {
            Assert.Equal(permitted, OperatorEmbeddedNavigation.IsUserReference(value, true));
            Assert.False(OperatorEmbeddedNavigation.IsUserReference(value, false));
        }
    }
}
