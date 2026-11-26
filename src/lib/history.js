// 练习历史（IndexedDB，含录音）
const DB = "learn-language";
const STORE = "sessions";

function open() {
  return new Promise((resolve, reject) => {
    if (!("indexedDB" in window)) return reject(new Error("no indexedDB"));
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const s = db.createObjectStore(STORE, { keyPath: "id" });
        s.createIndex("startedAt", "startedAt");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(mode, fn) {
  return open().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const store = t.objectStore(STORE);
        const p = Promise.resolve(fn(store));
        t.oncomplete = () => p.then(resolve, reject);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      })
  );
}

function reqP(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

/** 把运行时 session 转成可存储记录 */
export function toRecord(s) {
  return {
    id: s.id,
    startedAt: s.startedAt,
    endedAt: s.endedAt,
    mission: s.mission,
    accent: s.accent,
    level: s.level,
    mode: s.mode,
    topic: s.topic || "",
    teacherLang: s.teacherLang || undefined,
    singleModel: s.singleModel || undefined,
    missionComplete: !!s.missionComplete,
    transcript: s.transcript,
    summary: s.summary || null,
    turns: s.turns.map((t) => ({
      id: t.id,
      text: t.text,
      prevCharacterText: t.prevCharacterText,
      analysis: t.analysis || null,
      error: t.error || null,
      missing: t.status === "missing" || undefined,
      single: t.single || undefined,
      teacherWhole: t.teacherWhole || undefined,
      pcm: t.pcm ? t.pcm.buffer.slice(t.pcm.byteOffset, t.pcm.byteOffset + t.pcm.byteLength) : null,
      teacherPcm: t.teacherPcm ? t.teacherPcm.buffer.slice(t.teacherPcm.byteOffset, t.teacherPcm.byteOffset + t.teacherPcm.byteLength) : null,
    })),
  };
}

export function fromRecord(r) {
  return {
    ...r,
    fromHistory: true,
    turns: r.turns.map((t) => ({
      ...t,
      status: t.analysis ? "done" : t.missing ? "missing" : t.error ? "error" : "done",
      pcm: t.pcm ? new Int16Array(t.pcm) : null,
      teacherPcm: t.teacherPcm ? new Int16Array(t.teacherPcm) : null,
    })),
  };
}

export async function saveSession(s) {
  try {
    await tx("readwrite", (store) => store.put(toRecord(s)));
    return true;
  } catch (e) {
    console.warn("保存历史失败", e);
    return false;
  }
}

export async function listSessions() {
  try {
    const all = await tx("readonly", (store) => reqP(store.getAll()));
    return (all || [])
      .map((r) => ({
        id: r.id,
        startedAt: r.startedAt,
        endedAt: r.endedAt,
        mission: r.mission,
        accent: r.accent,
        count: r.turns.length,
        score: r.summary?.score,
      }))
      .sort((a, b) => b.startedAt - a.startedAt);
  } catch {
    return [];
  }
}

export async function getSession(id) {
  const r = await tx("readonly", (store) => reqP(store.get(id)));
  return r ? fromRecord(r) : null;
}

export async function deleteSession(id) {
  try {
    await tx("readwrite", (store) => store.delete(id));
  } catch {}
}
