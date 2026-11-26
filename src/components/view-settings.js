// 设置弹窗
import { getSettings, setSetting, LIVE_VOICES, TTS_VOICES, DEFAULTS } from "../lib/settings.js";
import { listModels, pickModels } from "../lib/gemini-rest.js";
import { escapeHtml } from "../lib/dom.js";

export function openSettings(opts = {}) {
  if (document.querySelector("view-settings")) return;
  const el = document.createElement("view-settings");
  el.firstRun = !!opts.firstRun;
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
          ${this.firstRun ? `<p class="note">欢迎！本工具直接在你的浏览器里调用 Google Gemini，需要你自己的 API Key（在 Google AI Studio 免费申请，按量计费/有免费额度）。</p>` : ""}

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
            <button class="small-btn" id="reset-models" type="button">恢复默认模型</button>
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
    };
    $("clear-key").onclick = () => {
      if (!confirm("确定清除本设备上保存的 API Key 吗？")) return;
      $("apiKey").value = "";
      setSetting("apiKey", "");
      $("test-status").textContent = "已清除。";
    };

    $("test").onclick = async () => {
      const key = $("apiKey").value.trim();
      const st = $("test-status");
      if (!key) {
        st.textContent = "请先填入 API Key";
        return;
      }
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
        if (!picked.live.length) notes.push("⚠️ 这个 Key 没有可用的 Live API 模型");
        st.innerHTML = `✅ Key 可用。找到 ${picked.live.length} 个实时对话模型。${notes.length ? "<br>" + notes.map(escapeHtml).join("<br>") : ""}<br>别忘了点“保存”。`;
      } catch (e) {
        st.textContent = `❌ ${e.message}`;
      }
    };

    $("save").onclick = () => {
      setSetting("apiKey", $("apiKey").value.trim());
      setSetting("teacherVoiceOn", $("teacherVoiceOn").checked);
      setSetting("teacherVoiceSource", $("teacherVoiceSource").value);
      setSetting("teacherVoice", $("teacherVoice").value);
      setSetting("characterVoice", $("characterVoice").value);
      setSetting("liveModel", $("liveModel").value.trim() || DEFAULTS.liveModel);
      setSetting("teacherModel", $("teacherModel").value.trim() || DEFAULTS.teacherModel);
      setSetting("ttsModel", $("ttsModel").value.trim() || DEFAULTS.ttsModel);
      close();
    };
  }
}

customElements.define("view-settings", ViewSettings);
