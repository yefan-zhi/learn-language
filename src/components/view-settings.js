// 设置弹窗
import { getSettings, setSetting, LIVE_VOICES, TTS_VOICES, DEFAULTS, authMode } from "../lib/settings.js";
import { getQuota, isUnlimited } from "../lib/relay.js";
import { relayConfigured } from "../lib/config.js";
import { listModels, pickModels } from "../lib/gemini-rest.js";
import { setManual } from "../lib/models.js";
import { escapeHtml } from "../lib/dom.js";

export function openSettings(opts = {}) {
  if (document.querySelector("view-settings")) return;
  const el = document.createElement("view-settings");
  el.firstRun = !!opts.firstRun;
  el.tab = opts.tab;
  document.body.appendChild(el);
}

class ViewSettings extends HTMLElement {
  connectedCallback() {
    const s = getSettings();
    const opt = (arr, cur) => arr.map((v) => `<option value="${v}" ${v === cur ? "selected" : ""}>${v}</option>`).join("");
    this.innerHTML = `
      <div class="modal-backdrop">
        <div class="modal glass-panel" role="dialog" aria-label="设置">
          <div class="modal-head">
            <h3>⚙️ 设置</h3>
            <button class="icon-btn" id="close" aria-label="关闭">✕</button>
          </div>
          <h4>🔑 接入方式</h4>
          <div class="segmented" id="auth-tabs">
            <button data-tab="invite" type="button">邀请码（用站长的额度）</button>
            <button data-tab="key" type="button">自己的 API Key</button>
          </div>
          <small class="opt-desc">同时填了两种时，优先使用自己的 Key。当前：<b id="auth-now"></b></small>

          <div id="panel-invite">
            <label class="field">
              <span>邀请码</span>
              <div class="row">
                <input id="inviteCode" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="朋友给你的邀请码" value="${escapeHtml(s.inviteCode)}">
                <button class="small-btn primary" id="check-invite" type="button">验证</button>
              </div>
              <small>${relayConfigured() ? "使用站长提供的额度（每台设备每天有分钟数上限）。" : "⚠️ 站长还没有部署中转服务，邀请码暂时不可用。"}</small>
            </label>
            <p class="status-line" id="invite-status"></p>
          </div>

          <div id="panel-key">
          ${this.firstRun ? `<p class="note">本工具直接在你的浏览器里调用 Google Gemini，需要你自己的 API Key（在 Google AI Studio 免费申请，有免费额度）。</p>` : ""}

          <label class="field">
            <span>Gemini API Key</span>
            <div class="row">
              <input id="apiKey" type="password" autocomplete="off" spellcheck="false" placeholder="AIza..." value="${escapeHtml(s.apiKey)}">
              <button class="small-btn" id="toggle-key" type="button">显示</button>
            </div>
            <small><a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">→ 在 Google AI Studio 获取 API Key</a></small>
          </label>
          <div class="row gap">
            <button class="small-btn primary" id="test">测试 Key 并检测可用模型</button>
          </div>
          <p class="status-line" id="test-status"></p>

          <details class="security">
            <summary>🔒 Key 安全说明（建议看一下）</summary>
            <ul>
              <li>Key 只保存在<b>这台设备的浏览器</b>里（localStorage），只会发送给 Google 的 API，不经过任何第三方服务器。</li>
              <li>建议在 <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noopener">Google Cloud 控制台 → 凭据</a> 里给这个 Key 加上“应用限制 → 网站（HTTP referrer）”，只允许 <code>https://yefan-zhi.github.io/*</code>，并把 API 限制为 Generative Language API。这样即使 Key 泄露也难以被滥用。</li>
              <li>在公用电脑上用完后，可以点下面的“清除 Key”。</li>
            </ul>
          </details>
          </div>

          <h4>🧑‍🏫 老师点评</h4>
          <label class="check"><input type="checkbox" id="teacherVoiceOn" ${s.teacherVoiceOn ? "checked" : ""}> 每句话后用中文语音点评（关闭后只显示文字）</label>
          <label class="field">
            <span>老师声音来源</span>
            <select id="teacherVoiceSource">
              <option value="gemini" ${s.teacherVoiceSource === "gemini" ? "selected" : ""}>Gemini 语音（更自然，稍慢）</option>
              <option value="browser" ${s.teacherVoiceSource === "browser" ? "selected" : ""}>设备自带语音（更快、免费）</option>
            </select>
          </label>
          <label class="field">
            <span>老师音色（Gemini）</span>
            <select id="teacherVoice">${opt(TTS_VOICES, s.teacherVoice)}</select>
          </label>

          <h4>🎭 对话角色</h4>
          <label class="field">
            <span>角色音色</span>
            <select id="characterVoice">${opt(LIVE_VOICES, s.characterVoice)}</select>
          </label>

          <details class="advanced">
            <summary>高级：模型选择</summary>
            <label class="field">
              <span>实时对话模型（Live API）</span>
              <input id="liveModel" list="live-models" value="${escapeHtml(s.liveModel)}" spellcheck="false">
              <datalist id="live-models"></datalist>
            </label>
            <label class="field">
              <span>老师分析模型（需支持音频输入）</span>
              <input id="teacherModel" list="text-models" value="${escapeHtml(s.teacherModel)}" spellcheck="false">
              <datalist id="text-models"></datalist>
            </label>
            <label class="field">
              <span>语音合成模型（TTS）</span>
              <input id="ttsModel" list="tts-models" value="${escapeHtml(s.ttsModel)}" spellcheck="false">
              <datalist id="tts-models"></datalist>
            </label>
            <div class="row gap">
              <button class="small-btn" id="reset-models" type="button">恢复默认模型</button>
              <button class="small-btn" id="detect-invite" type="button">通过邀请码检测模型</button>
            </div>
            <p class="status-line" id="detect-status"></p>
          </details>

          <div class="modal-foot">
            <button class="small-btn danger" id="clear-key" type="button">清除 Key</button>
            <button class="small-btn primary" id="save">保存</button>
          </div>
        </div>
      </div>
    `;

    const $ = (id) => this.querySelector(`#${id}`);
    const close = () => this.remove();

    // 接入方式切换
    const modeLabel = { key: "自己的 API Key", invite: "邀请码", null: "未设置" };
    const refreshNow = () => {
      const k = $("apiKey").value.trim();
      const inv = $("inviteCode").value.trim();
      $("auth-now").textContent = k ? modeLabel.key : inv ? modeLabel.invite : modeLabel.null;
    };
    const showTab = (tab) => {
      this.querySelectorAll("#auth-tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
      $("panel-invite").hidden = tab !== "invite";
      $("panel-key").hidden = tab !== "key";
    };
    this.querySelectorAll("#auth-tabs button").forEach((b) => (b.onclick = () => showTab(b.dataset.tab)));
    showTab(this.tab || (authMode() === "key" ? "key" : relayConfigured() ? "invite" : "key"));
    refreshNow();
    $("apiKey").addEventListener("input", refreshNow);
    $("inviteCode").addEventListener("input", refreshNow);
    $("check-invite").onclick = async () => {
      const code = $("inviteCode").value.trim();
      const st = $("invite-status");
      if (!code) {
        st.textContent = "请先输入邀请码";
        return;
      }
      st.textContent = "验证中…";
      try {
        const q = await getQuota(code);
        st.textContent = isUnlimited(q)
          ? "✅ 邀请码有效。别忘了点“保存”。"
          : `✅ 邀请码有效，今天还可以练习 ${q.remainingMinutes} 分钟。别忘了点“保存”。`;
      } catch (e) {
        st.textContent = `❌ ${e.message}`;
      }
    };
    $("close").onclick = close;
    this.querySelector(".modal-backdrop").addEventListener("click", (e) => {
      if (e.target.classList.contains("modal-backdrop")) close();
    });
    $("toggle-key").onclick = () => {
      const i = $("apiKey");
      i.type = i.type === "password" ? "text" : "password";
      $("toggle-key").textContent = i.type === "password" ? "显示" : "隐藏";
    };
    $("reset-models").onclick = () => {
      $("liveModel").value = DEFAULTS.liveModel;
      $("teacherModel").value = DEFAULTS.teacherModel;
      $("ttsModel").value = DEFAULTS.ttsModel;
      ["live", "text", "tts"].forEach((k) => setManual(k, false)); // 恢复自动选择
    };
    $("clear-key").onclick = () => {
      if (!confirm("确定清除本设备上保存的 API Key 吗？")) return;
      $("apiKey").value = "";
      setSetting("apiKey", "");
      $("test-status").textContent = "已清除。";
    };

    const detect = async (key, st) => {
      st.textContent = "检测中…";
      try {
        const models = await listModels(key);
        const picked = pickModels(models);
        const fill = (id, arr) => ($(id).innerHTML = arr.map((m) => `<option value="${m}">`).join(""));
        fill("live-models", picked.live);
        fill("text-models", picked.text);
        fill("tts-models", picked.tts);
        const notes = [];
        const liveNow = $("liveModel").value.trim();
        if (picked.live.length && !picked.live.includes(liveNow)) {
          $("liveModel").value = picked.live[0];
          notes.push(`实时对话模型已切换为 ${picked.live[0]}`);
        }
        if (picked.tts.length && !picked.tts.includes($("ttsModel").value.trim())) {
          $("ttsModel").value = picked.tts.find((m) => /flash/.test(m)) || picked.tts[0];
          notes.push(`语音模型已切换为 ${$("ttsModel").value}`);
        }
        if (picked.text.length && !picked.text.includes($("teacherModel").value.trim())) {
          $("teacherModel").value = picked.text.find((m) => /flash/.test(m) && !/lite/.test(m)) || picked.text[0];
          notes.push(`老师模型已切换为 ${$("teacherModel").value}`);
        }
        if (!picked.live.length) notes.push("⚠️ 没有可用的 Live API 模型");
        st.innerHTML = `✅ 可用。找到 ${picked.live.length} 个实时对话模型。${notes.length ? "<br>" + notes.map(escapeHtml).join("<br>") : ""}<br>别忘了点“保存”。`;
      } catch (e) {
        st.textContent = `❌ ${e.message}`;
      }
    };

    $("test").onclick = () => {
      const key = $("apiKey").value.trim();
      const st = $("test-status");
      if (!key) {
        st.textContent = "请先填入 API Key";
        return;
      }
      detect(key, st);
    };

    $("detect-invite").onclick = () => {
      const code = $("inviteCode").value.trim();
      const st = $("detect-status");
      if (!code) {
        st.textContent = "请先在上面填入邀请码";
        return;
      }
      setSetting("inviteCode", code);
      detect(undefined, st);
    };

    $("save").onclick = () => {
      setSetting("apiKey", $("apiKey").value.trim());
      setSetting("inviteCode", $("inviteCode").value.trim());
      setSetting("teacherVoiceOn", $("teacherVoiceOn").checked);
      setSetting("teacherVoiceSource", $("teacherVoiceSource").value);
      setSetting("teacherVoice", $("teacherVoice").value);
      setSetting("characterVoice", $("characterVoice").value);
      // 用户改动过的模型记为“手动指定”（自动选择不再覆盖，除非它确定不可用）
      for (const [kind, id] of [["live", "liveModel"], ["text", "teacherModel"], ["tts", "ttsModel"]]) {
        const v = $(id).value.trim() || DEFAULTS[id];
        if (v !== s[id]) setManual(kind, v !== DEFAULTS[id]);
        setSetting(id, v);
      }
      close();
    };
  }
}

customElements.define("view-settings", ViewSettings);
