using System;
using System.Globalization;
using System.Text;

namespace RevitOperator.SafeReadHost.Kernel
{
    internal enum FailureCode
    {
        None = 0,
        BadRequest,
        Unauthorized,
        Busy,
        NoActiveDocument,
        DocumentChanged,
        NotReadOnly,
        CountLimitExceeded,
        AuthorizationUnavailable,
        RevitUnavailable,
        InternalFailure
    }

    internal sealed class ResponsePayload
    {
        private ResponsePayload(int statusCode, byte[] body)
        {
            if (body == null || body.Length == 0 || body.Length > SafeReadContract.MaximumResponseBytes)
                throw new ArgumentOutOfRangeException(nameof(body));
            StatusCode = statusCode;
            Body = body;
        }

        public int StatusCode { get; private set; }
        public byte[] Body { get; private set; }

        public static ResponsePayload Success(int count)
        {
            if (count < 0 || count > SafeReadContract.MaximumSheetCount)
                return Failure(FailureCode.CountLimitExceeded);
            string json = "{\"schema\":\"" + SafeReadContract.ResponseSchema + "\",\"count\":" +
                          count.ToString(CultureInfo.InvariantCulture) + "}";
            return Create(200, json);
        }

        public static ResponsePayload Failure(FailureCode code)
        {
            int status;
            string value;
            switch (code)
            {
                case FailureCode.BadRequest:
                    status = 400;
                    value = "bad_request";
                    break;
                case FailureCode.Unauthorized:
                    status = 403;
                    value = "unauthorized";
                    break;
                case FailureCode.Busy:
                    status = 409;
                    value = "busy";
                    break;
                case FailureCode.NoActiveDocument:
                    status = 409;
                    value = "no_active_document";
                    break;
                case FailureCode.DocumentChanged:
                    status = 409;
                    value = "document_changed";
                    break;
                case FailureCode.NotReadOnly:
                    status = 409;
                    value = "document_not_read_only";
                    break;
                case FailureCode.CountLimitExceeded:
                    status = 422;
                    value = "sheet_count_limit_exceeded";
                    break;
                case FailureCode.AuthorizationUnavailable:
                    status = 503;
                    value = "authorization_unavailable";
                    break;
                case FailureCode.RevitUnavailable:
                    status = 503;
                    value = "revit_unavailable";
                    break;
                default:
                    status = 500;
                    value = "internal_failure";
                    break;
            }
            return Create(status, "{\"schema\":\"" + SafeReadContract.FailureSchema + "\",\"code\":\"" + value + "\"}");
        }

        private static ResponsePayload Create(int status, string json)
        {
            return new ResponsePayload(status, new UTF8Encoding(false).GetBytes(json));
        }
    }
}
