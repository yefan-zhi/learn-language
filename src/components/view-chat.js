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
import { analyzeTurn, teacherTTS, nativeTTS, speakBrowser, stopBrowserSpeech, unlockBrowserSpeech } from "../lib/teacher.js";
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

        <div class="chat-bottom">
          <div class="viz-row small"><audio-visualizer id="user-viz"></audio-visualizer></div>
          <div class="controls">
            <button class="chip ${getSetting("teacherVoiceOn") ? "on" : ""}" id="voice-toggle" title="老师语音点评">🔊 老师语音</button>
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
      let live;
      for (let attempt = 0; ; attempt++) {
        live = this.buildLive(relay);
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
  buildLive(relay) {
    const cfg = this._cfg;
    const live = new LiveSession({
      apiKey: relay ? undefined : getSetting("apiKey"),
      url: relay ? relay.wsUrl : undefined,
      model: getSetting("liveModel"),
      voiceName: getSetting("characterVoice"),
      systemInstruction: buildSystemInstruction(cfg),
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
      this.setStatus("连接即将到期，正在结束本次练习…", "var(--color-accent-secondary)");
      setTimeout(() => this.state === "active" && this.endSession(), 3000);
    };
    live.onClose = (info) => {
      if (info.byUser || this.state !== "active") return;
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

    if (this.micHeld) return; // 老师说话时不上传、不录音
    if (!this.modelSpeaking && !(this.player && this.player.streaming)) this.userChunks.push(pcm);
    this.live.sendAudio(pcm);
  }

  onModelOutput() {
    if (this.modelSpeaking) return;
    this.modelSpeaking = true;
    this.finalizeUserTurn();
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
    if (!text && !trimmed) return;
    if (!text && !this.lastCharacterText) return; // 开场前的环境声
    if (!text && trimmed && trimmed.length < 16000 * 0.6) return; // 很短又没有转写，多半是噪音
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
    }
    this.pumpTeacher();
  }

  emit() {
    this.session.events.dispatchEvent(new Event("update"));
  }

  // ---------------- 老师语音排队 ----------------
  pumpTeacher() {
    if (this.state !== "active") return this.setHold(false);
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
    turn.voice = "played";
    if (this.teacherQueue[0] === turn) this.teacherQueue.shift();
    this.teacherSpeaking = false;
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
    b.classList.toggle("hidden", !on);
    if (text) this.$("hold-text").textContent = text;
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
    wrap.innerHTML = `
      <div class="bubble user">${escapeHtml(turn.text || "（未识别到文字）")}</div>
      <div class="teacher-card ${wrap.classList.contains("speaking") ? "speaking" : ""}">
        <div class="tc-title">🧑‍🏫 老师点评</div>
        ${fb}
      </div>
    `;
    if (turn.analysis) this.scrollDown();
  }

  async onTranscriptClick(e) {
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    const wrap = btn.closest("[data-turn]");
    const turn = this.session.turns.find((t) => t.id === wrap?.dataset.turn);
    if (!turn || !turn.analysis) return;
    if (btn.dataset.act === "native") {
      btn.disabled = true;
      btn.textContent = "⏳";
      try {
        const pcm = await nativeTTS(turn.analysis.better_expression, this._cfg.accent);
        if (this.player) await this.player.playClip(pcm, 24000);
      } catch (err) {
        await speakBrowser(turn.analysis.better_expression, (ACCENTS[this._cfg.accent] || ACCENTS.us).bcp47);
      }
      btn.disabled = false;
      btn.textContent = "🔊";
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
