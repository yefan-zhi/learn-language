import "./style.css";
import "./components/app-root.js";

document.querySelector("#app").innerHTML = `<app-root></app-root>`;

// 自动选择可用的最新模型（每天最多查一次；旧默认值/停用模型会自动迁移）
import { autoSelectModels } from "./lib/models.js";
import { listModels } from "./lib/gemini-rest.js";
import { hasAccess } from "./lib/settings.js";

let selecting = false;
function selectModels() {
  if (!hasAccess() || selecting) return;
  selecting = true;
  autoSelectModels(() => listModels())
    .then((changes) => changes.length && console.info("模型已自动更新：", changes))
    .finally(() => (selecting = false));
}
selectModels();
window.addEventListener("settings-changed", (e) => {
  if (e.detail?.key === "apiKey" || e.detail?.key === "inviteCode") selectModels();
});
