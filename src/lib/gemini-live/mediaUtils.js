/**
 * Copyright 2026 Google LLC (original), modified for learn-language.
 * Licensed under the Apache License, Version 2.0.
 *
 * 麦克风采集 + 模型音频播放
 */
import { Downsampler, int16ToFloat32 } from "../audio-utils.js";

const BASE = import.meta.env.BASE_URL || "./";

/**
 * 采集麦克风音频，降采样为 16kHz Int16，通过 onChunk 回调输出
 */
export class AudioStreamer {
  constructor() {
    this.audioContext = null;
    this.audioWorklet = null;
    this.mediaStream = null;
    this.source = null;
    this.isStreaming = false;
    this.onChunk = () => {};
  }

  async start() {
    // 注意：不要给 AudioContext 指定 sampleRate，Firefox/Safari 下麦克风会失败
    const Ctx = window.AudioContext || window.webkitAudioContext;
    this.audioContext = new Ctx();
    if (this.audioContext.state === "suspended") {
      try { await this.audioContext.resume(); } catch {}
    }

    this.mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
    });

    await this.audioContext.audioWorklet.addModule(
      `${BASE}audio-processors/capture.worklet.js`
    );
    this.audioWorklet = new AudioWorkletNode(this.audioContext, "audio-capture-processor");
    const ds = new Downsampler(this.audioContext.sampleRate, 16000);

    this.audioWorklet.port.onmessage = (event) => {
      if (!this.isStreaming || event.data?.type !== "audio") return;
      const pcm = ds.process(event.data.data);
      if (pcm.length) this.onChunk(pcm);
    };

    this.source = this.audioContext.createMediaStreamSource(this.mediaStream);
    this.source.connect(this.audioWorklet);
    // 部分浏览器（Safari）需要节点连到 destination 才会运行 process，用 0 增益静音
    const mute = this.audioContext.createGain();
    mute.gain.value = 0;
    this.audioWorklet.connect(mute);
    mute.connect(this.audioContext.destination);

    this.isStreaming = true;
    return true;
  }

  stop() {
    this.isStreaming = false;
    try {
      if (this.audioWorklet) {
        this.audioWorklet.disconnect();
        this.audioWorklet.port.close();
      }
    } catch {}
    this.audioWorklet = null;
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((t) => t.stop());
      this.mediaStream = null;
    }
    if (this.audioContext) {
      this.audioContext.close().catch(() => {});
      this.audioContext = null;
    }
  }
}

/**
 * 播放 24kHz PCM。流式播放模型音频，并提供“播放完毕”事件；
 * 另外可以整段播放（老师点评语音）。
 */
export class AudioPlayer {
  constructor() {
    this.audioContext = null;
    this.workletNode = null;
    this.gainNode = null;
    this.isInitialized = false;
    this.sampleRate = 24000;
    this.streaming = false; // 流式队列里是否还有声音
    this.onDrained = () => {};
    this._clipSource = null;
  }

  async init() {
    if (this.isInitialized) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    try {
      this.audioContext = new Ctx({ sampleRate: this.sampleRate });
    } catch {
      this.audioContext = new Ctx();
    }
    if (!this.audioContext.audioWorklet) {
      throw new Error("当前浏览器不支持 AudioWorklet，请使用最新版 Chrome / Safari / Edge（需 HTTPS）。");
    }
    await this.audioContext.audioWorklet.addModule(
      `${BASE}audio-processors/playback.worklet.js`
    );
    this.workletNode = new AudioWorkletNode(this.audioContext, "pcm-processor", {
      processorOptions: { inputRate: this.sampleRate },
    });
    this.workletNode.port.onmessage = (e) => {
      if (e.data === "drained") {
        this.streaming = false;
        this.onDrained();
      }
    };
    this.gainNode = this.audioContext.createGain();
    this.workletNode.connect(this.gainNode);
    this.gainNode.connect(this.audioContext.destination);
    this.isInitialized = true;
  }

  async resume() {
    if (this.audioContext && this.audioContext.state === "suspended") {
      try { await this.audioContext.resume(); } catch {}
    }
  }

  /** 流式播放一块 Int16 PCM（24k） */
  play(int16) {
    if (!this.isInitialized) return;
    this.resume();
    this.streaming = true;
    this.workletNode.port.postMessage(int16ToFloat32(int16));
  }

  interrupt() {
    if (this.workletNode) this.workletNode.port.postMessage("interrupt");
    this.streaming = false;
  }

  /** 整段播放一个 Int16 PCM 片段，返回播放结束的 Promise */
  playClip(int16, rate = 24000) {
    if (!this.isInitialized) return Promise.resolve();
    this.resume();
    this.stopClip();
    const buffer = this.audioContext.createBuffer(1, int16.length, rate);
    buffer.copyToChannel(int16ToFloat32(int16), 0);
    const src = this.audioContext.createBufferSource();
    src.buffer = buffer;
    src.connect(this.gainNode);
    this._clipSource = src;
    return new Promise((resolve) => {
      src.onended = () => {
        if (this._clipSource === src) this._clipSource = null;
        resolve();
      };
      src.start();
    });
  }

  stopClip() {
    if (this._clipSource) {
      try { this._clipSource.stop(); } catch {}
      this._clipSource = null;
    }
  }

  destroy() {
    this.stopClip();
    if (this.audioContext) {
      this.audioContext.close().catch(() => {});
      this.audioContext = null;
    }
    this.isInitialized = false;
  }
}
