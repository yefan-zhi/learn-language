// Gemini REST API（浏览器直连）
import { getSetting, authMode } from "./settings.js";
import { relayGenerate, relayModels } from "./relay.js";

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

/** 根据模型系列加上合适的“思考”配置，追求低延迟 */
export function thinkingFor(model) {
  const m = model.toLowerCase();
  if (m.includes("tts")) return undefined;
  if (m.includes("gemini-2.5-flash") || m.includes("gemini-2.5-flash-lite")) return { thinkingBudget: 0 };
  if (m.includes("gemini-2.5-pro")) return { thinkingBudget: 128 };
  if (/gemini-3/.test(m)) return { thinkingLevel: "low" };
  return undefined;
}

export async function generateContent(model, body, opts = {}) {
  const m = model.replace(/^models\//, "");
  const gc = { ...(body.generationConfig || {}) };
  const t = thinkingFor(m);
  if (t && !gc.thinkingConfig && !opts.noThinkingConfig) gc.thinkingConfig = t;
  return request(`models/${m}:generateContent`, {
    method: "POST",
    body: { ...body, generationConfig: gc },
  });
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
  let resp;
  try {
    resp = await generateContent(model, body);
  } catch (e) {
    // 某些模型不接受 thinkingConfig，去掉再试
    if (e.status === 400 && /thinking/i.test(e.message)) {
      resp = await generateContent(model, body, { noThinkingConfig: true });
    } else throw e;
  }
  const txt = textOf(resp);
  try {
    return JSON.parse(txt);
  } catch {
    const m = txt.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    throw new Error("模型返回的不是 JSON");
  }
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

/** 从模型列表里挑出推荐的 live / teacher / tts 模型 */
export function pickModels(models) {
  const live = models.filter((m) => m.methods.includes("bidiGenerateContent"));
  const nativeAudio = live.filter((m) => /native-audio/.test(m.name));
  const text = models.filter(
    (m) => m.methods.includes("generateContent") && /^gemini-/.test(m.name) && !/tts|image|embedding|live|audio|robotics|computer/.test(m.name)
  );
  const tts = models.filter((m) => /tts/.test(m.name) && m.methods.includes("generateContent"));
  const newest = (arr) => [...arr].sort((a, b) => b.name.localeCompare(a.name, "en", { numeric: true }));
  return {
    live: newest(nativeAudio.length ? nativeAudio : live).map((m) => m.name),
    text: newest(text).map((m) => m.name),
    tts: newest(tts).map((m) => m.name),
  };
}
