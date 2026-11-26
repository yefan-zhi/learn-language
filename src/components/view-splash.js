import { detectBrowser } from "../lib/mic-permission.js";
import { authMode, hasAccess } from "../lib/settings.js";
import { openSettings } from "./view-settings.js";
import { openInvite } from "./view-invite.js";
import { relayConfigured } from "../lib/config.js";
import { getQuota, isUnlimited } from "../lib/relay.js";

class ViewSplash extends HTMLElement {
  connectedCallback() {
    this.innerHTML = `
      <div class="container splash">
        <div class="splash-hero">
          <div class="splash-emoji">🗣️🇺🇸🇬🇧</div>
          <h1>用中文学地道英语口语</h1>
          <p class="lead">和 AI 扮演的英语母语者进行真实情景对话。<br>每说完一句，旁边的<strong>中文老师</strong>会点评你的表达是否地道、发音和语调哪里需要改。</p>
        </div>

        <ul class="feature-list">
          <li><span>🎭</span><div><b>情景角色扮演</b><small>点咖啡、问路、看医生、面试……可选美式或英式口音</small></div></li>
          <li><span>🧑‍🏫</span><div><b>中文老师实时点评</b><small>每句话后用中文语音告诉你哪里说得好、哪里要改</small></div></li>
          <li><span>📋</span><div><b>课后总结</b><small>逐句回放你的录音，对照问题、地道说法和老师语音</small></div></li>
        </ul>

        <button class="cta-btn" id="start">开始练习</button>
        <p class="hint" id="key-hint"></p>
        ${detectBrowser().isIPhone ? `<p class="hint">🎧 建议戴耳机，效果更好</p>` : ""}
      </div>
    `;
    const hint = this.querySelector("#key-hint");
    const askAccess = () => (relayConfigured() ? openInvite() : openSettings({ firstRun: true }));
    const refresh = () => {
      const mode = authMode();
      if (mode === "key") {
        hint.innerHTML = "使用自己的 Gemini API Key ✓";
      } else if (mode === "invite") {
        hint.innerHTML = "使用邀请码 ✓ <span id=\"quota\"></span>";
        getQuota()
          .then((q) => {
            const el = this.querySelector("#quota");
            if (el) el.textContent = isUnlimited(q) ? "" : `· 今天还可以练习 ${q.remainingMinutes} 分钟`;
          })
          .catch((e) => {
            const el = this.querySelector("#quota");
            if (el) el.textContent = `· ${e.message}`;
          });
      } else {
        hint.innerHTML = relayConfigured()
          ? `首次使用请 <a href="#" id="set-invite">输入邀请码</a>，或者 <a href="#" id="set-key">用自己的 Gemini API Key</a>`
          : `首次使用需要填入你自己的 <a href="#" id="set-key">Gemini API Key</a>（免费申请）`;
      }
      const a = this.querySelector("#set-key");
      if (a) a.onclick = (e) => { e.preventDefault(); openSettings({ firstRun: true, tab: "key" }); };
      const b = this.querySelector("#set-invite");
      if (b) b.onclick = (e) => { e.preventDefault(); openInvite(); };
    };
    refresh();
    this._onSettings = refresh;
    window.addEventListener("settings-changed", refresh);

    this.querySelector("#start").onclick = () => {
      if (!hasAccess()) {
        askAccess();
        return;
      }
      this.dispatchEvent(new CustomEvent("navigate", { bubbles: true, detail: { view: "missions" } }));
    };
  }

  disconnectedCallback() {
    window.removeEventListener("settings-changed", this._onSettings);
  }
}

customElements.define("view-splash", ViewSplash);
