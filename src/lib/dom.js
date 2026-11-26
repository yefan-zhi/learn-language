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

/** 渲染一句话的老师点评（文字部分） */
export function feedbackHtml(a, { compact = false } = {}) {
  if (!a) return "";
  if (a.no_speech) return `<div class="fb-muted">（这句没听清你的英语，跳过点评）</div>`;
  const pron = (a.pronunciation || [])
    .map(
      (p) =>
        `<li><button class="word-say" data-act="word" data-word="${escapeHtml(p.word)}" title="点击听 ${escapeHtml(p.word)} 的标准发音"><b class="en">${escapeHtml(p.word)}</b><span class="spk" aria-hidden="true">🔈</span></button>${
          p.ipa ? `<span class="ipa">${escapeHtml(p.ipa)}</span>` : ""
        }：${escapeHtml(p.problem_zh)}<br><span class="tip">👉 ${escapeHtml(p.tip_zh)}</span></li>`
    )
    .join("");
  return `
    <div class="fb-head"><span class="stars">${stars(a.rating)}</span>${a.natural ? `<span class="tag good">表达地道</span>` : `<span class="tag warn">可以更地道</span>`}</div>
    ${!a.natural || !compact ? `<div class="fb-row"><span class="fb-label">地道说法</span><span class="en better">${escapeHtml(a.better_expression)}</span><button class="play-mini" data-act="native" title="听地道说法">🔊</button></div>` : ""}
    ${a.expression_note_zh ? `<div class="fb-row"><span class="fb-label">表达</span><span>${escapeHtml(a.expression_note_zh)}</span></div>` : ""}
    ${pron ? `<div class="fb-row"><span class="fb-label">发音</span><ul class="pron">${pron}</ul></div>` : ""}
    ${a.intonation_zh ? `<div class="fb-row"><span class="fb-label">语调</span><span>${escapeHtml(a.intonation_zh)}</span></div>` : ""}
    ${!compact ? `<div class="fb-row teacher-say"><span class="fb-label">老师说</span><span>${escapeHtml(a.spoken_feedback_zh)}</span></div>` : ""}
  `;
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
