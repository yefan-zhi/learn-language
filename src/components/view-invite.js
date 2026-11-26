// 首次使用：输入邀请码（使用站长的额度）
import { setSetting, getSetting } from "../lib/settings.js";
import { getQuota, isUnlimited } from "../lib/relay.js";
import { openSettings } from "./view-settings.js";
import { escapeHtml, lockScroll, unlockScroll } from "../lib/dom.js";

export function openInvite() {
  if (document.querySelector("view-invite") || document.querySelector("view-settings")) return;
  document.body.appendChild(document.createElement("view-invite"));
}

class ViewInvite extends HTMLElement {
  disconnectedCallback() {
    unlockScroll();
  }

  connectedCallback() {
    lockScroll();
    this.innerHTML = `
      <div class="modal-backdrop">
        <div class="modal glass-panel invite-modal" role="dialog" aria-label="输入邀请码">
          <div class="modal-head">
            <h3>🎟️ 输入邀请码</h3>
            <button class="icon-btn" id="close" aria-label="关闭">✕</button>
          </div>
          <div class="modal-body">
          <p class="note">朋友给你的邀请码，相当于进门密码。输入后就能直接开始练习，不需要自己申请 API Key。</p>
          <label class="field">
            <span>邀请码</span>
            <div class="row">
              <input id="invite" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="请输入邀请码" value="${escapeHtml(getSetting("inviteCode"))}">
              <button class="small-btn primary" id="ok">确定</button>
            </div>
          </label>
          <p class="status-line" id="status"></p>
          <p class="hint invite-alt">我有自己的 Gemini API Key？<a href="#" id="own-key">用自己的 Key →</a></p>
          </div>
        </div>
      </div>
    `;
    const $ = (id) => this.querySelector(`#${id}`);
    const close = () => this.remove();
    $("close").onclick = close;
    $("own-key").onclick = (e) => {
      e.preventDefault();
      close();
      openSettings({ firstRun: true, tab: "key" });
    };
    const submit = async () => {
      const code = $("invite").value.trim();
      const st = $("status");
      if (!code) {
        st.textContent = "请先输入邀请码";
        return;
      }
      st.textContent = "验证中…";
      $("ok").disabled = true;
      try {
        const q = await getQuota(code);
        setSetting("inviteCode", code);
        st.style.color = "var(--color-success)";
        st.textContent = isUnlimited(q) ? "✅ 邀请码有效" : `✅ 邀请码有效，今天还可以练习 ${q.remainingMinutes} 分钟`;
        setTimeout(close, 900);
      } catch (e) {
        st.style.color = "var(--color-danger)";
        st.textContent = `❌ ${e.message}`;
      } finally {
        $("ok").disabled = false;
      }
    };
    $("ok").onclick = submit;
    $("invite").addEventListener("keydown", (e) => {
      if (e.key === "Enter") submit();
    });
    setTimeout(() => $("invite").focus(), 50);
  }
}

customElements.define("view-invite", ViewInvite);
