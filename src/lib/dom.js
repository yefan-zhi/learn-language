import { teacherLang } from "./settings.js";

export function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function stars(n) {
  n = Math.max(0, Math.min(5, Math.round(n || 0)));
  return "★".repeat(n) + "☆".repeat(5 - n);
}

/**
 * 渲染一句话的老师点评（文字部分）
 * partial=true：流式生成中，只显示已经出来的字段，并在末尾显示“生成中”
 */
export function feedbackHtml(a, { compact = false, partial = false, timing = "" } = {}) {
  if (!a) return "";
  const T = teacherLang(a._lang || "zh").labels;
  if (a.no_speech) return `<div class="fb-muted">${T.noSpeech}</div>`;
  const pron = (Array.isArray(a.pronunciation) ? a.pronunciation : [])
    .filter((p) => p && p.word)
    .map(
      (p) =>
        `<li><button class="word-say" data-act="word" data-word="${escapeHtml(p.word)}" title="点击听 ${escapeHtml(p.word)} 的标准发音"><b class="en">${escapeHtml(p.word)}</b><span class="spk" aria-hidden="true">🔈</span></button>${
          p.ipa ? `<span class="ipa">${escapeHtml(p.ipa)}</span>` : ""
        }${p.problem_zh ? `：${escapeHtml(p.problem_zh)}` : ""}${p.tip_zh ? `<br><span class="tip">👉 ${escapeHtml(p.tip_zh)}</span>` : ""}</li>`
    )
    .join("");
  const hasRating = typeof a.rating === "number";
  const hasNatural = typeof a.natural === "boolean";
  const head =
    hasRating || hasNatural
      ? `<div class="fb-head">${hasRating ? `<span class="stars">${stars(a.rating)}</span>` : ""}${
          hasNatural ? (a.natural ? `<span class="tag good">${T.natural}</span>` : `<span class="tag warn">${T.improve}</span>`) : ""
        }</div>`
      : "";
  const say = a.spoken_feedback_zh && !compact
    ? `<div class="fb-row teacher-say"><span class="fb-label">${T.teacherSay}</span><span>${escapeHtml(a.spoken_feedback_zh)}</span></div>`
    : "";
  const better =
    a.better_expression && (a.natural === false || !compact)
      ? `<div class="fb-row"><span class="fb-label">${T.better}</span><span class="en better">${escapeHtml(a.better_expression)}</span>${
          partial ? "" : `<button class="play-mini" data-act="native" title="听地道说法">🔊</button>`
        }</div>`
      : "";
  const rest = `
    ${a.expression_note_zh ? `<div class="fb-row"><span class="fb-label">${T.expression}</span><span>${escapeHtml(a.expression_note_zh)}</span></div>` : ""}
    ${pron ? `<div class="fb-row"><span class="fb-label">${T.pron}</span><ul class="pron">${pron}</ul></div>` : ""}
    ${a.intonation_zh ? `<div class="fb-row"><span class="fb-label">${T.intonation}</span><span>${escapeHtml(a.intonation_zh)}</span></div>` : ""}
  `;
  const timingHtml = timing ? `<div class="fb-timing">${escapeHtml(timing)}</div>` : "";
  if (partial) {
    // 流式：老师说的话最先生成，放在最上面
    return `${say}${head}${better}${rest}<div class="fb-loading"><span class="dots"></span> ${T.generating}</div>`;
  }
  return `${head}${better}${rest}${say}${timingHtml}`;
}

/** 弹窗打开时锁定页面滚动（支持多层弹窗计数） */
let scrollLocks = 0;
export function lockScroll() {
  if (scrollLocks++ === 0) document.documentElement.classList.add("modal-open");
}
export function unlockScroll() {
  scrollLocks = Math.max(0, scrollLocks - 1);
  if (scrollLocks === 0) document.documentElement.classList.remove("modal-open");
}
