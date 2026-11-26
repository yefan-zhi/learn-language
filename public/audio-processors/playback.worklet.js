/**
 * Copyright 2025 Google LLC (original), modified for learn-language.
 * Licensed under the Apache License, Version 2.0.
 *
 * PCM 流式播放；队列播空时向主线程发送 "drained"。
 */
class PCMProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.audioQueue = [];
    this.inputRate = (options && options.processorOptions && options.processorOptions.inputRate) || sampleRate;
    this.hadData = false;

    this.port.onmessage = (event) => {
      if (event.data === "interrupt") {
        this.audioQueue = [];
        if (this.hadData) {
          this.hadData = false;
          this.port.postMessage("drained");
        }
      } else if (event.data instanceof Float32Array) {
        this.audioQueue.push(this.resample(event.data));
        this.hadData = true;
      }
    };
  }

  resample(data) {
    if (this.inputRate === sampleRate) return data;
    const ratio = this.inputRate / sampleRate;
    const outLen = Math.floor(data.length / ratio);
    const out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const p = i * ratio;
      const i0 = Math.floor(p);
      const i1 = Math.min(data.length - 1, i0 + 1);
      const f = p - i0;
      out[i] = data[i0] * (1 - f) + data[i1] * f;
    }
    return out;
  }

  process(inputs, outputs) {
    const output = outputs[0];
    if (output.length === 0) return true;
    const channel = output[0];
    let outputIndex = 0;

    while (outputIndex < channel.length && this.audioQueue.length > 0) {
      const cur = this.audioQueue[0];
      if (!cur || cur.length === 0) {
        this.audioQueue.shift();
        continue;
      }
      const n = Math.min(channel.length - outputIndex, cur.length);
      channel.set(cur.subarray(0, n), outputIndex);
      outputIndex += n;
      if (n < cur.length) this.audioQueue[0] = cur.subarray(n);
      else this.audioQueue.shift();
    }
    while (outputIndex < channel.length) channel[outputIndex++] = 0;

    if (this.hadData && this.audioQueue.length === 0) {
      this.hadData = false;
      this.port.postMessage("drained");
    }
    for (let c = 1; c < output.length; c++) output[c].set(channel);
    return true;
  }
}

registerProcessor("pcm-processor", PCMProcessor);
