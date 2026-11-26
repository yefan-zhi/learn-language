/**
 * 对话页：角色扮演（Gemini Live）+ 第三方中文老师点评
 */
import "./audio-visualizer.js";
import { LiveSession } from "../lib/gemini-live/geminilive.js";
import { isModelGoneError, replaceModel } from "../lib/models.js";
import { listModels } from "../lib/gemini-rest.js";
import { AudioStreamer, AudioPlayer } from "../lib/gemini-live/mediaUtils.js";
import { concatInt16, trimSilence, formatDuration } from "../lib/audio-utils.js";
import { getSetting, setSetting, ACCENTS, LEVELS, authMode } from "../lib/settings.js";
import { startRelaySession, reportUsage } from "../lib/relay.js";
import { analyzeTurn, teacherTTS, nativeTTS, wordTTS, speakBrowser, stopBrowserSpeech, unlockBrowserSpeech } from "../lib/teacher.js";
import { escapeHtml, feedbackHtml } from "../lib/dom.js";

const SESSION_LIMIT_SEC = 15 * 60; // Live API 纯音频会话上限约 15 分钟
const RING_SAMPLES = 16000 * 3;
const TEACHER_WAIT_MS = 12000;
const ANALYSIS_DELAY_MS = 800;

function buildSystemInstruction(cfg) {
  const m = cfg.mission;
  const a = ACCENTS[cfg.accent] || ACCENTS.us;
  const lvl = (LEVELS[cfg.level] || LEVELS.intermediate).en;
  const scenario = m.scenario_en.replace(/\{city\}/g, a.city);
  const isUK = cfg.accent === "uk";
  const goal = m.custom
    ? `Topic: ${cfg.topic ? `"${cfg.topic}"` : "anything the learner wants to talk about; if they don't pick one, suggest an everyday topic"}.`
    : `The learner's goal: ${m.goal_en}`;
  const lang =
    cfg.mode === "assisted"
      ? `- Speak English. If the learner is clearly stuck, speaks Chinese, or asks how to say something, you may give ONE very short hint (say the English phrase they need; at most a few words of Chinese), then carry on in English, in character.`
      : `- Speak English only. Never speak Chinese, even if the learner does. If the learner uses Chinese, react in character as someone who doesn't understand it and encourage them to try in English (you may offer a simple English phrase they could use).`;
  return `You are role-playing as ${m.role_en} in a spoken English conversation practice.
Setting: ${scenario}
The learner is a native Mandarin Chinese speaker practising ${a.en}. Learner level: ${lvl}.
${goal}

ACCENT & LANGUAGE:
- Speak with a natural ${isUK ? "standard southern British (London) accent" : "General American accent"} and use ${isUK ? "British" : "American"} vocabulary and idioms (e.g. ${isUK ? "flat, queue, the Tube, bill, mobile, quid, cheers" : "apartment, line, the subway, check, cell phone, bucks, sounds good"}).
${lang}

STYLE:
- Stay fully in character as a real person. Never mention being an AI or a language tutor.
- Keep each reply short: 1-2 sentences (about 30 words at most), then give the learner room to speak. Ask questions to keep them talking.
- Do NOT correct the learner's grammar or pronunciation and do not give language lessons: a separate teacher gives feedback. Just react naturally as a real person would; if you genuinely can't understand them, ask them to repeat or clarify, as a real person would.
- Make the conversation realistic, with small natural complications that fit your role.

START: When you receive the message "[START]", open the conversation in character with one short line.
${m.custom ? "" : `MISSION: When the learner has achieved the goal, wrap up naturally in character, then call the complete_mission tool. If the learner keeps talking afterwards, keep chatting.`}`;
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
      transcript: [],
      turns: [],
      summary: null,
      events: new EventTarget(),
    };

    this.innerHTML = `
      <div class="chat">
        <div class="chat-top">
          <button class="icon-btn" id="back" aria-label="返回">←</button>
          <div class="chat-title">
            <div class="t1">${cfg.mission.icon} ${escapeHtml(cfg.mission.title_zh)}${cfg.topic ? `：${escapeHtml(cfg.topic)}` : ""}</div>
            <div class="t2">${a.short} · ${(LEVELS[cfg.level] || LEVELS.intermediate).label} · ${cfg.mode === "assisted" ? "辅助" : "沉浸"} · 对方：${escapeHtml(cfg.mission.role_zh)}</div>
          </div>
          <button class="chip step-chip ${getSetting("stepMode") ? "on" : ""}" id="step-toggle" title="逐句模式：每句话后看完老师反馈，再点“下一句”继续">逐句</button>
          <div class="timer" id="timer">0:00</div>
        </div>

        <div class="viz-row">
          <audio-visualizer id="model-viz"></audio-visualizer>
        </div>

        <div class="mission-banner hidden" id="mission-banner">🎉 任务完成！可以继续聊，或者点“结束”看总结。</div>

        <div class="transcript" id="transcript">
          <div class="empty-hint" id="empty-hint">
            <p>🎧 建议戴耳机，效果更好。</p>
            <p>点下方按钮开始，对方会先开口。你每说完一句，<b>中文老师</b>会给出点评${getSetting("teacherVoiceOn") ? "并用语音说出来" : ""}。</p>
            ${cfg.mission.custom ? "" : `<p class="goal">🎯 目标：${escapeHtml(cfg.mission.desc_zh)}</p>`}
          </div>
        </div>

        <div class="hold-banner hidden" id="hold-banner">
          <span id="hold-text">🧑‍🏫 老师点评中，请稍候再说…</span>
          <button class="small-btn" id="skip-teacher">跳过</button>
        </div>

        <div class="step-panel hidden" id="step-panel">
          <span id="step-text">🧑‍🏫 老师点评中…</span>
          <button class="link-btn" id="step-skip">跳过等待</button>
        </div>

        <div class="chat-bottom">
          <div class="viz-row small"><audio-visualizer id="user-viz"></audio-visualizer></div>
          <div class="controls">
            <button class="chip ${getSetting("teacherVoiceOn") ? "on" : ""}" id="voice-toggle" title="老师语音点评">🔊 老师语音</button>
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
    this.$("voice-toggle").onclick = () => {
      const on = !getSetting("teacherVoiceOn");
      setSetting("teacherVoiceOn", on);
      this.$("voice-toggle").classList.toggle("on", on);
      if (!on) this.skipTeacher(true);
    };
    this.$("transcript").addEventListener("click", (e) => this.onTranscriptClick(e));
    this.$("next-btn").onclick = () => this.onNext();
    this.$("step-skip").onclick = () => this.onNext(true);
    this.$("step-toggle").onclick = () => {
      const on = !getSetting("stepMode");
      setSetting("stepMode", on);
      this.$("step-toggle").classList.toggle("on", on);
      this.setStatus(on ? "已开启逐句模式：每句话后看完点评再点“下一句”" : "已关闭逐句模式：可以连续对话", "var(--color-text-sub)");
      // 关闭时如果正停在某一句，立即继续
      if (!on && this.stepPaused) this.onNext(true);
    };
  }

  // ---------------- 逐句模式 ----------------
  stepOn() {
    return !!getSetting("stepMode");
  }

  /** 一句话结束：暂停上传麦克风，等老师点评 */
  enterStepPause(turn) {
    this.stepPaused = true;
    this.stepTurn = turn;
    this.userChunks = [];
    this.updateStepUI();
  }

  /** 点评是否已经出来（完成/失败） */
  stepReady() {
    const t = this.stepTurn;
    if (this.liveDown && !t) return true;
    return !t || t.status === "done" || t.status === "error";
  }

  updateStepUI() {
    const panel = this.$("step-panel");
    const next = this.$("next-btn");
    const main = this.$("main-btn");
    if (!panel || !next || !main) return;
    const show = this.stepPaused && (this.state === "active" || this.reconnecting);
    panel.classList.toggle("hidden", !show);
    next.classList.toggle("hidden", !show);
    main.classList.toggle("compact", show);
    if (!show) return;
    // 逐句暂停时不显示“请稍候”横幅，由逐句面板提示
    this.$("hold-banner")?.classList.add("hidden");
    const ready = this.stepReady();
    if (this.reconnecting) {
      next.disabled = true;
      next.textContent = "重新连接中…";
      this.$("step-text").textContent = "🔌 正在重新连接，马上就好…";
      this.$("step-skip").classList.add("hidden");
      return;
    }
    next.disabled = !ready;
    next.textContent = ready ? "下一句 ▶" : "老师点评中…";
    this.$("step-skip").classList.toggle("hidden", ready);
    let text;
    if (!ready) text = "🧑‍🏫 老师正在听你刚才那句…";
    else if (this.teacherSpeaking) text = "🧑‍🏫 老师正在点评，听完点“下一句”（点击会停止语音）";
    else text = "✅ 看完点评后，点“下一句”继续说";
    if (this.liveDown) text += "（连接已断开，点“下一句”会自动重连）";
    this.$("step-text").textContent = text;
    main.textContent = "结束";
  }

  async onNext(skipWait = false) {
    if (!this.stepPaused || this.reconnecting) return;
    if (!skipWait && !this.stepReady()) return;
    // 停掉老师语音，不再播放这一句
    if (this.player) this.player.stopClip();
    stopBrowserSpeech();
    const t = this.stepTurn;
    if (t && t.voice !== "played" && t.voice !== "off") t.voice = "skipped";
    this.teacherQueue = this.teacherQueue.filter((x) => !["skipped", "off", "played"].includes(x.voice));
    this.teacherSpeaking = false;
    this.holdStartedAt = 0;
    this.setHold(false);

    if (this.liveDown) {
      const ok = await this.reconnectLive();
      if (!ok) return;
    }
    this.stepPaused = false;
    this.stepTurn = null;
    this.userChunks = [];
    this.updateStepUI();
    const main = this.$("main-btn");
    if (main) main.textContent = "结束并查看总结";
    this.setStatus("🎙️ 请说下一句", "var(--color-success)");
  }

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
      this.goAwayPending = false;
      this.reconnecting = false;
      if (this._onPageHide) window.addEventListener("pagehide", this._onPageHide);
      return true;
    } catch (e) {
      console.error("重连失败", e);
      this.reconnecting = false;
      this.updateStepUI();
      const next = this.$("next-btn");
      if (next) {
        next.disabled = false;
        next.textContent = "重试连接 ▶";
      }
      this.$("step-text").textContent = `⚠️ 重连失败：${e.message || e}。可以点“重试连接”，或者点“结束”查看总结。`;
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

  /** 逐句模式下连接即将到期或已断开：标记为需要重连，等用户点“下一句” */
  markLiveDown(message) {
    this.liveDown = true;
    if (this.live) {
      this.live.onClose = () => {};
      this.live.close();
    }
    this.finishRelay();
    if (!this.stepPaused) {
      // 正在说话时断开：先停下来，让用户点一下继续
      this.enterStepPause(null);
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

  // ---------------- 会话生命周期 ----------------
  async startSession() {
    const cfg = this._cfg;
    this.state = "connecting";
    const btn = this.$("main-btn");
    btn.disabled = true;
    btn.textContent = "连接中…";
    this.setStatus("正在打开麦克风并连接…");

    // 运行时状态
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
    this.holdStartedAt = 0;
    this.micHeld = false;
    this.stepPaused = false;
    this.stepTurn = null;
    this.liveDown = false;
    this.reconnecting = false;
    this.goAwayPending = false;

    try {
      // iOS：必须在用户手势里尽早创建/解锁音频
      unlockBrowserSpeech();
      this.player = new AudioPlayer();
      const playerInit = this.player.init();
      this.streamer = new AudioStreamer();
      await playerInit;
      await this.streamer.start();
      this.streamer.onChunk = (pcm) => this.onMicChunk(pcm);
      this.player.onDrained = () => this.pumpTeacher();

      this.$("user-viz").connect(this.streamer.audioContext, this.streamer.source);
      this.$("model-viz").connect(this.player.audioContext, this.player.gainNode);

      // 邀请码模式：先向中转服务申请一次性令牌（同时预留今日额度）
      this.sessionLimitSec = SESSION_LIMIT_SEC;
      let relay = null;
      if (authMode() === "invite") {
        this.setStatus("正在申请练习额度…");
        relay = await startRelaySession();
        this.relaySession = relay;
        this.relayReported = false;
        this.sessionLimitSec = Math.min(SESSION_LIMIT_SEC, relay.grantedMinutes * 60);
      }

      // 连接；如果 Live 模型已停用，自动换成推荐模型再试一次
      const res = await this.connectLive(relay);
      relay = res.relay;
      const live = res.live;
      this.state = "active";
      this.session.startedAt = Date.now();
      this.connectedAt = this.session.startedAt;
      live.sendText("[START]");

      btn.disabled = false;
      btn.textContent = "结束并查看总结";
      btn.classList.add("active");
      this.setStatus(
        relay ? `已连接，对方马上开口…（本次最多 ${relay.grantedMinutes} 分钟）` : "已连接，对方马上开口…",
        "var(--color-success)"
      );
      this._onPageHide = () => this.finishRelay();
      window.addEventListener("pagehide", this._onPageHide);
      const hint = this.$("empty-hint");
      if (hint) hint.remove();

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
      if (err.name === "NotAllowedError") msg = "没有麦克风权限，请在浏览器设置里允许本网站使用麦克风。";
      else if (err.name === "NotFoundError") msg = "没有找到麦克风设备。";
      this.setStatus(`❌ ${msg}`, "var(--color-danger)");
    }
  }

  /** 创建 LiveSession 并挂好回调（不连接） */
  buildLive(relay, resumeContext) {
    const cfg = this._cfg;
    let systemInstruction = buildSystemInstruction(cfg);
    if (resumeContext) {
      systemInstruction += `

RESUMING: The connection dropped and has just been restored in the middle of this conversation. Here is the conversation so far (most recent last):
${resumeContext}

Continue seamlessly from exactly this point. Do NOT greet again, do NOT restart or summarize the conversation, and ignore any "[START]" instruction. Stay silent until the learner speaks, then reply naturally in character.`;
    }
    const live = new LiveSession({
      apiKey: relay ? undefined : getSetting("apiKey"),
      url: relay ? relay.wsUrl : undefined,
      model: getSetting("liveModel"),
      voiceName: getSetting("characterVoice"),
      systemInstruction,
      functionDeclarations: cfg.mission.custom
        ? []
        : [
            {
              name: "complete_mission",
              description: "Call this when the learner has successfully achieved the mission goal.",
              parameters: {
                type: "OBJECT",
                properties: { note: { type: "STRING", description: "One short sentence about how the learner did." } },
              },
            },
          ],
    });
    this.live = live;
    live.onAudio = (pcm) => {
      this.onModelOutput();
      this.player.play(pcm);
    };
    live.onOutputTranscript = (t) => {
      this.onModelOutput();
      this.appendModelText(t);
    };
    live.onInputTranscript = (t) => this.onInputText(t);
    live.onTurnComplete = () => this.onModelTurnEnd(false);
    live.onInterrupted = () => this.onModelTurnEnd(true);
    live.onToolCall = (calls) => this.onToolCall(calls);
    live.onGoAway = () => {
      if (this.live !== live) return;
      if (this.stepOn()) {
        // 逐句模式：停在当前句时直接断开，点“下一句”再重连；正在说话时等这句说完
        if (this.stepPaused) this.markLiveDown("连接即将到期，点“下一句”会自动重新连接");
        else this.goAwayPending = true;
        return;
      }
      this.setStatus("连接即将到期，正在结束本次练习…", "var(--color-accent-secondary)");
      setTimeout(() => this.state === "active" && this.endSession(), 3000);
    };
    live.onClose = (info) => {
      if (this.live !== live) return;
      if (info.byUser || this.state !== "active") return;
      if (this.stepOn()) {
        this.markLiveDown(`⚠️ ${info.message || "连接已断开"}。点“下一句”会自动重新连接`);
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
      // 逐句模式：单次连接快到上限时不结束练习，而是断开后自动重连
      const connSec = this.connectedAt ? (Date.now() - this.connectedAt) / 1000 : 0;
      el.classList.remove("warn");
      if (!this.liveDown && !this.reconnecting) {
        if (this.stepPaused && connSec >= limit - 30) this.markLiveDown("单次连接快到 15 分钟上限，点“下一句”会自动重新连接");
        else if (connSec >= limit - 5) this.markLiveDown("已达到单次连接时长上限，点“下一句”会自动重新连接");
      }
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

  stopAudio() {
    clearInterval(this.timer);
    this.timer = null;
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
    // 把最后一句没被模型回应的话也算上
    if (!this.modelSpeaking && this.userChunks && this.userChunks.length && this.pendingUserText.trim()) {
      this.finalizeUserTurn();
    }
    this.closeModelEntry();
    this.state = "ended";
    if (this.live) this.live.close();
    this.stopAudio();
    this.session.endedAt = Date.now();
    this.finishRelay();
    this.dispatchEvent(new CustomEvent("navigate", { bubbles: true, detail: { view: "summary", session: this.session } }));
  }

  // ---------------- 音频与回合切分 ----------------
  onMicChunk(pcm) {
    if (this.state !== "active") return;
    this.ring.push(pcm);
    this.ringLen += pcm.length;
    while (this.ringLen > RING_SAMPLES && this.ring.length > 1) this.ringLen -= this.ring.shift().length;

    if (this.stepPaused || this.liveDown || this.reconnecting) return; // 逐句模式暂停中：不上传、不录音
    if (this.micHeld) return; // 老师说话时不上传、不录音
    if (this.clipPlaying) return; // 正在回放录音/示范发音：不上传，避免把回放当成用户说话
    if (!this.modelSpeaking && !(this.player && this.player.streaming)) this.userChunks.push(pcm);
    this.live.sendAudio(pcm);
  }

  onModelOutput() {
    if (this.modelSpeaking) return;
    this.modelSpeaking = true;
    const turn = this.finalizeUserTurn();
    if (turn && this.stepOn() && !this.stepPaused) this.enterStepPause(turn);
    this.openModelEntry();
  }

  onInputText(t) {
    // 刚结束的一句话的迟到转写
    const lt = this.lastFinalizedTurn;
    if (this.modelSpeaking && lt && !lt.analysisStarted && Date.now() - lt.finalizedAt < 2000) {
      lt.text = joinText(lt.text, t);
      this.renderTurn(lt);
      return;
    }
    this.pendingUserText = joinText(this.pendingUserText, t);
    this.renderLiveUser();
  }

  onModelTurnEnd(interrupted) {
    if (interrupted && this.player) this.player.interrupt();
    this.modelSpeaking = false;
    this.closeModelEntry();
    // 新一句开始：被打断时带上最近一小段音频（用户抢话的开头）
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
    // 逐句模式下收到过 goAway：这句说完就断开，点“下一句”时重连
    if (this.goAwayPending && this.stepOn() && !this.liveDown) {
      if (!this.stepPaused) this.enterStepPause(null);
      this.markLiveDown("连接即将到期，点“下一句”会自动重新连接");
    }
    this.pumpTeacher();
  }

  finalizeUserTurn() {
    const chunks = this.userChunks || [];
    this.userChunks = [];
    const text = this.pendingUserText.trim();
    this.pendingUserText = "";
    this.removeLiveUser();
    const pcm = concatInt16(chunks);
    const trimmed = trimSilence(pcm, 16000);
    if (!text && !trimmed) return null;
    if (!text && !this.lastCharacterText) return null; // 开场前的环境声
    if (!text && trimmed && trimmed.length < 16000 * 0.6) return null; // 很短又没有转写，多半是噪音
    const turn = {
      id: `t_${Date.now()}_${this.session.turns.length}`,
      text,
      pcm: trimmed || pcm,
      prevCharacterText: this.lastCharacterText,
      status: "pending",
      finalizedAt: Date.now(),
      analysisStarted: false,
      analysis: null,
      teacherPcm: null,
      voice: getSetting("teacherVoiceOn") ? "waiting" : "off",
    };
    this.session.turns.push(turn);
    this.session.transcript.push({ role: "user", text, turnId: turn.id });
    this.lastFinalizedTurn = turn;
    this.renderTurn(turn);
    if (turn.voice === "waiting") this.teacherQueue.push(turn);
    setTimeout(() => this.runAnalysis(turn), ANALYSIS_DELAY_MS);
    return turn;
  }

  /** 逐句模式：当前这句的老师卡片滚动到可见位置 */
  revealStepCard(turn) {
    if (!this.stepPaused || this.stepTurn !== turn) return;
    const card = this.querySelector(`[data-turn="${turn.id}"] .teacher-card`);
    card?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  async runAnalysis(turn) {
    turn.analysisStarted = true;
    turn.status = "analyzing";
    const entry = this.session.transcript.find((e) => e.turnId === turn.id);
    if (entry) entry.text = turn.text;
    this.renderTurn(turn);
    const cfg = this._cfg;
    try {
      const a = await analyzeTurn({
        pcm: turn.pcm,
        asrText: turn.text,
        prevCharacterText: turn.prevCharacterText,
        missionTitle: cfg.mission.title_en + (cfg.topic ? ` (topic: ${cfg.topic})` : ""),
        missionDesc: cfg.mission.desc_zh,
        role: cfg.mission.role_en,
        accent: cfg.accent,
        level: cfg.level,
      });
      turn.analysis = a;
      if (!turn.text && a.transcript) {
        turn.text = a.transcript;
        if (entry) entry.text = a.transcript;
      }
      turn.status = "done";
      if (a.no_speech) turn.voice = "skipped";
      this.renderTurn(turn);
      this.emit();
      this.updateStepUI();
      this.revealStepCard(turn);

      if (turn.voice === "waiting" && this.state === "active") {
        if (getSetting("teacherVoiceSource") === "browser") {
          turn.voice = "ready";
        } else {
          try {
            turn.teacherPcm = await teacherTTS(a.spoken_feedback_zh);
            if (turn.voice === "waiting") turn.voice = "ready";
          } catch (e) {
            console.warn("TTS 失败，改用设备语音", e);
            if (turn.voice === "waiting") turn.voice = "ready-browser";
          }
        }
      }
    } catch (e) {
      console.error("点评失败", e);
      turn.status = "error";
      turn.error = e.message;
      turn.voice = "skipped";
      this.renderTurn(turn);
      this.emit();
      this.updateStepUI();
      this.revealStepCard(turn);
    }
    this.pumpTeacher();
  }

  emit() {
    this.session.events.dispatchEvent(new Event("update"));
  }

  // ---------------- 老师语音排队 ----------------
  pumpTeacher() {
    if (this.state !== "active") return this.setHold(false);
    if (this.clipPlaying) return; // 用户正在回放卡片上的音频：等它播完再播老师语音
    // 去掉不需要播放的
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
    this.teacherSpeaking = true;
    this.setHold(true, "🧑‍🏫 老师点评中，听完再继续说…");
    const card = this.querySelector(`[data-turn="${turn.id}"]`);
    card?.classList.add("speaking");
    card?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    try {
      if (turn.voice === "ready" && turn.teacherPcm && this.player) {
        await this.player.playClip(turn.teacherPcm, 24000);
      } else if (turn.analysis) {
        await speakBrowser(turn.analysis.spoken_feedback_zh, "zh-CN");
      }
    } catch (e) {
      console.warn(e);
    }
    card?.classList.remove("speaking");
    if (turn.voice !== "skipped") turn.voice = "played";
    if (this.teacherQueue[0] === turn) this.teacherQueue.shift();
    this.teacherSpeaking = false;
    if (this.stepPaused) this.updateStepUI();
    // 新的一句从这里开始录
    this.userChunks = [];
    this.pumpTeacher();
  }

  skipTeacher(all = false) {
    if (this.player) this.player.stopClip();
    stopBrowserSpeech();
    const list = all ? this.teacherQueue : this.teacherQueue.slice(0, 1);
    list.forEach((t) => {
      if (t.voice !== "played") t.voice = "skipped";
    });
    this.holdStartedAt = 0;
    this.pumpTeacher();
  }

  setHold(on, text) {
    if (on && !this.micHeld) this.userChunks = [];
    this.micHeld = on;
    const b = this.$("hold-banner");
    if (!b) return;
    b.classList.toggle("hidden", !on || this.stepPaused);
    if (text) this.$("hold-text").textContent = text;
    if (this.stepPaused) this.updateStepUI();
  }

  // ---------------- 工具调用 ----------------
  onToolCall(calls) {
    const responses = [];
    for (const c of calls) {
      if (c.name === "complete_mission") {
        this.session.missionComplete = true;
        this.$("mission-banner")?.classList.remove("hidden");
      }
      responses.push({ id: c.id, name: c.name, response: { result: "ok" } });
    }
    this.live.sendToolResponse(responses);
  }

  // ---------------- 渲染 ----------------
  scrollDown() {
    const tr = this.$("transcript");
    if (tr) tr.scrollTop = tr.scrollHeight;
  }

  openModelEntry() {
    const entry = { role: "model", text: "" };
    this.session.transcript.push(entry);
    this.currentModelEntry = entry;
    const el = document.createElement("div");
    el.className = "bubble model temp";
    el.innerHTML = `<span class="who">${escapeHtml(this._cfg.mission.role_zh)}</span><span class="txt"></span>`;
    this.$("transcript").appendChild(el);
    this.currentModelEl = el;
    this.scrollDown();
  }

  appendModelText(t) {
    if (!this.currentModelEntry) this.openModelEntry();
    this.currentModelEntry.text = joinText(this.currentModelEntry.text, t);
    this.currentModelEl.querySelector(".txt").textContent = this.currentModelEntry.text;
    this.scrollDown();
  }

  closeModelEntry() {
    if (!this.currentModelEntry) return;
    const e = this.currentModelEntry;
    e.text = e.text.trim();
    if (e.text) this.lastCharacterText = e.text;
    // 给对应的用户句子补上角色回复（用于总结）
    if (this.lastFinalizedTurn && !this.lastFinalizedTurn.characterReply) this.lastFinalizedTurn.characterReply = e.text;
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
    let wrap = this.querySelector(`[data-turn="${turn.id}"]`);
    if (!wrap) {
      wrap = document.createElement("div");
      wrap.className = "turn";
      wrap.dataset.turn = turn.id;
      this.$("transcript").appendChild(wrap);
      this.scrollDown();
    }
    const fb =
      turn.status === "error"
        ? `<div class="fb-muted">点评失败：${escapeHtml(turn.error)}</div>`
        : turn.analysis
        ? feedbackHtml(turn.analysis, { compact: false })
        : `<div class="fb-loading"><span class="dots"></span> 老师正在听…</div>`;
    const canTeacher = turn.analysis && !turn.analysis.no_speech && turn.status !== "error";
    wrap.innerHTML = `
      <div class="bubble user">${escapeHtml(turn.text || "（未识别到文字）")}</div>
      <div class="teacher-card ${wrap.classList.contains("speaking") ? "speaking" : ""}">
        <div class="tc-title">🧑‍🏫 老师点评</div>
        ${fb}
        <div class="tc-actions">
          <button class="play-btn" data-act="mine" ${turn.pcm ? "" : "disabled"}>▶ 我的录音</button>
          ${canTeacher ? `<button class="play-btn teacher" data-act="teacher">▶ 老师语音</button>` : ""}
        </div>
      </div>
    `;
    this.reapplyPlaying(wrap, turn);
    if (turn.analysis && !this.stepPaused) this.scrollDown();
  }

  // ---------------- 卡片上的播放（互斥） ----------------
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
    this.clipPlaying = true; // 加载和播放期间都暂停上传麦克风
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
  }

  async onTranscriptClick(e) {
    const btn = e.target.closest("[data-act]");
    if (!btn || btn.disabled) return;
    const wrap = btn.closest("[data-turn]");
    const turn = this.session.turns.find((t) => t.id === wrap?.dataset.turn);
    if (!turn) return;
    const a = turn.analysis;
    const lang = (ACCENTS[this._cfg.accent] || ACCENTS.us).bcp47;
    const act = btn.dataset.act;
    if (act === "mine" && turn.pcm) {
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
    } else if (act === "teacher" && a) {
      // 老师语音：手动回放时，自动播放队列里就不再播这一句
      if (turn.voice !== "played" && turn.voice !== "off") turn.voice = "skipped";
      const browser = getSetting("teacherVoiceSource") === "browser";
      this.playOnCard(
        turn,
        btn,
        async () => {
          if (turn.teacherPcm) return { pcm: turn.teacherPcm, rate: 24000 };
          if (browser) return null;
          turn.teacherPcm = await teacherTTS(a.spoken_feedback_zh);
          return { pcm: turn.teacherPcm, rate: 24000 };
        },
        () => speakBrowser(a.spoken_feedback_zh, "zh-CN")
      );
    }
  }

}

function joinText(a, b) {
  if (!a) return b.replace(/^\s+/, "");
  if (!b) return a;
  if (/\s$/.test(a) || /^[\s.,!?;:'’)]/.test(b)) return a + b;
  return a + " " + b;
}

customElements.define("view-chat", ViewChat);
