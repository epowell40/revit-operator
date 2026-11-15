import {runtimeSourcesSha256} from '../../apps/operator-desktop/runtime_sources.mjs';
import {fileURLToPath} from 'node:url';
console.log(runtimeSourcesSha256(fileURLToPath(new URL('../../apps/operator-desktop/',import.meta.url))));
