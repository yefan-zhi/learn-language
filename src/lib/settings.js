// 本地设置（只存在本机浏览器 localStorage）

export const DEFAULTS = {
  apiKey: "",
  inviteCode: "",
  // 默认模型（2026-11）；启动时会自动检测并切换到可用的最新版本，见 lib/models.js
  liveModel: "gemini-3.8-live",
  teacherModel: "gemini-3.8-flash",
  ttsModel: "gemini-3.8-flash-tts",
  characterVoice: "Puck",
  teacherVoice: "Kore",
  teacherVoiceSource: "browser", // browser（设备语音，快）| gemini（更自然，较慢）
  teacherSpeed: "standard", // standard（flash）| fast（flash-lite，更快，发音判断可能略弱）
  detailedTiming: false, // 卡片底部显示各阶段详细耗时
  teacherVoiceOn: true,
  accent: "us", // us | uk
  level: "intermediate", // beginner | intermediate | advanced
  mode: "immersive", // immersive | assisted
  stepMode: true, // 逐句模式：每句话后看完老师反馈再点“下一句”
  teacherLanguage: "zh", // 老师点评语言：zh（中文）| en（English）
  opener: "random", // 谁先开口：random（每次随机）| partner（对方）| me（我）
  singleModelMode: false, // 单模型模式：角色和老师由同一个实时模型担任（点评更快，共用一个声音）
};

export const LIVE_VOICES = ["Puck", "Charon", "Kore", "Fenrir", "Aoede", "Leda", "Orus", "Zephyr"];
export const TTS_VOICES = [
  "Kore", "Puck", "Zephyr", "Charon", "Fenrir", "Leda", "Orus", "Aoede",
  "Callirrhoe", "Autonoe", "Enceladus", "Iapetus", "Umbriel", "Algieba",
  "Despina", "Erinome", "Algenib", "Rasalgethi", "Laomedeia", "Achernar",
  "Alnilam", "Schedar", "Gacrux", "Pulcherrima", "Achird", "Zubenelgenubi",
  "Vindemiatrix", "Sadachbia", "Sadaltager", "Sulafat",
];

const PREFIX = "ll_";

function read(key) {
  try {
    const v = localStorage.getItem(PREFIX + key);
    if (v === null) return DEFAULTS[key];
    return JSON.parse(v);
  } catch {
    return DEFAULTS[key];
  }
}

// 一次性设置迁移（按版本号，只执行一次）
const SETTINGS_VERSION = 2;
(function migrate() {
  try {
    const v = Number(localStorage.getItem(PREFIX + "settingsVersion") || 0);
    if (v >= SETTINGS_VERSION) return;
    if (v < 2) {
      // v2：老师语音默认改为设备语音（更快）。旧版本默认是 gemini，统一迁移一次
      if (localStorage.getItem(PREFIX + "teacherVoiceSource") === JSON.stringify("gemini")) {
        localStorage.setItem(PREFIX + "teacherVoiceSource", JSON.stringify("browser"));
      }
    }
    localStorage.setItem(PREFIX + "settingsVersion", String(SETTINGS_VERSION));
  } catch {}
})();

export function getSetting(key) {
  return read(key);
}

export function setSetting(key, value) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {}
  window.dispatchEvent(new CustomEvent("settings-changed", { detail: { key, value } }));
}

export function getSettings() {
  const out = {};
  for (const k of Object.keys(DEFAULTS)) out[k] = read(k);
  return out;
}

export function hasApiKey() {
  return !!(read("apiKey") || "").trim();
}

export function hasInvite() {
  return !!(read("inviteCode") || "").trim();
}

/** 当前接入方式：有自己的 Key 优先用 Key，其次邀请码 */
export function authMode() {
  if (hasApiKey()) return "key";
  if (hasInvite()) return "invite";
  return null;
}

export function hasAccess() {
  return authMode() !== null;
}

/** 本设备的随机标识（用于邀请码模式按设备限额） */
export function getDeviceId() {
  const k = PREFIX + "deviceId";
  try {
    let id = localStorage.getItem(k);
    if (!id || !/^[A-Za-z0-9-]{8,64}$/.test(id)) {
      id = (crypto.randomUUID ? crypto.randomUUID() : Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join(""));
      localStorage.setItem(k, id);
    }
    return id;
  } catch {
    if (!window.__llDeviceId) window.__llDeviceId = crypto.randomUUID();
    return window.__llDeviceId;
  }
}

export const ACCENTS = {
  us: { label: "🇺🇸 美式英语", short: "美式", en: "American English", city: "New York", bcp47: "en-US" },
  uk: { label: "🇬🇧 英式英语", short: "英式", en: "British English", city: "London", bcp47: "en-GB" },
};

export const LEVELS = {
  beginner: { label: "初级", en: "beginner (A2): speak slowly and clearly, use simple everyday words and short sentences" },
  intermediate: { label: "中级", en: "intermediate (B1-B2): speak at a natural but not rushed pace, everyday idioms are fine" },
  advanced: { label: "高级", en: "advanced (C1): speak at a fully natural native pace with idioms, phrasal verbs and slang where appropriate" },
};

// ---------------- 老师点评语言 ----------------
const LABELS = {
  zh: {
    teacherSay: "老师说", better: "地道说法", expression: "表达", pron: "发音", intonation: "语调",
    natural: "表达地道", improve: "可以更地道", noSpeech: "（这句没听清你的英语，跳过点评）", generating: "继续生成中…",
    strengths: "👍 做得好", improvements: "🎯 要改进", phrases: "📌 本场景地道表达", timing: "点评用时",
  },
  en: {
    teacherSay: "Teacher", better: "Better", expression: "Wording", pron: "Pronunciation", intonation: "Intonation",
    natural: "Natural", improve: "Could be more natural", noSpeech: "(Couldn't hear your English clearly — skipped)", generating: "Writing…",
    strengths: "👍 What went well", improvements: "🎯 To improve", phrases: "📌 Useful phrases", timing: "Feedback in",
  },
};

export const TEACHER_LANGS = {
  zh: { label: "中文" },
  en: { label: "English" },
};

/**
 * 老师点评语言的说明（老师提示词、单模型模式都复用）
 * 返回 { key, label, promptName, instruction, speechLang, labels }
 *  - promptName：写进提示词里的语言名
 *  - instruction：一句完整的“请用某语言点评”的要求（英文，方便各种提示词直接拼接）
 *  - speechLang：朗读点评用的 BCP-47 语言（zh-CN / en-US / en-GB）
 */
export function teacherLang(key, accentKey) {
  return teacherLangInfo(key, accentKey);
}

/**
 * 单模型模式下老师的口头标记：开头的切换提示语 + 结尾回到角色的固定句子
 * （客户端靠它们把模型一轮输出拆成“老师”和“角色”两部分）
 */
export function coachMarkers(key) {
  const k = (key ?? read("teacherLanguage")) === "en" ? "en" : "zh";
  return k === "en"
    ? { start: "Coach:", end: "Okay, back to the conversation." }
    : { start: "老师：", end: "好，我们继续。" };
}

function teacherLangInfo(key, accentKey) {
  const k = (key ?? read("teacherLanguage")) === "en" ? "en" : "zh";
  const acc = ACCENTS[accentKey ?? read("accent")] || ACCENTS.us;
  if (k === "en") {
    return {
      key: "en",
      label: "English",
      promptName: `simple, clear ${acc.en}`,
      instruction: `Give all feedback, explanations and spoken comments in simple, clear ${acc.en} (short sentences, everyday B1-level words). Never use Chinese.`,
      speechLang: acc.bcp47,
      labels: LABELS.en,
    };
  }
  return {
    key: "zh",
    label: "中文",
    promptName: "简体中文",
    instruction: "Give all feedback, explanations and spoken comments in Simplified Chinese (简体中文); quote English words or sentences only where needed.",
    speechLang: "zh-CN",
    labels: LABELS.zh,
  };
}

/**
 * 决定这次练习谁先开口。random 时掷一次，并避免连续 3 次以上相同（记录最近几次结果）。
 * 返回 "partner" | "me"
 */
export function resolveOpener(rand = Math.random) {
  const pref = read("opener");
  if (pref === "partner" || pref === "me") return pref;
  let hist = [];
  try {
    hist = JSON.parse(localStorage.getItem(PREFIX + "openerHistory") || "[]");
    if (!Array.isArray(hist)) hist = [];
  } catch {}
  let pick = rand() < 0.5 ? "partner" : "me";
  const n = hist.length;
  if (n >= 2 && hist[n - 1] === hist[n - 2] && hist[n - 1] === pick) pick = pick === "me" ? "partner" : "me";
  hist = [...hist, pick].slice(-6);
  try {
    localStorage.setItem(PREFIX + "openerHistory", JSON.stringify(hist));
  } catch {}
  return pick;
}
