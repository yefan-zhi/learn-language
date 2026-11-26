/**
 * learn-language-relay：给朋友用的 Gemini 中转（Cloudflare Worker）
 *
 * - 真正的 GEMINI_API_KEY 只存在 Worker secret 里，永远不发给浏览器
 * - 实时对话：签发一次性 ephemeral token，浏览器拿 token 直连 Gemini Live（音频不经过 Worker）
 * - 老师点评 / TTS / 总结：代理 generateContent
 * - 凭邀请码使用；按设备、按全站每日分钟数限额
 *
 * 分钟计费方案（尽量少写 KV）：
 *   开始会话时预留 grant 分钟（≤15，且不超过剩余额度），token 的 expireTime 也只给 grant+1 分钟；
 *   会话结束时客户端上报实际分钟数，Worker 把没用完的退回。
 *   客户端没上报（崩溃/关页面），预留的分钟就算用掉了（偏保守）。
 */

const GEMINI = "https://generativelanguage.googleapis.com";
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const DAY_TTL = 60 * 60 * 48; // 计数器保留 2 天
const MODEL_RE = /^gemini-[a-z0-9][a-z0-9.\-]{0,80}$/;
const DEVICE_RE = /^[A-Za-z0-9-]{8,64}$/;
const SESSION_RE = /^[a-f0-9-]{36}$/;

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin");
    const cors = corsHeaders(origin, env);

    if (origin && !cors) {
      return json({ error: { code: "origin", message: "不允许的来源" } }, 403, {});
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors || {} });
    }

    const url = new URL(request.url);
    try {
      let res;
      if (url.pathname === "/" || url.pathname === "/api/health") {
        res = json({ ok: true, service: "learn-language-relay" });
      } else if (url.pathname === "/api/quota" && request.method === "POST") {
        res = await handleQuota(request, env);
      } else if (url.pathname === "/api/session" && request.method === "POST") {
        res = await handleSession(request, env);
      } else if (url.pathname === "/api/usage" && request.method === "POST") {
        res = await handleUsage(request, env);
      } else if (url.pathname === "/api/generate" && request.method === "POST") {
        res = await handleGenerate(request, env);
      } else if (url.pathname === "/api/models" && request.method === "GET") {
        res = await handleModels(request, env, url);
      } else {
        res = json({ error: { code: "not_found", message: "接口不存在" } }, 404);
      }
      return withHeaders(res, cors);
    } catch (e) {
      if (e instanceof HttpError) {
        return withHeaders(json({ error: { code: e.code, message: e.message } }, e.status), cors);
      }
      console.error(e);
      return withHeaders(json({ error: { code: "internal", message: "中转服务出错了，请稍后再试" } }, 500), cors);
    }
  },
};

// ---------------- handlers ----------------

async function handleQuota(request, env) {
  const { deviceId } = await auth(request, env);
  const q = await quota(env, deviceId);
  return json({ ...q, sessionMaxMinutes: sessionMax(env) });
}

async function handleSession(request, env) {
  const { deviceId } = await auth(request, env);
  const q = await quota(env, deviceId);
  if (q.remainingMinutes < 1) {
    throw new HttpError(429, "quota", q.deviceRemaining < 1 ? "你今天的练习额度已经用完了，明天再来吧～" : "今天大家的总额度已经用完了，明天再来吧～");
  }
  const grant = Math.min(sessionMax(env), q.remainingMinutes);
  const now = Date.now();

  // 签发一次性 ephemeral token
  const tokenRes = await fetch(`${base(env)}/v1beta/auth_tokens`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
    body: JSON.stringify({
      uses: 1,
      expireTime: new Date(now + (grant + 1) * 60_000).toISOString(),
      newSessionExpireTime: new Date(now + 2 * 60_000).toISOString(),
    }),
  });
  if (!tokenRes.ok) {
    const msg = await upstreamMessage(tokenRes);
    console.error("auth_tokens failed", tokenRes.status, msg);
    throw new HttpError(502, "upstream", `无法创建实时对话令牌（${tokenRes.status}）：${msg}`);
  }
  const token = (await tokenRes.json()).name;
  if (!token) throw new HttpError(502, "upstream", "实时对话令牌为空");

  // 预留分钟（3 次 KV 写入）
  const day = q.day;
  const sessionId = crypto.randomUUID();
  await Promise.all([
    putInt(env, devKey(day, deviceId), q.deviceUsed + grant),
    putInt(env, totKey(day), q.totalUsed + grant),
    env.USAGE.put(`s:${sessionId}`, JSON.stringify({ d: deviceId, day, g: grant, t: now }), { expirationTtl: DAY_TTL }),
  ]);

  const ver = env.LIVE_API_VERSION || "v1beta";
  return json({
    token,
    wsUrl: `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.${ver}.GenerativeService.BidiGenerateContentConstrained?access_token=${encodeURIComponent(token)}`,
    sessionId,
    grantedMinutes: grant,
    remainingMinutes: q.remainingMinutes - grant,
  });
}

async function handleUsage(request, env) {
  const { deviceId, body } = await auth(request, env);
  const sessionId = String(body.sessionId || "");
  if (!SESSION_RE.test(sessionId)) throw new HttpError(400, "bad_request", "sessionId 无效");
  const raw = await env.USAGE.get(`s:${sessionId}`);
  if (!raw) return json({ ok: true, refunded: 0 }); // 已上报过或已过期
  const s = JSON.parse(raw);
  if (s.d !== deviceId) throw new HttpError(403, "forbidden", "会话不属于这台设备");

  const reported = Number(body.usedMinutes);
  const clientUsed = Number.isFinite(reported) ? Math.ceil(Math.max(0, reported)) : s.g;
  // 不能少于“从签发到现在”的真实时间（减去 1 分钟连接宽限），防止少报
  const elapsedFloor = Math.max(0, Math.ceil((Date.now() - s.t) / 60_000) - 1);
  const used = Math.min(s.g, Math.max(clientUsed, elapsedFloor));
  const refund = s.g - used;

  const writes = [env.USAGE.delete(`s:${sessionId}`)];
  if (refund > 0) {
    const [d, t] = await Promise.all([getInt(env, devKey(s.day, deviceId)), getInt(env, totKey(s.day))]);
    writes.push(putInt(env, devKey(s.day, deviceId), Math.max(0, d - refund)));
    writes.push(putInt(env, totKey(s.day), Math.max(0, t - refund)));
  }
  await Promise.all(writes);
  return json({ ok: true, used, refunded: refund });
}

async function handleGenerate(request, env) {
  const len = Number(request.headers.get("Content-Length") || 0);
  if (len > MAX_BODY_BYTES) throw new HttpError(413, "too_large", "请求太大了（录音过长）");
  const { deviceId, body } = await auth(request, env, { maxBytes: MAX_BODY_BYTES });

  const model = String(body.model || "").replace(/^models\//, "");
  if (!MODEL_RE.test(model)) throw new HttpError(400, "bad_model", "模型名称不合法");
  if (!body.body || typeof body.body !== "object") throw new HttpError(400, "bad_request", "缺少请求内容");

  await rateLimit(env.GEN_LIMITER, deviceId, "请求太频繁了，请稍等几秒再试");

  // 每设备每日请求数上限：概率计数（每 10 次请求平均写 1 次 KV）
  const day = utcDay();
  const rKey = `r:${day}:${deviceId}`;
  const count = await getInt(env, rKey);
  const limit = intVar(env.DEVICE_DAILY_REQUESTS, 400);
  if (count >= limit) throw new HttpError(429, "quota", "你今天的点评次数已经用完了，明天再来吧～");
  if (Math.random() < 0.1) await putInt(env, rKey, count + 10);

  const up = await fetch(`${base(env)}/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
    body: JSON.stringify(body.body),
  });
  return new Response(up.body, {
    status: up.status,
    headers: { "Content-Type": up.headers.get("Content-Type") || "application/json" },
  });
}

async function handleModels(request, env, url) {
  await auth(request, env, {
    fromQuery: { invite: url.searchParams.get("invite"), deviceId: url.searchParams.get("deviceId") },
  });
  const all = [];
  let pageToken = "";
  for (let i = 0; i < 5; i++) {
    const r = await fetch(`${base(env)}/v1beta/models?pageSize=1000${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`, {
      headers: { "x-goog-api-key": env.GEMINI_API_KEY },
    });
    if (!r.ok) throw new HttpError(502, "upstream", `获取模型列表失败（${r.status}）：${await upstreamMessage(r)}`);
    const j = await r.json();
    for (const m of j.models || []) {
      all.push({ name: m.name, displayName: m.displayName, supportedGenerationMethods: m.supportedGenerationMethods });
    }
    if (!j.nextPageToken) break;
    pageToken = j.nextPageToken;
  }
  return json({ models: all });
}

// ---------------- auth & quota ----------------

async function auth(request, env, opts = {}) {
  const ip = request.headers.get("CF-Connecting-IP") || "local";
  let body = {};
  if (opts.fromQuery) {
    body = opts.fromQuery;
  } else {
    const text = await request.text();
    if (opts.maxBytes && text.length > opts.maxBytes) throw new HttpError(413, "too_large", "请求太大了（录音过长）");
    try {
      body = JSON.parse(text || "{}");
    } catch {
      throw new HttpError(400, "bad_request", "请求格式不对");
    }
  }
  const invite = String(body.invite || "").trim();
  const deviceId = String(body.deviceId || "");
  if (!DEVICE_RE.test(deviceId)) throw new HttpError(400, "bad_request", "设备标识无效，请刷新页面重试");
  if (!invite || !(await inviteOk(invite, env))) {
    await rateLimit(env.AUTH_LIMITER, ip, "尝试次数太多了，请一分钟后再试");
    throw new HttpError(401, "bad_invite", "邀请码不对，请向朋友确认一下");
  }
  if (!env.GEMINI_API_KEY) throw new HttpError(500, "config", "中转服务还没配置 API Key");
  return { deviceId, body };
}

/** 常量时间比较：先各自 SHA-256，再逐字节 XOR。INVITE_CODE 可以用逗号分隔多个 */
async function inviteOk(invite, env) {
  const codes = String(env.INVITE_CODE || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!codes.length) return false;
  const a = await sha256(invite);
  let ok = 0;
  for (const c of codes) {
    const b = await sha256(c);
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
    ok |= diff === 0 ? 1 : 0;
  }
  return ok === 1;
}

async function sha256(s) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
}

async function quota(env, deviceId) {
  const day = utcDay();
  const [deviceUsed, totalUsed] = await Promise.all([getInt(env, devKey(day, deviceId)), getInt(env, totKey(day))]);
  const devLimit = intVar(env.DEVICE_DAILY_MINUTES, 30);
  const totLimit = intVar(env.TOTAL_DAILY_MINUTES, 120);
  const deviceRemaining = Math.max(0, devLimit - deviceUsed);
  const totalRemaining = Math.max(0, totLimit - totalUsed);
  return {
    day,
    deviceUsed,
    totalUsed,
    deviceRemaining,
    totalRemaining,
    remainingMinutes: Math.min(deviceRemaining, totalRemaining),
    deviceDailyMinutes: devLimit,
  };
}

async function rateLimit(limiter, key, message) {
  if (!limiter || typeof limiter.limit !== "function") return;
  try {
    const { success } = await limiter.limit({ key });
    if (!success) throw new HttpError(429, "rate_limited", message);
  } catch (e) {
    if (e instanceof HttpError) throw e;
    console.warn("rate limiter unavailable", e);
  }
}

// ---------------- helpers ----------------

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function corsHeaders(origin, env) {
  if (!origin) return null;
  const allowed = String(env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!allowed.includes(origin)) return null;
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function withHeaders(res, extra) {
  if (!extra) return res;
  const h = new Headers(res.headers);
  for (const [k, v] of Object.entries(extra)) h.set(k, v);
  return new Response(res.body, { status: res.status, headers: h });
}

function json(obj, status = 200, headers = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
  });
}

async function upstreamMessage(res) {
  try {
    const j = await res.json();
    return j.error?.message || res.statusText;
  } catch {
    return res.statusText;
  }
}

// 仅用于本地测试时把上游指到桩服务（.dev.vars 里设置）；生产环境不要设置
const base = (env) => env.GEMINI_BASE || GEMINI;
const utcDay = () => new Date().toISOString().slice(0, 10);
const devKey = (day, id) => `m:${day}:${id}`;
const totKey = (day) => `m:${day}:total`;
const sessionMax = (env) => intVar(env.SESSION_MAX_MINUTES, 15);

function intVar(v, d) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : d;
}

async function getInt(env, key) {
  const v = await env.USAGE.get(key);
  const n = parseInt(v || "0", 10);
  return Number.isFinite(n) ? n : 0;
}

function putInt(env, key, n) {
  return env.USAGE.put(key, String(Math.max(0, Math.round(n))), { expirationTtl: DAY_TTL });
}
