// 模型自动选择 + 停用模型自动迁移
//
// 三类模型：live（实时对话）、text（老师点评/总结）、tts（语音合成）
// 规则：
//  - 每天最多查一次模型列表（listModels，自己 Key 直连 / 邀请码走中转），结果缓存在 localStorage
//  - 用户在设置里手动指定的模型优先；但若是旧默认值、或已被判定不可用、或不在可用列表里，就自动迁移
//  - 任何“模型已停用/不存在/不支持”的错误：解析错误信息里推荐的 models/xxx，没有就用检测结果，换模型重试一次并记住

import { getSetting, setSetting, DEFAULTS } from "./settings.js";

export const KIND_SETTING = { live: "liveModel", text: "teacherModel", tts: "ttsModel" };

// 以前版本用过的默认值：遇到就迁移
export const LEGACY_DEFAULTS = {
  live: ["gemini-2.5-flash-native-audio-preview-12-2025", "gemini-2.5-flash-native-audio-preview-09-2025", "gemini-live-2.5-flash-native-audio"],
  text: ["gemini-2.5-flash", "gemini-2.0-flash"],
  tts: ["gemini-2.5-flash-preview-tts", "gemini-2.5-pro-preview-tts"],
};

const CACHE_KEY = "ll_modelCache";
const BAD_KEY = "ll_badModels";
const MANUAL_KEY = "ll_modelManual";

function load(key, d) {
  try {
    const v = localStorage.getItem(key);
    return v ? JSON.parse(v) : d;
  } catch {
    return d;
  }
}
function save(key, v) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {}
}

const strip = (m) => String(m || "").replace(/^models\//, "").trim();

// ---------------- 不可用模型 & 手动标记 ----------------

export function badModels() {
  return load(BAD_KEY, []);
}
export function markBad(model) {
  const m = strip(model);
  const list = badModels();
  if (m && !list.includes(m)) {
    list.push(m);
    save(BAD_KEY, list.slice(-50));
  }
}
export function isBad(model) {
  return badModels().includes(strip(model));
}

/** 设置页保存时调用：值与之前不同就记为“用户手动指定” */
export function setManual(kind, manual) {
  const m = load(MANUAL_KEY, {});
  m[kind] = !!manual;
  save(MANUAL_KEY, m);
}
export function isManual(kind) {
  return !!load(MANUAL_KEY, {})[kind];
}

// ---------------- 挑选规则 ----------------

/** 解析 gemini-X.Y 的版本号，用于比较 */
function version(name) {
  const m = name.match(/^gemini-(\d+)(?:\.(\d+))?/);
  return m ? [Number(m[1]), Number(m[2] || 0)] : [0, 0];
}
const isPreview = (n) => /preview|exp|experimental/.test(n);

/** 排序：版本号高的优先；同版本稳定版优先；再按名称（日期后缀）倒序 */
function rank(arr, extra = () => 0) {
  return [...arr].sort((a, b) => {
    const [a1, a2] = version(a);
    const [b1, b2] = version(b);
    if (a1 !== b1) return b1 - a1;
    if (a2 !== b2) return b2 - a2;
    const e = extra(a) - extra(b);
    if (e) return e;
    const p = Number(isPreview(a)) - Number(isPreview(b));
    if (p) return p;
    return b.localeCompare(a, "en", { numeric: true });
  });
}

/**
 * 输入：[{ name, methods }]
 * 输出：{ live: [...], text: [...], tts: [...] }，每类按推荐顺序排列（第一个最好）
 */
export function pickModels(models) {
  const list = (models || []).map((m) => ({ name: strip(m.name), methods: m.methods || m.supportedGenerationMethods || [] }));
  const gen = list.filter((m) => m.methods.includes("generateContent")).map((m) => m.name);
  const bidi = list.filter((m) => m.methods.includes("bidiGenerateContent")).map((m) => m.name);

  // 老师/总结：gemini-X(.Y)-flash 纯名字最好；退而求其次接受 -preview 之类，但排除 tts/audio/live/image/lite 等
  const BAD_TEXT = /tts|audio|live|image|lite|embedding|robotics|computer|transcribe|translate|thinking|nano|veo|imagen|aqa/;
  const textAll = gen.filter((n) => /^gemini-\d+(\.\d+)?-flash/.test(n) && !BAD_TEXT.test(n));
  const textPure = textAll.filter((n) => /^gemini-\d+(\.\d+)?-flash$/.test(n));
  const text = [...rank(textPure), ...rank(textAll.filter((n) => !textPure.includes(n)))];

  // TTS：名字含 tts；非 lite、稳定版优先
  const tts = rank(
    gen.filter((n) => /^gemini-/.test(n) && /tts/.test(n)),
    (n) => (/lite/.test(n) ? 1 : 0) + (/pro/.test(n) ? 0.5 : 0)
  );

  // Live：支持 bidiGenerateContent 且名字含 native-audio 或 live；排除转写/翻译；“扩展思考”等变体靠后
  const live = rank(
    bidi.filter((n) => /native-audio|live/.test(n) && !/transcribe|translate/.test(n)),
    (n) => (/extended|thinking/.test(n) ? 2 : 0) + (/lite/.test(n) ? 1 : 0)
  );

  return { live, text, tts };
}

// ---------------- 模型列表缓存 ----------------

const today = () => new Date().toISOString().slice(0, 10);

export function cachedPicks() {
  const c = load(CACHE_KEY, null);
  return c && c.picks ? c : null;
}

/**
 * 获取（并缓存）推荐模型。force=true 时忽略“每天一次”的限制。
 * listModelsFn 由调用方注入，避免循环依赖
 */
let inflight = null;
export async function refreshPicks(listModelsFn, { force = false } = {}) {
  const c = cachedPicks();
  if (!force && c && c.day === today()) return c.picks;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const models = await listModelsFn();
      const picks = pickModels(models);
      save(CACHE_KEY, { day: today(), picks });
      return picks;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** 某类的最佳可用模型（跳过已判定不可用的） */
export function bestOf(kind, picks) {
  const arr = (picks && picks[kind]) || [];
  return arr.find((n) => !isBad(n)) || null;
}

/**
 * 根据推荐结果调整当前设置。返回 [{kind, from, to}] 变更列表
 */
export function applyPicks(picks) {
  const changes = [];
  for (const kind of Object.keys(KIND_SETTING)) {
    const key = KIND_SETTING[kind];
    const cur = strip(getSetting(key));
    const best = bestOf(kind, picks);
    if (!best || best === cur) continue;
    const available = (picks[kind] || []).includes(cur);
    const legacy = LEGACY_DEFAULTS[kind].includes(cur);
    const listKnown = (picks[kind] || []).length > 0;
    let change;
    if (!cur || legacy || isBad(cur)) change = true;
    else if (isManual(kind)) change = listKnown && !available; // 手动指定：只有确定不可用才换
    else change = true; // 自动模式：总是用最新的推荐
    if (change) {
      setSetting(key, best);
      changes.push({ kind, from: cur, to: best });
    }
  }
  return changes;
}

/** 启动时调用：旧默认值先迁移到新默认值，然后（每天一次）自动检测 */
export async function autoSelectModels(listModelsFn) {
  for (const kind of Object.keys(KIND_SETTING)) {
    const key = KIND_SETTING[kind];
    const cur = strip(getSetting(key));
    if (LEGACY_DEFAULTS[kind].includes(cur) || (cur && isBad(cur) && cur !== DEFAULTS[key])) {
      setSetting(key, DEFAULTS[key]);
    }
  }
  try {
    const picks = await refreshPicks(listModelsFn);
    return applyPicks(picks);
  } catch (e) {
    console.warn("自动检测模型失败（不影响使用）：", e.message);
    return [];
  }
}

// ---------------- 错误识别与替换 ----------------

const GONE_RE = /no longer available|not found|is not supported|not supported for|unsupported model|does not exist|has been (?:deprecated|shut ?down|retired|discontinued)|is deprecated|was deprecated|been removed|unknown model|invalid model/i;

export function isModelGoneError(err) {
  const msg = String(err?.message || err || "");
  if (!msg) return false;
  if (err?.status === 404) return true;
  if (/thinking/i.test(msg)) return false; // 交给 thinking 降级处理
  return GONE_RE.test(msg);
}

/** 从错误信息里找推荐模型，比如 "use models/gemini-3.8-flash for ..." */
export function suggestedModel(message, kind, current) {
  const found = [...String(message || "").matchAll(/models\/(gemini-[a-z0-9][a-z0-9.\-]*[a-z0-9])/gi)].map((m) => m[1].toLowerCase());
  const cur = strip(current);
  const fits = (n) => {
    if (n === cur || isBad(n)) return false;
    if (kind === "tts") return /tts/.test(n);
    if (kind === "live") return /live|native-audio/.test(n);
    return !/tts|live|native-audio|image|embedding/.test(n);
  };
  return found.find(fits) || null;
}

/**
 * 当前模型不可用时，找一个替代并写入设置。返回新模型名或 null
 */
export async function replaceModel(kind, failedModel, message, listModelsFn) {
  markBad(failedModel);
  let next = suggestedModel(message, kind, failedModel);
  if (!next) {
    try {
      const picks = await refreshPicks(listModelsFn, { force: true });
      next = bestOf(kind, picks);
    } catch {}
  }
  if (!next) {
    const def = DEFAULTS[KIND_SETTING[kind]];
    if (def !== strip(failedModel) && !isBad(def)) next = def;
  }
  if (next && next !== strip(failedModel)) {
    setSetting(KIND_SETTING[kind], next);
    console.info(`模型 ${failedModel} 不可用，已自动切换为 ${next}`);
    return next;
  }
  return null;
}

/** 根据模型名猜它属于哪一类（用于 generateContent 的自动替换） */
export function kindOfModel(model) {
  const m = strip(model);
  if (m === strip(getSetting("ttsModel")) || /tts/.test(m)) return "tts";
  if (m === strip(getSetting("liveModel"))) return "live";
  return "text";
}
