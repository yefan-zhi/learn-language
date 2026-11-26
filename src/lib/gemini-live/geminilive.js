/**
 * Gemini Live API 浏览器直连客户端（无需后端）
 * 参考 Google LLC 原始实现（Apache-2.0），为 GitHub Pages 静态部署重写。
 */
import { arrayBufferToBase64, base64ToInt16 } from "../audio-utils.js";

const WS_URL =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

export class LiveSession {
  /**
   * @param {object} opts
   *  apiKey | url, model, systemInstruction, voiceName, functionDeclarations,
   *  inputTranscription, outputTranscription, silenceDurationMs
   */
  constructor(opts) {
    this.opts = opts;
    this.ws = null;
    this.connected = false;
    this.closedByUser = false;

    // 回调
    this.onAudio = () => {};
    this.onInputTranscript = () => {};
    this.onOutputTranscript = () => {};
    this.onTurnComplete = () => {};
    this.onGenerationComplete = () => {};
    this.onInterrupted = () => {};
    this.onToolCall = () => {};
    this.onGoAway = () => {};
    this.onClose = () => {};
    this.onError = () => {};
  }

  connect() {
    const { apiKey, url } = this.opts;
    // url：邀请码模式下中转服务返回的 ephemeral token 地址（BidiGenerateContentConstrained?access_token=...）
    const wsUrl = url || `${WS_URL}?key=${encodeURIComponent(apiKey)}`;
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (err) => {
        if (!settled) {
          settled = true;
          reject(err);
        }
      };
      let ws;
      try {
        ws = new WebSocket(wsUrl);
      } catch (e) {
        fail(e);
        return;
      }
      ws.binaryType = "arraybuffer";
      this.ws = ws;

      ws.onopen = () => {
        this._sendJSON({ setup: this._buildSetup() });
      };

      ws.onerror = () => {
        this.onError(new Error("WebSocket 连接出错"));
      };

      ws.onclose = (ev) => {
        const wasConnected = this.connected;
        this.connected = false;
        const reason = ev.reason || "";
        if (!settled) {
          const err = new Error(explainClose(ev.code, reason));
          err.code = ev.code;
          err.reason = reason;
          fail(err);
        }
        this.onClose({ code: ev.code, reason, message: explainClose(ev.code, reason), wasConnected, byUser: this.closedByUser });
      };

      ws.onmessage = async (ev) => {
        let text;
        try {
          if (typeof ev.data === "string") text = ev.data;
          else if (ev.data instanceof ArrayBuffer) text = new TextDecoder().decode(ev.data);
          else if (ev.data instanceof Blob) text = await ev.data.text();
          else return;
        } catch {
          return;
        }
        let msg;
        try {
          msg = JSON.parse(text);
        } catch {
          return;
        }
        if (msg.setupComplete !== undefined) {
          this.connected = true;
          if (!settled) {
            settled = true;
            resolve();
          }
        }
        this._handle(msg);
      };
    });
  }

  _buildSetup() {
    const o = this.opts;
    const model = o.model.startsWith("models/") ? o.model : `models/${o.model}`;
    const setup = {
      model,
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName: o.voiceName || "Puck" } },
        },
      },
      systemInstruction: { parts: [{ text: o.systemInstruction || "" }] },
      realtimeInputConfig: {
        automaticActivityDetection: {
          silenceDurationMs: o.silenceDurationMs ?? 900,
          prefixPaddingMs: 300,
        },
      },
    };
    if (o.functionDeclarations && o.functionDeclarations.length) {
      setup.tools = [{ functionDeclarations: o.functionDeclarations }];
    }
    if (o.inputTranscription !== false) setup.inputAudioTranscription = {};
    if (o.outputTranscription !== false) setup.outputAudioTranscription = {};
    return setup;
  }

  _handle(msg) {
    const sc = msg.serverContent;
    if (sc) {
      if (sc.inputTranscription && sc.inputTranscription.text) {
        this.onInputTranscript(sc.inputTranscription.text);
      }
      const parts = sc.modelTurn && sc.modelTurn.parts;
      if (parts) {
        for (const p of parts) {
          if (p.inlineData && p.inlineData.data) {
            this.onAudio(base64ToInt16(p.inlineData.data));
          }
        }
      }
      if (sc.outputTranscription && sc.outputTranscription.text) {
        this.onOutputTranscript(sc.outputTranscription.text);
      }
      if (sc.interrupted) this.onInterrupted();
      if (sc.generationComplete) this.onGenerationComplete();
      if (sc.turnComplete) this.onTurnComplete();
    }
    if (msg.toolCall && msg.toolCall.functionCalls) {
      this.onToolCall(msg.toolCall.functionCalls);
    }
    if (msg.goAway) {
      this.onGoAway(msg.goAway);
    }
  }

  _sendJSON(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
    }
  }

  /** 发送 16kHz Int16 PCM */
  sendAudio(int16) {
    if (!this.connected) return;
    this._sendJSON({
      realtimeInput: {
        audio: {
          data: arrayBufferToBase64(new Uint8Array(int16.buffer, int16.byteOffset, int16.byteLength)),
          mimeType: "audio/pcm;rate=16000",
        },
      },
    });
  }

  /** 发送一条文本（作为用户回合） */
  sendText(text) {
    this._sendJSON({
      clientContent: {
        turns: [{ role: "user", parts: [{ text }] }],
        turnComplete: true,
      },
    });
  }

  sendToolResponse(functionResponses) {
    this._sendJSON({ toolResponse: { functionResponses } });
  }

  close() {
    this.closedByUser = true;
    this.connected = false;
    if (this.ws) {
      try { this.ws.close(1000, "bye"); } catch {}
    }
  }
}

function explainClose(code, reason) {
  const r = (reason || "").toLowerCase();
  if (r.includes("token") && (r.includes("expire") || r.includes("invalid") || r.includes("used"))) {
    return `临时令牌无效或已过期，请重新开始：${reason}`;
  }
  if (r.includes("api key") || r.includes("api_key") || r.includes("permission") || r.includes("unauthenticated")) {
    return `API Key 无效或没有权限：${reason}`;
  }
  if (r.includes("not found") || r.includes("not supported") || r.includes("model")) {
    return `模型不可用（请在设置里点「检测可用模型」）：${reason}`;
  }
  if (r.includes("quota") || r.includes("resource_exhausted") || r.includes("rate")) {
    return `额度用完或请求过于频繁：${reason}`;
  }
  if (code === 1000 && !reason) return "连接已关闭";
  return reason ? `连接被关闭（${code}）：${reason}` : `连接被关闭（${code}）`;
}
