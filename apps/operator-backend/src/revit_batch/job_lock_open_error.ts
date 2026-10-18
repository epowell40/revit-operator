/** Only failures of exclusive lock-file OPEN may enter bounded acquisition wait.
 * No filesystem denial establishes ownership; metadata/action failures never retry. */
export function jobLockOpenWaitKind(error:unknown,platform:NodeJS.Platform):'existing'|'windows_denial'|null {
 const code=error&&typeof error==='object'?(error as NodeJS.ErrnoException).code:undefined;
 return code==='EEXIST'?'existing':platform==='win32'&&code==='EPERM'?'windows_denial':null;
}
