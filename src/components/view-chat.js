/**
 * 对话页：角色扮演（Gemini Live）+ 老师点评
 *
 * 两种流程：
 *  - 实时流程（逐句关闭）：麦克风实时上传给 Live，对方说完就回应；老师在旁边点评。
 *  - 逐句流程（逐句开启）：本地录下一句 → 老师点评 → 点“下一句”才把这句发给对方 → 对方回应 → 再录下一句。
 *
 * 两种老师：
 *  - 独立老师（默认）：另一个文本模型听录音给点评，设备语音 / Gemini TTS 朗读。
 *  - 单模型模式：同一个 Live 模型先调用 give_feedback 并口头点评，再（或等“[continue]”后）以角色身份回应。
 */
import "./audio-visualizer.js";
import { LiveSession } from "../lib/gemini-live/geminilive.js";
import { isModelGoneError, replaceModel } from "../lib/models.js";
import { listModels, fieldComplete } from "../lib/gemini-rest.js";
import { AudioStreamer, AudioPlayer } from "../lib/gemini-live/mediaUtils.js";
import { concatInt16, trimSilence, formatDuration, rms } from "../lib/audio-utils.js";
import { getSetting, setSetting, ACCENTS, LEVELS, authMode, teacherLang, resolveOpener } from "../lib/settings.js";
import { startRelaySession, reportUsage } from "../lib/relay.js";
import { analyzeTurnStream, teacherTTS, nativeTTS, wordTTS, speakBrowser, stopBrowserSpeech, unlockBrowserSpeech } from "../lib/teacher.js";
import { escapeHtml, feedbackHtml } from "../lib/dom.js";
import { acquireMic, reacquireMic, watchAudioLifecycle } from "../lib/mic-permission.js";
import {
  coachProtocol, giveFeedbackDeclaration, resumeRoleplayDeclaration, toolNextHint, cleanCharacterText, argsToAnalysis,
  COACH_MUTE_SIGNAL, COACH_UNMUTE_SIGNAL,
} from "../lib/single-model.js";

const SESSION_LIMIT_SEC = 15 * 60; // Live API 纯音频会话上限约 15 分钟
const RING_SAMPLES = 16000 * 3;
const TEACHER_WAIT_MS = 12000;
// 本地 VAD：说话至少 0.3 秒后，静音 0.7 秒就认为这句说完
const VAD_MIN_VOICE = 16000 * 0.3;
const VAD_END_SILENCE = 16000 * 0.7;
const STEP_MAX_SENTENCE = 16000 * 25; // 逐句模式一句最长 25 秒
const SEND_CHUNK = 1600; // 补发音频：每块 100ms
const SEND_INTERVAL_MS = 25; // 比实时快约 4 倍
const SILENCE_TAIL_SEC = 1.2; // 补发后追加的静音，让服务端 VAD 判定这句结束
const RESPONSE_WATCHDOG_MS = 8000;

export const CONTINUE_SIGNAL = "[continue]";
const NUDGE_REPLY = "[The learner has finished speaking. Please reply in character now.]";
const NUDGE_FEEDBACK = "[The learner has finished speaking. Please call give_feedback and give your short coach comment now, then stop and wait.]";
const REDO_SIGNAL =
  "[redo] The learner wants to try that sentence again. Forget their previous attempt and your feedback on it. Say nothing now; wait for their new attempt.";

function buildSystemInstruction(cfg, { single = false, step = false, opener = "partner" } = {}) {
  const m = cfg.mission;
  const a = ACCENTS[cfg.accent] || ACCENTS.us;
  const lvl = (LEVELS[cfg.level] || LEVELS.intermediate).en;
  const scenario = m.scenario_en.replace(/\{city\}/g, a.city);
  const isUK = cfg.accent === "uk";
  const goal = m.custom
    ? `Topic: ${cfg.topic ? `"${cfg.topic}"` : "anything the learner wants to talk about; if they don't pick one, suggest an everyday topic"}.`
    : `The learner's goal: ${m.goal_en}`;
  const who = single ? "The CHARACTER should s" : "- S";
  const lang =
    cfg.mode === "assisted"
      ? `${single ? "- " : ""}${who}peak English. If the learner is clearly stuck, speaks Chinese, or asks how to say something, ${single ? "the character" : "you"} may give ONE very short hint (say the English phrase they need; at most a few words of Chinese), then carry on in English, in character.`
      : `${single ? "- " : ""}${who}peak English only. ${single ? "The character must never" : "Never"} speak Chinese, even if the learner does. If the learner uses Chinese, react in character as someone who doesn't understand it and encourage them to try in English (you may offer a simple English phrase they could use).`;
  const correction = single
    ? `- The CHARACTER does not correct the learner's grammar or pronunciation and gives no language lessons: only the COACH (see below) does that. If the character genuinely can't understand them, it asks them to repeat, as a real person would.`
    : `- Do NOT correct the learner's grammar or pronunciation and do not give language lessons: a separate teacher gives feedback. Just react naturally as a real person would; if you genuinely can't understand them, ask them to repeat or clarify, as a real person would.`;
  const stepNote =
    step && !single
      ? `\n- The app sends each learner sentence to you only after they have finished it, sometimes followed by a short silence. Reply to each one normally.`
      : "";
  let text = `You are role-playing as ${m.role_en} in a spoken English conversation practice.
Setting: ${scenario}
The learner is a native Mandarin Chinese speaker practising ${a.en}. Learner level: ${lvl}.
${goal}

ACCENT & LANGUAGE:
- Speak with a natural ${isUK ? "standard southern British (London) accent" : "General American accent"} and use ${isUK ? "British" : "American"} vocabulary and idioms (e.g. ${isUK ? "flat, queue, the Tube, bill, mobile, quid, cheers" : "apartment, line, the subway, check, cell phone, bucks, sounds good"}).
${lang}

STYLE:
- Stay fully in character as a real person. Never mention being an AI or a language tutor.
- Keep each reply short: 1-2 sentences (about 30 words at most), then give the learner room to speak. Ask questions to keep them talking.
${correction}
- Make the conversation realistic, with small natural complications that fit your role.${stepNote}

${
    opener === "me"
      ? `START: The LEARNER speaks first this time. Do NOT say anything until the learner has spoken; then respond in character${single ? " (following the coach protocol below)" : ""}. Never open the conversation yourself.`
      : `START: When you receive the message "[START]", open the conversation in character with one short line.`
  }
${m.custom ? "" : `MISSION: When the learner has achieved the goal, wrap up naturally in character, then call the complete_mission tool. If the learner keeps talking afterwards, keep chatting.`}`;
  if (single)
    text +=
      "\n" +
      coachProtocol(cfg.accent, teacherLang(undefined, cfg.accent).key, { stepMode: step, coachMuted: !getSetting("teacherVoiceOn") });
  return text;
}

class ViewChat extends HTMLElement {
  set config(v) {
    this._cfg = v;
  }

  isActive() {
    return this.state === "active" || this.state === "connecting";
  }

  connectedCallback() {
    if (!this._cfg) return;
    const cfg = this._cfg;
    const a = ACCENTS[cfg.accent] || ACCENTS.us;
    // 单模型模式在开始时确定，中途切换设置要到下一次才生效
    this.single = !!getSetting("singleModelMode");
    const TL = teacherLang(undefined, cfg.accent);
    this.state = "idle";
    this.session = {
      id: `s_${Date.now()}`,
      startedAt: Date.now(),
      endedAt: null,
      mission: cfg.mission,
      topic: cfg.topic,
      accent: cfg.accent,
      level: cfg.level,
      mode: cfg.mode,
      teacherLang: TL.key,
      singleModel: this.single,
      transcript: [],
      turns: [],
      summary: null,
      events: new EventTarget(),
    };

    const teacherWord = TL.key === "en" ? "英文老师" : "中文老师";
    const intro = this.single
      ? `你每说完一句，同一个 AI 会先以<b>老师</b>身份点评（${TL.key === "en" ? "英文" : "中文"}），再回到角色。`
      : `你每说完一句，<b>${teacherWord}</b>会给出点评${getSetting("teacherVoiceOn") ? "并用语音说出来" : ""}。`;
    this.innerHTML = `
      <div class="chat">
        <div class="chat-top">
          <button class="icon-btn" id="back" aria-label="返回">←</button>
          <div class="chat-title">
            <div class="t1">${cfg.mission.icon} ${escapeHtml(cfg.mission.title_zh)}${cfg.topic ? `：${escapeHtml(cfg.topic)}` : ""}</div>
            <div class="t2">${a.short} · ${(LEVELS[cfg.level] || LEVELS.intermediate).label} · ${cfg.mode === "assisted" ? "辅助" : "沉浸"}${this.single ? " · 单模型" : ""} · 对方：${escapeHtml(cfg.mission.role_zh)}</div>
          </div>
          <button class="chip step-chip ${getSetting("stepMode") ? "on" : ""}" id="step-toggle" title="逐句模式：每说完一句先看老师点评，点“下一句”后对方才回应">逐句</button>
          ${voiceChipHtml(getSetting("teacherVoiceOn"))}
          <div class="timer" id="timer">0:00</div>
        </div>

        <div class="viz-row">
          <audio-visualizer id="model-viz"></audio-visualizer>
        </div>

        <div class="mission-banner hidden" id="mission-banner">🎉 任务完成！可以继续聊，或者点“结束”看总结。</div>

        <div class="transcript" id="transcript">
          <div class="empty-hint" id="empty-hint">
            <p>🎧 建议戴耳机，效果更好。</p>
            <p>点下方按钮开始，对方会先开口。${intro}</p>
            <p>${getSetting("stepMode") ? "逐句模式：说完一句先看点评，点“下一句”后对方才回应；不满意可以“重说”。" : "实时模式：对方会直接回应你。"}</p>
            ${cfg.mission.custom ? "" : `<p class="goal">🎯 目标：${escapeHtml(cfg.mission.desc_zh)}</p>`}
          </div>
        </div>

        <div class="hold-banner hidden" id="hold-banner">
          <span id="hold-text">🧑‍🏫 老师点评中，请稍候再说…</span>
          <button class="small-btn" id="skip-teacher">跳过</button>
        </div>

        <div class="step-panel hidden" id="step-panel">
          <span id="step-text">🎙️ 正在听…</span>
          <span class="step-links">
            <button class="link-btn hidden" id="done-btn">说完了</button>
            <button class="link-btn hidden" id="step-skip">跳过等待</button>
          </span>
        </div>

        <div class="chat-bottom">
          <div class="viz-row small"><audio-visualizer id="user-viz"></audio-visualizer></div>
          <div class="controls">
            <button class="cta-btn redo-btn hidden" id="redo-btn" title="丢掉这句的录音和点评，重新说">↺ 重说</button>
            <button class="cta-btn next-btn hidden" id="next-btn" disabled>老师点评中…</button>
            <button class="cta-btn" id="main-btn">开始对话</button>
          </div>
          <p class="status-line" id="status"></p>
        </div>
      </div>
    `;

    this.$ = (id) => this.querySelector(`#${id}`);
    this.$("back").onclick = () => this.onBack();
    this.$("main-btn").onclick = () => this.onMainBtn();
    this.$("skip-teacher").onclick = () => this.skipTeacher();
    this.$("voice-toggle").onclick = () => this.onVoiceToggle();
    this.$("transcript").addEventListener("click", (e) => this.onTranscriptClick(e));
    this.$("next-btn").onclick = () => this.onNext();
    this.$("step-skip").onclick = () => this.onSkipWait();
    this.$("redo-btn").onclick = () => this.onRedo();
    this.$("done-btn").onclick = () => this.onDoneSpeaking();
    this.$("step-toggle").onclick = () => this.onStepToggle();
  }

  // ======================================================================
  // 逐句流程
  // ======================================================================
  stepOn() {
    return this.flow === "step";
  }

  setPhase(phase) {
    this.stepPhase = phase;
    if (phase === "listen") {
      this.userChunks = [];
      this.resetVad();
    }
    this.updateStepUI();
  }

  /** 当前这句（review 阶段）是否可以点“下一句” */
  stepReady() {
    const t = this.stepTurn;
    if (!t || t.skipWait) return true;
    if (this.single) return !!t.singleDone;
    return (t.status === "done" || t.status === "error") && t.voice !== "waiting";
  }

  updateStepUI() {
    const panel = this.$("step-panel");
    const next = this.$("next-btn");
    const main = this.$("main-btn");
    const redo = this.$("redo-btn");
    const done = this.$("done-btn");
    const skip = this.$("step-skip");
    if (!panel || !next || !main) return;
    const show = this.stepOn() && (this.state === "active" || this.reconnecting);
    panel.classList.toggle("hidden", !show);
    if (!show) {
      next.classList.add("hidden");
      redo.classList.add("hidden");
      main.classList.remove("compact");
      return;
    }
    this.$("hold-banner")?.classList.add("hidden");
    main.classList.add("compact");
    main.textContent = "结束";
    const setText = (t) => (this.$("step-text").textContent = t);
    const down = this.liveDown ? "（连接已断开，发送时会自动重连）" : "";
    next.classList.add("hidden");
    redo.classList.add("hidden");
    done.classList.add("hidden");
    skip.classList.add("hidden");

    if (this.reconnecting) {
      next.classList.remove("hidden");
      next.disabled = true;
      next.textContent = "重新连接中…";
      setText("🔌 正在重新连接，马上就好…");
      return;
    }
    const phase = this.stepPhase;
    if (phase === "listen") {
      const heard = this.vad && this.vad.voiced >= VAD_MIN_VOICE;
      setText(heard ? "🎙️ 正在听…说完停顿一下即可" : `🎙️ 请说${this.session.turns.length ? "下一句" : "第一句"}${down}`);
      done.classList.toggle("hidden", !heard);
      return;
    }
    if (phase === "review") {
      const ready = this.stepReady();
      next.classList.remove("hidden");
      redo.classList.remove("hidden");
      next.disabled = !ready;
      if (ready) next.innerHTML = `下一句 ▶<small class="btn-sub">让对方回应</small>`;
      else next.textContent = "老师点评中…";
      skip.classList.toggle("hidden", ready);
      let text;
      if (!ready) text = this.single ? "🧑‍🏫 老师正在听你这句…" : "🧑‍🏫 老师正在听你刚才那句…";
      else if (this.teacherSpeaking) text = "🧑‍🏫 老师正在点评，听完点“下一句”（点击会停止语音）";
      else text = "✅ 看完点评后点“下一句”让对方回应；不满意可以“重说”";
      setText(text + down);
      return;
    }
    if (phase === "responding") {
      if (this.respondFailed) {
        next.classList.remove("hidden");
        next.disabled = false;
        next.textContent = "重试 ▶";
        setText("⚠️ 对方没有回应，点“重试”再发一次");
        return;
      }
      setText(this.modelSpeaking || this.player?.streaming ? "🎭 对方说话中…" : "⏳ 等待对方回应…");
      return;
    }
    setText("");
  }

  /** 本地 VAD 判定一句说完（或点了“说完了”） */
  onStepSentenceEnd(manual = false) {
    if (!this.stepOn() || this.stepPhase !== "listen") return;
    const pcm = concatInt16(this.userChunks || []);
    const trimmed = trimSilence(pcm, 16000);
    if (!trimmed || trimmed.length < 16000 * 0.4) {
      if (manual) this.setStatus("没听到你说话，再说一次吧", "var(--color-accent-secondary)");
      this.setPhase("listen");
      return;
    }
    const silenceMs = this.vadSilenceMs();
    const turn = this.createTurn({ text: "", pcm: trimmed, spokeEnd: Date.now() - (manual ? 0 : silenceMs) });
    turn.step = true;
    this.setStatus("");
    this.stepTurn = turn;
    this.setPhase("review");
    if (this.single) {
      // 单模型：立刻把这句发给 Live，让它先点评（等“[continue]”才以角色回应）
      this.singleTurn = turn;
      this.renderTurn(turn);
      this.sendStepAudio(turn, "feedback");
    } else {
      const job = this.startAnalysisJob({
        pcm: trimmed,
        asrText: "",
        prevCharacterText: this.lastCharacterText,
        spokeEnd: turn.t.spokeEnd,
      });
      this.adoptJob(turn, job);
    }
    this.revealStepCard(turn);
  }

  onDoneSpeaking() {
    this.onStepSentenceEnd(true);
  }

  onSkipWait() {
    const t = this.stepTurn;
    if (!t) return;
    t.skipWait = true;
    if (this.player) this.player.stopClip();
    stopBrowserSpeech();
    if (t.voice === "waiting" || t.voice === "ready" || t.voice === "ready-browser") t.voice = "skipped";
    this.teacherSpeaking = false;
    this.updateStepUI();
  }

  /** 点“下一句”：把这句发给对方（单模型：发“[continue]”） */
  async onNext() {
    if (!this.stepOn() || this.reconnecting) return;
    if (this.stepPhase === "responding" && this.respondFailed) return this.retryRespond();
    if (this.stepPhase !== "review") return;
    if (!this.stepReady()) return;
    const turn = this.stepTurn;
    // 停掉老师语音
    if (this.player) this.player.stopClip();
    stopBrowserSpeech();
    if (turn && turn.voice !== "played" && turn.voice !== "off") turn.voice = "skipped";
    this.teacherQueue = this.teacherQueue.filter((x) => !["skipped", "off", "played"].includes(x.voice));
    this.teacherSpeaking = false;
    this.setHold(false);
    this.stepTurn = null;
    this.replyTurn = turn;
    this.respondFailed = false;
    this.setPhase("responding");
    if (this.single) await this.sendContinue(turn);
    else await this.sendStepAudio(turn, "reply");
  }

  /** 重说：丢掉当前这句的录音和点评，重新录 */
  onRedo() {
    if (!this.stepOn() || this.stepPhase !== "review") return;
    const turn = this.stepTurn;
    if (!turn) return;
    this.stopPlayback();
    if (this.player) this.player.stopClip();
    stopBrowserSpeech();
    turn.job?.controller?.abort();
    turn.cancelled = true;
    turn.voice = "skipped";
    this.clearWatchdog();
    this.teacherQueue = this.teacherQueue.filter((x) => x !== turn);
    this.teacherSpeaking = false;
    this.session.turns = this.session.turns.filter((t) => t !== turn);
    this.session.transcript = this.session.transcript.filter((e) => e.turnId !== turn.id);
    this.querySelector(`[data-turn="${turn.id}"]`)?.remove();
    if (this.lastFinalizedTurn === turn) this.lastFinalizedTurn = null;
    if (this.single) {
      // 已经发给模型了：告诉它忽略上一次尝试；正在输出的点评不再显示
      if (this.singleTurn === turn) this.singleTurn = null;
      if (this.modelSpeaking) {
        this.ignoreModelTurn = true;
        this.player?.interrupt();
      }
      if (turn.sentToLive && this.live && !this.liveDown) this.live.sendText(REDO_SIGNAL, false);
    }
    this.stepTurn = null;
    this.emit();
    this.setPhase("listen");
    this.setStatus("↺ 请重说这一句", "var(--color-accent-secondary)");
  }

  /** 逐句模式开关（对话中切换立即生效） */
  onStepToggle() {
    const on = !getSetting("stepMode");
    setSetting("stepMode", on);
    this.$("step-toggle").classList.toggle("on", on);
    this.setStatus(
      on ? "已开启逐句模式：说完一句先看点评，点“下一句”后对方才回应" : "已关闭逐句模式：对方会直接回应你",
      "var(--color-text-sub)"
    );
    if (this.state !== "active") return;
    const prev = this.flow;
    const next = on ? "step" : "live";
    if (prev === next) return;
    if (next === "live") this.switchToLive();
    else this.switchToStep();
  }

  switchToLive() {
    const turn = this.stepTurn;
    const phase = this.stepPhase;
    this.flow = "live";
    this.stepTurn = null;
    this.clearWatchdog();
    this.updateStepUI();
    const main = this.$("main-btn");
    if (main) main.textContent = "结束并查看总结";
    // 单模型的提示词跟逐句模式有关：重连换成实时版本
    if (this.single) this.needReconnect = true;
    if (phase === "review" && turn) {
      // 还没发给对方的这句：现在发出去，对方照常回应
      this.replyTurn = turn;
      if (this.single) this.sendContinue(turn);
      else this.sendStepAudio(turn, "reply");
    } else if (this.needReconnect && !this.modelSpeaking) {
      this.ensureLive();
    }
    this.userChunks = [];
    this.resetVad();
  }

  switchToStep() {
    this.flow = "step";
    if (this.single) this.needReconnect = true;
    // 对方正在说：等它说完再开始录下一句
    if (this.modelSpeaking || this.player?.streaming) {
      this.replyTurn = null;
      this.setPhase("responding");
    } else {
      this.setPhase("listen");
    }
  }

  /** 确保 Live 连着（断开或需要换提示词时重连）；失败返回 false */
  async ensureLive() {
    if (!this.liveDown && !this.needReconnect) return true;
    return this.reconnectLive();
  }

  /**
   * 把这句录音补发给 Live：按 100ms 一块、比实时快地发送，然后补一段静音让服务端判定说完。
   * purpose: "reply"（让角色回应）| "feedback"（单模型先点评）
   */
  async sendStepAudio(turn, purpose) {
    const ok = await this.ensureLive();
    if (!ok) {
      this.respondFailed = true;
      this.updateStepUI();
      return;
    }
    const live = this.live;
    turn.sentToLive = true;
    this.awaitingTurn = turn;
    this.awaitPurpose = purpose;
    this.asrTarget = turn;
    this.modelOutputSince = false;
    const pcm = turn.pcm;
    const total = pcm.length + Math.round(16000 * SILENCE_TAIL_SEC);
    const silence = new Int16Array(SEND_CHUNK);
    for (let off = 0; off < total; off += SEND_CHUNK) {
      if (this.live !== live || this.state !== "active" || turn.cancelled) return;
      live.sendAudio(off < pcm.length ? pcm.subarray(off, Math.min(pcm.length, off + SEND_CHUNK)) : silence);
      await sleep(SEND_INTERVAL_MS);
    }
    if (turn.cancelled) return;
    this.startWatchdog(purpose);
  }

  /** 单模型：让角色回应（发送“[continue]”） */
  async sendContinue(turn) {
    const ok = await this.ensureLive();
    if (!ok) {
      this.respondFailed = true;
      this.updateStepUI();
      return;
    }
    this.awaitingTurn = turn;
    this.awaitPurpose = "reply";
    this.modelOutputSince = false;
    if (this.flow === "live") {
      // 已切回实时模式：直接让它以角色身份回应
      this.live.sendText(`${CONTINUE_SIGNAL} Reply in character now.`);
    } else {
      this.live.sendText(CONTINUE_SIGNAL);
    }
    this.startWatchdog("reply");
  }

  startWatchdog(purpose) {
    this.clearWatchdog();
    this.watchdogTries = 0;
    const arm = () => {
      this.watchdog = setTimeout(() => {
        this.watchdog = null;
        if (this.modelOutputSince || this.state !== "active") return;
        if (this.watchdogTries === 0 && this.live && !this.liveDown) {
          this.watchdogTries++;
          console.warn("[逐句] 8 秒没回应，发送文字提示");
          this.live.sendText(purpose === "feedback" ? NUDGE_FEEDBACK : this.single ? CONTINUE_SIGNAL : NUDGE_REPLY);
          arm();
          return;
        }
        // 两次都没回应：给出重试
        if (purpose === "feedback") {
          const t = this.stepTurn;
          if (t && !t.analysis) this.markMissing(t, "模型没有回应");
          if (t) t.singleDone = true;
          this.updateStepUI();
        } else {
          this.respondFailed = true;
          this.updateStepUI();
        }
      }, RESPONSE_WATCHDOG_MS);
    };
    arm();
  }

  clearWatchdog() {
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = null;
  }

  async retryRespond() {
    const turn = this.replyTurn;
    this.respondFailed = false;
    this.updateStepUI();
    if (this.single) await this.sendContinue(turn);
    else if (turn) await this.sendStepAudio(turn, "reply");
    else this.setPhase("listen"); // 开场白没出来：直接让用户先说
  }

  /** 角色这一轮说完（并且播放完）：开始录下一句 */
  onRespondFinished() {
    this.replyTurn = null;
    this.respondFailed = false;
    if (this.stepOn() && this.stepPhase === "responding") {
      this.setPhase("listen");
      this.setStatus("🎙️ 请说下一句", "var(--color-success)");
    }
  }

  // ======================================================================
  // 连接
  // ======================================================================
  /** Live 连接断开（会话到期/goAway/空闲断开）后重连，并把最近对话作为上下文 */
  async reconnectLive() {
    this.reconnecting = true;
    this.updateStepUI();
    try {
      if (this.live) {
        this.live.onClose = () => {};
        this.live.close();
      }
      this.finishRelay();
      let relay = null;
      if (authMode() === "invite") {
        relay = await startRelaySession();
        this.relaySession = relay;
        this.relayReported = false;
      }
      await this.connectLive(relay, this.buildResumeContext());
      this.liveDown = false;
      this.needReconnect = false;
      this.goAwayPending = false;
      this.reconnecting = false;
      this.modelSpeaking = false;
      if (this._onPageHide) window.addEventListener("pagehide", this._onPageHide);
      this.updateStepUI();
      return true;
    } catch (e) {
      console.error("重连失败", e);
      this.reconnecting = false;
      this.liveDown = true;
      this.updateStepUI();
      this.setStatus(`⚠️ 重连失败：${e.message || e}。可以再试一次，或者点“结束”查看总结。`, "var(--color-danger)");
      return false;
    }
  }

  /** 最近几轮对话的文字，用于重连后接着聊 */
  buildResumeContext() {
    const lines = this.session.transcript
      .filter((e) => e.text && e.text.trim())
      .slice(-12)
      .map((e) => `${e.role === "user" ? "Learner" : "You"}: ${e.text.trim()}`);
    return lines.join("\n");
  }

  /** 连接 Live；模型停用时自动换成推荐模型再试一次 */
  async connectLive(relay, resumeContext) {
    let live;
    for (let attempt = 0; ; attempt++) {
      live = this.buildLive(relay, resumeContext);
      try {
        await live.connect();
        break;
      } catch (e) {
        const gone = e.reason && isModelGoneError({ message: e.reason });
        if (attempt === 0 && gone) {
          const failed = getSetting("liveModel");
          const next = await replaceModel("live", failed, e.reason, listModels);
          if (next) {
            this.setStatus(`模型 ${failed} 已停用，正在换成 ${next}…`);
            if (relay) {
              // 一次性令牌已用掉：退回刚才预留的额度，重新申请
              reportUsage(relay.sessionId, 0);
              relay = await startRelaySession();
              this.relaySession = relay;
              this.relayReported = false;
            }
            continue;
          }
        }
        throw e;
      }
    }
    this.connectedAt = Date.now();
    return { live, relay };
  }

  /** 连接即将到期或已断开：标记为需要重连，下次发送时自动重连 */
  markLiveDown(message) {
    this.liveDown = true;
    if (this.live) {
      this.live.onClose = () => {};
      this.live.close();
    }
    this.finishRelay();
    this.clearWatchdog();
    if (this.modelSpeaking) {
      this.modelSpeaking = false;
      this.finishModelTurn(true);
    }
    if (this.stepPhase === "responding" && this.replyTurn) {
      // 对方还没回应就断了：让用户点“重试”（会自动重连）
      this.respondFailed = true;
    } else if (this.stepPhase === "responding") {
      this.setPhase("listen");
    }
    if (message) this.setStatus(message, "var(--color-accent-secondary)");
    this.updateStepUI();
  }

  disconnectedCallback() {
    this.cleanup();
  }

  setStatus(text, color) {
    const el = this.$("status");
    if (!el) return;
    el.textContent = text || "";
    el.style.color = color || "";
  }

  onBack() {
    if (this.isActive() && this.session.turns.length) {
      if (confirm("结束对话并查看总结？")) this.endSession();
      return;
    }
    this.cleanup();
    this.dispatchEvent(new CustomEvent("navigate", { bubbles: true, detail: { view: "missions" } }));
  }

  onMainBtn() {
    if (this.state === "idle" || this.state === "error") this.startSession();
    else if (this.state === "active" || this.state === "ended-unexpectedly") this.endSession();
  }

  // ======================================================================
  // 会话生命周期
  // ======================================================================
  async startSession() {
    this.state = "connecting";
    const btn = this.$("main-btn");
    btn.disabled = true;
    btn.textContent = "连接中…";
    this.setStatus("正在打开麦克风并连接…");

    // 运行时状态
    this.flow = getSetting("stepMode") ? "step" : "live";
    this.stepPhase = "idle";
    this.userChunks = [];
    this.ring = [];
    this.ringLen = 0;
    this.pendingUserText = "";
    this.modelSpeaking = false;
    this.currentModelEntry = null;
    this.lastCharacterText = "";
    this.lastFinalizedTurn = null;
    this.teacherQueue = [];
    this.teacherSpeaking = false;
    this.teacherPlayToken = 0;
    this.pendingCoachSignal = null;
    this.holdStartedAt = 0;
    this.micHeld = false;
    this.stepTurn = null;
    this.replyTurn = null;
    this.singleTurn = null;
    this.liveDown = false;
    this.needReconnect = false;
    this.reconnecting = false;
    this.goAwayPending = false;
    this.respondFailed = false;
    this.mt = null;
    this.ignoreModelTurn = false;
    this.pendingDrain = null;
    this.resetVad();
    this.earlyJob = null;

    try {
      // iOS：必须在用户手势里尽早创建/解锁音频
      unlockBrowserSpeech();
      this.player = new AudioPlayer();
      const playerInit = this.player.init();
      this.streamer = new AudioStreamer();
      this.streamer.prepareContext();
      // 麦克风权限：必要时弹出说明/引导框，在按钮点击里同步申请（iOS）
      const micStream = await acquireMic({ onGesture: () => this.unlockAudio() });
      await playerInit;
      await this.streamer.start(micStream);
      this.streamer.onChunk = (pcm) => this.onMicChunk(pcm);
      this.lifecycle = watchAudioLifecycle({
        getContexts: () => [this.player?.audioContext, this.streamer?.audioContext],
        getStream: () => this.streamer?.mediaStream,
        onTrackEnded: () => this.onMicEnded(),
      });
      this.player.onDrained = () => this.onPlayerDrained();

      this.$("user-viz").connect(this.streamer.audioContext, this.streamer.source);
      this.$("model-viz").connect(this.player.audioContext, this.player.gainNode);

      // 邀请码模式：先向中转服务申请一次性令牌
      this.sessionLimitSec = SESSION_LIMIT_SEC;
      let relay = null;
      if (authMode() === "invite") {
        this.setStatus("正在申请练习额度…");
        relay = await startRelaySession();
        this.relaySession = relay;
        this.relayReported = false;
        this.sessionLimitSec = Math.min(SESSION_LIMIT_SEC, relay.grantedMinutes * 60);
      }

      // 谁先开口：每次练习只决定一次（重连时不再重新决定）
      if (!this.session.opener) this.session.opener = resolveOpener();
      const meFirst = this.session.opener === "me";

      // 连接；如果 Live 模型已停用，自动换成推荐模型再试一次
      const res = await this.connectLive(relay);
      relay = res.relay;
      const live = res.live;
      this.state = "active";
      this.session.startedAt = Date.now();
      this.connectedAt = this.session.startedAt;
      if (meFirst) {
        // 我先开口：不发开场提示；逐句模式直接开始本地录第一句
        if (this.stepOn()) this.setPhase("listen");
      } else {
        live.sendText("[START]");
        if (this.stepOn()) {
          // 对方先开口；说完后开始录第一句
          this.replyTurn = null;
          this.setPhase("responding");
          this.modelOutputSince = false;
          this.startWatchdog("reply");
        }
      }

      btn.disabled = false;
      btn.textContent = this.stepOn() ? "结束" : "结束并查看总结";
      btn.classList.add("active");
      const unl = relay && relay.grantedMinutes && relay.grantedMinutes < 15 ? `（本次最多 ${relay.grantedMinutes} 分钟）` : "";
      this.setStatus(meFirst ? `已连接，这次由你先开口${unl}` : `已连接，对方马上开口…${unl}`, "var(--color-success)");
      this._onPageHide = () => this.finishRelay();
      window.addEventListener("pagehide", this._onPageHide);
      const hint = this.$("empty-hint");
      if (hint) hint.remove();
      if (meFirst) this.showOpenerBox();

      this.timer = setInterval(() => this.tick(), 300);
    } catch (err) {
      console.error(err);
      this.state = "error";
      this.stopAudio();
      if (this.live) this.live.close();
      this.finishRelay();
      btn.disabled = false;
      btn.textContent = "重试";
      let msg = err.message || String(err);
      if (err.name === "MicCancelled") msg = "需要麦克风才能开始练习，点“重试”再试一次。";
      else if (err.name === "NotAllowedError") msg = "没有麦克风权限，请在浏览器设置里允许本网站使用麦克风。";
      else if (err.name === "NotFoundError") msg = "没有找到麦克风设备。";
      this.setStatus(`❌ ${msg}`, "var(--color-danger)");
    }
  }

  /** 创建 LiveSession 并挂好回调（不连接） */
  buildLive(relay, resumeContext) {
    const cfg = this._cfg;
    const step = this.flow === "step";
    let systemInstruction = buildSystemInstruction(cfg, { single: this.single, step, opener: this.session.opener || "partner" });
    if (resumeContext) {
      systemInstruction += `

RESUMING: The connection dropped and has just been restored in the middle of this conversation. Here is the conversation so far (most recent last):
${resumeContext}

Continue seamlessly from exactly this point. Do NOT greet again, do NOT restart or summarize the conversation, and ignore any "[START]" instruction. Stay silent until the learner speaks${this.single && step ? ` or you receive "${CONTINUE_SIGNAL}" (then reply in character to the learner's last line above)` : ""}, then reply naturally in character.`;
    }
    const model = getSetting("liveModel");
    const tools = [];
    if (!cfg.mission.custom) {
      tools.push({
        name: "complete_mission",
        description: "Call this when the learner has successfully achieved the mission goal.",
        parameters: {
          type: "OBJECT",
          properties: { note: { type: "STRING", description: "One short sentence about how the learner did." } },
        },
      });
    }
    if (this.single) {
      tools.push(giveFeedbackDeclaration(cfg.accent, teacherLang(undefined, cfg.accent).key, model));
      if (!step) tools.push(resumeRoleplayDeclaration(model));
    }
    const live = new LiveSession({
      apiKey: relay ? undefined : getSetting("apiKey"),
      url: relay ? relay.wsUrl : undefined,
      model,
      voiceName: getSetting("characterVoice"),
      systemInstruction,
      functionDeclarations: tools,
    });
    this.live = live;
    this.liveToolNonBlocking = /think/i.test(model);
    live.onAudio = (pcm) => {
      if (this.live !== live) return;
      this.onModelOutput();
      if (this.ignoreModelTurn) return;
      this.recordModelAudio(pcm);
      this.routeModelAudio(pcm);
    };
    live.onOutputTranscript = (t) => {
      if (this.live !== live) return;
      this.onModelOutput();
      if (this.ignoreModelTurn) return;
      this.appendModelText(t);
    };
    live.onInputTranscript = (t) => this.live === live && this.onInputText(t);
    live.onTurnComplete = () => this.live === live && this.onModelTurnEnd(false);
    live.onInterrupted = () => this.live === live && this.onModelTurnEnd(true);
    live.onToolCall = (calls) => this.live === live && this.onToolCall(calls);
    live.onGoAway = () => {
      if (this.live !== live) return;
      if (this.stepOn()) {
        // 逐句模式：没在说话时直接断开，下次发送时重连；正在说话时等这轮说完
        if (this.modelSpeaking || this.stepPhase === "responding") this.goAwayPending = true;
        else this.markLiveDown("连接即将到期，下次发送时会自动重新连接");
        return;
      }
      this.setStatus("连接即将到期，正在结束本次练习…", "var(--color-accent-secondary)");
      setTimeout(() => this.state === "active" && this.endSession(), 3000);
    };
    live.onClose = (info) => {
      if (this.live !== live) return;
      if (info.byUser || this.state !== "active") return;
      if (this.stepOn()) {
        this.markLiveDown(`⚠️ ${info.message || "连接已断开"}。下次发送时会自动重新连接`);
        return;
      }
      this.state = "ended-unexpectedly";
      this.finishRelay();
      this.stopAudio();
      this.setStatus(`⚠️ ${info.message}`, "var(--color-danger)");
      const b = this.$("main-btn");
      if (b) {
        b.disabled = false;
        b.textContent = this.session.turns.length ? "查看总结" : "返回";
        if (!this.session.turns.length) b.onclick = () => this.onBack();
      }
    };
    return live;
  }

  tick() {
    const el = this.$("timer");
    if (!el || this.state !== "active") return;
    const sec = (Date.now() - this.session.startedAt) / 1000;
    el.textContent = formatDuration(sec);
    const limit = this.sessionLimitSec || SESSION_LIMIT_SEC;
    if (this.stepOn()) {
      // 逐句模式：单次连接快到上限时不结束练习，而是断开后在下次发送时自动重连
      const connSec = this.connectedAt ? (Date.now() - this.connectedAt) / 1000 : 0;
      el.classList.remove("warn");
      if (!this.liveDown && !this.reconnecting) {
        const idle = this.stepPhase === "listen" || this.stepPhase === "review";
        if (idle && !this.modelSpeaking && connSec >= limit - 30) this.markLiveDown("");
        else if (connSec >= limit - 5) this.markLiveDown("已达到单次连接时长上限，下次发送时会自动重新连接");
      }
      if (this.stepPhase === "listen") this.updateListenHint();
      this.pumpTeacher();
      return;
    }
    el.classList.toggle("warn", sec > limit - 60);
    if (sec >= limit - 5) {
      this.setStatus(
        limit < SESSION_LIMIT_SEC ? `已用完今天的剩余额度（${Math.round(limit / 60)} 分钟）` : "已达到单次练习时长上限（15 分钟）",
        "var(--color-accent-secondary)"
      );
      this.endSession();
      return;
    }
    this.pumpTeacher();
  }

  updateListenHint() {
    const heard = this.vad && this.vad.voiced >= VAD_MIN_VOICE;
    if (heard !== this._lastHeard) {
      this._lastHeard = heard;
      this.updateStepUI();
    }
  }

  /** 在用户手势里调用：解锁/恢复播放与采集的音频（iOS） */
  unlockAudio() {
    unlockBrowserSpeech();
    try { this.streamer?.prepareContext(); } catch {}
    this.player?.resume();
  }

  /** 麦克风轨道被系统中断（来电、切后台等）：弹窗一键恢复 */
  async onMicEnded() {
    if (this.state !== "active" || this._restoringMic) return;
    this._restoringMic = true;
    this.setStatus("⚠️ 麦克风断开了", "var(--color-danger)");
    const next = new AudioStreamer();
    try {
      const stream = await reacquireMic({
        onGesture: () => {
          next.prepareContext();
          this.unlockAudio();
        },
      });
      if (this.state !== "active") {
        stream.getTracks().forEach((t) => t.stop());
        next.stop();
        return;
      }
      try { this.$("user-viz")?.disconnect(); } catch {}
      this.streamer?.stop();
      this.streamer = next;
      await next.start(stream);
      next.onChunk = (pcm) => this.onMicChunk(pcm);
      this.$("user-viz").connect(next.audioContext, next.source);
      this.lifecycle?.rebind();
      this.setStatus("🎙️ 麦克风已恢复，可以继续说", "var(--color-success)");
    } catch (e) {
      next.stop();
      if (e.name === "MicCancelled") this.setStatus("⚠️ 麦克风已断开，点“结束”查看总结，或重新开始", "var(--color-danger)");
    } finally {
      this._restoringMic = false;
    }
  }

  stopAudio() {
    clearInterval(this.timer);
    this.timer = null;
    this.clearWatchdog();
    this.lifecycle?.stop();
    this.lifecycle = null;
    try { this.$("user-viz")?.disconnect(); } catch {}
    try { this.$("model-viz")?.disconnect(); } catch {}
    if (this.streamer) this.streamer.stop();
    if (this.player) this.player.destroy();
    stopBrowserSpeech();
    this.streamer = null;
    this.player = null;
  }

  /** 邀请码模式：上报实际用时，退回没用完的额度（只上报一次） */
  finishRelay() {
    if (!this.relaySession || this.relayReported) return;
    this.relayReported = true;
    const started = this.connectedAt;
    const minutes = started ? (Date.now() - started) / 60000 : 0;
    reportUsage(this.relaySession.sessionId, Math.round(minutes * 100) / 100);
    if (this._onPageHide) window.removeEventListener("pagehide", this._onPageHide);
  }

  cleanup() {
    this.finishRelay();
    if (this.live) this.live.close();
    this.stopAudio();
    this.state = this.state === "active" ? "ended" : this.state;
  }

  endSession() {
    if (this.state === "ended") return;
    // 实时流程：把最后一句没被模型回应的话也算上
    if (!this.stepOn() && !this.modelSpeaking && this.userChunks && this.userChunks.length && this.pendingUserText.trim()) {
      this.finalizeUserTurn();
    }
    this.cancelEarly("session-end");
    if (this.modelSpeaking) this.finishModelTurn(true);
    this.closeModelEntry();
    // 单模型：还没拿到点评的句子标记为“未点评”，总结页不再等待
    for (const t of this.session.turns) {
      if (t.single && !t.analysis && t.status !== "error" && t.status !== "missing" && !t.job) this.markMissing(t, "对话已结束");
    }
    this.state = "ended";
    if (this.live) this.live.close();
    this.stopAudio();
    this.session.endedAt = Date.now();
    this.finishRelay();
    this.dispatchEvent(new CustomEvent("navigate", { bubbles: true, detail: { view: "summary", session: this.session } }));
  }

  // ======================================================================
  // 音频与回合切分
  // ======================================================================
  onMicChunk(pcm) {
    if (this.state !== "active") return;
    this.ring.push(pcm);
    this.ringLen += pcm.length;
    while (this.ringLen > RING_SAMPLES && this.ring.length > 1) this.ringLen -= this.ring.shift().length;

    if (this.stepOn()) {
      // 逐句：只在“听”的阶段本地录音，不上传
      if (this.stepPhase !== "listen" || this.reconnecting) return;
      if (this.clipPlaying || this.teacherSpeaking || this.modelSpeaking || this.player?.streaming) return;
      this.userChunks.push(pcm);
      const len = this.userChunks.reduce((n, c) => n + c.length, 0);
      this.vadStep(pcm);
      if (len >= STEP_MAX_SENTENCE) this.onStepSentenceEnd(true);
      return;
    }

    if (this.liveDown || this.reconnecting) return;
    if (this.micHeld) return; // 老师说话时不上传、不录音
    if (this.clipPlaying) return; // 正在回放录音/示范发音：不上传
    if (!this.modelSpeaking && !(this.player && this.player.streaming)) {
      this.userChunks.push(pcm);
      this.vadStep(pcm);
    }
    this.live.sendAudio(pcm);
  }

  /** 模型开始有输出（音频/文字/工具调用） */
  onModelOutput() {
    this.modelOutputSince = true;
    this.clearWatchdog();
    if (this.modelSpeaking) return;
    this.modelSpeaking = true;
    if (!this.stepOn()) {
      const turn = this.finalizeUserTurn();
      if (this.single) this.singleTurn = turn;
    }
    this.openModelEntry();
    if (this.stepOn()) this.updateStepUI();
  }

  onInputText(t) {
    if (this.stepOn()) {
      // 逐句：补发音频之后才会收到转写，用它更新这句卡片上的文字
      const turn = this.asrTarget;
      if (!turn) return;
      turn.asrText = joinText(turn.asrText || "", t);
      turn.text = turn.asrText;
      const entry = this.session.transcript.find((e) => e.turnId === turn.id);
      if (entry) entry.text = turn.text;
      this.scheduleRender(turn);
      return;
    }
    // 刚结束的一句话的迟到转写
    const lt = this.lastFinalizedTurn;
    if (this.modelSpeaking && lt && Date.now() - lt.finalizedAt < 3000) {
      lt.text = joinText(lt.text, t);
      const entry = this.session.transcript.find((e) => e.turnId === lt.id);
      if (entry) entry.text = lt.text;
      this.renderTurn(lt);
      return;
    }
    this.pendingUserText = joinText(this.pendingUserText, t);
    this.renderLiveUser();
  }

  onModelTurnEnd(interrupted) {
    if (interrupted && this.player) this.player.interrupt();
    const wasSpeaking = this.modelSpeaking;
    this.modelSpeaking = false;
    const ignored = this.ignoreModelTurn;
    this.ignoreModelTurn = false;
    if (wasSpeaking) this.finishModelTurn(interrupted, ignored);
    this.closeModelEntry();
    this.flushCoachSignal();

    if (this.stepOn()) {
      this.asrTarget = null;
      // 这一轮是“让角色回应”：播放完后开始录下一句
      if (this.stepPhase === "responding") {
        this.afterDrain(() => this.onRespondFinished());
      }
      if (this.goAwayPending && !this.liveDown) this.markLiveDown("连接即将到期，下次发送时会自动重新连接");
      this.updateStepUI();
      this.pumpTeacher();
      return;
    }

    // 实时流程：新一句开始；被打断时带上最近一小段音频（用户抢话的开头）
    if (interrupted) {
      const recent = [];
      let n = 0;
      for (let i = this.ring.length - 1; i >= 0 && n < 16000 * 2; i--) {
        recent.unshift(this.ring[i]);
        n += this.ring[i].length;
      }
      this.userChunks = recent;
    } else {
      this.userChunks = [];
    }
    if (this.needReconnect && !this.liveDown) {
      // 单模型切换了逐句模式：在空档里换成对应的提示词
      this.ensureLive();
    }
    this.pumpTeacher();
  }

  /** 等模型音频播放完再执行 */
  afterDrain(fn) {
    if (this.player && this.player.streaming) this.pendingDrain = fn;
    else fn();
  }

  onPlayerDrained() {
    if (!this.modelSpeaking && this.pendingDrain) {
      const fn = this.pendingDrain;
      this.pendingDrain = null;
      fn();
    }
    this.updateStepUI();
    this.pumpTeacher();
  }

  /** 创建一句话的记录（卡片 + 会话数据） */
  createTurn({ text, pcm, spokeEnd }) {
    const turn = {
      id: `t_${Date.now()}_${this.session.turns.length}`,
      text: text || "",
      pcm,
      prevCharacterText: this.lastCharacterText,
      status: this.single ? "analyzing" : "pending",
      finalizedAt: Date.now(),
      analysisStarted: false,
      analysis: null,
      teacherPcm: null,
      single: this.single,
      t: { spokeEnd: spokeEnd || Date.now(), analysisStart: Date.now() },
      voice: this.single ? "live" : getSetting("teacherVoiceOn") ? "waiting" : "off",
    };
    this.session.turns.push(turn);
    this.session.transcript.push({ role: "user", text: turn.text, turnId: turn.id });
    this.lastFinalizedTurn = turn;
    if (turn.voice === "waiting") this.teacherQueue.push(turn);
    return turn;
  }

  /** 实时流程：模型开始回应时，把用户刚才这句定稿 */
  finalizeUserTurn() {
    const chunks = this.userChunks || [];
    this.userChunks = [];
    const text = this.pendingUserText.trim();
    this.pendingUserText = "";
    this.removeLiveUser();
    const pcm = concatInt16(chunks);
    const trimmed = trimSilence(pcm, 16000);
    const early = this.takeEarlyJob();
    const silenceMs = this.vadSilenceMs();
    this.resetVad();
    const drop = () => {
      if (early) early.controller.abort();
      return null;
    };
    if (!text && !trimmed) return drop();
    if (!text && !this.lastCharacterText) return drop(); // 开场前的环境声
    if (!text && trimmed && trimmed.length < 16000 * 0.6) return drop(); // 很短又没有转写，多半是噪音
    const turn = this.createTurn({ text, pcm: trimmed || pcm, spokeEnd: Date.now() - silenceMs });
    if (this.single) {
      if (early) early.controller.abort();
      this.renderTurn(turn);
      return turn;
    }
    // 本地 VAD 已经提前开始分析（且之后没再说话）：直接沿用；否则现在立刻开始
    const job =
      early ||
      this.startAnalysisJob({
        pcm: turn.pcm,
        asrText: text,
        prevCharacterText: this.lastCharacterText,
        spokeEnd: turn.t.spokeEnd,
      });
    this.adoptJob(turn, job);
    return turn;
  }

  /** 当前这句的老师卡片滚动到可见位置 */
  revealStepCard(turn) {
    if (!this.stepOn() || this.stepTurn !== turn) return;
    const card = this.querySelector(`[data-turn="${turn.id}"] .teacher-card`);
    card?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  // ======================================================================
  // 本地 VAD（实时流程：提前开始分析；逐句流程：判定一句说完）
  // ======================================================================
  resetVad() {
    this.vad = { ref: null, voiced: 0, silence: 0, streak: 0, noise: 0.004 };
    this._lastHeard = false;
  }

  vadSilenceMs() {
    return this.vad ? Math.round((this.vad.silence / 16000) * 1000) : 0;
  }

  vadStep(pcm) {
    const v = this.vad;
    if (!v) return;
    // 录音缓冲被重置（新的一句/暂停后）：重新开始判断
    if (v.ref !== this.userChunks) {
      if (this.earlyJob) this.cancelEarly("buffer-reset");
      this.resetVad();
      this.vad.ref = this.userChunks;
      return this.vadStep(pcm);
    }
    const e = rms(pcm);
    const thr = Math.max(0.012, v.noise * 3);
    if (e > thr) {
      v.voiced += pcm.length;
      v.silence = 0;
      v.streak++;
      if (this.earlyJob) {
        this.earlyJob.dirty = true;
        if (v.streak >= 2) this.cancelEarly("resumed");
      }
    } else {
      v.streak = 0;
      v.noise = v.noise * 0.95 + e * 0.05;
      if (v.voiced >= VAD_MIN_VOICE) v.silence += pcm.length;
      if (v.voiced >= VAD_MIN_VOICE && v.silence >= VAD_END_SILENCE) {
        if (this.stepOn()) {
          this.onStepSentenceEnd(false);
          return;
        }
        if (!this.single && !this.earlyJob && !v.triedAt) this.startEarly();
      }
    }
  }

  startEarly() {
    const chunks = this.userChunks;
    const pcm = trimSilence(concatInt16(chunks), 16000);
    this.vad.triedAt = chunks.length;
    if (!pcm || pcm.length < 16000 * 0.4) return; // 太短，等模型判定
    const job = this.startAnalysisJob({
      pcm,
      asrText: this.pendingUserText.trim(),
      prevCharacterText: this.lastCharacterText,
      spokeEnd: Date.now() - this.vadSilenceMs(),
    });
    job.early = true;
    this.earlyJob = job;
    console.log("[老师] 本地检测到一句话结束，提前开始分析");
  }

  cancelEarly(reason) {
    const job = this.earlyJob;
    if (!job) return;
    this.earlyJob = null;
    job.controller.abort();
    if (this.vad) {
      this.vad.triedAt = 0;
      this.vad.silence = 0;
    }
    console.log(`[老师] 取消提前分析（${reason}）`);
  }

  /** 句子定稿时取走提前开始的分析；如果之后又说过话就作废 */
  takeEarlyJob() {
    const job = this.earlyJob;
    this.earlyJob = null;
    if (!job) return null;
    if (job.dirty || job.error) {
      job.controller.abort();
      return null;
    }
    return job;
  }

  // ======================================================================
  // 独立老师（流式分析）
  // ======================================================================
  /** 开始一次（流式）老师分析；结果先存在 job 上，句子定稿后再挂到 turn 上 */
  startAnalysisJob({ pcm, asrText, prevCharacterText, spokeEnd }) {
    const cfg = this._cfg;
    const job = {
      controller: new AbortController(),
      t: { spokeEnd, analysisStart: Date.now() },
      partial: null,
      raw: "",
      done: false,
      result: null,
      error: null,
      turn: null,
      dirty: false,
      lang: teacherLang(undefined, cfg.accent).key,
    };
    analyzeTurnStream(
      {
        pcm,
        asrText,
        prevCharacterText,
        missionTitle: cfg.mission.title_en + (cfg.topic ? ` (topic: ${cfg.topic})` : ""),
        missionDesc: cfg.mission.desc_zh,
        role: cfg.mission.role_en,
        accent: cfg.accent,
        level: cfg.level,
        lang: job.lang,
      },
      {
        signal: job.controller.signal,
        onFirstToken: () => {
          if (!job.t.firstToken) job.t.firstToken = Date.now();
        },
        onPartial: (p, raw) => {
          job.partial = p;
          job.raw = raw;
          if (job.turn) this.onJobProgress(job);
        },
      }
    )
      .then((a) => {
        job.result = a;
        job.done = true;
        job.t.cardDone = Date.now();
        if (job.turn) this.onJobDone(job);
      })
      .catch((e) => {
        if (e?.name === "AbortError" || job.controller.signal.aborted) return;
        job.error = e;
        job.done = true;
        if (job.turn) this.onJobDone(job);
      });
    return job;
  }

  adoptJob(turn, job) {
    job.turn = turn;
    turn.job = job;
    turn.t = job.t;
    turn.analysisStarted = true;
    turn.status = "analyzing";
    this.renderTurn(turn);
    if (job.partial) this.onJobProgress(job);
    if (job.done) this.onJobDone(job);
  }

  /** 流式片段到达：更新卡片；老师要说的话一完整就开始准备语音 */
  onJobProgress(job) {
    const turn = job.turn;
    if (!turn || turn.status === "done" || turn.status === "error") return;
    if (!this.session.turns.includes(turn)) return; // 已经“重说”
    const p = job.partial || {};
    turn.partial = p;
    if (p.no_speech === true && turn.voice === "waiting") turn.voice = "skipped";
    if (!turn.spokenText && p.spoken_feedback_zh && fieldComplete(job.raw, "spoken_feedback_zh") && p.no_speech !== true) {
      turn.spokenText = p.spoken_feedback_zh;
      this.prepareTeacherVoice(turn);
    }
    this.scheduleRender(turn);
  }

  onJobDone(job) {
    const turn = job.turn;
    if (!turn || !this.session.turns.includes(turn)) return;
    const entry = this.session.transcript.find((e) => e.turnId === turn.id);
    if (job.error) {
      console.error("点评失败", job.error);
      turn.status = "error";
      turn.error = job.error.message || String(job.error);
      if (turn.voice !== "played") turn.voice = "skipped";
    } else {
      const a = job.result || {};
      turn.analysis = a;
      turn.partial = null;
      if (!turn.text && a.transcript) {
        turn.text = a.transcript;
        if (entry) entry.text = a.transcript;
      }
      turn.status = "done";
      if (a.no_speech && turn.voice !== "played") turn.voice = "skipped";
      if (!turn.spokenText && a.spoken_feedback_zh && !a.no_speech) {
        turn.spokenText = a.spoken_feedback_zh;
        this.prepareTeacherVoice(turn);
      }
    }
    this.logTiming(turn);
    this.renderTurn(turn);
    this.emit();
    this.updateStepUI();
    this.revealStepCard(turn);
    this.pumpTeacher();
  }

  /** 准备老师语音：设备语音直接就绪；Gemini 语音在后台合成 */
  prepareTeacherVoice(turn) {
    if (turn.voice !== "waiting" || this.state !== "active") return;
    if (getSetting("teacherVoiceSource") !== "gemini") {
      turn.voice = "ready-browser";
      this.pumpTeacher();
      return;
    }
    const text = turn.spokenText;
    teacherTTS(text, turn.job?.lang)
      .then((pcm) => {
        turn.teacherPcm = pcm;
        if (turn.voice === "waiting") turn.voice = "ready";
      })
      .catch((e) => {
        console.warn("TTS 失败，改用设备语音", e);
        if (turn.voice === "waiting") turn.voice = "ready-browser";
      })
      .finally(() => {
        this.updateStepUI();
        this.pumpTeacher();
      });
  }

  scheduleRender(turn) {
    if (turn._raf) return;
    turn._raf = requestAnimationFrame(() => {
      turn._raf = 0;
      if (this.session.turns.includes(turn)) this.renderTurn(turn);
    });
  }

  /** 朗读老师点评用的语言（按这句点评生成时的语言） */
  speechLangOf(turn) {
    return teacherLang(turn.analysis?._lang || turn.partial?._lang || turn.job?.lang, this._cfg.accent).speechLang;
  }

  timingText(turn) {
    const t = turn.t;
    if (!t || !t.spokeEnd || !t.cardDone) return "";
    const s = (ms) => `${(Math.max(0, ms) / 1000).toFixed(1)}s`;
    const T = teacherLang(turn.job?.lang || turn.analysis?._lang, this._cfg.accent).labels;
    let out = `${T.timing} ${s(t.cardDone - t.spokeEnd)}`;
    if (getSetting("detailedTiming")) {
      const parts = [`开始分析 +${s(t.analysisStart - t.spokeEnd)}`];
      if (t.firstToken) parts.push(`首字 +${s(t.firstToken - t.spokeEnd)}`);
      parts.push(`完成 +${s(t.cardDone - t.spokeEnd)}`);
      if (t.voiceStart) parts.push(`语音 +${s(t.voiceStart - t.spokeEnd)}`);
      out = `${parts.join(" · ")}${turn.job?.early ? "（提前触发）" : ""}${turn.single && !turn.job ? "（单模型）" : ""}`;
    }
    return out;
  }

  logTiming(turn) {
    const t = turn.t;
    if (!t || !t.spokeEnd) return;
    const r = (x) => (x ? `${x - t.spokeEnd}ms` : "-");
    console.log(
      `[老师计时] 说完→开始分析 ${r(t.analysisStart)} · 首字 ${r(t.firstToken)} · 卡片完成 ${r(t.cardDone)} · 语音开始 ${r(t.voiceStart)}${turn.job?.early ? "（本地VAD提前）" : ""}${turn.single && !turn.job ? "（单模型）" : ""}`
    );
  }

  emit() {
    this.session.events.dispatchEvent(new Event("update"));
  }

  // ======================================================================
  // 老师语音排队（独立老师）
  // ======================================================================
  pumpTeacher() {
    if (this.state !== "active") return this.setHold(false);
    if (this.clipPlaying) return; // 用户正在回放卡片上的音频：等它播完再播老师语音
    while (this.teacherQueue.length && ["skipped", "off", "played"].includes(this.teacherQueue[0].voice)) {
      this.teacherQueue.shift();
    }
    const head = this.teacherQueue[0];
    const characterBusy = this.modelSpeaking || (this.player && this.player.streaming);
    if (!head || this.teacherSpeaking) {
      this.setHold(this.teacherSpeaking);
      return;
    }
    if (characterBusy) {
      this.setHold(false);
      return;
    }
    // 角色已说完，老师还没准备好：暂停麦克风等待，最多 12 秒
    if (head.voice === "waiting") {
      if (!this.holdStartedAt) this.holdStartedAt = Date.now();
      if (Date.now() - this.holdStartedAt > TEACHER_WAIT_MS) {
        head.voice = "skipped";
        this.teacherQueue.shift();
        this.holdStartedAt = 0;
        this.setHold(false);
        this.updateStepUI();
        this.pumpTeacher();
        return;
      }
      this.setHold(true, "🧑‍🏫 老师正在听你刚才那句…");
      return;
    }
    this.holdStartedAt = 0;
    this.playTeacher(head);
  }

  async playTeacher(turn) {
    const token = ++this.teacherPlayToken;
    this.teacherSpeaking = true;
    this.setHold(true, "🧑‍🏫 老师点评中，听完再继续说…");
    this.updateStepUI();
    const card = this.querySelector(`[data-turn="${turn.id}"]`);
    card?.classList.add("speaking");
    card?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    const markStart = () => {
      if (turn.t && !turn.t.voiceStart) {
        turn.t.voiceStart = Date.now();
        this.logTiming(turn);
        if (getSetting("detailedTiming")) this.renderTurn(turn);
      }
    };
    try {
      const text = turn.spokenText || turn.analysis?.spoken_feedback_zh;
      if (turn.voice === "ready" && turn.teacherPcm && this.player) {
        markStart();
        await this.player.playClip(turn.teacherPcm, 24000);
      } else if (text) {
        await speakBrowser(text, this.speechLangOf(turn), 1.0, markStart);
      }
    } catch (e) {
      console.warn(e);
    }
    if (token !== this.teacherPlayToken) return; // 播放中被静音：状态已经由 muteTeacher 清理
    card?.classList.remove("speaking");
    if (turn.voice !== "skipped") turn.voice = "played";
    if (this.teacherQueue[0] === turn) this.teacherQueue.shift();
    this.teacherSpeaking = false;
    this.updateStepUI();
    // 实时流程：新的一句从这里开始录
    if (!this.stepOn()) this.userChunks = [];
    this.pumpTeacher();
  }

  /** “这次由你先开口”提示框：场景提示 + 参考开场句（点击收听） */
  showOpenerBox() {
    const cfg = this._cfg;
    const m = cfg.mission;
    const en = this.session.teacherLang === "en";
    let hint = en ? m.opener_hint_en : m.opener_hint_zh;
    if (m.custom && cfg.topic) hint = en ? `You start: say something about "${cfg.topic}".` : `由你先开口，聊聊“${cfg.topic}”。`;
    const lines = (m.opener_lines && (m.opener_lines[cfg.accent] || m.opener_lines.us)) || [];
    const box = document.createElement("div");
    box.className = "opener-box";
    box.dataset.turn = "opener";
    box.innerHTML = `
      <div class="ob-title">👉 ${en ? "You start this time" : "这次由你先开口"}</div>
      ${hint ? `<div class="ob-hint">${escapeHtml(hint)}</div>` : ""}
      ${
        lines.length
          ? `<div class="ob-sub">${en ? "You could say:" : "可以这样开头："}</div>` +
            lines
              .slice(0, 2)
              .map(
                (l, i) =>
                  `<div class="ob-line"><button class="play-mini" data-act="opener" data-word="${i}" data-line="${escapeHtml(l)}" aria-label="${en ? "Listen" : "收听"}">🔊</button><span>${escapeHtml(l)}</span></div>`
              )
              .join("")
          : ""
      }`;
    this.$("transcript")?.prepend(box);
  }

  // ======================================================================
  // 老师静音开关
  // ======================================================================
  syncVoiceChip() {
    const chip = this.$("voice-toggle");
    if (!chip) return;
    const on = !!getSetting("teacherVoiceOn");
    chip.outerHTML = voiceChipHtml(on);
    this.$("voice-toggle").onclick = () => this.onVoiceToggle();
  }

  onVoiceToggle() {
    const on = !getSetting("teacherVoiceOn");
    setSetting("teacherVoiceOn", on);
    this.syncVoiceChip();
    if (on) {
      this.setStatus(this.single ? "🔊 老师语音已开启" : "🔊 老师语音已开启（从下一句开始）", "var(--color-accent-primary)");
    } else {
      this.muteTeacher();
      this.setStatus("🔇 老师已静音：只显示文字点评，卡片上仍可手动播放", "var(--color-text-sub)");
    }
    if (this.single) this.queueCoachSignal(on);
  }

  /** 静音：立刻停掉正在播的老师语音，清空待播队列 */
  muteTeacher() {
    this.teacherPlayToken++;
    if (this.teacherSpeaking) {
      if (this.player) this.player.stopClip();
      stopBrowserSpeech();
    }
    for (const t of this.session.turns) {
      if (["waiting", "ready", "ready-browser"].includes(t.voice)) {
        t.voice = "skipped";
        t.voiceMuted = true;
      }
    }
    this.teacherQueue = [];
    this.teacherSpeaking = false;
    this.querySelectorAll(".turn.speaking, .teacher-card.speaking").forEach((el) => el.classList.remove("speaking"));
    this.holdStartedAt = 0;
    // 单模型：这一轮还在老师那段：掐掉已经在播的声音，后面的老师音频不再播放
    if (this.inCoachPart() && this.player && this.player.streaming) this.player.interrupt();
    this.setHold(false);
    if (!this.stepOn()) this.userChunks = [];
    this.updateStepUI();
    this.pumpTeacher();
  }

  /** 单模型：把静音/取消静音告诉模型（只追加上下文，不触发回应；模型正在说话时等这轮结束再发） */
  queueCoachSignal(on) {
    this.pendingCoachSignal = on ? COACH_UNMUTE_SIGNAL : COACH_MUTE_SIGNAL;
    if (!this.modelSpeaking) this.flushCoachSignal();
  }

  flushCoachSignal() {
    if (!this.pendingCoachSignal) return;
    if (!this.live || this.liveDown || this.state !== "active") return; // 重连时提示词里已经带上当前状态
    const sig = this.pendingCoachSignal;
    this.pendingCoachSignal = null;
    try {
      this.live.sendText(sig, false);
    } catch (e) {
      console.warn("发送老师静音提示失败", e);
    }
  }

  /** 当前这一轮是不是正处在老师那段 */
  inCoachPart(mt = this.mt) {
    return !!(this.single && mt && (mt.kind === "coach" || (mt.kind === "mixed" && mt.boundarySample < 0)));
  }

  /** 单模型 + 老师静音：老师那段的声音不播放（按工具调用/轮次分界，实时判断） */
  routeModelAudio(pcm) {
    const mt = this.mt;
    if (this.inCoachPart(mt) && !getSetting("teacherVoiceOn")) {
      mt.coachMuted = true;
      return;
    }
    this.player.play(pcm);
  }

  skipTeacher(all = false) {
    if (this.player) this.player.stopClip();
    stopBrowserSpeech();
    const list = all ? this.teacherQueue : this.teacherQueue.slice(0, 1);
    list.forEach((t) => {
      if (t.voice !== "played") t.voice = "skipped";
    });
    this.holdStartedAt = 0;
    this.updateStepUI();
    this.pumpTeacher();
  }

  setHold(on, text) {
    if (on && !this.micHeld && !this.stepOn()) this.userChunks = [];
    this.micHeld = on;
    const b = this.$("hold-banner");
    if (!b) return;
    b.classList.toggle("hidden", !on || this.stepOn());
    if (text) this.$("hold-text").textContent = text;
  }

  // ======================================================================
  // 工具调用
  // ======================================================================
  onToolCall(calls) {
    const responses = [];
    for (const c of calls) {
      if (c.name === "complete_mission") {
        this.session.missionComplete = true;
        this.$("mission-banner")?.classList.remove("hidden");
      } else if (c.name === "give_feedback") {
        this.onGiveFeedback(c.args || {});
      } else if (c.name === "resume_roleplay") {
        this.onResumeRoleplay();
      }
      const hintOpts = { stepMode: this.stepOn(), coachMuted: !getSetting("teacherVoiceOn") };
      const response =
        c.name === "give_feedback" || c.name === "resume_roleplay"
          ? { ok: true, next: toolNextHint(c.name, hintOpts) }
          : { result: "ok" };
      if (this.liveToolNonBlocking) response.scheduling = "SILENT";
      responses.push({ id: c.id, name: c.name, response });
    }
    this.live.sendToolResponse(responses);
  }

  /** 单模型：模型调用 give_feedback → 填充当前这句的卡片 */
  onGiveFeedback(args) {
    if (!this.single || this.ignoreModelTurn) return;
    // 工具调用往往先于音频到达：先把用户这句定稿（实时流程）
    this.onModelOutput();
    let turn = this.singleTurn;
    if (!turn || turn.analysis) {
      // 没有对应的录音（比如被当成噪音丢掉了）：用模型听到的文字建一条
      if (!args.transcript) return;
      turn = this.createTurn({ text: args.transcript, pcm: null, spokeEnd: Date.now() });
      this.singleTurn = turn;
    }
    const lang = teacherLang(undefined, this._cfg.accent).key;
    const a = argsToAnalysis(args, lang);
    turn.analysis = a;
    turn.status = "done";
    turn.t = turn.t || { spokeEnd: turn.finalizedAt, analysisStart: turn.finalizedAt };
    turn.t.cardDone = Date.now();
    if (!turn.text && a.transcript) {
      turn.text = a.transcript;
      const entry = this.session.transcript.find((e) => e.turnId === turn.id);
      if (entry) entry.text = a.transcript;
    }
    const mt = this.mt;
    if (mt) {
      mt.feedbackTurn = turn;
      if (!mt.pendingTurn) mt.pendingTurn = turn;
      // 实时：这一轮还没有任何输出就来了点评 → 之后到 resume_roleplay 为止都算老师
      if (mt.kind === "character" && !this.stepOn() && !mt.full && !mt.samples) mt.kind = "mixed";
      if (!mt.attachTurn || mt.attachTurn !== turn) {
        mt.attachTurn = turn;
        mt.baseTeacher = turn.liveTeacher || "";
      }
    }
    if (turn.liveTeacher) a.spoken_feedback_zh = turn.liveTeacher;
    this.logTiming(turn);
    this.renderTurn(turn);
    this.emit();
    this.updateStepUI();
    this.revealStepCard(turn);
  }

  /** 实时单模型：模型调用 resume_roleplay = 老师说完、角色开始。记下文字和音频的分界 */
  onResumeRoleplay() {
    if (!this.single || this.ignoreModelTurn) return;
    this.onModelOutput();
    const mt = this.mt;
    if (!mt || mt.kind !== "mixed" || mt.boundarySample >= 0) return;
    mt.boundaryChar = mt.full.length;
    mt.boundarySample = mt.samples;
    this.renderModelText(mt, false);
  }

  markMissing(turn, why) {
    turn.status = "missing";
    turn.error = `本句未点评${why ? `（${why}）` : ""}`;
    this.renderTurn(turn);
    this.emit();
  }

  // ======================================================================
  // 模型输出：记录音频和文字（单模型模式下拆成老师/角色）
  // ======================================================================
  recordModelAudio(pcm) {
    const mt = this.mt;
    if (!mt) return;
    if (!mt.firstAudioAt) mt.firstAudioAt = Date.now();
    mt.audio.push(pcm);
    mt.samples += pcm.length;
  }

  scrollDown() {
    const tr = this.$("transcript");
    if (tr) tr.scrollTop = tr.scrollHeight;
  }

  openModelEntry() {
    const entry = { role: "model", text: "" };
    this.session.transcript.push(entry);
    this.currentModelEntry = entry;
    this.mt = this.newModelTurnState();
    const el = document.createElement("div");
    el.className = "bubble model temp";
    el.innerHTML = `<span class="who">${escapeHtml(this._cfg.mission.role_zh)}</span><span class="txt"></span>`;
    this.$("transcript").appendChild(el);
    this.currentModelEl = el;
    this.scrollDown();
  }

  /**
   * 单模型：这一轮输出归谁？
   *  - 逐句：发出句子之后、[continue] 之前（review 阶段）的输出全部算老师；之后的全部算角色
   *  - 实时：有待点评的句子时，resume_roleplay 之前算老师、之后算角色（mixed）
   */
  newModelTurnState() {
    const base = { chunks: [], audio: [], samples: 0, full: "", firstAudioAt: 0, boundaryChar: -1, boundarySample: -1 };
    if (!this.single) return { ...base, kind: "character", pendingTurn: null };
    let kind = "character";
    let turn = null;
    if (this.stepOn()) {
      if (this.stepPhase === "review" && this.stepTurn) {
        kind = "coach";
        turn = this.stepTurn;
      }
    } else if (this.singleTurn && !this.singleTurn.singleDone) {
      kind = "mixed";
      turn = this.singleTurn;
    }
    // 角色文字里清理出来的中文点评挂到哪一句上
    const attach = turn || (this.stepOn() ? this.replyTurn : this.lastFinalizedTurn) || null;
    return { ...base, kind, pendingTurn: turn, feedbackTurn: turn, attachTurn: attach, baseTeacher: attach?.liveTeacher || "" };
  }

  appendModelText(t) {
    if (!this.currentModelEntry) this.openModelEntry();
    const mt = this.mt;
    mt.full = joinText(mt.full, t);
    // 转写一般比音频晚：resume_roleplay 之后、角色的音频还没来之前到的文字，仍然是老师那段的
    if (mt.kind === "mixed" && mt.boundarySample >= 0 && mt.samples === mt.boundarySample) mt.boundaryChar = mt.full.length;
    this.renderModelText(mt, false);
    this.scrollDown();
  }

  /** 按分界把这一轮文字分成老师/角色，分别显示到卡片和气泡 */
  renderModelText(mt, final) {
    let coach = "";
    let character = "";
    if (mt.kind === "coach") coach = mt.full;
    else if (mt.kind === "character") character = mt.full;
    else if (mt.boundaryChar < 0) coach = mt.full;
    else {
      coach = mt.full.slice(0, mt.boundaryChar);
      character = mt.full.slice(mt.boundaryChar);
    }
    coach = coach.replace(/^\s*(?:老\s*师|教\s*练|coach|teacher)\s*[：:，,。.]?\s*/i, "");
    let moved = "";
    if (this.single && character) {
      const c = cleanCharacterText(character, this.session.teacherLang);
      character = c.character;
      if (mt.attachTurn) moved = c.moved;
      else if (c.moved) character = [c.moved, character].filter(Boolean).join(" ");
    }
    if (this.currentModelEntry) this.currentModelEntry.text = character.trim();
    if (this.currentModelEl) this.currentModelEl.querySelector(".txt").textContent = character.trim();
    const turn = mt.attachTurn;
    const extra = [coach.trim(), moved].filter(Boolean).join(" ");
    if (turn && (extra || mt.kind !== "character")) {
      turn.liveTeacher = [mt.baseTeacher, extra].filter(Boolean).join(" ").trim();
      if (turn.analysis && turn.liveTeacher) turn.analysis.spoken_feedback_zh = turn.liveTeacher;
      if (coach && !turn.t?.voiceStart && mt.firstAudioAt && turn.t) turn.t.voiceStart = mt.firstAudioAt;
      this.scheduleRender(turn);
    }
  }

  /** 这一轮里属于老师的音频（不含角色） */
  coachAudioOf(mt) {
    if (mt.kind === "character") return null;
    const pcm = concatInt16(mt.audio);
    return mt.kind === "mixed" && mt.boundarySample >= 0 ? pcm.slice(0, mt.boundarySample) : pcm;
  }

  /** 一轮模型输出结束：存下老师那段音频、检查是否漏了点评 */
  finishModelTurn(interrupted, ignored = false) {
    const mt = this.mt;
    this.mt = null;
    if (!mt || ignored) return;
    if (this.currentModelEntry) this.renderModelText(mt, true);
    const turn = mt.pendingTurn;
    if (!turn) return;
    const coachPcm = this.coachAudioOf(mt);
    if (coachPcm && coachPcm.length > 24000 * 0.1) {
      // 同一句的第二轮老师输出（比如逐句模式里模型又补了一句）：接在后面
      turn.teacherPcm = turn.teacherPcm && turn.singleDone ? concatInt16([turn.teacherPcm, coachPcm]) : coachPcm;
      turn.teacherWhole = false;
    }
    if (mt.kind === "mixed" && mt.boundarySample < 0 && !interrupted) turn.noRoleplay = true;
    if (turn.analysis && turn.liveTeacher) turn.analysis.spoken_feedback_zh = turn.liveTeacher;
    if (!turn.analysis && turn.status !== "missing") {
      this.markMissing(turn, interrupted ? "被打断" : turn.liveTeacher ? "模型只给了口头提示" : "模型没有调用点评工具");
    }
    this.afterDrain(() => {
      turn.singleDone = true;
      if (this.singleTurn === turn) this.singleTurn = null;
      this.renderTurn(turn);
      this.updateStepUI();
    });
    this.renderTurn(turn);
    this.emit();
  }

  closeModelEntry() {
    if (!this.currentModelEntry) return;
    const e = this.currentModelEntry;
    e.text = (e.text || "").trim();
    if (e.text) this.lastCharacterText = e.text;
    // 给对应的用户句子补上角色回复（用于总结）
    const target = this.stepOn() ? this.replyTurn || (e.text ? this.lastFinalizedTurn : null) : this.lastFinalizedTurn;
    if (target && !target.characterReply && e.text) target.characterReply = e.text;
    this.currentModelEl?.classList.remove("temp");
    if (!e.text) {
      this.currentModelEl?.remove();
      this.session.transcript = this.session.transcript.filter((x) => x !== e);
    }
    this.currentModelEntry = null;
    this.currentModelEl = null;
  }

  renderLiveUser() {
    let el = this.$("live-user");
    if (!el) {
      el = document.createElement("div");
      el.id = "live-user";
      el.className = "bubble user temp";
      this.$("transcript").appendChild(el);
    }
    el.textContent = this.pendingUserText;
    this.scrollDown();
  }

  removeLiveUser() {
    this.$("live-user")?.remove();
  }

  renderTurn(turn) {
    if (!this.session.turns.includes(turn)) return;
    let wrap = this.querySelector(`[data-turn="${turn.id}"]`);
    if (!wrap) {
      wrap = document.createElement("div");
      wrap.className = "turn";
      wrap.dataset.turn = turn.id;
      const tr = this.$("transcript");
      // 单模型实时流程：卡片要在本轮角色气泡之前
      if (this.currentModelEl && this.currentModelEl.parentNode === tr) tr.insertBefore(wrap, this.currentModelEl);
      else tr.appendChild(wrap);
      this.scrollDown();
    }
    const TL = teacherLang(turn.analysis?._lang || this.session.teacherLang, this._cfg.accent);
    let fb;
    if (turn.status === "error") fb = `<div class="fb-muted">点评失败：${escapeHtml(turn.error)}</div>`;
    else if (turn.status === "missing")
      fb = `<div class="fb-muted">${escapeHtml(turn.error || "本句未点评")}</div>${
        turn.liveTeacher ? `<div class="fb-row teacher-say"><span class="fb-label">${TL.labels.teacherSay}</span><span>${escapeHtml(turn.liveTeacher)}</span></div>` : ""
      }${turn.pcm ? `<button class="small-btn" data-act="supplement">补充点评</button>` : ""}`;
    else if (turn.analysis) fb = feedbackHtml(turn.analysis, { compact: false, timing: this.timingText(turn) });
    else if (turn.partial && Object.keys(turn.partial).length) fb = feedbackHtml(turn.partial, { partial: true });
    else if (turn.liveTeacher)
      fb = `<div class="fb-row teacher-say"><span class="fb-label">${TL.labels.teacherSay}</span><span>${escapeHtml(turn.liveTeacher)}</span></div><div class="fb-loading"><span class="dots"></span> ${TL.labels.generating}</div>`;
    else fb = `<div class="fb-loading"><span class="dots"></span> 老师正在听…</div>`;
    const canTeacher = (turn.analysis && !turn.analysis.no_speech && turn.status !== "error") || (turn.status === "missing" && turn.teacherPcm);
    const teacherLabel = turn.teacherPcm && turn.teacherWhole ? "▶ 老师语音（整段）" : "▶ 老师语音";
    const userText = turn.text || (turn.step && !turn.analysis ? "（正在识别…）" : "（未识别到文字）");
    wrap.innerHTML = `
      <div class="bubble user">${escapeHtml(userText)}</div>
      <div class="teacher-card ${wrap.classList.contains("speaking") ? "speaking" : ""}">
        <div class="tc-title">🧑‍🏫 ${TL.key === "en" ? "Coach" : "老师点评"}${turn.single ? `<span class="tc-badge">单模型</span>` : ""}</div>
        ${fb}
        ${turn.noRoleplay ? `<div class="fb-muted">（角色未回应）</div>` : ""}
        <div class="tc-actions">
          <button class="play-btn" data-act="mine" ${turn.pcm ? "" : "disabled"}>▶ 我的录音</button>
          ${canTeacher ? `<button class="play-btn teacher" data-act="teacher">${teacherLabel}</button>` : ""}
        </div>
      </div>
    `;
    this.reapplyPlaying(wrap, turn);
    if (turn.analysis && !this.stepOn()) this.scrollDown();
  }

  // ======================================================================
  // 卡片上的播放（互斥）
  // ======================================================================
  btnKey(turn, btn) {
    return `${turn.id}|${btn.dataset.act}|${btn.dataset.word || ""}`;
  }

  findBtn(key) {
    const [tid, act, word] = key.split("|");
    const wrap = this.querySelector(`[data-turn="${tid}"]`);
    if (!wrap) return null;
    return Array.from(wrap.querySelectorAll(`[data-act="${act}"]`)).find((b) => (b.dataset.word || "") === word) || null;
  }

  setBtnState(btn, state) {
    if (!btn) return;
    if (!btn.dataset.label) btn.dataset.label = btn.innerHTML;
    btn.classList.toggle("playing", state === "playing");
    btn.disabled = state === "loading";
    if (btn.classList.contains("play-btn")) {
      btn.innerHTML = state === "loading" ? "⏳ 生成中" : state === "playing" ? btn.dataset.label.replace("▶", "■") : btn.dataset.label;
    } else if (btn.classList.contains("play-mini")) {
      btn.textContent = state === "loading" ? "⏳" : state === "playing" ? "■" : "🔊";
    }
  }

  reapplyPlaying(wrap, turn) {
    if (!this.playingKey || !this.playingKey.startsWith(turn.id + "|")) return;
    this.setBtnState(this.findBtn(this.playingKey), this.playingState || "playing");
  }

  stopPlayback() {
    const key = this.playingKey;
    this.playingKey = null;
    this.playingState = null;
    this.clipPlaying = false;
    if (this.player) this.player.stopClip();
    stopBrowserSpeech();
    if (key) this.setBtnState(this.findBtn(key), "idle");
  }

  /**
   * 播放一个片段：getPcm() 返回 { pcm, rate }；失败时调用 fallback()（浏览器语音）
   * 同一时间只播一个；再点一次同一个按钮就停止。
   */
  async playOnCard(turn, btn, getPcm, fallback) {
    const key = this.btnKey(turn, btn);
    if (this.playingKey === key) {
      this.stopPlayback();
      return;
    }
    this.stopPlayback();
    this.playingKey = key;
    this.playingState = "loading";
    this.clipPlaying = true; // 加载和播放期间都暂停上传/录音
    this.setBtnState(this.findBtn(key), "loading");
    let res = null;
    try {
      res = await getPcm();
    } catch (e) {
      console.warn("生成音频失败，改用设备语音", e);
    }
    if (this.playingKey !== key) return; // 期间被别的按钮打断
    this.playingState = "playing";
    this.setBtnState(this.findBtn(key), "playing");
    try {
      if (res && res.pcm && this.player) await this.player.playClip(res.pcm, res.rate);
      else if (fallback) await fallback();
    } catch (e) {
      console.warn(e);
    }
    if (this.playingKey === key) this.stopPlayback();
    // 逐句“听”的阶段：回放的声音不能算进这句录音
    if (this.stepOn() && this.stepPhase === "listen") this.setPhase("listen");
  }

  /** 单模型漏掉点评：用独立老师补一次 */
  supplement(turn) {
    if (!turn.pcm) return;
    turn.status = "analyzing";
    turn.error = null;
    turn.supplemented = true;
    turn.teacherPcm = null;
    turn.teacherWhole = false;
    turn.voice = "off";
    const job = this.startAnalysisJob({
      pcm: turn.pcm,
      asrText: turn.text,
      prevCharacterText: turn.prevCharacterText,
      spokeEnd: Date.now(),
    });
    this.adoptJob(turn, job);
  }

  async onTranscriptClick(e) {
    const btn = e.target.closest("[data-act]");
    if (!btn || btn.disabled) return;
    if (btn.dataset.act === "opener") {
      const line = btn.dataset.line || "";
      const lang = (ACCENTS[this._cfg.accent] || ACCENTS.us).bcp47;
      this.playOnCard({ id: "opener" }, btn, async () => ({ pcm: await nativeTTS(line, this._cfg.accent), rate: 24000 }), () => speakBrowser(line, lang));
      return;
    }
    const wrap = btn.closest("[data-turn]");
    const turn = this.session.turns.find((t) => t.id === wrap?.dataset.turn);
    if (!turn) return;
    const a = turn.analysis;
    const lang = (ACCENTS[this._cfg.accent] || ACCENTS.us).bcp47;
    const act = btn.dataset.act;
    if (act === "supplement") {
      this.supplement(turn);
    } else if (act === "mine" && turn.pcm) {
      this.playOnCard(turn, btn, async () => ({ pcm: turn.pcm, rate: 16000 }));
    } else if (act === "native" && a) {
      this.playOnCard(turn, btn, async () => ({ pcm: await nativeTTS(a.better_expression, this._cfg.accent), rate: 24000 }), () =>
        speakBrowser(a.better_expression, lang)
      );
    } else if (act === "word" && btn.dataset.word) {
      const w = btn.dataset.word;
      this.playOnCard(turn, btn, async () => ({ pcm: await wordTTS(w, this._cfg.accent), rate: 24000 }), () =>
        speakBrowser(`${w}. ${w}.`, lang, 0.8)
      );
    } else if (act === "teacher" && (a || turn.teacherPcm)) {
      // 老师语音：手动回放时，自动播放队列里就不再播这一句
      if (turn.voice !== "played" && turn.voice !== "off" && turn.voice !== "live") turn.voice = "skipped";
      const browser = getSetting("teacherVoiceSource") === "browser";
      const text = turn.spokenText || a?.spoken_feedback_zh;
      this.playOnCard(
        turn,
        btn,
        async () => {
          if (turn.teacherPcm) return { pcm: turn.teacherPcm, rate: 24000 };
          if (browser || !text) return null;
          turn.teacherPcm = await teacherTTS(text, a?._lang);
          return { pcm: turn.teacherPcm, rate: 24000 };
        },
        text ? () => speakBrowser(text, this.speechLangOf(turn)) : undefined
      );
    }
  }
}

function voiceChipHtml(on) {
  return on
    ? `<button class="chip voice-chip on" id="voice-toggle" aria-pressed="false" title="老师语音：开（点一下静音）">🔊 老师</button>`
    : `<button class="chip voice-chip muted" id="voice-toggle" aria-pressed="true" title="老师已静音（点一下恢复语音）">🔇 <span class="vc-word">老师</span>已静音</button>`;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const CJK_EDGE = /[　-鿿＀-￯]/;
function joinText(a, b) {
  if (!a) return b.replace(/^\s+/, "");
  if (!b) return a;
  if (/\s$/.test(a) || /^[\s.,!?;:'’)]/.test(b)) return a + b;
  // 中文与中文/中文标点之间不加空格
  if (CJK_EDGE.test(a[a.length - 1]) || CJK_EDGE.test(b[0])) return a + b;
  return a + " " + b;
}

customElements.define("view-chat", ViewChat);
