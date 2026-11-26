/**
 * 应用外壳：头部（历史 / 设置 / 主题）+ 视图切换
 * 基于 Google LLC 的 Immergo（Apache-2.0）改写。
 */
import "./view-splash.js";
import "./view-missions.js";
import "./view-chat.js";
import "./view-summary.js";
import "./view-history.js";
import { openSettings } from "./view-settings.js";
import { hasAccess } from "../lib/settings.js";
import { relayConfigured } from "../lib/config.js";
import { openInvite } from "./view-invite.js";

class AppRoot extends HTMLElement {
  constructor() {
    super();
    this.state = { view: "splash", detail: {} };
  }

  connectedCallback() {
    this.innerHTML = "";
    this.currentTheme = safeGet("theme") || "system";
    this.mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    this.mediaQuery.addEventListener("change", () => {
      if (this.currentTheme === "system") this.applyTheme("system");
    });
    this.applyTheme(this.currentTheme);

    const header = document.createElement("header");
    header.className = "app-header";
    header.innerHTML = `
      <button class="brand" id="go-home" aria-label="首页">🗣️ <span>英语口语陪练</span></button>
      <div class="header-actions">
        <button class="icon-btn" id="btn-history" title="练习记录" aria-label="练习记录">🕘</button>
        <button class="icon-btn" id="btn-settings" title="设置" aria-label="设置">⚙️</button>
        <button class="icon-btn" id="theme-toggle" title="主题" aria-label="切换主题"><span class="theme-icon"></span></button>
      </div>
    `;
    this.appendChild(header);
    this.header = header;

    header.querySelector("#go-home").onclick = () => this.go({ view: "splash" });
    header.querySelector("#btn-history").onclick = () => this.go({ view: "history" });
    header.querySelector("#btn-settings").onclick = () => openSettings();
    this.themeBtn = header.querySelector("#theme-toggle");
    this.themeBtn.onclick = () => this.cycleTheme();
    this.updateThemeBtnIcon();

    this.viewContainer = document.createElement("main");
    this.viewContainer.className = "view-container";
    this.appendChild(this.viewContainer);

    this.addEventListener("navigate", (e) => this.go(e.detail));
    this.render();

    if (!hasAccess()) setTimeout(() => (relayConfigured() ? openInvite() : openSettings({ firstRun: true })), 400);
  }

  go(detail) {
    // 正在通话时离开页面要确认
    const chat = this.viewContainer.querySelector("view-chat");
    if (chat && chat.isActive && chat.isActive() && detail.view !== "summary") {
      if (!confirm("正在练习中，确定要离开吗？本次对话不会保存。")) return;
    }
    this.state = { view: detail.view, detail };
    this.render();
    window.scrollTo(0, 0);
  }

  render() {
    if (!this.viewContainer) return;
    this.viewContainer.innerHTML = "";
    const { view, detail } = this.state;
    let el;
    switch (view) {
      case "missions":
        el = document.createElement("view-missions");
        break;
      case "chat":
        el = document.createElement("view-chat");
        el.config = detail.config;
        break;
      case "summary":
        el = document.createElement("view-summary");
        el.session = detail.session;
        break;
      case "history":
        el = document.createElement("view-history");
        break;
      default:
        el = document.createElement("view-splash");
    }
    this.header.classList.toggle("compact", view === "chat");
    el.classList.add("fade-in");
    this.viewContainer.appendChild(el);
  }

  applyTheme(theme) {
    const light = theme === "system" ? !window.matchMedia("(prefers-color-scheme: dark)").matches : theme === "light";
    document.body.classList.toggle("light-mode", light);
  }

  cycleTheme() {
    const modes = ["dark", "light", "system"];
    const i = modes.indexOf(this.currentTheme);
    this.currentTheme = modes[(i + 1) % modes.length];
    safeSet("theme", this.currentTheme);
    this.applyTheme(this.currentTheme);
    this.updateThemeBtnIcon();
  }

  updateThemeBtnIcon() {
    const map = { light: ["☀️", "浅色"], dark: ["🌙", "深色"], system: ["💻", "跟随系统"] };
    const [icon, title] = map[this.currentTheme] || map.system;
    this.themeBtn.querySelector(".theme-icon").textContent = icon;
    this.themeBtn.title = `主题：${title}`;
  }
}

function safeGet(k) {
  try { return localStorage.getItem(k); } catch { return null; }
}
function safeSet(k, v) {
  try { localStorage.setItem(k, v); } catch {}
}

customElements.define("app-root", AppRoot);
