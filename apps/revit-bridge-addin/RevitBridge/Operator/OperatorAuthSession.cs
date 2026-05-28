using System.Threading;
using System.Threading.Tasks;
using RevitBridge.Common;

namespace RevitBridge.Operator
{
    internal sealed class OperatorAuthUiState
    {
        public string mode { get; set; } = "none";
        public bool auth_enabled { get; set; }
        public bool auth_configured { get; set; } = true;
        public string? auth_base_url { get; set; }
        public bool signed_in { get; set; }
        public string? user_id { get; set; }
        public string? email { get; set; }
        public string? token_expiry_utc { get; set; }
        public string? last_refresh_utc { get; set; }
        public bool can_chat { get; set; } = true;
        public string? message { get; set; } = "Local shared-token mode.";
    }

    internal sealed class OperatorAuthSession
    {
        public OperatorClientAuthMode Mode => OperatorClientAuthMode.None;

        public OperatorAuthUiState GetState()
        {
            return new OperatorAuthUiState();
        }

        public Task<OperatorAuthUiState> LoginAsync(string email, string password, CancellationToken cancellationToken)
        {
            return Task.FromResult(new OperatorAuthUiState
            {
                message = "Hosted sign-in is not included in the public core. Use the local backend shared-token mode."
            });
        }

        public Task<OperatorAuthUiState> RefreshAsync(CancellationToken cancellationToken)
        {
            return Task.FromResult(GetState());
        }

        public OperatorAuthUiState SignOut()
        {
            return GetState();
        }

        public Task<string> GetAccessTokenForBackendAsync(bool forceRefresh, CancellationToken cancellationToken)
        {
            return Task.FromResult(string.Empty);
        }

        public Task<bool> EnsureCanChatAsync(CancellationToken cancellationToken)
        {
            return Task.FromResult(true);
        }
    }
}
