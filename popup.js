// AI Translator popup logic
const $ = (id) => document.getElementById(id);

const els = {
  apiKey: $("apiKey"),
  baseUrl: $("baseUrl"),
  model: $("model"),
  targetLangBtns: document.querySelectorAll(".seg-btn"),
  autoSelection: $("autoSelection"),
  saveBtn: $("saveBtn"),
  testBtn: $("testBtn"),
  statusMsg: $("statusMsg"),
  revealKey: $("revealKey"),
  optionsBtn: $("optionsBtn"),
  translatePageBtn: $("translatePageBtn"),
  translatePageLabel: $("translatePageLabel"),
  summarizeBtn: $("summarizeBtn"),
  selectionBtn: $("selectionBtn")
};

let state = { targetLang: "zh", autoSelection: true };

async function loadSettings() {
  const res = await chrome.runtime.sendMessage({ type: "getSettings" });
  if (!res?.ok) return;
  const s = res.settings;
  els.apiKey.value = s.apiKey || "";
  els.baseUrl.value = s.baseUrl || "";
  els.model.value = s.model || "";
  state.targetLang = s.targetLang || "zh";
  state.autoSelection = s.autoSelection !== false;
  updateSeg();
  els.autoSelection.checked = state.autoSelection;
  await refreshPageState();
}

function updateSeg() {
  els.targetLangBtns.forEach(b => b.classList.toggle("active", b.dataset.lang === state.targetLang));
}

function setStatus(text, kind = "") {
  els.statusMsg.textContent = text;
  els.statusMsg.className = "status-msg" + (kind ? " " + kind : "");
}

function getFormSettings() {
  return {
    apiKey: els.apiKey.value.trim(),
    baseUrl: els.baseUrl.value.trim(),
    model: els.model.value.trim(),
    targetLang: state.targetLang,
    autoSelection: els.autoSelection.checked
  };
}

async function save() {
  const s = getFormSettings();
  await chrome.storage.sync.set(s);
  setStatus("Saved ✓", "ok");
  setTimeout(() => setStatus(""), 1500);
}

async function test() {
  setStatus("Testing…", "loading");
  const res = await chrome.runtime.sendMessage({ type: "testConnection", settings: getFormSettings() });
  if (res?.ok) setStatus("Connected ✓ " + (res.content || ""), "ok");
  else setStatus("✗ " + (res?.error || "Failed"), "err");
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0];
}

async function sendToTab(type) {
  const tab = await getActiveTab();
  if (!tab?.id) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type });
  } catch (e) {
    setStatus("Cannot reach this page.", "err");
  }
}

async function refreshPageState() {
  const tab = await getActiveTab();
  if (!tab?.id) return;
  try {
    const res = await chrome.tabs.sendMessage(tab.id, { type: "getState" });
    if (res?.ok && res.pageTranslated) {
      els.translatePageLabel.textContent = "Restore Page";
      els.translatePageBtn.classList.remove("primary");
    } else {
      els.translatePageLabel.textContent = "Translate Page";
      els.translatePageBtn.classList.add("primary");
    }
  } catch {
    // content script not ready
    els.translatePageLabel.textContent = "Translate Page";
    els.translatePageBtn.classList.add("primary");
  }
}

// Events
els.targetLangBtns.forEach(b => b.addEventListener("click", async () => {
  state.targetLang = b.dataset.lang;
  updateSeg();
  await chrome.storage.sync.set({ targetLang: state.targetLang });
}));

els.autoSelection.addEventListener("change", async (e) => {
  state.autoSelection = e.target.checked;
  await chrome.storage.sync.set({ autoSelection: state.autoSelection });
});

els.saveBtn.addEventListener("click", save);
els.testBtn.addEventListener("click", test);

els.revealKey.addEventListener("click", () => {
  const t = els.apiKey.type === "password" ? "text" : "password";
  els.apiKey.type = t;
  els.revealKey.textContent = t === "password" ? "eye" : "off";
});

els.optionsBtn.addEventListener("click", () => chrome.runtime.openOptionsPage());

els.translatePageBtn.addEventListener("click", async () => {
  await sendToTab("translatePage");
  setTimeout(refreshPageState, 400);
});
els.summarizeBtn.addEventListener("click", () => sendToTab("summarizePage"));
els.selectionBtn.addEventListener("click", () => sendToTab("translateSelectionFromCommand"));

// Enter to save
[els.apiKey, els.baseUrl, els.model].forEach(i => {
  i.addEventListener("keydown", (e) => { if (e.key === "Enter") save(); });
});

loadSettings();
