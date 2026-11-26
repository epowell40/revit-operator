import path from 'node:path';

// Decode only the existing artifact link contract. No external URLs, UNC paths,
// arbitrary relative paths or custom-protocol application dispatch.
export function operatorArtifactOpenPath(value, workspace) {
 if(typeof value!=='string'||!/^op:\/\//i.test(value))return null;
 const url=new URL(value);
 if(url.hostname!=='open-folder'||url.username||url.password||url.port||url.hash
   || !['','/'].includes(url.pathname)||[...url.searchParams.keys()].some(k=>k!=='path')
   ||url.searchParams.getAll('path').length!==1)throw Error('Unsupported Operator artifact link.');
 const relative=url.searchParams.get('path').replaceAll('\\','/');
 if(!relative.startsWith('artifacts/')||relative.includes('\0')||relative.includes(':')
   ||relative.split('/').some(p=>!p||p==='.'||p==='..'))throw Error('Artifact link must stay inside workspace artifacts.');
 return path.resolve(workspace,...relative.split('/'));
}
