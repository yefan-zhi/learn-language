// “老师”：每句点评、中文语音、地道说法朗读、会话总结
import { generateJSON, generateContent, audioOf, streamJSON } from "./gemini-rest.js";
import { teacherModelFor } from "./models.js";
import { getSetting, ACCENTS, LEVELS, teacherLang } from "./settings.js";
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
          ipa: { type: "STRING", description: "该单词按所选口音的标准 IPA 音标，例如 /ˈkɑːfi/（可选）" },
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
  // 流式输出时最先生成要朗读的点评和地道说法，语音可以更早开始
  propertyOrdering: [
    "no_speech", "spoken_feedback_zh", "better_expression", "natural", "rating",
    "transcript", "expression_note_zh", "pronunciation", "intonation_zh",
  ],
};

function teacherSystem(accentKey, level, langKey) {
  const a = ACCENTS[accentKey] || ACCENTS.us;
  const L = teacherLang(langKey, accentKey);
  const zh = L.key === "zh";
  const lang = zh ? "中文" : `简单清楚的英文（${a.en}，短句、常用词，不要用中文）`;
  return `你是一位经验丰富、亲切又专业的英语口语老师。学生的母语是中文，正在练习${a.short}英语（${a.en}）口语，水平大约是${(LEVELS[level] || LEVELS.intermediate).label}。
学生正在和一个英语母语者做情景角色扮演。你是旁听的第三方老师，在学生每说完一句话后给出点评。

你会收到：学生刚说的这句话的录音、语音识别文本（可能不准）、以及对话上下文。请：
1. 以录音为准，写出学生实际说了什么（transcript，保留语法错误，不要替学生改正）。
2. 判断表达是否地道：${a.en} 的母语者在这个场景下会不会这样说？语法、用词、搭配、礼貌程度是否合适？给出更地道的说法 better_expression（符合${a.short}用词习惯，例如美式 apartment/subway/check，英式 flat/tube/bill）。如果原句已经很地道，natural=true，better_expression 给原句或略作润色。expression_note_zh 用${lang}说明。
3. 仔细听发音：指出你确实清楚听到的单词发音问题（元音长短、th/v/w/l/r/n 等辅音、词尾辅音吞音或加多余元音、单词重音位置等），以 ${a.short}标准发音为参照。只说真实听到的问题，不要编造；没有就返回空数组；最多 3 个。每个问题的 word 只写一个英文单词（或固定短语），并在 ipa 里给出它的${a.short}标准 IPA 音标（${accentKey === "uk" ? "英式 RP，例如 /ˈkɒfi/" : "美式 General American，例如 /ˈkɑːfi/"}，带斜杠）。problem_zh 和 tip_zh 用${lang}写。
4. 语调：句子重音、疑问句升降调、意群停顿、连读和节奏是否自然，用${lang}简要说明（intonation_zh）。
5. spoken_feedback_zh：用${lang}写一段会被朗读出来的点评，像老师当面说话：2~4 句，口语化、温和、具体。先简短肯定一个优点，再讲最重要的 1~2 个问题和怎么改${zh ? "（需要时直接说出英文单词或句子）" : ""}。不要用 markdown、括号注释、列表或特殊符号。
6. rating：1~5 分综合评分（表达 + 发音 + 流利度）。
如果录音里几乎听不到学生说英语（只有静音、噪音或别人的声音），设置 no_speech=true，其他字段可以留空。
语言要求：${L.instruction}（字段名带 _zh 只是历史命名，内容按这里的语言要求写。）transcript 和 better_expression 始终是英文。
输出时按 JSON 字段顺序：先写 no_speech，再写 spoken_feedback_zh（先在心里听完整句再下结论），然后是其他字段；各字段内容要彼此一致。
spoken_feedback_zh 只写老师要说的话本身，不要写“用…语气说：”“Say this…:”之类的朗读提示。`;
}

function turnRequest(p) {
  const wav = int16ToWav(p.pcm, 16000);
  p.lang = p.lang || teacherLang().key;
  const ctx = `场景：${p.missionTitle}（${p.missionDesc}）。对方角色：${p.role}。
对方刚才说的话：${p.prevCharacterText ? `"${p.prevCharacterText}"` : "（无，学生先开口）"}
学生这句话的语音识别文本（可能不准、可能不完整）："${p.asrText || ""}"
下面是学生这句话的录音。`;
  return {
    system: teacherSystem(p.accent, p.level, p.lang),
    parts: [{ text: ctx }, { inlineData: { mimeType: "audio/wav", data: arrayBufferToBase64(wav) } }],
    schema: FEEDBACK_SCHEMA,
    temperature: 0.3,
  };
}

/**
 * 分析一句话（非流式）
 * @param {object} p { pcm: Int16Array(16k), asrText, prevCharacterText, missionTitle, missionDesc, role, accent, level }
 */
export async function analyzeTurn(p) {
  const req = turnRequest(p);
  const a = await generateJSON(teacherModelFor(getSetting), req);
  return { ...a, _lang: p.lang };
}

/**
 * 流式分析一句话：onPartial(部分结果, 原始文本) 边生成边回调；失败自动回退到非流式
 * opts: { onPartial, onFirstToken, signal }
 */
export async function analyzeTurnStream(p, opts = {}) {
  const req = turnRequest(p);
  const onPartial = opts.onPartial ? (part, raw) => opts.onPartial({ ...part, _lang: p.lang }, raw) : undefined;
  const a = await streamJSON(teacherModelFor(getSetting), req, { ...opts, onPartial });
  return { ...a, _lang: p.lang };
}

/**
 * 去掉误混进朗读文本的指令，比如 "Say this in an American accent: ..."、"用温和的语气朗读：..."
 */
export function cleanSpeechText(text) {
  let t = String(text || "").trim();
  for (let i = 0; i < 3; i++) {
    const before = t;
    t = t
      .replace(/^\s*(?:please\s+)?(?:say|read|speak|pronounce|repeat)\b[^:：\n]{0,160}[:：]\s*/i, "")
      .replace(/^\s*(?:in|with)\s+an?\s+[^:：\n]{0,80}(?:accent|voice|tone)[^:：\n]{0,60}[:：]\s*/i, "")
      .replace(/^\s*(?:请)?(?:用|以|按)[^:：\n]{0,80}(?:语气|口吻|声音|语调|语速|发音|口音|方式)[^:：\n]{0,60}[:：]\s*/, "")
      .replace(/^\s*(?:朗读|读出|念出)[^:：\n]{0,40}[:：]\s*/, "")
      .trim();
    if (t === before) break;
  }
  return t;
}

// TTS 风格提示放在 speechMetadata.style（不会被念出来）；接口不认这个字段时自动去掉并记住
let styleUnsupported = (() => {
  try { return localStorage.getItem("ll_ttsNoStyle") === "1"; } catch { return false; }
})();

/**
 * 用 Gemini TTS 合成，返回 24kHz Int16 PCM。
 * text 只能是要念的内容本身；风格放在 style 参数里。
 */
export async function geminiTTS(text, voiceName, style) {
  const model = getSetting("ttsModel");
  const spoken = cleanSpeechText(text);
  if (!spoken) throw new Error("没有要朗读的内容");
  const call = (withStyle) => {
    const part = { text: spoken };
    if (withStyle && style) part.speechMetadata = { style };
    return generateContent(model, {
      contents: [{ role: "user", parts: [part] }],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } },
      },
    });
  };
  let resp;
  if (style && !styleUnsupported) {
    try {
      resp = await call(true);
    } catch (e) {
      if (e.status === 400 && /speech_?metadata|unknown name|invalid json payload|cannot find field/i.test(e.message || "")) {
        styleUnsupported = true;
        try { localStorage.setItem("ll_ttsNoStyle", "1"); } catch {}
        resp = await call(false);
      } else throw e;
    }
  } else {
    resp = await call(false);
  }
  const a = audioOf(resp);
  if (!a) throw new Error("TTS 没有返回音频");
  return base64ToInt16(a.data);
}

/** 老师中文语音（Gemini） */
export function teacherTTS(text, langKey) {
  const L = teacherLang(langKey);
  const style =
    L.key === "en"
      ? `warm, clear and encouraging, like a friendly teacher talking to a student, moderate pace, ${getSetting("accent") === "uk" ? "British" : "American"} accent`
      : "warm, clear and encouraging, like a friendly teacher talking to a student, moderate pace, standard Mandarin";
  return geminiTTS(text, getSetting("teacherVoice"), style);
}

const accentStyle = (accentKey) =>
  accentKey === "uk" ? "standard southern British (RP) accent" : "General American accent";

/** 地道说法（美/英口音） */
const nativeCache = new Map();
export function nativeTTS(text, accentKey) {
  const k = `${accentKey}|${text}`;
  if (!nativeCache.has(k)) {
    const p = geminiTTS(text, getSetting("characterVoice"), `natural and conversational, ${accentStyle(accentKey)}`).catch((e) => {
      nativeCache.delete(k);
      throw e;
    });
    nativeCache.set(k, p);
  }
  return nativeCache.get(k);
}

/** 单词发音（发音问题里的单词）：先慢读一遍，再正常速度读一遍。内存 + IndexedDB 缓存 */
const wordMem = new Map();
const WORD_DB = "ll-audio-cache";
function wordDb() {
  return new Promise((resolve, reject) => {
    try {
      const req = indexedDB.open(WORD_DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore("words");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    } catch (e) {
      reject(e);
    }
  });
}
async function wordDbGet(k) {
  try {
    const db = await wordDb();
    return await new Promise((resolve) => {
      const r = db.transaction("words").objectStore("words").get(k);
      r.onsuccess = () => resolve(r.result ? new Int16Array(r.result) : null);
      r.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}
async function wordDbPut(k, pcm) {
  try {
    const db = await wordDb();
    db.transaction("words", "readwrite").objectStore("words").put(pcm.buffer.slice(0), k);
  } catch {}
}
export const wordTTSStats = { requests: 0, memHits: 0, dbHits: 0 };
export function wordTTS(word, accentKey) {
  const w = String(word || "").trim();
  // v2：旧缓存里可能录进了朗读指令，换新 key 不再使用
  const k = `v2|${accentKey === "uk" ? "uk" : "us"}|${w.toLowerCase()}`;
  if (wordMem.has(k)) {
    wordTTSStats.memHits++;
    return wordMem.get(k);
  }
  const p = (async () => {
    const cached = await wordDbGet(k);
    if (cached && cached.length) {
      wordTTSStats.dbHits++;
      return cached;
    }
    wordTTSStats.requests++;
    // 只发送要念的单词（念两遍）；“先慢后正常”的要求放在风格里，不会被念出来
    const pcm = await geminiTTS(
      `${w}. ... ${w}.`,
      getSetting("characterVoice"),
      `clear dictionary-style pronunciation, ${accentStyle(accentKey)}; first time slow and careful, second time at normal speed`
    );
    wordDbPut(k, pcm);
    return pcm;
  })().catch((e) => {
    wordMem.delete(k);
    throw e;
  });
  wordMem.set(k, p);
  return p;
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

/** 给设备语音打分：越高越好 */
function voiceScore(v, lang) {
  const name = v.name || "";
  const vl = (v.lang || "").replace("_", "-");
  let sc = 0;
  if (vl.toLowerCase() === lang.toLowerCase()) sc += 100;
  else if (vl.slice(0, 2).toLowerCase() === lang.slice(0, 2).toLowerCase()) sc += 40;
  else return -1;
  if (/premium|enhanced|高品质|增强/i.test(name)) sc += 30;
  if (/natural|neural|online/i.test(name)) sc += 25; // Edge 的 Xiaoxiao Online (Natural) 等
  if (/google/i.test(name)) sc += 20;
  if (lang.toLowerCase() === "zh-cn" && /ting-?ting|lili|xiaoxiao|yunxi|xiaoyi|普通话|mandarin/i.test(name)) sc += 15;
  if (/meijia|mei-jia|sinji|粤|cantonese|台湾|taiwan|hong ?kong/i.test(name) && lang.toLowerCase() === "zh-cn") sc -= 20;
  if (lang.toLowerCase() === "en-us" && /samantha|ava|allison|google us/i.test(name)) sc += 10;
  if (lang.toLowerCase() === "en-gb" && /daniel|kate|serena|google uk/i.test(name)) sc += 10;
  if (/compact|eloquence|novelty|bad news|bells|boing|bubbles|cellos|whisper|zarvox|trinoids|organ|jester|superstar/i.test(name)) sc -= 50;
  if (v.localService) sc += 2;
  return sc;
}

export async function pickBrowserVoice(lang) {
  const voices = await loadVoices();
  let best = null;
  let bestScore = -1;
  for (const v of voices) {
    const sc = voiceScore(v, lang);
    if (sc > bestScore) {
      bestScore = sc;
      best = v;
    }
  }
  return best;
}

let speakToken = 0;
/**
 * 设备语音朗读。长文本按句子切开依次朗读（避免 Chrome 长句中途停止），
 * 调用 stopBrowserSpeech() 会中止剩下的句子。
 * onStart：第一句真正开始时回调（用于计时）
 */
export async function speakBrowser(text, lang = "zh-CN", rate = 1.0, onStart) {
  if (!("speechSynthesis" in window)) throw new Error("浏览器不支持语音合成");
  const clean = cleanSpeechText(text);
  if (!clean) return;
  const voice = await pickBrowserVoice(lang);
  speechSynthesis.cancel();
  const token = ++speakToken;
  const pieces = clean.match(/[^。！？!?；;\n]+[。！？!?；;]*|[\n]+/g)?.map((x) => x.trim()).filter(Boolean) || [clean];
  let started = false;
  for (const piece of pieces) {
    if (token !== speakToken) return;
    await new Promise((resolve) => {
      const u = new SpeechSynthesisUtterance(piece);
      u.lang = lang;
      if (voice) u.voice = voice;
      u.rate = rate;
      u.onstart = () => {
        if (!started) {
          started = true;
          onStart?.();
        }
      };
      u.onend = resolve;
      u.onerror = resolve;
      // 某些浏览器不触发 onend：按字数估一个超时兜底
      setTimeout(resolve, 2000 + piece.length * 400);
      speechSynthesis.speak(u);
    });
  }
}

export function stopBrowserSpeech() {
  speakToken++;
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

export async function summarizeSession({ missionTitle, accent, level, transcript, turns, lang }) {
  const a = ACCENTS[accent] || ACCENTS.us;
  const L = teacherLang(lang, accent);
  const lines = transcript.map((t) => `${t.role === "user" ? "学生" : "对方"}：${t.text}`).join("\n");
  const fb = turns
    .filter((t) => t.analysis && !t.analysis.no_speech)
    .map(
      (t, i) =>
        `${i + 1}. 学生说："${t.analysis.transcript || t.text}"；更地道：${t.analysis.better_expression}；表达：${t.analysis.expression_note_zh}；发音：${(t.analysis.pronunciation || []).map((p) => `${p.word}-${p.problem_zh}`).join("；") || "无"}；语调：${t.analysis.intonation_zh}；评分 ${t.analysis.rating}`
    )
    .join("\n");
  const out = await generateJSON(getSetting("teacherModel"), {
    system: `你是一位英语口语老师，学生母语是中文，在练习${a.short}英语，水平${(LEVELS[level] || LEVELS.intermediate).label}。请根据整段角色扮演对话和每句点评，给出本次练习的总结。key_phrases 挑 3~6 个本场景最值得记住的${a.short}地道表达（优先选学生说错或没说好的地方），en 为英文，zh 为解释。strengths_zh / improvements_zh 各 2~4 条，具体、可执行。
语言要求：${L.instruction}（字段名带 _zh 只是历史命名，overall_zh、strengths_zh、improvements_zh、key_phrases[].zh、next_practice_zh 都按这个语言写。）`,
    parts: [{ text: `场景：${missionTitle}\n\n完整对话：\n${lines || "（空）"}\n\n每句点评：\n${fb || "（无）"}` }],
    schema: SUMMARY_SCHEMA,
    temperature: 0.4,
  });
  return { ...out, _lang: L.key };
}
