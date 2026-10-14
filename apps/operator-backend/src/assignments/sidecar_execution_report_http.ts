import type http from 'node:http';
import {handleSidecarExecutionFailureHttp} from './sidecar_execution_failure_http.js';
import {handleSidecarSupportingReceiptHttp} from './sidecar_supporting_receipt.js';

/** Called only within the composition's authenticated request context.
 * Both handlers retain the same caller-owned session access boundary. */
export async function handleSidecarExecutionReportHttp(req: http.IncomingMessage,res: http.ServerResponse,url: URL,
  boundary: Parameters<typeof handleSidecarSupportingReceiptHttp>[2]): Promise<boolean> {
  if(req.method!=='POST')return false;
  if(url.pathname==='/api/agent-goal/sidecar-receipt'){await handleSidecarSupportingReceiptHttp(req,res,boundary);return true;}
  if(url.pathname==='/api/agent-goal/sidecar-execution-failure'){await handleSidecarExecutionFailureHttp(req,res,boundary);return true;}
  return false;
}
