// 单模型模式：同一个 Live 模型既演角色、又当老师
// - 提示词里的“老师协议”
// - give_feedback 工具定义，以及把它的参数转成卡片用的点评对象
// - 把一轮模型输出（转写文字 + 音频）拆成“老师”部分和“角色”部分
import { ACCENTS, teacherLang, coachMarkers } from "./settings.js";
import { rms } from "./audio-utils.js";

/** 追加在角色提示词后面的双角色协议 */
export function coachProtocol(accentKey, langKey, { stepMode = false } = {}) {
  const a = ACCENTS[accentKey] || ACCENTS.us;
  const L = teacherLang(langKey, accentKey);
  const M = coachMarkers(L.key);
  const langName = L.key === "en" ? `simple, clear ${a.en}` : "Simplified Chinese (简体中文)";
  return `
TWO VOICES — CHARACTER + COACH:
In this session you play two voices: (1) the CHARACTER described above, and (2) a warm, experienced English speaking COACH who briefly comments on each thing the learner says. The learner is a native Mandarin Chinese speaker practising ${a.en}.

After EVERY learner turn in which they attempt to speak English, respond in this exact order${stepMode ? "" : ", all in the same response"}:
STEP 1 — Call the give_feedback tool FIRST, before saying anything at all. Base it on what you actually HEARD in the learner's audio (pronunciation of individual sounds, word stress, intonation, rhythm, linking), not only on the words. Only report pronunciation problems you clearly heard; never invent problems. ${L.instruction} The fields transcript and better_expression are always in English. Use ${a.en} as the reference accent and vocabulary.
STEP 2 — Speak as the COACH. Begin with exactly "${M.start}" and then say 1-3 short sentences in ${langName}: one quick, specific bit of praise, then the single most important fix, saying the better English wording out loud. Use a calm, warm, slightly slower teacher voice that sounds clearly different from the character. Keep it under about 15 seconds. Finish the coach part with exactly "${M.end}"
${
    stepMode
      ? `STEP 3 — STOP after the coach part and stay silent. Do NOT reply as the character yet. Only when you receive the text message "[continue]" do you reply as the CHARACTER, in English with your ${a.en} accent (1-2 sentences), to the learner's last line, continuing the scene naturally (no coach part, no tool call for "[continue]"). If the learner speaks again before "[continue]" (a new attempt), treat it as a new learner turn and do STEPS 1-2 again. A text message starting with "[redo]" means: forget the learner's previous attempt and your feedback on it, say nothing, and wait for their new attempt.`
      : `STEP 3 — Switch back to the CHARACTER and reply in English with your ${a.en} accent (1-2 sentences), continuing the scene naturally.`
  }

Rules:
- The CHARACTER never corrects the learner's English and never mentions the coach. All corrections come only from the coach.
- Never put the character's lines before the coach part.${stepMode ? "\n- Text messages in square brackets such as \"[continue]\", \"[redo]\" or \"[START]\" are control signals from the app, not the learner's words: never comment on them." : ""}
- If the learner spoke Chinese, said nothing meaningful, or you could not hear them clearly: do NOT call give_feedback. Instead say "${M.start}" plus ONE short hint in ${langName} (for example the English phrase they could use), finish with "${M.end}", then let the character continue or ask them to say it again.
- No coach part and no give_feedback for "[START]", for your opening line, or for anything that is not the learner's own speech.
- Never read tool arguments out loud and never describe the tool call.`;
}

/** give_feedback 工具定义（字段和独立老师的卡片一一对应） */
export function giveFeedbackDeclaration(accentKey, langKey, modelName = "") {
  const a = ACCENTS[accentKey] || ACCENTS.us;
  const L = teacherLang(langKey, accentKey);
  const lang = L.key === "en" ? `simple English` : "Simplified Chinese";
  const decl = {
    name: "give_feedback",
    description: `Coach feedback on the learner's latest English utterance. Call this FIRST, before speaking, every time the learner says something in English. Text fields marked (${lang}) must be written in ${lang}.`,
    parameters: {
      type: "OBJECT",
      properties: {
        transcript: { type: "STRING", description: "What the learner actually said, in English, exactly as heard (keep their mistakes)." },
        rating: { type: "INTEGER", description: "Overall score 1-5 (wording + pronunciation + fluency)." },
        natural: { type: "BOOLEAN", description: `true if a ${a.en} native speaker would naturally say it this way.` },
        better_expression: { type: "STRING", description: `A more natural ${a.en} way to say it (English). If already natural, repeat it or lightly polish it.` },
        expression_note: { type: "STRING", description: `Short note on wording/grammar/word choice (${lang}).` },
        pronunciation: {
          type: "ARRAY",
          description: "Up to 3 pronunciation problems you clearly heard; empty if none.",
          items: {
            type: "OBJECT",
            properties: {
              word: { type: "STRING", description: "One English word (or fixed phrase)." },
              ipa: { type: "STRING", description: `Standard ${accentKey === "uk" ? "British RP" : "General American"} IPA with slashes, e.g. ${accentKey === "uk" ? "/ˈkɒfi/" : "/ˈkɑːfi/"}.` },
              problem: { type: "STRING", description: `What was wrong (${lang}).` },
              tip: { type: "STRING", description: `How to fix it (${lang}).` },
            },
            required: ["word", "problem", "tip"],
          },
        },
        intonation: { type: "STRING", description: `Sentence stress, rising/falling tone, pausing, linking, rhythm (${lang}).` },
        spoken_feedback: { type: "STRING", description: `Exactly what the coach is about to say out loud (${lang}), 1-3 short sentences, without the "Coach/老师" prefix.` },
      },
      required: ["transcript", "rating", "natural", "better_expression", "spoken_feedback"],
    },
  };
  // “Extended Thinking” 版本的 Live 模型只支持异步函数调用
  if (/think/i.test(modelName)) decl.behavior = "NON_BLOCKING";
  return decl;
}

/** give_feedback 参数 → 卡片用的点评对象（沿用独立老师的字段名） */
export function argsToAnalysis(args = {}, langKey) {
  const pron = Array.isArray(args.pronunciation) ? args.pronunciation : [];
  return {
    no_speech: false,
    transcript: str(args.transcript),
    rating: typeof args.rating === "number" ? args.rating : Number(args.rating) || undefined,
    natural: typeof args.natural === "boolean" ? args.natural : args.natural === "true" ? true : args.natural === "false" ? false : undefined,
    better_expression: str(args.better_expression),
    expression_note_zh: str(args.expression_note),
    pronunciation: pron
      .filter((p) => p && p.word)
      .slice(0, 3)
      .map((p) => ({ word: str(p.word), ipa: str(p.ipa), problem_zh: str(p.problem), tip_zh: str(p.tip) })),
    intonation_zh: str(args.intonation),
    spoken_feedback_zh: str(args.spoken_feedback),
    _lang: langKey === "en" ? "en" : "zh",
    _source: "live",
  };
}

function str(v) {
  return typeof v === "string" ? v.trim() : v == null ? "" : String(v);
}

// ---------------- 文字拆分 ----------------
const START_RES = [/老\s*师\s*[：:，,]?/, /\bcoach\b\s*[：:,]?/i];
const END_RES = [
  /(?:好[的了吧]?\s*[，,、。.]?\s*)?我\s*们\s*继\s*续(?:吧|对话|聊)?\s*[。.!！]?/,
  /(?:ok(?:ay)?\s*[,.]?\s*)?back to (?:the |our )?(?:conversation|chat|scene|role-?play)\s*[.!]?/i,
];
const CJK = /[㐀-鿿豈-﫿　-〿＀-￯]/;

function joinParts(a, b) {
  return [a.trim(), b.trim()].filter(Boolean).join(" ");
}

function firstMatch(res, text, from = 0) {
  let best = null;
  for (const re of res) {
    const m = re.exec(text.slice(from));
    if (m && (!best || m.index + from < best.index)) best = { index: m.index + from, length: m[0].length };
  }
  return best;
}

/**
 * 把一轮输出的完整转写拆成老师/角色两部分。
 * final=false 时（还在流式输出）不做“最后一个中文字符”的推断。
 * 返回 { teacher, character, teacherStart, characterStart, found, closed }
 *  - teacherStart：老师部分（含标记）在 full 中的起点；没有老师部分为 -1
 *  - characterStart：老师之后角色部分在 full 中的起点；还没找到为 -1
 */
export function splitCoachText(full, langKey, final = false) {
  full = full || "";
  const head = firstMatch(START_RES, full);
  if (!head) return { teacher: "", character: full.trim(), teacherStart: -1, characterStart: -1, found: false, closed: false };
  const pre = full.slice(0, head.index);
  const bodyStart = head.index + head.length;
  const end = firstMatch(END_RES, full, bodyStart);
  if (end) {
    const cs = end.index + end.length;
    return {
      teacher: full.slice(bodyStart, end.index).trim(),
      character: joinParts(pre, full.slice(cs)),
      teacherStart: head.index,
      characterStart: cs,
      found: true,
      closed: true,
    };
  }
  if (final && langKey !== "en") {
    // 中文点评没说结束语：最后一个中文字符（及其后的标点）之后的英文算角色
    let last = -1;
    for (let i = full.length - 1; i >= bodyStart; i--) {
      if (CJK.test(full[i])) {
        last = i;
        break;
      }
    }
    if (last >= 0) {
      let cs = last + 1;
      while (cs < full.length && /[\s。！？!?.，,、”"']/.test(full[cs])) cs++;
      const character = full.slice(cs).trim();
      if (/[A-Za-z]/.test(character)) {
        return {
          teacher: full.slice(bodyStart, cs).trim(),
          character: joinParts(pre, character),
          teacherStart: head.index,
          characterStart: cs,
          found: true,
          closed: true,
        };
      }
    }
  }
  return {
    teacher: full.slice(bodyStart).trim(),
    character: pre.trim(),
    teacherStart: head.index,
    characterStart: -1,
    found: true,
    closed: false,
  };
}

// ---------------- 音频拆分 ----------------
/** 文本位置 → 音频样本位置：用“这段转写到达时已经收到多少音频”近似 */
export function sampleAtChar(chunks, charIndex) {
  if (!chunks.length) return 0;
  let pos = chunks[0].pos;
  for (const c of chunks) {
    if (c.start > charIndex) break;
    pos = c.pos;
  }
  return pos;
}

/**
 * 在 approx 附近找最长的一段静音，返回静音中点（24k 样本）。
 * 老师说完和角色开口之间一般会有停顿，用它校准切分点。
 */
export function refineSplit(pcm, approx, rate = 24000, before = 2.0, after = 0.8) {
  const frame = Math.round(rate * 0.02);
  const lo = Math.max(0, Math.floor((approx - before * rate) / frame));
  const hi = Math.min(Math.floor(pcm.length / frame), Math.ceil((approx + after * rate) / frame));
  if (hi - lo < 3) return Math.max(0, Math.min(pcm.length, approx));
  const thr = 0.01;
  let best = null;
  let runStart = -1;
  for (let f = lo; f <= hi; f++) {
    const silent = f < hi && rms(pcm.subarray(f * frame, (f + 1) * frame)) < thr;
    if (silent && runStart < 0) runStart = f;
    if (!silent && runStart >= 0) {
      const len = f - runStart;
      const mid = Math.round(((runStart + f) / 2) * frame);
      const score = len - Math.abs(mid - approx) / (rate * 0.5); // 偏好更长、离估计点更近
      if (len >= 6 && (!best || score > best.score)) best = { mid, score };
      runStart = -1;
    }
  }
  return best ? best.mid : Math.max(0, Math.min(pcm.length, approx));
}
