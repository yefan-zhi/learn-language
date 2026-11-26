/**
 * 总结页：整体评价 + 逐句回放（我的录音 / 地道说法 / 老师点评语音）
 */
import { summarizeSession, teacherTTS, nativeTTS, wordTTS, speakBrowser, stopBrowserSpeech } from "../lib/teacher.js";
import { saveSession, deleteSession } from "../lib/history.js";
import { int16ToWavBlob, formatDuration } from "../lib/audio-utils.js";
import { escapeHtml, feedbackHtml } from "../lib/dom.js";
import { getSetting, ACCENTS, LEVELS, teacherLang } from "../lib/settings.js";

class ViewSummary extends HTMLElement {
  set session(v) {
    this._s = v;
  }

  connectedCallback() {
    const s = this._s;
    if (!s) {
      this.innerHTML = `<div class="container"><p>没有可显示的练习。</p></div>`;
      return;
    }
    this.audio = new Audio();
    this.audio.preload = "auto";
    this.playingBtn = null;
    this.audio.onended = () => this.resetPlaying();

    const a = ACCENTS[s.accent] || ACCENTS.us;
    const dur = s.endedAt && s.startedAt ? formatDuration((s.endedAt - s.startedAt) / 1000) : "";
    const date = new Date(s.startedAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

    this.innerHTML = `
      <div class="container wide summary">
        <div class="sum-head">
          <div class="sum-icon">${s.mission.icon}</div>
          <div>
            <h2>${escapeHtml(s.mission.title_zh)}${s.topic ? `：${escapeHtml(s.topic)}` : ""}</h2>
            <div class="meta">${date} · ${a.short} · ${(LEVELS[s.level] || LEVELS.intermediate).label} · 时长 ${dur} · ${s.turns.length} 句${s.missionComplete ? " · 🎉 任务完成" : ""}</div>
          </div>
        </div>

        <div class="panel glass-panel overall" id="overall"></div>

        <h3 class="section-title">逐句回放</h3>
        <div id="turns"></div>

        <details class="panel glass-panel full-transcript">
          <summary>📜 完整对话</summary>
          <div id="full"></div>
        </details>

        <div class="sum-actions">
          <button class="cta-btn" id="again">再练一次</button>
          <button class="small-btn" id="other">换个场景</button>
          ${s.fromHistory ? `<button class="small-btn danger" id="del">删除这条记录</button>` : ""}
        </div>
      </div>
    `;

    this.$ = (id) => this.querySelector(`#${id}`);
    this.renderTurns();
    this.renderFull();
    this.renderOverall();

    this.$("turns").addEventListener("click", (e) => this.onClick(e));
    this.$("again").onclick = () =>
      this.nav({ view: "chat", config: { mission: s.mission, topic: s.topic, accent: s.accent, level: s.level, mode: s.mode } });
    this.$("other").onclick = () => this.nav({ view: "missions" });
    const del = this.$("del");
    if (del)
      del.onclick = async () => {
        if (!confirm("确定删除这条练习记录吗？")) return;
        await deleteSession(s.id);
        this.nav({ view: "history" });
      };

    if (s.events) {
      this._onUpdate = () => {
        this.renderTurns();
        this.renderFull();
        this.maybeSummarize();
      };
      s.events.addEventListener("update", this._onUpdate);
    }
    if (!s.fromHistory && s.turns.length) saveSession(s);
    this.maybeSummarize();
  }

  disconnectedCallback() {
    if (this._s?.events && this._onUpdate) this._s.events.removeEventListener("update", this._onUpdate);
    this.stopAll();
  }

  nav(detail) {
    this.dispatchEvent(new CustomEvent("navigate", { bubbles: true, detail }));
  }

  allAnalyzed() {
    return this._s.turns.every((t) => t.analysis || t.status === "error" || t.status === "missing");
  }

  maybeSummarize() {
    const s = this._s;
    if (s.summary || this.summarizing || !s.turns.length) return;
    if (!this.allAnalyzed()) {
      // 最多等 40 秒
      if (!this.waitTimer) this.waitTimer = setTimeout(() => this.doSummarize(), 40000);
      return;
    }
    this.doSummarize();
  }

  async doSummarize() {
    const s = this._s;
    if (s.summary || this.summarizing) return;
    clearTimeout(this.waitTimer);
    this.summarizing = true;
    this.renderOverall();
    try {
      s.summary = await summarizeSession({
        missionTitle: `${s.mission.title_en}${s.topic ? ` (${s.topic})` : ""}`,
        accent: s.accent,
        level: s.level,
        transcript: s.transcript.filter((t) => t.text),
        turns: s.turns,
        lang: s.teacherLang,
      });
      this.summaryError = null;
    } catch (e) {
      this.summaryError = e.message;
    }
    this.summarizing = false;
    this.renderOverall();
    if (s.turns.length) saveSession(s);
  }

  renderOverall() {
    const s = this._s;
    const el = this.$("overall");
    if (!el) return;
    if (!s.turns.length) {
      el.innerHTML = `<p>这次没有录到你说的话。下次试着多说几句吧！</p>`;
      return;
    }
    if (s.summary) {
      const m = s.summary;
      const T = teacherLang(m._lang || "zh", s.accent).labels;
      el.innerHTML = `
        <div class="score-row"><div class="score">${m.score ?? "-"}</div><div class="overall-text">${escapeHtml(m.overall_zh)}</div></div>
        <div class="two-col">
          <div><h4>${T.strengths}</h4><ul>${(m.strengths_zh || []).map((x) => `<li>${escapeHtml(x)}</li>`).join("")}</ul></div>
          <div><h4>${T.improvements}</h4><ul>${(m.improvements_zh || []).map((x) => `<li>${escapeHtml(x)}</li>`).join("")}</ul></div>
        </div>
        ${
          (m.key_phrases || []).length
            ? `<h4>${T.phrases}</h4><ul class="phrases">${m.key_phrases
                .map((p, i) => `<li><button class="play-mini" data-phrase="${i}" title="朗读">🔊</button><span class="en">${escapeHtml(p.en)}</span><span class="zh">${escapeHtml(p.zh)}</span></li>`)
                .join("")}</ul>`
            : ""
        }
        ${m.next_practice_zh ? `<p class="next">➡️ ${escapeHtml(m.next_practice_zh)}</p>` : ""}
      `;
      el.querySelectorAll("[data-phrase]").forEach((b) => {
        b.onclick = () => this.playNative(b, m.key_phrases[+b.dataset.phrase].en);
      });
    } else if (this.summaryError) {
      el.innerHTML = `<p>总结生成失败：${escapeHtml(this.summaryError)}</p><button class="small-btn" id="retry-sum">重试</button>`;
      el.querySelector("#retry-sum").onclick = () => this.doSummarize();
    } else {
      const done = s.turns.filter((t) => t.analysis || t.status === "error" || t.status === "missing").length;
      el.innerHTML = `<div class="fb-loading"><span class="dots"></span> 老师正在写总结…（已点评 ${done}/${s.turns.length} 句）</div>`;
    }
  }

  renderTurns() {
    const s = this._s;
    const box = this.$("turns");
    if (!box) return;
    if (!s.turns.length) {
      box.innerHTML = `<p class="muted">没有录音。</p>`;
      return;
    }
    box.innerHTML = s.turns
      .map((t, i) => {
        const a = t.analysis;
        const body =
          t.status === "missing"
            ? `<div class="fb-muted">${escapeHtml(t.error || "本句未点评")}</div>`
            : t.status === "error"
            ? `<div class="fb-muted">点评失败：${escapeHtml(t.error || "")}</div>`
            : a
            ? feedbackHtml(a, { compact: true })
            : `<div class="fb-loading"><span class="dots"></span> 点评中…</div>`;
        return `
        <div class="card sum-turn" data-idx="${i}">
          ${t.prevCharacterText ? `<div class="ctx">🎭 ${escapeHtml(t.prevCharacterText)}</div>` : ""}
          <div class="my-line">
            <button class="play-btn" data-act="mine" ${t.pcm ? "" : "disabled"}>▶ 我的录音</button>
            <span class="num">#${i + 1}</span>
            <span class="en said">${escapeHtml((a && !a.no_speech && a.transcript) || t.text || "（未识别）")}</span>
          </div>
          <div class="sum-fb">${body}</div>
          ${
            a && !a.no_speech
              ? `<div class="teacher-line">
                  <button class="play-btn teacher" data-act="teacher">▶ 老师点评</button>
                  <span>${escapeHtml(a.spoken_feedback_zh)}</span>
                </div>`
              : ""
          }
        </div>`;
      })
      .join("");
  }

  renderFull() {
    const el = this.$("full");
    if (!el) return;
    el.innerHTML = this._s.transcript
      .filter((t) => t.text)
      .map((t) => `<div class="bubble ${t.role === "user" ? "user" : "model"}">${escapeHtml(t.text)}</div>`)
      .join("");
  }

  // ---------------- 播放 ----------------
  resetPlaying() {
    if (this.playingBtn) {
      this.playingBtn.classList.remove("playing");
      if (this.playingBtn.dataset.label) this.playingBtn.textContent = this.playingBtn.dataset.label;
    }
    this.playingBtn = null;
  }

  stopAll() {
    try { this.audio?.pause(); } catch {}
    stopBrowserSpeech();
    this.resetPlaying();
  }

  setPlaying(btn) {
    this.stopAll();
    this.playingBtn = btn;
    btn.classList.add("playing");
    if (btn.classList.contains("word-say")) return; // 单词按钮只改颜色，不改文字
    btn.dataset.label = btn.dataset.label || btn.textContent;
    btn.textContent = btn.dataset.label.replace("▶", "■");
  }

  /** 发音问题里的单词：按口音 TTS（先慢后正常），失败时用浏览器语音 */
  async playWord(btn, word) {
    if (this.playingBtn === btn) return this.stopAll();
    this.stopAll();
    btn.disabled = true;
    try {
      const pcm = await wordTTS(word, this._s.accent);
      btn.disabled = false;
      this.playPcm(btn, pcm, 24000);
    } catch {
      btn.disabled = false;
      this.setPlaying(btn);
      await speakBrowser(`${word}. ${word}.`, (ACCENTS[this._s.accent] || ACCENTS.us).bcp47, 0.8);
      if (this.playingBtn === btn) this.resetPlaying();
    }
  }

  playPcm(btn, pcm, rate) {
    if (this.playingBtn === btn) return this.stopAll();
    this.setPlaying(btn);
    if (this.audio.src) URL.revokeObjectURL(this.audio.src);
    this.audio.src = URL.createObjectURL(int16ToWavBlob(pcm, rate));
    this.audio.play().catch(() => this.resetPlaying());
  }

  async playNative(btn, text) {
    if (this.playingBtn === btn) return this.stopAll();
    const label = btn.textContent;
    btn.textContent = "⏳";
    btn.disabled = true;
    try {
      const pcm = await nativeTTS(text, this._s.accent);
      btn.textContent = label;
      btn.disabled = false;
      this.playPcm(btn, pcm, 24000);
    } catch {
      btn.textContent = label;
      btn.disabled = false;
      this.setPlaying(btn);
      await speakBrowser(text, (ACCENTS[this._s.accent] || ACCENTS.us).bcp47);
      this.resetPlaying();
    }
  }

  async onClick(e) {
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    const card = btn.closest("[data-idx]");
    const t = this._s.turns[+card.dataset.idx];
    if (!t) return;
    const act = btn.dataset.act;
    if (act === "mine" && t.pcm) {
      this.playPcm(btn, t.pcm, 16000);
    } else if (act === "native" && t.analysis) {
      this.playNative(btn, t.analysis.better_expression);
    } else if (act === "word" && btn.dataset.word) {
      this.playWord(btn, btn.dataset.word);
    } else if (act === "teacher" && t.analysis) {
      if (this.playingBtn === btn) return this.stopAll();
      if (t.teacherPcm) return this.playPcm(btn, t.teacherPcm, 24000);
      if (getSetting("teacherVoiceSource") === "browser") {
        this.setPlaying(btn);
        await speakBrowser(t.analysis.spoken_feedback_zh, teacherLang(t.analysis._lang || "zh", this._s.accent).speechLang);
        this.resetPlaying();
        return;
      }
      const label = btn.textContent;
      btn.textContent = "⏳ 生成中";
      btn.disabled = true;
      try {
        t.teacherPcm = await teacherTTS(t.analysis.spoken_feedback_zh, t.analysis._lang || "zh");
        btn.textContent = label;
        btn.disabled = false;
        this.playPcm(btn, t.teacherPcm, 24000);
        saveSession(this._s);
      } catch {
        btn.textContent = label;
        btn.disabled = false;
        this.setPlaying(btn);
        await speakBrowser(t.analysis.spoken_feedback_zh, teacherLang(t.analysis._lang || "zh", this._s.accent).speechLang);
        this.resetPlaying();
      }
    }
  }
}

customElements.define("view-summary", ViewSummary);
