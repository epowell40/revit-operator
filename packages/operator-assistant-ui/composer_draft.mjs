const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_ENCODED_BYTES = 144 * 1024 * 1024;

function normalizedDraft(value) {
  if (!value || typeof value.text !== 'string' || value.text.length > 100_000
    || !Array.isArray(value.attachments) || value.attachments.length > 8) throw new Error('Draft exceeds local recovery limits.');
  let bytes = value.text.length * 2;
  const attachments = value.attachments.map(item => {
    if (!item || typeof item.id !== 'string' || item.id.length > 240
      || typeof item.name !== 'string' || item.name.length > 512
      || typeof item.mimeType !== 'string' || item.mimeType.length > 160
      || typeof item.dataBase64 !== 'string' || !Number.isSafeInteger(item.sizeBytes) || item.sizeBytes < 0) throw new Error('Draft attachment is invalid.');
    bytes += item.dataBase64.length * 2;
    if (bytes > MAX_ENCODED_BYTES) throw new Error('Draft exceeds local recovery limits.');
    return { id: item.id, name: item.name, mimeType: item.mimeType, sizeBytes: item.sizeBytes, dataBase64: item.dataBase64 };
  });
  return { text: value.text, attachments, sessionId: typeof value.sessionId === 'string' ? value.sessionId.slice(0, 240) : '' };
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
        const draft = normalizedDraft(value);
        return enqueue(() => !draft.text && !draft.attachments.length
          ? storage.delete(key) : storage.put(key, { version: 1, savedAt: now(), ...draft }));
      } catch (error) { return Promise.reject(error); }
    },
    load(key) {
      validKey(key);
      return enqueue(async () => {
        await storage.prune?.(now());
        const value = await storage.get(key);
        if (!value) return null;
        try {
          if (value.version !== 1 || !Number.isFinite(value.savedAt) || now() - value.savedAt > MAX_AGE_MS || value.savedAt > now() + 60_000) throw new Error('Expired draft');
          return normalizedDraft(value);
        } catch { await storage.delete(key); return null; }
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
