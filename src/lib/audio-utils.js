// 音频工具：PCM/WAV/Base64 转换、重采样、静音裁剪

export function arrayBufferToBase64(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function base64ToInt16(b64) {
  const bin = atob(b64);
  const len = bin.length - (bin.length % 2);
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
  return new Int16Array(bytes.buffer);
}

export function concatInt16(chunks) {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Int16Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

export function int16ToFloat32(int16) {
  const f = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) f[i] = int16[i] / 32768;
  return f;
}

/** 把 Int16 PCM 封装成 WAV（ArrayBuffer） */
export function int16ToWav(int16, sampleRate) {
  const dataLen = int16.length * 2;
  const buf = new ArrayBuffer(44 + dataLen);
  const v = new DataView(buf);
  const w = (o, s) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  w(0, "RIFF");
  v.setUint32(4, 36 + dataLen, true);
  w(8, "WAVE");
  w(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  w(36, "data");
  v.setUint32(40, dataLen, true);
  new Int16Array(buf, 44).set(int16);
  return buf;
}

export function int16ToWavBlob(int16, sampleRate) {
  return new Blob([int16ToWav(int16, sampleRate)], { type: "audio/wav" });
}

/**
 * 流式降采样器：任意采样率 Float32 -> 16kHz Int16
 * （iOS/Firefox 不允许 16k 的 AudioContext 搭配麦克风，所以在主线程里自己降采样）
 */
export class Downsampler {
  constructor(srcRate, dstRate = 16000) {
    this.ratio = srcRate / dstRate;
    this.pos = 0; // 在当前输入块中的小数位置
    this.carry = new Float32Array(0);
  }

  process(input) {
    let data = input;
    if (this.carry.length) {
      data = new Float32Array(this.carry.length + input.length);
      data.set(this.carry);
      data.set(input, this.carry.length);
    }
    if (this.ratio === 1) {
      this.carry = new Float32Array(0);
      return floatToInt16(data);
    }
    const out = [];
    let pos = this.pos;
    while (pos + this.ratio <= data.length) {
      // 区间平均，起到简易低通作用
      const start = Math.floor(pos);
      const end = Math.min(data.length, Math.floor(pos + this.ratio));
      let sum = 0;
      for (let i = start; i < end; i++) sum += data[i];
      out.push(sum / Math.max(1, end - start));
      pos += this.ratio;
    }
    const consumed = Math.floor(pos);
    this.carry = data.slice(consumed);
    this.pos = pos - consumed;
    return floatToInt16(Float32Array.from(out));
  }
}

function floatToInt16(f) {
  const o = new Int16Array(f.length);
  for (let i = 0; i < f.length; i++) {
    const s = Math.max(-1, Math.min(1, f[i]));
    o[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return o;
}

/** 一块音频的 RMS（0~1） */
export function rms(int16) {
  if (!int16.length) return 0;
  let sum = 0;
  for (let i = 0; i < int16.length; i++) {
    const s = int16[i] / 32768;
    sum += s * s;
  }
  return Math.sqrt(sum / int16.length);
}

/**
 * 裁掉首尾静音。返回 null 表示整段几乎没有人声。
 */
export function trimSilence(int16, sampleRate = 16000, opts = {}) {
  const frame = Math.round(sampleRate * 0.02); // 20ms
  const pad = Math.round(sampleRate * (opts.padSec ?? 0.25));
  const n = Math.floor(int16.length / frame);
  if (!n) return null;
  const energies = new Float32Array(n);
  let max = 0;
  for (let i = 0; i < n; i++) {
    energies[i] = rms(int16.subarray(i * frame, (i + 1) * frame));
    if (energies[i] > max) max = energies[i];
  }
  // 自适应门限：取能量分布的低分位作为噪声底
  const sorted = Array.from(energies).sort((a, b) => a - b);
  const noise = sorted[Math.floor(n * 0.2)] || 0;
  const thr = Math.max(0.012, noise * 2.5, max * 0.08);
  let first = -1;
  let last = -1;
  let voiced = 0;
  for (let i = 0; i < n; i++) {
    if (energies[i] > thr) {
      if (first < 0) first = i;
      last = i;
      voiced++;
    }
  }
  // 少于 ~0.25 秒有声帧，认为没说话
  if (first < 0 || voiced < 12) return null;
  const s = Math.max(0, first * frame - pad);
  const e = Math.min(int16.length, (last + 1) * frame + pad);
  return int16.slice(s, e);
}

export function formatDuration(sec) {
  sec = Math.max(0, Math.round(sec));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}
