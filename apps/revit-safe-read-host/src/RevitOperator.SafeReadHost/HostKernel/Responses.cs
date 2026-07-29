using System;
using System.Globalization;
using System.Text;
using RevitOperator.SafeReadCertifiedExecution;

namespace RevitOperator.SafeReadHost.HostKernel
{
    internal sealed class ResponsePayload
    {
        private ResponsePayload(int status,string json){StatusCode=status;Body=new UTF8Encoding(false).GetBytes(json);if(Body.Length>SafeReadContract.MaximumResponseBytes)throw new InvalidOperationException();}
        public int StatusCode{get;} public byte[] Body{get;}
        public static ResponsePayload Success(int count,string requestId,string attemptId)=>new ResponsePayload(200,"{\"schema\":"+Protocol.Quote(SafeReadContract.ResponseSchema)+",\"count\":"+count.ToString(CultureInfo.InvariantCulture)+",\"phase\":\"completed\",\"outcome\":\"succeeded\",\"request_id\":"+Protocol.Quote(requestId)+",\"attempt_id\":"+Protocol.Quote(attemptId)+"}");
        public static ResponsePayload Failure(CertifiedFailureCode code,CertifiedExecutionPhase phase,CertifiedExecutionOutcome outcome,string requestId,string attemptId)
        {
            int status;string wire;
            switch(code){case CertifiedFailureCode.BadRequest:status=400;wire="bad_request";break;case CertifiedFailureCode.Unauthorized:status=403;wire="unauthorized";break;case CertifiedFailureCode.Busy:status=409;wire="busy";break;case CertifiedFailureCode.NoActiveDocument:status=409;wire="no_active_document";break;case CertifiedFailureCode.DocumentChanged:status=409;wire="document_changed";break;case CertifiedFailureCode.NotReadOnly:status=409;wire="document_not_read_only";break;case CertifiedFailureCode.CountLimitExceeded:status=422;wire="sheet_count_limit_exceeded";break;case CertifiedFailureCode.DeadlineExceeded:status=504;wire="deadline_exceeded";break;case CertifiedFailureCode.AuthorizationUnavailable:status=503;wire="authorization_unavailable";break;case CertifiedFailureCode.RevitUnavailable:status=503;wire="revit_unavailable";break;default:status=500;wire="internal_failure";break;}
            return new ResponsePayload(status,"{\"schema\":"+Protocol.Quote(SafeReadContract.FailureSchema)+",\"code\":"+Protocol.Quote(wire)+",\"phase\":"+Protocol.Quote(Phase(phase))+",\"outcome\":"+Protocol.Quote(Outcome(outcome))+",\"request_id\":"+NullableQuote(requestId)+",\"attempt_id\":"+NullableQuote(attemptId)+"}");
        }
        private static string NullableQuote(string value)=>Protocol.IsCanonicalGuid(value)?Protocol.Quote(value):"null";
        private static string Phase(CertifiedExecutionPhase value)=>value==CertifiedExecutionPhase.CaptureBinding?"capture_binding":value==CertifiedExecutionPhase.VerifyFinalReceipt?"verify_final_receipt":value==CertifiedExecutionPhase.CountSheets?"count_sheets":value==CertifiedExecutionPhase.Completed?"completed":"none";
        private static string Outcome(CertifiedExecutionOutcome value)=>value==CertifiedExecutionOutcome.Succeeded?"succeeded":value==CertifiedExecutionOutcome.Denied?"denied":value==CertifiedExecutionOutcome.Cancelled?"cancelled":value==CertifiedExecutionOutcome.Pending?"pending":"failed";
    }
}
