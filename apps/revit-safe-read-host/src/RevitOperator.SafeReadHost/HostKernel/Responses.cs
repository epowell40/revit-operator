using System;
using System.Globalization;
using System.Text;

namespace RevitOperator.SafeReadHost.HostKernel
{
    internal sealed class ResponsePayload
    {
        private ResponsePayload(int status,string json){StatusCode=status;Body=new UTF8Encoding(false).GetBytes(json);if(Body.Length>SafeReadContract.MaximumResponseBytes)throw new InvalidOperationException();}
        public int StatusCode{get;} public byte[] Body{get;}
        public static ResponsePayload Success(int count)=>new ResponsePayload(200,"{\"schema\":"+Protocol.Quote(SafeReadContract.ResponseSchema)+",\"count\":"+count.ToString(CultureInfo.InvariantCulture)+"}");
        public static ResponsePayload Failure(CertifiedFailureCode code,CertifiedExecutionPhase phase,bool requestDispatched,bool outcomeUnknown)
        {
            int status;string wire;string error;bool retryable;
            switch(code){case CertifiedFailureCode.BadRequest:status=400;wire="bad_request";error="SafeRead request did not match the exact certified route contract.";retryable=false;break;case CertifiedFailureCode.Unauthorized:status=403;wire="unauthorized";error="SafeRead request identity or startup token was rejected.";retryable=false;break;case CertifiedFailureCode.Busy:status=409;wire="busy";error="Certified SafeRead host is processing another request.";retryable=true;break;case CertifiedFailureCode.NoActiveDocument:status=409;wire="no_active_document";error="No active Revit document is available for certified SafeRead.";retryable=true;break;case CertifiedFailureCode.DocumentChanged:status=409;wire="document_changed";error="The active Revit document binding changed before completion.";retryable=true;break;case CertifiedFailureCode.NotReadOnly:status=409;wire="document_not_read_only";error="Certified SafeRead requires a non-modifiable Revit document context.";retryable=true;break;case CertifiedFailureCode.CountLimitExceeded:status=422;wire="sheet_count_limit_exceeded";error="Certified sheet count exceeded its fixed upper bound.";retryable=false;break;case CertifiedFailureCode.DeadlineExceeded:status=504;wire=outcomeUnknown?"deadline_exceeded_outcome_unknown":"deadline_exceeded";error=outcomeUnknown?"Certified SafeRead deadline elapsed after Revit dispatch; outcome is unknown and must not be retried automatically.":"Certified SafeRead deadline elapsed before execution dispatch.";retryable=!outcomeUnknown;break;case CertifiedFailureCode.AuthorizationUnavailable:status=503;wire="authorization_unavailable";error="Backend final authorization was unavailable or invalid.";retryable=true;break;case CertifiedFailureCode.RevitUnavailable:status=503;wire="revit_unavailable";error="Revit could not execute the certified read.";retryable=!outcomeUnknown;break;default:status=500;wire="internal_failure";error="Certified SafeRead failed closed.";retryable=false;break;}
            if(outcomeUnknown){requestDispatched=true;retryable=false;}
            return new ResponsePayload(status,"{\"schema\":"+Protocol.Quote(SafeReadContract.FailureSchema)+",\"code\":"+Protocol.Quote(wire)+",\"error\":"+Protocol.Quote(error)+",\"retryable\":"+(retryable?"true":"false")+",\"request_dispatched\":"+(requestDispatched?"true":"false")+",\"outcome_unknown\":"+(outcomeUnknown?"true":"false")+",\"phase\":"+Protocol.Quote(Phase(phase))+"}");
        }
        public static ResponsePayload AuthorizationFailure(BackendAuthorizationFailure failure)
        {
            bool unknown=failure.OutcomeUnknown,dispatched=unknown||failure.RequestDispatched,retryable=unknown?false:failure.Retryable;
            return new ResponsePayload(503,"{\"schema\":"+Protocol.Quote(SafeReadContract.FailureSchema)+",\"code\":\"authorization_unavailable\",\"error\":"+Protocol.Quote(failure.Error)+",\"retryable\":"+(retryable?"true":"false")+",\"request_dispatched\":"+(dispatched?"true":"false")+",\"outcome_unknown\":"+(unknown?"true":"false")+",\"phase\":\"authorization\"}");
        }
        private static string Phase(CertifiedExecutionPhase value)=>value==CertifiedExecutionPhase.CaptureBinding?"capture_binding":value==CertifiedExecutionPhase.VerifyFinalReceipt?"authorization":value==CertifiedExecutionPhase.CountSheets?"execution":value==CertifiedExecutionPhase.Completed?"completed":"admission";
    }
}
