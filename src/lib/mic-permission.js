/**
 * 麦克风权限：申请前说明、被拒绝/出错时按浏览器给出开启步骤（重点适配 iOS Safari / iOS Chrome / 微信等内置浏览器）。
 *
 * 用法（在用户点击里调用）：
 *   const stream = await acquireMic({ onGesture })
 * - onGesture：会在“用户点击”的同步阶段被调用，用来创建/resume AudioContext、解锁 speechSynthesis（iOS 需要）。
 * - 成功返回 MediaStream；用户关闭弹窗则抛出 name === "MicCancelled" 的错误。
 */
import { escapeHtml, lockScroll, unlockScroll } from "./dom.js";

export const MIC_CONSTRAINTS = {
  audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
};

const GRANTED_KEY = "ll_micGranted";

// ---------------- 浏览器识别 ----------------
export function detectBrowser(ua = navigator.userAgent) {
  const isIPad = /iPad/.test(ua) || (/Macintosh/.test(ua) && (navigator.maxTouchPoints || 0) > 1);
  const isIPhone = /iPhone|iPod/.test(ua);
  const ios = isIPhone || isIPad;
  let inApp = null;
  if (/MicroMessenger/i.test(ua)) inApp = "微信";
  else if (/\bQQ\/[\d.]+/i.test(ua) && !/MQQBrowser/i.test(ua)) inApp = "QQ";
  else if (/Weibo/i.test(ua)) inApp = "微博";
  else if (/DingTalk/i.test(ua)) inApp = "钉钉";
  else if (/AliApp|AlipayClient/i.test(ua)) inApp = "支付宝";
  else if (/Lark|Feishu/i.test(ua)) inApp = "飞书";
  else if (/FBAN|FBAV|Instagram|Line\/|Twitter/i.test(ua)) inApp = "App 内置浏览器";
  let kind = "other";
  if (inApp) kind = "inapp";
  else if (ios && /CriOS/.test(ua)) kind = "ios-chrome";
  else if (ios && /FxiOS/.test(ua)) kind = "ios-firefox";
  else if (ios && /EdgiOS/.test(ua)) kind = "ios-edge";
  else if (ios) kind = "ios-safari";
  else if (/Edg\//.test(ua)) kind = "edge";
  else if (/Chrome\//.test(ua)) kind = "chrome";
  else if (/Firefox\//.test(ua)) kind = "firefox";
  else if (/Safari\//.test(ua)) kind = "safari";
  return { ios, isIPhone, isIPad, inApp, kind };
}

/** iOS 17+：让麦克风和播放共存，减少声音从听筒出来的情况 */
export function configureAudioSession() {
  try {
    if (navigator.audioSession && navigator.audioSession.type !== "play-and-record") {
      navigator.audioSession.type = "play-and-record";
    }
  } catch {}
}

async function permissionState() {
  try {
    if (!navigator.permissions?.query) return "unknown";
    const r = await navigator.permissions.query({ name: "microphone" });
    return r.state || "unknown"; // granted | denied | prompt
  } catch {
    return "unknown";
  }
}

function remember(ok) {
  try {
    if (ok) localStorage.setItem(GRANTED_KEY, "1");
    else localStorage.removeItem(GRANTED_KEY);
  } catch {}
}

function grantedBefore() {
  try {
    return localStorage.getItem(GRANTED_KEY) === "1";
  } catch {
    return false;
  }
}

function micSupported() {
  return !!(window.isSecureContext !== false && navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
}

/** 在点击事件里同步调用：先做 onGesture，再立即调用 getUserMedia（不能放到 await 之后） */
function requestNow(onGesture) {
  try { onGesture && onGesture(); } catch (e) { console.warn(e); }
  configureAudioSession();
  return navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS);
}

export function errorKind(err) {
  const n = err && err.name;
  if (n === "NotAllowedError" || n === "PermissionDeniedError" || n === "SecurityError") return "denied";
  if (n === "NotFoundError" || n === "DevicesNotFoundError" || n === "OverconstrainedError") return "notfound";
  if (n === "NotReadableError" || n === "TrackStartError" || n === "AbortError") return "busy";
  if (n === "Unsupported") return "unsupported";
  return "other";
}

/**
 * 申请麦克风。
 * - 已授权（Permissions API 返回 granted）：直接获取，不弹说明框。
 * - 其余情况：先弹“需要使用麦克风”说明框，在“允许麦克风”按钮的点击里同步申请。
 * - 失败时弹出对应的引导框，“我已开启，重试”同样在点击里同步申请。
 */
export async function acquireMic({ onGesture } = {}) {
  const env = detectBrowser();
  if (!micSupported()) {
    return runDialog(env, { kind: env.inApp ? "inapp" : "unsupported" }, onGesture);
  }
  const state = await permissionState();
  if (state === "granted") {
    try {
      const s = await requestNow(onGesture);
      remember(true);
      return s;
    } catch (err) {
      return runDialog(env, { kind: errorKind(err), err }, onGesture);
    }
  }
  if (state === "denied") {
    remember(false);
    return runDialog(env, { kind: "denied" }, onGesture);
  }
  return runDialog(env, { kind: "explain", again: grantedBefore() }, onGesture);
}

/** 只显示“麦克风断开”这类提示，并在按钮点击里重新申请（用于轨道 ended 后一键恢复） */
export function reacquireMic({ onGesture, reason } = {}) {
  const env = detectBrowser();
  return runDialog(env, { kind: "ended", reason }, onGesture);
}

function runDialog(env, first, onGesture) {
  return new Promise((resolve, reject) => {
    const dlg = document.createElement("mic-dialog");
    dlg.env = env;
    dlg.onRequest = () => {
      if (!micSupported()) {
        dlg.show({ kind: env.inApp ? "inapp" : "unsupported" });
        return;
      }
      dlg.busy(true);
      let p;
      try {
        p = requestNow(onGesture);
      } catch (e) {
        p = Promise.reject(e);
      }
      p.then(
        (stream) => {
          remember(true);
          dlg.close();
          resolve(stream);
        },
        (err) => {
          console.warn("getUserMedia 失败", err);
          dlg.busy(false);
          const k = errorKind(err);
          if (k === "denied") remember(false);
          dlg.show({ kind: env.inApp && k !== "busy" && k !== "notfound" ? "inapp" : k, err });
        }
      );
    };
    dlg.onCancel = () => {
      dlg.close();
      const e = new Error("已取消");
      e.name = "MicCancelled";
      reject(e);
    };
    document.body.appendChild(dlg);
    dlg.show(first);
  });
}

// ---------------- 文案 ----------------
function deniedSteps(env) {
  switch (env.kind) {
    case "ios-safari":
      return {
        title: "麦克风被关闭了（Safari）",
        steps: [
          "点地址栏左侧的 <b>“大小”图标（aA）</b> → <b>网站设置</b> → <b>麦克风</b> → 选 <b>允许</b>。",
          "如果没有这个选项：打开 iPhone <b>设置</b> → <b>App</b> → <b>Safari</b> → <b>麦克风</b>，改成 <b>询问</b> 或 <b>允许</b>。",
          "回到这里 <b>刷新页面</b>，再点“我已开启，重试”。",
        ],
      };
    case "ios-chrome":
      return {
        title: "麦克风被关闭了（iOS Chrome）",
        steps: [
          "打开 iPhone <b>设置</b> → <b>App</b> → <b>Chrome</b> → 打开 <b>麦克风</b> 开关。",
          "回到 Chrome <b>刷新页面</b>，重新点开始，系统询问时选 <b>允许</b>。",
          "如果之前在网页里选过“不允许”：点地址栏左侧的 <b>锁/设置图标</b> → <b>网站设置</b> → <b>麦克风</b> 改为允许；或者在 Chrome <b>设置</b> → <b>隐私和安全</b> → <b>网站设置</b> 里重置本网站的权限。",
        ],
      };
    case "ios-firefox":
    case "ios-edge":
      return {
        title: `麦克风被关闭了（iOS ${env.kind === "ios-edge" ? "Edge" : "Firefox"}）`,
        steps: [
          `打开 iPhone <b>设置</b> → <b>App</b> → <b>${env.kind === "ios-edge" ? "Edge" : "Firefox"}</b> → 打开 <b>麦克风</b>。`,
          "回到浏览器刷新页面，重新点开始并选 <b>允许</b>。",
          "还不行的话，建议用 <b>Safari</b> 打开（可以点下方“复制链接”）。",
        ],
      };
    case "chrome":
    case "edge":
      return {
        title: "麦克风被关闭了",
        steps: [
          "点地址栏左侧的 <b>锁/设置图标</b> → 把 <b>麦克风</b> 改为 <b>允许</b>。",
          "Mac 用户还要检查：<b>系统设置</b> → <b>隐私与安全性</b> → <b>麦克风</b> → 勾选浏览器。",
          "刷新页面后再点“我已开启，重试”。",
        ],
      };
    case "safari":
      return {
        title: "麦克风被关闭了（Safari）",
        steps: [
          "菜单栏 <b>Safari</b> → <b>设置</b> → <b>网站</b> → <b>麦克风</b> → 本网站改为 <b>允许</b>。",
          "并检查 <b>系统设置</b> → <b>隐私与安全性</b> → <b>麦克风</b> → 勾选 Safari。",
          "刷新页面后再点“我已开启，重试”。",
        ],
      };
    default:
      return {
        title: "麦克风被关闭了",
        steps: [
          "在浏览器的网站设置里，允许本网站使用 <b>麦克风</b>。",
          "在系统设置里，允许浏览器使用麦克风。",
          "刷新页面后再点“我已开启，重试”。",
        ],
      };
  }
}

function content(env, s) {
  const err = s.err ? `<p class="mic-err">错误信息：${escapeHtml(s.err.name || "")} ${escapeHtml(s.err.message || "")}</p>` : "";
  const headphones = env.isIPhone ? `<p class="mic-tip">🎧 建议戴耳机，效果更好（iPhone 外放时声音可能从听筒出来）。</p>` : "";
  switch (s.kind) {
    case "explain":
      return {
        title: "🎙️ 需要使用麦克风",
        body: `<p>需要使用麦克风来听你说英语。</p>
          <p class="muted">${s.again ? "浏览器需要再次确认一下。" : "点下面的按钮后，浏览器会弹出授权提示，请选择 <b>允许</b>。"}录音只用于这次练习的对话和老师点评，保存在你自己的设备上。</p>${headphones}`,
        primary: "允许麦克风",
        copy: false,
      };
    case "denied": {
      const d = deniedSteps(env);
      return {
        title: `🔇 ${d.title}`,
        body: `<p>没有麦克风权限，无法和对方对话。请按下面步骤开启：</p><ol class="mic-steps">${d.steps.map((x) => `<li>${x}</li>`).join("")}</ol>${err}`,
        primary: "我已开启，重试",
        copy: true,
      };
    }
    case "inapp":
      return {
        title: `🌐 请在浏览器中打开`,
        body: `<p>${escapeHtml(env.inApp || "当前 App")}内置的浏览器不能使用麦克风。</p>
          <ol class="mic-steps"><li>点右上角 <b>…</b>（或 <b>⋯</b>）→ <b>在浏览器中打开</b>${env.ios ? "（Safari）" : ""}。</li>
          <li>或者点下方 <b>复制链接</b>，粘贴到 ${env.ios ? "Safari / Chrome" : "Chrome / 系统浏览器"} 里打开。</li></ol>${err}`,
        primary: "重试",
        copy: true,
      };
    case "notfound":
      return {
        title: "🎤 没有找到麦克风",
        body: `<p>没有检测到可用的麦克风。请检查：</p><ol class="mic-steps"><li>耳机/麦克风是否插好、蓝牙耳机是否已连接。</li><li>电脑上是否在系统设置里关闭了输入设备。</li></ol>${err}`,
        primary: "重试",
        copy: true,
      };
    case "busy":
      return {
        title: "📞 麦克风正被占用",
        body: `<p>麦克风可能正在被其他 App 使用（比如正在通话、语音消息、录音、视频会议）。</p><ol class="mic-steps"><li>先结束通话或关闭正在录音的 App。</li><li>回到这里点“重试”。</li></ol>${err}`,
        primary: "重试",
        copy: true,
      };
    case "unsupported":
      return {
        title: "⚠️ 当前浏览器不能使用麦克风",
        body: `<p>请用 <b>Safari</b> 或 <b>Chrome</b> 打开本页面的 <b>https</b> 链接。</p>
          <ol class="mic-steps"><li>${location.protocol !== "https:" && location.hostname !== "localhost" && location.hostname !== "127.0.0.1" ? "当前不是 https 链接，浏览器会禁止麦克风。" : "当前浏览器不支持网页录音。"}</li>
          <li>iPhone 上的 Chrome 需要 <b>iOS 14.3 或以上</b>；更旧的系统请用 Safari。</li></ol>${err}`,
        primary: "重试",
        copy: true,
      };
    case "ended":
      return {
        title: "🎙️ 麦克风断开了",
        body: `<p>${escapeHtml(s.reason || "麦克风被系统中断了（比如来电、切换了 App 或拔掉了耳机）。")}</p><p class="muted">点下面的按钮恢复，继续刚才的对话。</p>`,
        primary: "恢复麦克风",
        copy: false,
      };
    default:
      return {
        title: "⚠️ 无法打开麦克风",
        body: `<p>打开麦克风时出了问题，可以重试一次；如果一直失败，换用 Safari 或 Chrome 打开。</p>${err}`,
        primary: "重试",
        copy: true,
      };
  }
}

async function copyLink(btn) {
  const url = location.href.split("#")[0];
  let ok = false;
  try {
    await navigator.clipboard.writeText(url);
    ok = true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = url;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, url.length);
      ok = document.execCommand("copy");
      ta.remove();
    } catch {}
  }
  btn.textContent = ok ? "✅ 已复制" : url;
  setTimeout(() => (btn.textContent = "复制链接"), 2500);
}

class MicDialog extends HTMLElement {
  connectedCallback() {
    lockScroll();
    this._locked = true;
  }

  disconnectedCallback() {
    if (this._locked) unlockScroll();
    this._locked = false;
  }

  show(state) {
    this.state = state;
    const c = content(this.env || detectBrowser(), state);
    this.dataset.kind = state.kind;
    this.innerHTML = `
      <div class="modal-backdrop">
        <div class="modal glass-panel mic-modal" role="dialog" aria-label="${escapeHtml(c.title)}">
          <div class="modal-head">
            <h3>${c.title}</h3>
            <button class="icon-btn" data-mic="cancel" aria-label="关闭">✕</button>
          </div>
          <div class="modal-body">${c.body}</div>
          <div class="modal-foot">
            ${c.copy ? `<button class="small-btn" data-mic="copy">复制链接</button>` : ""}
            <button class="small-btn primary" data-mic="go">${c.primary}</button>
          </div>
        </div>
      </div>`;
    // 注意：用 onclick 直接调用，保证 getUserMedia 在用户手势里同步发起
    this.querySelector('[data-mic="go"]').onclick = () => this.onRequest && this.onRequest();
    this.querySelector('[data-mic="cancel"]').onclick = () => this.onCancel && this.onCancel();
    const cp = this.querySelector('[data-mic="copy"]');
    if (cp) cp.onclick = () => copyLink(cp);
  }

  busy(on) {
    const b = this.querySelector('[data-mic="go"]');
    if (!b) return;
    b.disabled = on;
    if (on) {
      b.dataset.label = b.textContent;
      b.textContent = "请在弹窗中选择“允许”…";
    } else if (b.dataset.label) b.textContent = b.dataset.label;
  }

  close() {
    this.remove();
  }
}
customElements.define("mic-dialog", MicDialog);

// ---------------- 页面切后台 / 轨道中断 ----------------
/**
 * 监听页面回到前台时 resume AudioContext；麦克风轨道 ended 时回调。
 * 返回取消监听的函数。
 */
export function watchAudioLifecycle({ getContexts, getStream, onTrackEnded }) {
  const resumeAll = () => {
    for (const ctx of getContexts() || []) {
      if (ctx && (ctx.state === "suspended" || ctx.state === "interrupted")) ctx.resume().catch(() => {});
    }
  };
  const onVis = () => {
    if (document.visibilityState !== "visible") return;
    resumeAll();
    const s = getStream();
    const t = s && s.getAudioTracks()[0];
    if (t && t.readyState === "ended") onTrackEnded && onTrackEnded();
  };
  document.addEventListener("visibilitychange", onVis);
  window.addEventListener("pageshow", onVis);
  let track = null;
  const onEnded = () => onTrackEnded && onTrackEnded();
  const bindTrack = () => {
    if (track) track.removeEventListener("ended", onEnded);
    const s = getStream();
    track = s && s.getAudioTracks()[0];
    if (track) track.addEventListener("ended", onEnded);
  };
  bindTrack();
  return {
    rebind: bindTrack,
    resumeAll,
    stop() {
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("pageshow", onVis);
      if (track) track.removeEventListener("ended", onEnded);
    },
  };
}
