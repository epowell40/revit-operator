import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

/** Display-only child. It cannot capture the desktop, send input, or authorize work. */
export function createComputerControlIndicator(readState, options = {}) {
  const platform = options.platform || process.platform, launch = options.spawn || spawn;
  let child = null, heartbeat = null, failed = false, ready = false;
  const active = () => {const s=readState();return s.running === true && s.desktopCaptureSuppressed === false;};
  function stop() {
    clearInterval(heartbeat);heartbeat=null;
    const old=child;child=null;ready=false;
    // EOF closes only our display process. Never kill a desktop app or alter input.
    if(old){old.stdin.end();old.unref?.();}
  }
  function update() {
    if(!active()){stop();failed=false;return;}
    if(platform!=='win32'||failed||child)return;
    try {
      child=launch(fileURLToPath(new URL('./indicator/bin/Release/net48/OperatorControlIndicator.exe',import.meta.url)),[],
        {windowsHide:true,stdio:['pipe','pipe','ignore']});
      const owned=child;
      const unavailable=()=>{if(child===owned){failed=true;stop();}};
      owned.on('error',unavailable);owned.on('exit',unavailable);
      owned.stdin.on('error',unavailable);
      owned.stdout.on('data',data=>{if(child===owned&&String(data).includes('READY'))ready=true;});
      owned.stdin.write('active\n');
      heartbeat=setInterval(()=>{if(!active()){stop();failed=false;}else if(child===owned)owned.stdin.write('active\n');},1000);
      heartbeat.unref?.();
    } catch {failed=true;stop();}
  }
  return {update,stop,status:()=>platform!=='win32'?'unsupported':failed?'unavailable':ready?'visible':child?'starting':'idle'};
}
