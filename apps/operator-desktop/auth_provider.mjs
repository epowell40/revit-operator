/** Standalone account boundary. No hosted token store or login implementation. */
export function createAuthProvider({loadOperatorClientConfig,resolveBackendUrl,resolveOperatorToken}) {
  function validateRuntime() {
    const url=new URL(resolveBackendUrl());
    const mode=String(loadOperatorClientConfig()?.auth_mode||'shared_token');
    if(url.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)
      ||url.username||url.password||url.pathname!=='/'||url.search||url.hash
      ||!['none','shared_token'].includes(mode)||String(process.env.OPERATOR_BEARER_TOKEN||'').trim()) {
      throw new Error('Standalone Operator requires its local backend. Start it with Start-OpenCore.cmd.');
    }
  }
  function status() {
    validateRuntime();
    let available=false;try{available=!!resolveOperatorToken();}catch{}
    return {authMode:'shared_token',backendUrl:resolveBackendUrl(),backendLocal:true,
      signInRequired:false,sharedTokenAvailable:available,accessTokenCached:false,
      refreshTokenCached:false,authStoreExists:false,lastRefreshError:null};
  }
  function unavailable(){throw new Error('No account sign-in is used in standalone Operator. Configure OpenCore.settings.txt and restart.');}
  return {validateRuntime,status,refreshStatus:async()=>status(),isAccountMode:()=>false,
    loadOperatorAuthTokenSet:async()=>null,clearOperatorAuthTokenCache(){},normalizeStoredTokenSet:()=>null,
    persistOperatorAuthTokenSet:unavailable,clearOperatorAuthTokenSet:async()=>status(),
    login:unavailable,ensureTokens:unavailable};
}
