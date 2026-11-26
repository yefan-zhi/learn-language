// 与中转服务（邀请码模式）通信
import { RELAY_URL, relayConfigured } from "./config.js";
import { getSetting, getDeviceId } from "./settings.js";

function creds() {
  return { invite: (getSetting("inviteCode") || "").trim(), deviceId: getDeviceId() };
}

async function parse(res) {
  let j = null;
  try { j = await res.json(); } catch {}
  if (!res.ok) {
    const err = new Error(j?.error?.message || `中转服务出错（${res.status}）`);
    err.status = res.status;
    err.code = j?.error?.code;
    throw err;
  }
  return j;
}

async function post(path, body, invite) {
  if (!relayConfigured()) throw new Error("中转服务还没有部署（站长需要先配置 RELAY_URL）");
  const c = creds();
  if (invite !== undefined) c.invite = invite;
  let res;
  try {
    res = await fetch(`${RELAY_URL}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...c, ...body }),
    });
  } catch {
    throw new Error("连不上中转服务，请检查网络");
  }
  return parse(res);
}

/** 查询今日剩余分钟数（只读）。可传入待验证的邀请码 */
export function getQuota(invite) {
  return post("/api/quota", {}, invite);
}

/** 开始一次实时对话：返回 { wsUrl, sessionId, grantedMinutes, remainingMinutes } */
export function startRelaySession() {
  return post("/api/session", {});
}

/** 会话结束时上报实际用时（分钟），退回没用完的额度 */
export function reportUsage(sessionId, usedMinutes) {
  if (!sessionId || !relayConfigured()) return;
  const body = JSON.stringify({ ...creds(), sessionId, usedMinutes });
  try {
    fetch(`${RELAY_URL}/api/usage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      keepalive: true,
    }).catch(() => {});
  } catch {}
}

/** 代理 generateContent，返回 Gemini 的 JSON 响应；出错时抛出带 status 的 Error */
export async function relayGenerate(model, body) {
  return post("/api/generate", { model, body });
}

export async function relayModels() {
  if (!relayConfigured()) throw new Error("中转服务还没有部署");
  const c = creds();
  const res = await fetch(`${RELAY_URL}/api/models?invite=${encodeURIComponent(c.invite)}&deviceId=${encodeURIComponent(c.deviceId)}`);
  return parse(res);
}
