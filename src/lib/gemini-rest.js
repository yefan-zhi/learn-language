// Gemini REST API（浏览器直连）
import { getSetting, authMode } from "./settings.js";
import { relayGenerate, relayModels, relayStream } from "./relay.js";
import { isModelGoneError, replaceModel, kindOfModel, pickModels as pick } from "./models.js";

const BASE = "https://generativelanguage.googleapis.com/v1beta";

function key() {
  return (getSetting("apiKey") || "").trim();
}

/**
 * 统一请求入口：有自己的 Key 时直连 Google；否则在邀请码模式下转发给中转服务
 */
async function request(path, { method = "GET", body, apiKey } = {}) {
  const k = apiKey ?? key();
  if (!k) {
    if (authMode() === "invite") return relayRequest(path, body);
    throw new Error("还没有设置 API Key 或邀请码");
  }
  return directRequest(path, { method, body, k });
}

async function relayRequest(path, body) {
  const gen = path.match(/^models\/([^:]+):generateContent$/);
  for (let attempt = 0; ; attempt++) {
    try {
      if (gen) return await relayGenerate(gen[1], body);
      if (path.startsWith("models?")) return await relayModels();
      throw new Error(`邀请码模式不支持这个请求：${path}`);
    } catch (e) {
      if (attempt === 0 && (e.status === 503 || e.status === 500 || (e.status === 429 && e.code !== "quota"))) {
        await new Promise((r) => setTimeout(r, 1200));
        continue;
      }
      throw e;
    }
  }
}

async function directRequest(path, { method, body, k }) {
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(`${BASE}/${path}`, {
      method,
      headers: { "Content-Type": "application/json", "x-goog-api-key": k },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.ok) return res.json();
    let msg = `${res.status}`;
    try {
      const j = await res.json();
      msg = j.error?.message || msg;
    } catch {}
    lastErr = new Error(msg);
    lastErr.status = res.status;
    if ((res.status === 429 || res.status === 503 || res.status === 500) && attempt === 0) {
      await new Promise((r) => setTimeout(r, 1200));
      continue;
    }
    break;
  }
  throw lastErr;
}

/**
 * 根据模型系列加上合适的“思考”配置，追求低延迟
 * - 2.5 flash：thinkingBudget 0；2.5 pro：最小预算
 * - 3.x：thinkingLevel "low"（3.8 Flash 支持 low/medium/high，不支持 minimal）
 * - TTS / Live 不加
 */
export function thinkingFor(model) {
  const m = model.toLowerCase();
  if (/tts|live|native-audio/.test(m)) return undefined;
  if (m.includes("gemini-2.5-flash")) return { thinkingBudget: 0 };
  if (m.includes("gemini-2.5-pro")) return { thinkingBudget: 128 };
  if (/^gemini-[3-9]/.test(m)) return { thinkingLevel: "low" };
  return undefined;
}

async function rawGenerate(m, body, noThinking) {
  const gc = { ...(body.generationConfig || {}) };
  const t = thinkingFor(m);
  if (t && !gc.thinkingConfig && !noThinking) gc.thinkingConfig = t;
  if (noThinking) delete gc.thinkingConfig;
  return request(`models/${m}:generateContent`, {
    method: "POST",
    body: { ...body, generationConfig: gc },
  });
}

/**
 * generateContent，自带两层容错：
 *  1. thinking 参数报错 → 去掉再试
 *  2. 模型已停用/不存在 → 换成推荐模型（错误信息里的 models/xxx 或自动检测结果）重试一次，并记住
 */
export async function generateContent(model, body, opts = {}) {
  let m = model.replace(/^models\//, "");
  let noThinking = !!opts.noThinkingConfig;
  let swapped = false;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await rawGenerate(m, body, noThinking);
    } catch (e) {
      if (!noThinking && e.status === 400 && /thinking/i.test(e.message || "")) {
        noThinking = true;
        continue;
      }
      if (!swapped && isModelGoneError(e)) {
        swapped = true;
        const next = await replaceModel(opts.kind || kindOfModel(m), m, e.message, listModels);
        if (next) {
          m = next;
          noThinking = !!opts.noThinkingConfig;
          continue;
        }
      }
      throw e;
    }
  }
  throw new Error("请求失败");
}

export function textOf(resp) {
  const parts = resp?.candidates?.[0]?.content?.parts || [];
  return parts.filter((p) => p.text && !p.thought).map((p) => p.text).join("");
}

export function audioOf(resp) {
  const parts = resp?.candidates?.[0]?.content?.parts || [];
  const p = parts.find((x) => x.inlineData?.data);
  return p ? p.inlineData : null;
}

export async function generateJSON(model, { system, parts, schema, temperature = 0.4 }) {
  const body = {
    contents: [{ role: "user", parts }],
    generationConfig: {
      temperature,
      responseMimeType: "application/json",
      responseSchema: schema,
    },
  };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  const resp = await generateContent(model, body);
  const txt = textOf(resp);
  try {
    return JSON.parse(txt);
  } catch {
    const m = txt.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    throw new Error("模型返回的不是 JSON");
  }
}

// ---------------- 流式 ----------------

/** 打开 streamGenerateContent 的 SSE 流，返回 Response */
async function openStream(m, body, signal) {
  const k = key();
  if (!k) {
    if (authMode() === "invite") return relayStream(m, body, signal);
    throw new Error("还没有设置 API Key 或邀请码");
  }
  const res = await fetch(`${BASE}/models/${m}:streamGenerateContent?alt=sse`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": k },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    let msg = `${res.status}`;
    try {
      const j = await res.json();
      msg = j.error?.message || msg;
    } catch {}
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return res;
}

/** 逐块读取 SSE，每收到一段文本调用 onText(累计文本) */
async function readSSE(res, onText, signal) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let text = "";
  for (;;) {
    if (signal?.aborted) throw new DOMException("aborted", "AbortError");
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.search(/\r?\n\r?\n/)) >= 0) {
      const evt = buf.slice(0, idx);
      buf = buf.slice(idx).replace(/^\r?\n\r?\n/, "");
      const data = evt
        .split(/\r?\n/)
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart())
        .join("\n");
      if (!data || data === "[DONE]") continue;
      let j;
      try {
        j = JSON.parse(data);
      } catch {
        continue;
      }
      if (j.error) {
        const err = new Error(j.error.message || "流式请求出错");
        err.status = j.error.code;
        throw err;
      }
      const t = textOf(j);
      if (t) {
        text += t;
        onText(text);
      }
    }
  }
  return text;
}

/**
 * 流式生成 JSON：onPartial(部分对象, 原始文本) 在每块到达时调用。
 * 流式失败（还没收到任何内容，或中途断开）时回退到普通 generateJSON。
 */
export async function streamJSON(model, { system, parts, schema, temperature = 0.4 }, { onPartial, signal, onFirstToken } = {}) {
  const body = {
    contents: [{ role: "user", parts }],
    generationConfig: { temperature, responseMimeType: "application/json", responseSchema: schema },
  };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  let m = String(model).replace(/^models\//, "");
  const gc = body.generationConfig;
  const t = thinkingFor(m);
  if (t) gc.thinkingConfig = t;
  let first = true;
  try {
    const res = await openStream(m, body, signal);
    const text = await readSSE(
      res,
      (acc) => {
        if (first) {
          first = false;
          onFirstToken?.();
        }
        const p = parsePartialJSON(acc);
        if (p) onPartial?.(p, acc);
      },
      signal
    );
    return parseFullJSON(text);
  } catch (e) {
    if (e?.name === "AbortError" || signal?.aborted) throw e;
    console.warn("流式点评失败，改用普通请求：", e.message || e);
    const out = await generateJSON(m, { system, parts, schema, temperature });
    onFirstToken?.();
    return out;
  }
}

function parseFullJSON(txt) {
  try {
    return JSON.parse(txt);
  } catch {
    const m = txt.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]); // 不完整时这里会抛错 → 回退到普通请求
    throw new Error("流式结果不完整");
  }
}

/**
 * 容错解析不完整的 JSON：补全未闭合的字符串/括号；
 * 末尾残缺的键或值会被丢弃。返回对象，失败返回 null。
 * 未闭合的字符串值会保留已生成的部分（适合边生成边显示）。
 */
export function parsePartialJSON(src) {
  const s = String(src || "").replace(/^[^{[]*/, "");
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {}
  let cut = s.length;
  for (let attempt = 0; attempt < 6 && cut > 0; attempt++) {
    const candidate = closeJSON(s.slice(0, cut));
    try {
      return JSON.parse(candidate);
    } catch {}
    // 退回到上一个逗号或开括号之后
    const prev = Math.max(s.lastIndexOf(",", cut - 1), s.lastIndexOf("{", cut - 1), s.lastIndexOf("[", cut - 1));
    if (prev < 0) break;
    cut = s[prev] === "," ? prev : prev + 1;
  }
  return null;
}

function closeJSON(s) {
  const stack = [];
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{" || c === "[") stack.push(c);
    else if (c === "}" || c === "]") stack.pop();
  }
  let out = s;
  if (inStr) {
    if (esc) out = out.slice(0, -1);
    // 半个 \uXXXX 转义
    out = out.replace(/\\u[0-9a-fA-F]{0,3}$/, "");
    out += '"';
  }
  out = out.replace(/\s+$/, "");
  if (/[:]$/.test(out)) out += "null";
  out = out.replace(/,$/, "");
  for (let i = stack.length - 1; i >= 0; i--) out += stack[i] === "{" ? "}" : "]";
  return out;
}

/** 判断某个字符串字段是否已经完整生成（右引号已出现） */
export function fieldComplete(raw, field) {
  const re = new RegExp(`"${field}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`);
  return re.test(raw);
}

/** 列出所有模型 */
export async function listModels(apiKey) {
  const all = [];
  let pageToken = "";
  for (let i = 0; i < 5; i++) {
    const q = `models?pageSize=1000${pageToken ? `&pageToken=${pageToken}` : ""}`;
    const j = await request(q, { apiKey });
    all.push(...(j.models || []));
    if (!j.nextPageToken) break;
    pageToken = j.nextPageToken;
  }
  return all.map((m) => ({
    name: m.name.replace(/^models\//, ""),
    displayName: m.displayName,
    methods: m.supportedGenerationMethods || [],
  }));
}

/** 从模型列表里挑出推荐的 live / teacher / tts 模型（规则见 lib/models.js） */
export const pickModels = pick;
