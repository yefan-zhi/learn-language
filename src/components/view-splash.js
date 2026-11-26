import { hasApiKey } from "../lib/settings.js";
import { openSettings } from "./view-settings.js";

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
      </div>
    `;
    const hint = this.querySelector("#key-hint");
    const refresh = () => {
      hint.innerHTML = hasApiKey()
        ? "已设置 Gemini API Key ✓"
        : `首次使用需要填入你自己的 <a href="#" id="set-key">Gemini API Key</a>（免费申请）`;
      const a = this.querySelector("#set-key");
      if (a) a.onclick = (e) => { e.preventDefault(); openSettings({ firstRun: true }); };
    };
    refresh();
    this._onSettings = refresh;
    window.addEventListener("settings-changed", refresh);

    this.querySelector("#start").onclick = () => {
      if (!hasApiKey()) {
        openSettings({ firstRun: true });
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
