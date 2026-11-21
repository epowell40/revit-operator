import fs from 'node:fs';

// Windows readers can briefly keep the destination open. Retry only the
// atomic replacement of these same bytes, never the operation that made them.
export function renameStagedFile(source: string, destination: string): void {
  const delays = [25, 75, 150];
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(source, destination);
      return;
    } catch (error) {
      const delay = delays[attempt];
      const code = (error as NodeJS.ErrnoException).code;
      if (delay === undefined || !['EPERM', 'EACCES', 'EBUSY'].includes(code ?? '')) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
    }
  }
}
