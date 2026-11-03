import {getRequestContext} from '../request_context.js';
import {assignmentKernelV2Enabled} from '../domain/assignment-kernel/feature_flag.js';
import {getSidecarAgentProfileState} from '../capabilities/sidecar_agent_profile.js';
import {trustedLocalExperimentHost} from './local_advisory_policy.js';
import {isHostedRuntime} from '../runtime_mode.js';

/** Transport availability for the existing local desktop executor. This must
 * not select the optional advisory verification policy. The current canonical
 * assignment, native authority and tool admission remain independently checked. */
export function localDesktopNativeTransportAvailable(env:NodeJS.ProcessEnv=process.env,context=getRequestContext()):boolean {
  let selfHosted=false;
  try {
    selfHosted=env.REVIT_OPERATOR_MODE==='self_hosted'&&!isHostedRuntime(env)&&!context?.principal
      &&context?.operator_backend_auth?.mode==='shared_token'
      &&['127.0.0.1','localhost','[::1]'].includes(new URL(context.operator_backend_auth.allowed_origin).hostname);
  } catch { /* An invalid origin cannot select transport or advisory policy. */ }
  const hosted = (env.REVIT_OPERATOR_MODE==='hosted'||env.REVIT_OPERATOR_MODE==='production')
    &&env.OPERATOR_REVIT_TRANSPORT==='courier'&&Boolean(context?.principal)
    &&context?.operator_backend_auth?.mode==='principal_jwt';
  return (trustedLocalExperimentHost(env,context)||selfHosted||hosted)&&assignmentKernelV2Enabled(env)
    &&getSidecarAgentProfileState(env).general_agent_ready;
}
