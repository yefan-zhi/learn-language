// “老师”：每句点评、中文语音、地道说法朗读、会话总结
import { generateJSON, generateContent, audioOf } from "./gemini-rest.js";
import { getSetting, ACCENTS, LEVELS } from "./settings.js";
import { arrayBufferToBase64, int16ToWav, base64ToInt16 } from "./audio-utils.js";

const FEEDBACK_SCHEMA = {
  type: "OBJECT",
  properties: {
    no_speech: { type: "BOOLEAN", description: "录音里几乎没有学生的英语语音" },
    transcript: { type: "STRING", description: "按录音听到的学生原话（英文，保留错误）" },
    rating: { type: "INTEGER", description: "1-5 综合评分" },
    natural: { type: "BOOLEAN", description: "表达是否已经地道" },
    better_expression: { type: "STRING", description: "更地道的说法（英文）" },
    expression_note_zh: { type: "STRING", description: "表达方面的中文说明" },
    pronunciation: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          word: { type: "STRING" },
          problem_zh: { type: "STRING" },
          tip_zh: { type: "STRING" },
        },
        required: ["word", "problem_zh", "tip_zh"],
      },
    },
    intonation_zh: { type: "STRING", description: "语调、重音、节奏、连读方面的中文点评" },
    spoken_feedback_zh: { type: "STRING", description: "要朗读出来的中文老师点评" },
  },
  required: [
    "no_speech", "transcript", "rating", "natural", "better_expression",
    "expression_note_zh", "pronunciation", "intonation_zh", "spoken_feedback_zh",
  ],
};

function teacherSystem(accentKey, level) {
  const a = ACCENTS[accentKey] || ACCENTS.us;
  return `你是一位经验丰富、亲切又专业的英语口语老师。学生的母语是中文，正在练习${a.short}英语（${a.en}）口语，水平大约是${(LEVELS[level] || LEVELS.intermediate).label}。
学生正在和一个英语母语者做情景角色扮演。你是旁听的第三方老师，在学生每说完一句话后给出点评。

你会收到：学生刚说的这句话的录音、语音识别文本（可能不准）、以及对话上下文。请：
1. 以录音为准，写出学生实际说了什么（transcript，保留语法错误，不要替学生改正）。
2. 判断表达是否地道：${a.en} 的母语者在这个场景下会不会这样说？语法、用词、搭配、礼貌程度是否合适？给出更地道的说法 better_expression（符合${a.short}用词习惯，例如美式 apartment/subway/check，英式 flat/tube/bill）。如果原句已经很地道，natural=true，better_expression 给原句或略作润色。
3. 仔细听发音：指出你确实清楚听到的单词发音问题（元音长短、th/v/w/l/r/n 等辅音、词尾辅音吞音或加多余元音、单词重音位置等），以 ${a.short}标准发音为参照。只说真实听到的问题，不要编造；没有就返回空数组；最多 3 个。
4. 语调：句子重音、疑问句升降调、意群停顿、连读和节奏是否自然，用中文简要说明（intonation_zh）。
5. spoken_feedback_zh：用中文写一段会被朗读出来的点评，像老师当面说话：2~4 句，口语化、温和、具体。先简短肯定一个优点，再讲最重要的 1~2 个问题和怎么改（需要时直接说出英文单词或句子）。不要用 markdown、括号注释、列表或特殊符号。
6. rating：1~5 分综合评分（表达 + 发音 + 流利度）。
如果录音里几乎听不到学生说英语（只有静音、噪音或别人的声音），设置 no_speech=true，其他字段可以留空。
除 transcript 和 better_expression 外，所有说明一律用简体中文。`;
}

/**
 * 分析一句话
 * @param {object} p { pcm: Int16Array(16k), asrText, prevCharacterText, missionTitle, missionDesc, role, accent, level }
 */
export async function analyzeTurn(p) {
  const model = getSetting("teacherModel");
  const wav = int16ToWav(p.pcm, 16000);
  const ctx = `场景：${p.missionTitle}（${p.missionDesc}）。对方角色：${p.role}。
对方刚才说的话：${p.prevCharacterText ? `"${p.prevCharacterText}"` : "（无，学生先开口）"}
学生这句话的语音识别文本（可能不准）："${p.asrText || ""}"
下面是学生这句话的录音。`;
  return generateJSON(model, {
    system: teacherSystem(p.accent, p.level),
    parts: [{ text: ctx }, { inlineData: { mimeType: "audio/wav", data: arrayBufferToBase64(wav) } }],
    schema: FEEDBACK_SCHEMA,
    temperature: 0.3,
  });
}

/** 用 Gemini TTS 合成，返回 24kHz Int16 PCM */
export async function geminiTTS(text, voiceName) {
  const model = getSetting("ttsModel");
  const resp = await generateContent(model, {
    contents: [{ role: "user", parts: [{ text }] }],
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } },
    },
  });
  const a = audioOf(resp);
  if (!a) throw new Error("TTS 没有返回音频");
  return base64ToInt16(a.data);
}

/** 老师中文语音（Gemini） */
export function teacherTTS(text) {
  return geminiTTS(
    `用温和、清晰、像老师当面指导学生一样的语气，语速适中地朗读下面这段中文点评，其中的英文单词和句子用标准英语发音读：\n${text}`,
    getSetting("teacherVoice")
  );
}

/** 地道说法（美/英口音） */
const nativeCache = new Map();
export function nativeTTS(text, accentKey) {
  const a = ACCENTS[accentKey] || ACCENTS.us;
  const k = `${accentKey}|${text}`;
  if (!nativeCache.has(k)) {
    const p = geminiTTS(
      `Say this naturally and conversationally, with a ${accentKey === "uk" ? "standard southern British (London)" : "general American"} accent: ${text}`,
      getSetting("characterVoice")
    ).catch((e) => {
      nativeCache.delete(k);
      throw e;
    });
    nativeCache.set(k, p);
  }
  return nativeCache.get(k);
}

/** 浏览器自带语音合成（兜底/快速模式） */
let voicesReady = null;
function loadVoices() {
  if (!("speechSynthesis" in window)) return Promise.resolve([]);
  if (!voicesReady) {
    voicesReady = new Promise((resolve) => {
      const v = speechSynthesis.getVoices();
      if (v.length) return resolve(v);
      speechSynthesis.onvoiceschanged = () => resolve(speechSynthesis.getVoices());
      setTimeout(() => resolve(speechSynthesis.getVoices()), 1500);
    });
  }
  return voicesReady;
}

export function unlockBrowserSpeech() {
  try {
    if ("speechSynthesis" in window) {
      const u = new SpeechSynthesisUtterance("");
      u.volume = 0;
      speechSynthesis.speak(u);
    }
  } catch {}
}

export async function speakBrowser(text, lang = "zh-CN") {
  if (!("speechSynthesis" in window)) throw new Error("浏览器不支持语音合成");
  const voices = await loadVoices();
  const voice =
    voices.find((v) => v.lang === lang && /premium|enhanced|natural|google/i.test(v.name)) ||
    voices.find((v) => v.lang === lang) ||
    voices.find((v) => v.lang && v.lang.startsWith(lang.slice(0, 2)));
  speechSynthesis.cancel();
  return new Promise((resolve) => {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = lang;
    if (voice) u.voice = voice;
    u.rate = 1.0;
    u.onend = resolve;
    u.onerror = resolve;
    speechSynthesis.speak(u);
  });
}

export function stopBrowserSpeech() {
  try { speechSynthesis.cancel(); } catch {}
}

const SUMMARY_SCHEMA = {
  type: "OBJECT",
  properties: {
    score: { type: "INTEGER", description: "0-100 总体得分" },
    overall_zh: { type: "STRING", description: "整体评价，3~5 句中文" },
    strengths_zh: { type: "ARRAY", items: { type: "STRING" } },
    improvements_zh: { type: "ARRAY", items: { type: "STRING" } },
    key_phrases: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: { en: { type: "STRING" }, zh: { type: "STRING" } },
        required: ["en", "zh"],
      },
    },
    next_practice_zh: { type: "STRING", description: "下次练习建议" },
  },
  required: ["score", "overall_zh", "strengths_zh", "improvements_zh", "key_phrases", "next_practice_zh"],
};

export async function summarizeSession({ missionTitle, accent, level, transcript, turns }) {
  const a = ACCENTS[accent] || ACCENTS.us;
  const lines = transcript.map((t) => `${t.role === "user" ? "学生" : "对方"}：${t.text}`).join("\n");
  const fb = turns
    .filter((t) => t.analysis && !t.analysis.no_speech)
    .map(
      (t, i) =>
        `${i + 1}. 学生说："${t.analysis.transcript || t.text}"；更地道：${t.analysis.better_expression}；表达：${t.analysis.expression_note_zh}；发音：${(t.analysis.pronunciation || []).map((p) => `${p.word}-${p.problem_zh}`).join("；") || "无"}；语调：${t.analysis.intonation_zh}；评分 ${t.analysis.rating}`
    )
    .join("\n");
  return generateJSON(getSetting("teacherModel"), {
    system: `你是一位英语口语老师，学生母语是中文，在练习${a.short}英语，水平${(LEVELS[level] || LEVELS.intermediate).label}。请根据整段角色扮演对话和每句点评，给出本次练习的总结。所有说明用简体中文；key_phrases 挑 3~6 个本场景最值得记住的${a.short}地道表达（优先选学生说错或没说好的地方），en 为英文，zh 为中文解释。strengths_zh / improvements_zh 各 2~4 条，具体、可执行。`,
    parts: [{ text: `场景：${missionTitle}\n\n完整对话：\n${lines || "（空）"}\n\n每句点评：\n${fb || "（无）"}` }],
    schema: SUMMARY_SCHEMA,
    temperature: 0.4,
  });
}
