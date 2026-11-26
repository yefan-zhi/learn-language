// 本地设置（只存在本机浏览器 localStorage）

export const DEFAULTS = {
  apiKey: "",
  liveModel: "gemini-2.5-flash-native-audio-preview-12-2025",
  teacherModel: "gemini-2.5-flash",
  ttsModel: "gemini-2.5-flash-preview-tts",
  characterVoice: "Puck",
  teacherVoice: "Kore",
  teacherVoiceSource: "gemini", // gemini | browser
  teacherVoiceOn: true,
  accent: "us", // us | uk
  level: "intermediate", // beginner | intermediate | advanced
  mode: "immersive", // immersive | assisted
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

export const ACCENTS = {
  us: { label: "🇺🇸 美式英语", short: "美式", en: "American English", city: "New York", bcp47: "en-US" },
  uk: { label: "🇬🇧 英式英语", short: "英式", en: "British English", city: "London", bcp47: "en-GB" },
};

export const LEVELS = {
  beginner: { label: "初级", en: "beginner (A2): speak slowly and clearly, use simple everyday words and short sentences" },
  intermediate: { label: "中级", en: "intermediate (B1-B2): speak at a natural but not rushed pace, everyday idioms are fine" },
  advanced: { label: "高级", en: "advanced (C1): speak at a fully natural native pace with idioms, phrasal verbs and slang where appropriate" },
};
