import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';

/** Display and physical Escape takeover only. Never grants or resumes work. */
export function createComputerControlIndicator(readState, options = {}) {
  const platform = options.platform || process.platform, launch = options.spawn || spawn;
  let child = null, heartbeat = null, failed = false, ready = false, stopEvent = '', stopped = false;
  const active = () => {const s=readState();return s.running === true && s.desktopCaptureSuppressed === false;};
  function stop() {
    clearInterval(heartbeat);heartbeat=null;
    const old=child;child=null;ready=false;stopEvent='';
    // EOF closes only our display process. Never kill a desktop app or alter input.
    if(old){old.stdin.end();old.unref?.();}
  }
  function update() {
    if(!active()){stop();failed=false;return;}
    if(platform!=='win32'||failed||child)return;
    try {
      stopEvent='Local\\OperatorInputStop_'+randomUUID().replaceAll('-','');stopped=false;
      child=launch(fileURLToPath(new URL('./indicator/bin/Release/net48/OperatorControlIndicator.exe',import.meta.url)),[stopEvent],
        {windowsHide:true,stdio:['pipe','pipe','ignore']});
      const owned=child;
      const requestStop=()=>{if(child===owned&&active()&&!stopped){stopped=true;options.onStop?.();}};
      const unavailable=()=>{if(child===owned){requestStop();failed=true;stop();}};
      owned.on('error',unavailable);owned.on('exit',unavailable);
      owned.stdin.on('error',unavailable);
      let lines='';
      owned.stdout.on('data',data=>{
        if(child!==owned)return;
        lines+=String(data);if(lines.length>4096){unavailable();return;}
        let end;while((end=lines.indexOf('\n'))>=0){
          const line=lines.slice(0,end).trim();lines=lines.slice(end+1);
          if(line==='READY')ready=true;
          if(line==='STOP')requestStop();
        }
      });
      owned.stdin.write('active\n');
      heartbeat=setInterval(()=>{if(!active()){stop();failed=false;}else if(child===owned)owned.stdin.write('active\n');},1000);
      heartbeat.unref?.();
    } catch {failed=true;options.onStop?.();stop();}
  }
  function latchStop() {stopped=true;if(child)child.stdin.write('stop\n');}
  return {update,stop,latchStop,inputStopEvent:()=>stopEvent,status:()=>platform!=='win32'?'unsupported':failed?'unavailable':stopped?'stopped':ready?'visible':child?'starting':'idle'};
}
