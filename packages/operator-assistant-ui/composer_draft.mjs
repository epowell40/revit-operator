const MAX_AGE_MS = 24 * 60 * 60 * 1000;
// The Sidecar allows at most a 200 MiB configured file cap and a combined
// payload smaller than 225 MiB. Store raw bytes within that envelope.
const MAX_FILE_BYTES = 200 * 1024 * 1024;
const MAX_ATTACHMENT_BYTES = 225 * 1024 * 1024;

function normalizedDraft(value, binary = false) {
  if (!value || typeof value.text !== 'string' || value.text.length > 100_000
    || !Array.isArray(value.attachments) || value.attachments.length > 8) throw new Error('Draft exceeds local recovery limits.');
  let bytes = 0;
  const attachments = value.attachments.map(item => {
    if (!item || typeof item.id !== 'string' || item.id.length > 240
      || typeof item.name !== 'string' || item.name.length > 512
      || typeof item.mimeType !== 'string' || item.mimeType.length > 160
      || !Number.isSafeInteger(item.sizeBytes) || item.sizeBytes < 0 || item.sizeBytes > MAX_FILE_BYTES
      || (binary ? !(item.payload instanceof Blob) || item.payload.size !== item.sizeBytes
        : typeof item.dataBase64 !== 'string' || item.dataBase64.length !== 4 * Math.ceil(item.sizeBytes / 3))) {
      throw new Error('Draft attachment is invalid.');
    }
    bytes += item.sizeBytes;
    if (bytes > MAX_ATTACHMENT_BYTES) throw new Error('Draft exceeds local recovery limits.');
    const { id, name, mimeType, sizeBytes } = item;
    return { id, name, mimeType, sizeBytes, ...(binary ? {payload:item.payload} : {dataBase64:item.dataBase64}) };
  });
  return { text: value.text, attachments, sessionId: typeof value.sessionId === 'string' ? value.sessionId.slice(0, 240) : '' };
}

// Chunk the fallback on a Base64 boundary for older WebView2 versions.
function attachmentBlob(encoded, size) {
  let payload;
  if (typeof Uint8Array.fromBase64 === 'function') {
    payload = new Blob([Uint8Array.fromBase64(encoded)]);
  } else {
    const parts = [];
    for (let offset = 0; offset < encoded.length; offset += 32_768) {
      parts.push(Uint8Array.from(atob(encoded.slice(offset, offset + 32_768)), char => char.charCodeAt(0)));
    }
    payload = new Blob(parts);
  }
  if (payload.size !== size) throw new Error('Draft attachment bytes do not match its size.');
  return payload;
}

async function base64ForAttachment(payload) {
  const bytes = new Uint8Array(await payload.arrayBuffer());
  if (typeof bytes.toBase64 === 'function') return bytes.toBase64();
  const parts = [];
  for (let offset = 0; offset < bytes.length; offset += 24_576) {
    parts.push(btoa(String.fromCharCode(...bytes.subarray(offset, offset + 24_576))));
  }
  return parts.join('');
}

/** IndexedDB is local to this origin. Each tab gets a separate recovery key. */
export function indexedDbDraftStorage(indexedDB = globalThis.indexedDB) {
  let database;
  const open = () => database ||= new Promise((resolve, reject) => {
    if (!indexedDB) return reject(new Error('Local draft storage is unavailable.'));
    const request = indexedDB.open('operator-composer-drafts', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('drafts');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
  const transaction = async (mode, action) => {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('drafts', mode);
      const request = action(tx.objectStore('drafts'));
      tx.oncomplete = () => resolve(request?.result);
      tx.onabort = tx.onerror = () => reject(tx.error || new Error('Could not save the draft locally.'));
    });
  };
  return {
    get: key => transaction('readonly', store => store.get(key)),
    put: (key, value) => transaction('readwrite', store => store.put(value, key)),
    delete: key => transaction('readwrite', store => store.delete(key)),
    prune: now => transaction('readwrite', store => {
      const cursor = store.openCursor();
      cursor.onsuccess = () => {
        const entry = cursor.result;
        if (!entry) return;
        if (!Number.isFinite(entry.value?.savedAt) || now - entry.value.savedAt > MAX_AGE_MS) entry.delete();
        entry.continue();
      };
    })
  };
}

/** Serialize saves and clears so a slow write cannot resurrect a sent draft. */
export function createComposerDraftStore({ storage = indexedDbDraftStorage(), now = Date.now } = {}) {
  let pending = Promise.resolve();
  const payloads = new WeakMap();
  const enqueue = operation => {
    const result = pending.catch(() => {}).then(operation);
    pending = result;
    return result;
  };
  const validKey = key => {
    if (typeof key !== 'string' || !/^[A-Za-z0-9-]{8,100}$/.test(key)) throw new Error('Draft recovery key is unavailable.');
    return key;
  };
  return {
    save(key, value) {
      try {
        validKey(key);
        const normalized = normalizedDraft(value);
        const attachments = normalized.attachments.map(({dataBase64,...metadata}, index) => {
          const item = value.attachments[index];
          const cached = payloads.get(item);
          const payload = cached?.encoded === dataBase64 && cached.payload.size === metadata.sizeBytes
            ? cached.payload : attachmentBlob(dataBase64, metadata.sizeBytes);
          payloads.set(item, {encoded:dataBase64,payload});
          return {...metadata,payload};
        });
        const draft = {...normalized,attachments};
        return enqueue(() => !draft.text && !draft.attachments.length
          ? storage.delete(key) : storage.put(key, { version: 2, savedAt: now(), ...draft }));
      } catch (error) { return Promise.reject(error); }
    },
    load(key) {
      validKey(key);
      return enqueue(async () => {
        await storage.prune?.(now());
        const value = await storage.get(key);
        if (!value) return null;
        let draft;
        try {
          if (![1,2].includes(value.version) || !Number.isFinite(value.savedAt) || now() - value.savedAt > MAX_AGE_MS || value.savedAt > now() + 60_000) throw new Error('Expired draft');
          draft = normalizedDraft(value, value.version === 2);
        } catch { await storage.delete(key); return null; }
        if (value.version === 1) return draft;
        const attachments = [];
        for (const {payload,...metadata} of draft.attachments) {
          const dataBase64 = await base64ForAttachment(payload);
          const item = {...metadata,dataBase64};
          payloads.set(item, {encoded:dataBase64,payload});
          attachments.push(item);
        }
        return {...draft,attachments};
      });
    },
    clear(key) { validKey(key); return enqueue(() => storage.delete(key)); }
  };
}

/** A stale-page warning belongs to the composer, independent of idle polling. */
export function staleComposerNotice(saved) {
  return saved
    ? 'Operator was updated. Refresh to continue; your unsent text and attachments are saved.'
    : 'Operator was updated. Copy your unsent text and keep the original attachments before refreshing; local draft recovery is unavailable.';
}

const REFRESH_TARGET_KEY = 'operator-desktop.composer-refresh-target';
/** An intentional composer Refresh can reopen its draft's conversation for
 * review. This is navigation intent only; never execution or Resume authority. */
export function saveComposerRefreshTarget(storage, tabId, sessionId, now = Date.now()) {
  if (typeof tabId !== 'string' || !tabId || tabId.length > 240 || typeof sessionId !== 'string' || sessionId.length > 240) throw Error('Invalid refresh target');
  storage.setItem(REFRESH_TARGET_KEY, JSON.stringify({ schema: 'revit-operator.composer-refresh/v1', tabId, sessionId, at: now }));
}
export function readComposerRefreshTarget(storage, tabId, now = Date.now()) {
  try {
    const value = JSON.parse(storage.getItem(REFRESH_TARGET_KEY));
    if (value?.schema === 'revit-operator.composer-refresh/v1' && value.tabId === tabId
      && typeof value.sessionId === 'string' && value.sessionId.length <= 240
      && Number.isFinite(value.at) && value.at <= now + 60_000 && now - value.at <= MAX_AGE_MS) return value;
  } catch { /* Corrupt or unavailable navigation storage grants nothing. */ }
  return null;
}
export function clearComposerRefreshTarget(storage) { storage.removeItem(REFRESH_TARGET_KEY); }
