using System;

namespace RevitBridge.Common
{
    public sealed class OperatorToolUserErrorException : Exception
    {
        public OperatorToolUserErrorException(
            string message,
            string code,
            string? requiredConfirm = null,
            string? confirmReceived = null,
            int? maxChangesPerCall = null,
            string? hint = null) : base(message)
        {
            Code = (code ?? "").Trim();
            RequiredConfirm = requiredConfirm;
            ConfirmReceived = confirmReceived;
            MaxChangesPerCall = maxChangesPerCall;
            Hint = hint;
        }

        public string Code { get; }
        public string? RequiredConfirm { get; }
        public string? ConfirmReceived { get; }
        public int? MaxChangesPerCall { get; }
        public string? Hint { get; }
    }
}

