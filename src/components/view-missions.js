import missionsData from "../data/missions.json";
import { getSetting, setSetting, ACCENTS, LEVELS, hasApiKey } from "../lib/settings.js";
import { escapeHtml } from "../lib/dom.js";
import { openSettings } from "./view-settings.js";

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
        </div>

        <h2 class="section-title">选择一个场景</h2>
        <div class="mission-grid"></div>
      </div>
    `;

    const updateModeDesc = () => {
      this.querySelector("#mode-desc").textContent = MODES[getSetting("mode")]?.desc || "";
    };
    updateModeDesc();

    this.querySelectorAll(".segmented").forEach((segEl) => {
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
        if (!hasApiKey()) {
          openSettings({ firstRun: true });
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
