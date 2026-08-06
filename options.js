// AI Translator options page logic
const $ = (id) => document.getElementById(id);

const els = {
  apiKey: $("apiKey"),
  baseUrl: $("baseUrl"),
  model: $("model"),
  targetLangBtns: document.querySelectorAll(".seg-btn"),
  autoSelection: $("autoSelection"),
  temperature: $("temperature"),
  maxTokens: $("maxTokens"),
  translatePrompt: $("translatePrompt"),
  summaryPrompt: $("summaryPrompt"),
  saveBtn: $("saveBtn"),
  testBtn: $("testBtn"),
  statusMsg: $("statusMsg"),
  revealKey: $("revealKey")
};

let state = { targetLang: "zh" };

function setStatus(text, kind = "") {
  els.statusMsg.textContent = text;
  els.statusMsg.className = "status-msg" + (kind ? " " + kind : "");
}

function updateSeg() {
  els.targetLangBtns.forEach(b => b.classList.toggle("active", b.dataset.lang === state.targetLang));
}

async function loadSettings() {
  const res = await chrome.runtime.sendMessage({ type: "getSettings" });
  if (!res?.ok) return;
  const s = res.settings;
  els.apiKey.value = s.apiKey || "";
  els.baseUrl.value = s.baseUrl || "";
  els.model.value = s.model || "";
  state.targetLang = s.targetLang || "zh";
  els.autoSelection.checked = s.autoSelection !== false;
  els.temperature.value = s.temperature ?? 0.3;
  els.maxTokens.value = s.maxTokens ?? 2048;
  els.translatePrompt.value = s.translatePrompt || "";
  els.summaryPrompt.value = s.summaryPrompt || "";
  updateSeg();
}

function getFormSettings() {
  return {
    apiKey: els.apiKey.value.trim(),
    baseUrl: els.baseUrl.value.trim(),
    model: els.model.value.trim(),
    targetLang: state.targetLang,
    autoSelection: els.autoSelection.checked,
    temperature: parseFloat(els.temperature.value) || 0.3,
    maxTokens: parseInt(els.maxTokens.value) || 2048,
    translatePrompt: els.translatePrompt.value.trim(),
    summaryPrompt: els.summaryPrompt.value.trim()
  };
}

async function save() {
  await chrome.storage.sync.set(getFormSettings());
  setStatus("Settings saved ✓", "ok");
  setTimeout(() => setStatus(""), 2000);
}

async function test() {
  setStatus("Testing connection…", "loading");
  const res = await chrome.runtime.sendMessage({ type: "testConnection", settings: getFormSettings() });
  if (res?.ok) setStatus("Connected ✓ Reply: " + (res.content || "OK"), "ok");
  else setStatus("✗ " + (res?.error || "Failed"), "err");
}

els.targetLangBtns.forEach(b => b.addEventListener("click", () => {
  state.targetLang = b.dataset.lang;
  updateSeg();
}));

els.saveBtn.addEventListener("click", save);
els.testBtn.addEventListener("click", test);

els.revealKey.addEventListener("click", () => {
  const t = els.apiKey.type === "password" ? "text" : "password";
  els.apiKey.type = t;
  els.revealKey.textContent = t === "password" ? "Show" : "Hide";
});

loadSettings();
