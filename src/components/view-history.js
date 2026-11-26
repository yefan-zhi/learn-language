import { listSessions, getSession } from "../lib/history.js";
import { ACCENTS } from "../lib/settings.js";
import { escapeHtml } from "../lib/dom.js";

class ViewHistory extends HTMLElement {
  async connectedCallback() {
    this.innerHTML = `<div class="container wide"><h2 class="section-title">🕘 练习记录</h2><div id="list"><p class="muted">加载中…</p></div></div>`;
    const list = await listSessions();
    const box = this.querySelector("#list");
    if (!list.length) {
      box.innerHTML = `<p class="muted">还没有练习记录。记录只保存在这台设备的浏览器里。</p>
        <button class="cta-btn" id="go">去练习</button>`;
      box.querySelector("#go").onclick = () => this.nav({ view: "missions" });
      return;
    }
    box.innerHTML = list
      .map((r) => {
        const d = new Date(r.startedAt).toLocaleString("zh-CN", { year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
        return `<button class="card history-item" data-id="${escapeHtml(r.id)}">
          <span class="hi-icon">${r.mission?.icon || "📜"}</span>
          <span class="hi-main"><b>${escapeHtml(r.mission?.title_zh || "")}</b><small>${d} · ${(ACCENTS[r.accent] || ACCENTS.us).short} · ${r.count} 句</small></span>
          <span class="hi-score">${r.score ?? ""}</span>
        </button>`;
      })
      .join("") + `<p class="muted small">记录只保存在本设备浏览器中。</p>`;
    box.querySelectorAll(".history-item").forEach((b) => {
      b.onclick = async () => {
        const s = await getSession(b.dataset.id);
        if (s) this.nav({ view: "summary", session: s });
      };
    });
  }

  nav(detail) {
    this.dispatchEvent(new CustomEvent("navigate", { bubbles: true, detail }));
  }
}

customElements.define("view-history", ViewHistory);
