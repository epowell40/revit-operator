import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';

// An input obligation belongs to its admitted task, including across resume.
// Other tasks keep their own records; this does not clear their native effects.
export function desktopReadinessFilename(root, assignment) {
  if (!assignment) return path.join(root, 'desktop-native-readiness-required.json');
  const id=assignment.goal_id || assignment.assignment_id;
  if(typeof id!=='string'||!id||typeof assignment.session_id!=='string'||!assignment.session_id)
    throw Error('desktop_readiness_owner_required');
  const key=createHash('sha256').update(JSON.stringify([assignment.session_id,id])).digest('hex');
  return path.join(root,'desktop-native-readiness',key+'.json');
}

// A sticky requirement for fresh native readiness checks, not an effect receipt.
// Never clear this on chat reset, successful probing, or provider termination.
// Keeping it monotonic also prevents a late probe from clearing newer input.
export function createDesktopReadinessObligation(filename) {
  return {
    filename,
    required() {
      try { fs.lstatSync(filename); return true; }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        // Windows may report ENOENT for a child of a file, not ENOTDIR.
        try {
          if (!fs.statSync(path.dirname(filename)).isDirectory())
            throw new Error('desktop_readiness_state_directory_invalid');
        } catch (parentError) { if (parentError.code !== 'ENOENT') throw parentError; }
        return false;
      }
    },
    beforeInput() {
      fs.mkdirSync(path.dirname(filename), {recursive: true});
      let fd;
      try {
        fd = fs.openSync(filename, 'wx', 0o600);
        fs.writeFileSync(fd, JSON.stringify({schema: 1, fresh_native_readiness_required: true}) + '\n');
        fs.fsyncSync(fd);
      } catch (error) {
        // Even an empty/interrupted record remains an obligation. Never parse
        // malformed persisted state as permission to skip the native check.
        if (error.code !== 'EEXIST') throw error;
      } finally { if (fd !== undefined) fs.closeSync(fd); }
    }
  };
}
