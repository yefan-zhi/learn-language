import missionsData from "../data/missions.json";
import { getSetting, setSetting, ACCENTS, LEVELS, hasAccess, authMode } from "../lib/settings.js";
import { escapeHtml } from "../lib/dom.js";
import { openSettings } from "./view-settings.js";
import { openInvite } from "./view-invite.js";
import { relayConfigured } from "../lib/config.js";
import { getQuota, isUnlimited } from "../lib/relay.js";

const DIFF = {
  Easy: ["简单", "#8bc34a"],
  Medium: ["中等", "#ffc107"],
  Hard: ["较难", "#ff9800"],
  Expert: ["挑战", "#f44336"],
  Free: ["自由", "#64b5f6"],
};

const MODES = {
  immersive: { label: "🎭 沉浸模式", desc: "角色全程只说英语" },
  assisted: { label: "🤝 辅助模式", desc: "卡住时角色会给简短提示" },
};

class ViewMissions extends HTMLElement {
  connectedCallback() {
    const seg = (name, obj, cur) =>
      `<div class="segmented" data-name="${name}">${Object.entries(obj)
        .map(([k, v]) => `<button data-val="${k}" class="${k === cur ? "active" : ""}">${v.label}</button>`)
        .join("")}</div>`;

    this.innerHTML = `
      <div class="container wide">
        <div class="panel glass-panel options">
          <div class="opt">
            <label>口音</label>
            ${seg("accent", ACCENTS, getSetting("accent"))}
          </div>
          <div class="opt">
            <label>难度</label>
            ${seg("level", LEVELS, getSetting("level"))}
          </div>
          <div class="opt">
            <label>模式</label>
            ${seg("mode", MODES, getSetting("mode"))}
            <small class="opt-desc" id="mode-desc"></small>
          </div>
          <div class="opt">
            <label>逐句模式</label>
            <div class="opt-switch">
              <div class="segmented" id="step-seg">
                <button data-val="on" class="${getSetting("stepMode") ? "active" : ""}">开</button>
                <button data-val="off" class="${getSetting("stepMode") ? "" : "active"}">关</button>
              </div>
            </div>
            <small class="opt-desc">开启后，每说完一句先看老师点评，点“下一句”后对方才回应，不满意可以“重说”；对话中也可以随时切换。</small>
          </div>
          <div class="opt">
            <label>单模型模式</label>
            <div class="opt-switch">
              <div class="segmented" id="single-seg">
                <button data-val="on" class="${getSetting("singleModelMode") ? "active" : ""}">开</button>
                <button data-val="off" class="${getSetting("singleModelMode") ? "" : "active"}">关</button>
              </div>
            </div>
            <small class="opt-desc">角色和老师由同一个实时模型担任，点评更快，但会共用一个声音（实验功能，下次开始对话时生效）。</small>
          </div>
          <div class="opt">
            <label>老师点评语言</label>
            <div class="opt-switch">
              <div class="segmented" id="tlang-seg">
                <button data-val="zh" class="${getSetting("teacherLanguage") === "en" ? "" : "active"}">中文</button>
                <button data-val="en" class="${getSetting("teacherLanguage") === "en" ? "active" : ""}">English</button>
              </div>
            </div>
            <small class="opt-desc">选 English 时，老师用简单清楚的英文点评和朗读（按所选口音），课后总结也用英文。</small>
          </div>
        </div>

        <p class="quota-line" id="quota-line" hidden></p>
        <h2 class="section-title">选择一个场景</h2>
        <div class="mission-grid"></div>
      </div>
    `;

    const updateModeDesc = () => {
      this.querySelector("#mode-desc").textContent = MODES[getSetting("mode")]?.desc || "";
    };
    updateModeDesc();

    this.querySelector("#tlang-seg").addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      this.querySelectorAll("#tlang-seg button").forEach((x) => x.classList.toggle("active", x === b));
      setSetting("teacherLanguage", b.dataset.val);
    });

    this.querySelector("#single-seg").addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      this.querySelectorAll("#single-seg button").forEach((x) => x.classList.toggle("active", x === b));
      setSetting("singleModelMode", b.dataset.val === "on");
    });

    this.querySelector("#step-seg").addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      this.querySelectorAll("#step-seg button").forEach((x) => x.classList.toggle("active", x === b));
      setSetting("stepMode", b.dataset.val === "on");
    });

    this.querySelectorAll(".segmented[data-name]").forEach((segEl) => {
      segEl.addEventListener("click", (e) => {
        const b = e.target.closest("button");
        if (!b) return;
        segEl.querySelectorAll("button").forEach((x) => x.classList.toggle("active", x === b));
        setSetting(segEl.dataset.name, b.dataset.val);
        if (segEl.dataset.name === "mode") updateModeDesc();
        if (segEl.dataset.name === "accent") this.renderMissions();
      });
    });

    this.renderMissions();
    this.showQuota();
  }

  /** 邀请码模式下显示今日剩余分钟数 */
  showQuota() {
    const el = this.querySelector("#quota-line");
    if (!el || authMode() !== "invite") return;
    getQuota()
      .then((q) => {
        if (isUnlimited(q)) {
          el.hidden = true; // 不限额度时不显示
          return;
        }
        el.hidden = false;
        el.classList.toggle("empty", q.remainingMinutes < 1);
        el.textContent =
          q.remainingMinutes < 1
            ? "🎟️ 今天的练习额度已经用完了，明天再来吧～"
            : `🎟️ 邀请码额度：今天还可以练习 ${q.remainingMinutes} 分钟（单次最多 ${Math.min(q.remainingMinutes, q.sessionMaxMinutes)} 分钟）`;
      })
      .catch((e) => {
        el.hidden = false;
        el.textContent = `🎟️ ${e.message}`;
      });
  }

  renderMissions() {
    const grid = this.querySelector(".mission-grid");
    const accent = ACCENTS[getSetting("accent")] || ACCENTS.us;
    grid.innerHTML = "";
    missionsData.forEach((m) => {
      const [dl, dc] = DIFF[m.difficulty] || DIFF.Medium;
      const card = document.createElement("div");
      card.className = "card mission-card";
      card.tabIndex = 0;
      card.innerHTML = `
        <div class="mc-top">
          <div class="mc-icon">${m.icon}</div>
          <span class="badge" style="background:${dc}22;color:${dc};border-color:${dc}55">${dl}</span>
        </div>
        <h3>${escapeHtml(m.title_zh)}</h3>
        <div class="mc-en">${escapeHtml(m.title_en)}</div>
        <p>${escapeHtml(m.desc_zh)}</p>
        ${m.custom ? `<input class="topic-input" placeholder="话题（可选），如：聊聊周末、旅行计划、我的工作…" maxlength="120">` : ""}
        <div class="mc-role">对方：${escapeHtml(m.role_zh)} · ${accent.city}</div>
      `;
      const start = () => {
        if (!hasAccess()) {
          relayConfigured() ? openInvite() : openSettings({ firstRun: true });
          return;
        }
        const topic = m.custom ? (card.querySelector(".topic-input").value || "").trim() : "";
        this.dispatchEvent(
          new CustomEvent("navigate", {
            bubbles: true,
            detail: {
              view: "chat",
              config: {
                mission: m,
                topic,
                accent: getSetting("accent"),
                level: getSetting("level"),
                mode: getSetting("mode"),
              },
            },
          })
        );
      };
      card.addEventListener("click", (e) => {
        if (e.target.classList.contains("topic-input")) return;
        start();
      });
      card.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.target.classList.contains("topic-input")) start();
      });
      const ti = card.querySelector(".topic-input");
      if (ti) ti.addEventListener("keydown", (e) => e.key === "Enter" && start());
      grid.appendChild(card);
    });
  }
}

customElements.define("view-missions", ViewMissions);
