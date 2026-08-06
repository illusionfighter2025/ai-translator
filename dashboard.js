// AI Translator dashboard logic
const $ = (id) => document.getElementById(id);

const els = {
  // config
  apiKey: $("apiKey"), baseUrl: $("baseUrl"), model: $("model"),
  temperature: $("temperature"), maxTokens: $("maxTokens"),
  revealKey: $("revealKey"), saveBtn: $("saveBtn"), testBtn: $("testBtn"),
  statusMsg: $("statusMsg"),
  // language
  sourceBtns: document.querySelectorAll("#panel-language .field:nth-child(1) .seg-btn"),
  targetBtns: document.querySelectorAll("#panel-language .field:nth-child(3) .seg-btn"),
  autoSelection: $("autoSelection"), saveLangBtn: $("saveLangBtn"), langStatus: $("langStatus"),
  // stats
  statRequests: $("statRequests"), statTotal: $("statTotal"),
  statPrompt: $("statPrompt"), statCompletion: $("statCompletion"),
  breakdownKind: $("breakdownKind"), breakdownModel: $("breakdownModel"),
  resetStatsBtn: $("resetStatsBtn"),
  // history
  historyList: $("historyList"), historyEmpty: $("historyEmpty"),
  historySearch: $("historySearch"), clearHistoryBtn: $("clearHistoryBtn"),
  // tabs
  tabs: document.querySelectorAll(".tab"), panels: document.querySelectorAll(".panel")
};

const KIND_LABELS = { selection: "划词翻译", page: "整页翻译", summary: "网页总结", chat: "对话" };
let langState = { sourceLang: "auto", targetLang: "zh", autoSelection: true };
let allHistory = [];

// ---------- Tabs ----------
els.tabs.forEach(t => t.addEventListener("click", () => {
  els.tabs.forEach(x => x.classList.remove("active"));
  els.panels.forEach(p => p.classList.remove("active"));
  t.classList.add("active");
  $("panel-" + t.dataset.tab).classList.add("active");
  if (t.dataset.tab === "stats") loadStats();
  if (t.dataset.tab === "history") loadHistory();
}));

// ---------- Settings load ----------
async function loadSettings() {
  const res = await chrome.runtime.sendMessage({ type: "getSettings" });
  if (!res?.ok) return;
  const s = res.settings;
  els.apiKey.value = s.apiKey || "";
  els.baseUrl.value = s.baseUrl || "";
  els.model.value = s.model || "";
  els.temperature.value = s.temperature ?? 0.3;
  els.maxTokens.value = s.maxTokens ?? 2048;
  langState.sourceLang = s.sourceLang || "auto";
  langState.targetLang = s.targetLang || "zh";
  langState.autoSelection = s.autoSelection !== false;
  updateLangSeg();
  els.autoSelection.checked = langState.autoSelection;
}

function updateLangSeg() {
  els.sourceBtns.forEach(b => b.classList.toggle("active", b.dataset.lang === langState.sourceLang));
  els.targetBtns.forEach(b => b.classList.toggle("active", b.dataset.lang === langState.targetLang));
}

function setStatus(node, text, kind = "") {
  node.textContent = text;
  node.className = "status-msg" + (kind ? " " + kind : "");
}

// ---------- Config save/test ----------
function getFormSettings() {
  return {
    apiKey: els.apiKey.value.trim(),
    baseUrl: els.baseUrl.value.trim(),
    model: els.model.value.trim(),
    temperature: parseFloat(els.temperature.value) || 0.3,
    maxTokens: parseInt(els.maxTokens.value, 10) || 2048
  };
}

async function saveConfig() {
  const s = getFormSettings();
  await chrome.storage.sync.set(s);
  setStatus(els.statusMsg, "配置已保存 ✓", "ok");
  setTimeout(() => setStatus(els.statusMsg, ""), 1500);
}

async function testConnection() {
  setStatus(els.statusMsg, "正在测试连接…", "loading");
  const res = await chrome.runtime.sendMessage({ type: "testConnection", settings: { ...getFormSettings(), ...langState } });
  if (res?.ok) setStatus(els.statusMsg, "连接成功 ✓ " + (res.content || ""), "ok");
  else setStatus(els.statusMsg, "✗ " + (res?.error || "连接失败"), "err");
}

els.saveBtn.addEventListener("click", saveConfig);
els.testBtn.addEventListener("click", testConnection);
els.revealKey.addEventListener("click", () => {
  const t = els.apiKey.type === "password" ? "text" : "password";
  els.apiKey.type = t;
  els.revealKey.textContent = t === "password" ? "显示" : "隐藏";
});

// ---------- Language ----------
els.sourceBtns.forEach(b => b.addEventListener("click", () => {
  langState.sourceLang = b.dataset.lang;
  updateLangSeg();
}));
els.targetBtns.forEach(b => b.addEventListener("click", () => {
  langState.targetLang = b.dataset.lang;
  updateLangSeg();
}));
els.autoSelection.addEventListener("change", (e) => { langState.autoSelection = e.target.checked; });

els.saveLangBtn.addEventListener("click", async () => {
  await chrome.storage.sync.set({
    sourceLang: langState.sourceLang,
    targetLang: langState.targetLang,
    autoSelection: langState.autoSelection
  });
  setStatus(els.langStatus, "语言设置已保存 ✓", "ok");
  setTimeout(() => setStatus(els.langStatus, ""), 1500);
});

// ---------- Stats ----------
async function loadStats() {
  const res = await chrome.runtime.sendMessage({ type: "getStats" });
  if (!res?.ok) return;
  const s = res.stats;
  els.statRequests.textContent = fmt(s.totalRequests);
  els.statTotal.textContent = fmt(s.totalTokens);
  els.statPrompt.textContent = fmt(s.promptTokens);
  els.statCompletion.textContent = fmt(s.completionTokens);

  // by kind
  const kinds = ["selection", "page", "summary", "chat"];
  const maxKind = Math.max(1, ...kinds.map(k => (s.byKind[k]?.tokens || 0)));
  els.breakdownKind.innerHTML = kinds.map(k => {
    const v = s.byKind[k]?.tokens || 0;
    const pct = (v / maxKind * 100).toFixed(1);
    return `<div class="bd-row"><span class="bd-name">${KIND_LABELS[k]}</span>` +
      `<div class="bd-bar"><div class="bd-fill" style="width:${pct}%"></div></div>` +
      `<span class="bd-num">${fmt(v)} · ${s.byKind[k]?.requests || 0} 次</span></div>`;
  }).join("");

  // by model
  const models = Object.entries(s.byModel).sort((a, b) => b[1].tokens - a[1].tokens);
  const maxModel = Math.max(1, ...models.map(m => m[1].tokens));
  if (!models.length) {
    els.breakdownModel.innerHTML = `<div class="empty-state" style="padding:16px">暂无模型数据</div>`;
  } else {
    els.breakdownModel.innerHTML = models.map(([m, v]) => {
      const pct = (v.tokens / maxModel * 100).toFixed(1);
      return `<div class="bd-row"><span class="bd-name" style="width:180px">${escapeHtml(m)}</span>` +
        `<div class="bd-bar"><div class="bd-fill" style="width:${pct}%"></div></div>` +
        `<span class="bd-num">${fmt(v.tokens)} · ${v.requests} 次</span></div>`;
    }).join("");
  }
}

els.resetStatsBtn.addEventListener("click", async () => {
  if (!confirm("确定要重置所有 Token 统计吗？此操作不可撤销。")) return;
  await chrome.runtime.sendMessage({ type: "resetStats" });
  await loadStats();
});

// ---------- History ----------
async function loadHistory() {
  const res = await chrome.runtime.sendMessage({ type: "getHistory" });
  if (!res?.ok) return;
  allHistory = res.history || [];
  renderHistory(allHistory);
}

function renderHistory(list) {
  const q = (els.historySearch.value || "").trim().toLowerCase();
  const filtered = q ? list.filter(h =>
    (h.sourceText || "").toLowerCase().includes(q) ||
    (h.targetText || "").toLowerCase().includes(q) ||
    (h.url || "").toLowerCase().includes(q) ||
    (h.title || "").toLowerCase().includes(q)
  ) : list;

  if (!filtered.length) {
    els.historyList.innerHTML = "";
    els.historyEmpty.style.display = "block";
    els.historyEmpty.textContent = list.length ? "没有匹配的记录。" : "暂无翻译记录。使用插件翻译或总结后，记录会出现在这里。";
    return;
  }
  els.historyEmpty.style.display = "none";
  els.historyList.innerHTML = filtered.map(h => {
    const cls = h.ok === false ? "fail" : (h.kind || "chat");
    const label = h.ok === false ? "失败" : (KIND_LABELS[h.kind] || h.kind || "对话");
    const src = escapeHtml((h.sourceText || "").slice(0, 200));
    const tgt = h.ok === false
      ? `<span style="color:var(--danger)">⚠ ${escapeHtml(h.error || "失败")}</span>`
      : escapeHtml((h.targetText || "").slice(0, 300));
    const lang = `${langLabel(h.source)} → ${langLabel(h.target)}`;
    const time = new Date(h.time).toLocaleString();
    const tokens = h.tokens ? `${fmt(h.tokens)} tokens` : "";
    const count = h.count ? ` · ${h.count} 段` : "";
    const url = h.url ? `<div class="hist-url">${escapeHtml(h.url)}</div>` : "";
    return `<div class="hist-item">
      <div class="hist-top">
        <span class="badge ${cls}">${label}</span>
        <span class="hist-lang">${lang}</span>
        <span class="hist-tokens">${tokens}${count}</span>
        <span class="hist-time">${time}</span>
      </div>
      <div class="hist-src">${src}</div>
      <div class="hist-tgt">${tgt}</div>
      ${url}
    </div>`;
  }).join("");
}

els.historySearch.addEventListener("input", () => renderHistory(allHistory));

els.clearHistoryBtn.addEventListener("click", async () => {
  if (!confirm("确定要清空所有翻译历史吗？此操作不可撤销。")) return;
  await chrome.runtime.sendMessage({ type: "clearHistory" });
  allHistory = [];
  renderHistory(allHistory);
});

// ---------- Helpers ----------
function fmt(n) { return Number(n || 0).toLocaleString(); }
function langLabel(code) { return { auto: "自动", zh: "中文", en: "English" }[code] || code; }
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

// ---------- Refresh on focus (so stats/history update after using the extension) ----------
window.addEventListener("focus", () => {
  const active = document.querySelector(".tab.active");
  if (!active) return;
  if (active.dataset.tab === "stats") loadStats();
  if (active.dataset.tab === "history") loadHistory();
});

loadSettings();
