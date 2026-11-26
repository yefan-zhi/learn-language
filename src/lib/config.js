// 中转服务（Cloudflare Worker）地址。部署 Worker 后把下面的占位地址换成真实地址，
// 或者构建时用环境变量 VITE_RELAY_URL 覆盖。
export const RELAY_URL = (import.meta.env.VITE_RELAY_URL || "https://learn-language-relay.yefan-zhi.workers.dev").replace(/\/+$/, "");

export function relayConfigured() {
  return !!RELAY_URL && !RELAY_URL.includes("<");
}
