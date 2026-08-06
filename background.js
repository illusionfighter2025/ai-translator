// Background service worker for AI Translator
// Handles API calls (OpenAI-compatible), context menus, commands, and message routing.

const DEFAULTS = {
  apiKey: "",
  baseUrl: "https://api.deepseek.com",
  model: "deepseek-chat",
  sourceLang: "auto",
  targetLang: "zh",
  autoSelection: true,
  temperature: 0.3,
  maxTokens: 2048,
  translatePrompt: "",
  summaryPrompt: ""
};

const LANG_LABELS = {
  auto: "Auto-detect",
  zh: "中文",
  en: "English"
};

const HISTORY_KEY = "ait_history";
const STATS_KEY = "ait_stats";
const HISTORY_LIMIT = 200;

const KIND_LABELS = { selection: "划词翻译", page: "整页翻译", summary: "网页总结" };

// ---- Lifecycle ----
chrome.runtime.onInstalled.addListener(async () => {
  const cur = await chrome.storage.sync.get(Object.keys(DEFAULTS));
  const toSet = {};
  for (const k of Object.keys(DEFAULTS)) {
    if (cur[k] === undefined) toSet[k] = DEFAULTS[k];
  }
  if (Object.keys(toSet).length) await chrome.storage.sync.set(toSet);
  createContextMenus();
});

chrome.runtime.onStartup.addListener(createContextMenus);

function createContextMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "ait-translate-selection",
      title: "AI Translate: Translate selection",
      contexts: ["selection"]
    });
    chrome.contextMenus.create({
      id: "ait-translate-page",
      title: "AI Translate: Translate entire page",
      contexts: ["page"]
    });
    chrome.contextMenus.create({
      id: "ait-summarize-page",
      title: "AI Translate: Summarize this page",
      contexts: ["page"]
    });
  });
}

// Inject content.js into a tab if it isn't already (e.g. tab was open before
// the extension loaded). Returns true if the content script is reachable.
async function ensureContentScript(tabId) {
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: "ping" });
    if (res?.ok) return true;
  } catch { /* not injected yet */ }
  try {
    await chrome.scripting.insertCSS({ target: { tabId }, files: ["content.css"] });
  } catch { /* CSS optional */ }
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    await new Promise(r => setTimeout(r, 250));
    return true;
  } catch { return false; }
}

async function sendToTab(tabId, message) {
  const ok = await ensureContentScript(tabId);
  if (!ok) return false;
  try { await chrome.tabs.sendMessage(tabId, message); return true; } catch { return false; }
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab?.id) return;
  if (info.menuItemId === "ait-translate-selection") {
    sendToTab(tab.id, { type: "translateSelection", text: info.selectionText });
  } else if (info.menuItemId === "ait-translate-page") {
    sendToTab(tab.id, { type: "translatePage" });
  } else if (info.menuItemId === "ait-summarize-page") {
    sendToTab(tab.id, { type: "summarizePage" });
  }
});

chrome.commands.onCommand.addListener((command) => {
  chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
    const tab = tabs[0];
    if (!tab?.id) return;
    if (command === "translate-page") sendToTab(tab.id, { type: "translatePage" });
    else if (command === "summarize-page") sendToTab(tab.id, { type: "summarizePage" });
    else if (command === "toggle-selection-translate") sendToTab(tab.id, { type: "translateSelectionFromCommand" });
  });
});

// ---- Settings helper ----
async function getSettings() {
  const stored = await chrome.storage.sync.get(Object.keys(DEFAULTS));
  return { ...DEFAULTS, ...stored };
}

// ---- Message router ----
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg.type === "getSettings") {
        sendResponse({ ok: true, settings: await getSettings() });
      } else if (msg.type === "testConnection") {
        const res = await testConnection(msg.settings || (await getSettings()));
        sendResponse(res);
      } else if (msg.type === "chat") {
        const settings = await getSettings();
        const res = await chatCompletion(settings, msg.messages, msg.options || {});
        if (msg.meta) {
          recordHistory({
            kind: msg.meta.kind || "chat",
            source: msg.meta.source || "auto",
            target: msg.meta.target || settings.targetLang || "zh",
            sourceText: msg.meta.sourceText || "",
            targetText: res.content || "",
            url: msg.meta.url || "",
            title: msg.meta.title || "",
            model: settings.model,
            tokens: res.usage?.total_tokens || 0,
            promptTokens: res.usage?.prompt_tokens || 0,
            completionTokens: res.usage?.completion_tokens || 0,
            ok: true
          });
          addUsage(res.usage, settings.model, msg.meta.kind || "chat");
        }
        sendResponse(res);
      } else if (msg.type === "translateBatch") {
        const settings = await getSettings();
        const res = await translateBatch(settings, msg.items, msg.source, msg.target);
        if (msg.meta) {
          recordHistory({
            kind: msg.meta.kind || "page",
            source: msg.meta.source || msg.source || "auto",
            target: msg.meta.target || msg.target || settings.targetLang || "zh",
            sourceText: (msg.meta.preview || msg.items || []).slice(0, 3).join(" / "),
            targetText: res.translations ? res.translations.slice(0, 3).join(" / ") : "",
            url: msg.meta.url || "",
            title: msg.meta.title || "",
            model: settings.model,
            tokens: res.usage?.total_tokens || 0,
            promptTokens: res.usage?.prompt_tokens || 0,
            completionTokens: res.usage?.completion_tokens || 0,
            count: msg.items?.length || 0,
            ok: !!res.ok,
            error: res.ok ? "" : res.error
          });
          addUsage(res.usage, settings.model, msg.meta.kind || "page");
        }
        sendResponse(res);
      } else if (msg.type === "getHistory") {
        const data = await chrome.storage.local.get(HISTORY_KEY);
        const history = data[HISTORY_KEY] || [];
        const limit = typeof msg.limit === "number" ? msg.limit : history.length;
        sendResponse({ ok: true, history: history.slice(0, limit) });
      } else if (msg.type === "clearHistory") {
        await chrome.storage.local.remove(HISTORY_KEY);
        sendResponse({ ok: true });
      } else if (msg.type === "getStats") {
        const data = await chrome.storage.local.get(STATS_KEY);
        sendResponse({ ok: true, stats: data[STATS_KEY] || emptyStats() });
      } else if (msg.type === "resetStats") {
        await chrome.storage.local.remove(STATS_KEY);
        sendResponse({ ok: true });
      } else {
        sendResponse({ ok: false, error: "Unknown message type: " + msg.type });
      }
    } catch (e) {
      sendResponse({ ok: false, error: e?.message || String(e) });
    }
  })();
  return true; // async
});

// ---- API helpers ----
function normalizeBaseUrl(baseUrl) {
  let url = (baseUrl || "").trim().replace(/\/+$/, "");
  if (!url) return "";
  // If user included /v1 or /chat/completions, keep base up to /v1
  return url;
}

function chatCompletionsUrl(baseUrl) {
  const base = normalizeBaseUrl(baseUrl);
  if (!base) throw new Error("Base URL is not configured.");
  if (/\/v\d+$/.test(base)) return base + "/chat/completions";
  if (/\/chat\/completions$/.test(base)) return base;
  return base + "/v1/chat/completions";
}

async function chatCompletion(settings, messages, options = {}) {
  if (!settings.apiKey) throw new Error("API Key is not configured. Open the extension popup to set it.");
  const url = chatCompletionsUrl(settings.baseUrl);
  // Reasoning models (e.g. deepseek-v4-flash) spend tokens on chain-of-thought
  // before the answer. If max_tokens is too small, reasoning consumes the whole
  // budget, finish_reason becomes "length", and content comes back empty.
  // Floor the budget at 512 and retry with a larger budget on truncation.
  let maxTokens = Math.max(options.maxTokens ?? settings.maxTokens ?? 2048, 512);
  const temperature = options.temperature ?? settings.temperature;
  const model = options.model || settings.model;
  let lastErr = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    const body = { model, messages, temperature, max_tokens: maxTokens, stream: false };
    let resp;
    try {
      resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${settings.apiKey}` },
        body: JSON.stringify(body)
      });
    } catch (e) {
      lastErr = "Network error: " + (e?.message || String(e));
      if (attempt < 2) { await new Promise(r => setTimeout(r, 400 * (attempt + 1))); continue; }
      throw new Error(lastErr);
    }
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`API error ${resp.status}: ${text.slice(0, 500)}`);
    }
    const data = await resp.json();
    const content = data?.choices?.[0]?.message?.content;
    const finishReason = data?.choices?.[0]?.finish_reason;
    if (content && content.trim()) {
      return { ok: true, content: content.trim(), usage: data.usage, finishReason };
    }
    // Empty content. If truncated by token limit, retry with a bigger budget.
    lastErr = finishReason === "length"
      ? "Model response truncated (max_tokens too small for reasoning)."
      : "Empty response from model.";
    if (finishReason === "length" && attempt < 2) {
      maxTokens = Math.min(8192, maxTokens * 2);
      continue;
    }
  }
  throw new Error(lastErr || "Empty response from model.");
}

async function testConnection(settings) {
  try {
    const res = await chatCompletion(settings, [
      { role: "system", content: "Reply with exactly: OK" },
      { role: "user", content: "ping" }
    ], { maxTokens: 512, temperature: 0 });
    return { ok: true, content: res.content };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

// ---- History & stats ----
function emptyStats() {
  return {
    totalRequests: 0,
    totalTokens: 0,
    promptTokens: 0,
    completionTokens: 0,
    byKind: { selection: { requests: 0, tokens: 0 }, page: { requests: 0, tokens: 0 }, summary: { requests: 0, tokens: 0 }, chat: { requests: 0, tokens: 0 } },
    byModel: {}
  };
}

async function recordHistory(entry) {
  try {
    const data = await chrome.storage.local.get(HISTORY_KEY);
    const history = data[HISTORY_KEY] || [];
    history.unshift({
      id: Date.now() + "-" + Math.random().toString(36).slice(2, 7),
      time: Date.now(),
      ...entry
    });
    if (history.length > HISTORY_LIMIT) history.length = HISTORY_LIMIT;
    await chrome.storage.local.set({ [HISTORY_KEY]: history });
  } catch (e) { /* non-fatal */ }
}

async function addUsage(usage, model, kind) {
  try {
    if (!usage) return;
    const data = await chrome.storage.local.get(STATS_KEY);
    const stats = data[STATS_KEY] || emptyStats();
    const pt = usage.prompt_tokens || 0;
    const ct = usage.completion_tokens || 0;
    const tt = usage.total_tokens || (pt + ct);
    stats.totalRequests += 1;
    stats.totalTokens += tt;
    stats.promptTokens += pt;
    stats.completionTokens += ct;
    const k = stats.byKind[kind] || (stats.byKind[kind] = { requests: 0, tokens: 0 });
    k.requests += 1;
    k.tokens += tt;
    const m = stats.byModel[model] || (stats.byModel[model] = { requests: 0, tokens: 0 });
    m.requests += 1;
    m.tokens += tt;
    await chrome.storage.local.set({ [STATS_KEY]: stats });
  } catch (e) { /* non-fatal */ }
}

// ---- Batch translation ----
// items: array of strings. Returns { ok, translations: string[] }
// Translates each item individually for reliability with reasoning models.
async function translateBatch(settings, items, source, target) {
  if (!items?.length) return { ok: true, translations: [], usage: { total_tokens: 0, prompt_tokens: 0, completion_tokens: 0 } };
  const tgtLabel = LANG_LABELS[target] || target;
  const other = target === "zh" ? "English" : "中文";
  const sys = `You are a professional translation engine. ` +
    `If the input is in English, translate it to 中文. If the input is in 中文, translate it to English. ` +
    `This request's target language is ${tgtLabel} (so prefer ${tgtLabel} unless the input is already in ${tgtLabel}, then output ${other}). ` +
    `Output ONLY the translated text. No explanations, no transliteration, no rephrasing in the source language. Preserve formatting and punctuation.`;
  const out = new Array(items.length).fill("");
  let okCount = 0;
  let lastErr = "";
  let usage = { total_tokens: 0, prompt_tokens: 0, completion_tokens: 0 };
  for (let i = 0; i < items.length; i++) {
    const text = items[i];
    if (!text || !text.trim()) { out[i] = text || ""; okCount++; continue; }
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await chatCompletion(settings, [
          { role: "system", content: sys },
          { role: "user", content: text }
        ], { temperature: 0.2, maxTokens: Math.min(2048, Math.max(256, text.length * 4)) });
        if (res.content) {
          out[i] = res.content; okCount++;
          if (res.usage) {
            usage.total_tokens += res.usage.total_tokens || 0;
            usage.prompt_tokens += res.usage.prompt_tokens || 0;
            usage.completion_tokens += res.usage.completion_tokens || 0;
          }
          break;
        }
        lastErr = "Empty response.";
      } catch (e) {
        lastErr = e?.message || String(e);
      }
    }
  }
  if (!okCount) return { ok: false, error: lastErr || "All translations failed.", translations: out, usage };
  return { ok: true, translations: out, usage };
}
