// Background service worker for AI Translator
// Handles API calls (OpenAI-compatible), context menus, commands, and message routing.

const DEFAULTS = {
  apiKey: "",
  baseUrl: "https://api.deepseek.com",
  model: "deepseek-chat",
  targetLang: "zh",
  autoSelection: true,
  temperature: 0.3,
  maxTokens: 2048,
  translatePrompt: "",
  summaryPrompt: ""
};

const LANG_LABELS = {
  zh: "中文",
  en: "English"
};

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

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab?.id) return;
  if (info.menuItemId === "ait-translate-selection") {
    chrome.tabs.sendMessage(tab.id, { type: "translateSelection", text: info.selectionText });
  } else if (info.menuItemId === "ait-translate-page") {
    chrome.tabs.sendMessage(tab.id, { type: "translatePage" });
  } else if (info.menuItemId === "ait-summarize-page") {
    chrome.tabs.sendMessage(tab.id, { type: "summarizePage" });
  }
});

chrome.commands.onCommand.addListener((command) => {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    if (!tab?.id) return;
    if (command === "translate-page") chrome.tabs.sendMessage(tab.id, { type: "translatePage" });
    else if (command === "summarize-page") chrome.tabs.sendMessage(tab.id, { type: "summarizePage" });
    else if (command === "toggle-selection-translate") chrome.tabs.sendMessage(tab.id, { type: "translateSelectionFromCommand" });
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
        sendResponse(res);
      } else if (msg.type === "translateBatch") {
        const settings = await getSettings();
        const res = await translateBatch(settings, msg.items, msg.source, msg.target);
        sendResponse(res);
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
  const body = {
    model: options.model || settings.model,
    messages,
    temperature: options.temperature ?? settings.temperature,
    max_tokens: options.maxTokens ?? settings.maxTokens,
    stream: false
  };
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${settings.apiKey}`
    },
    body: JSON.stringify(body)
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`API error ${resp.status}: ${text.slice(0, 500)}`);
  }
  const data = await resp.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error("Empty response from model.");
  return { ok: true, content: content.trim(), usage: data.usage };
}

async function testConnection(settings) {
  try {
    const res = await chatCompletion(settings, [
      { role: "system", content: "You are a connectivity test. Reply with: OK" },
      { role: "user", content: "ping" }
    ], { maxTokens: 16, temperature: 0 });
    return { ok: true, content: res.content };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

// ---- Batch translation ----
// items: array of strings. Returns { ok, translations: string[] }
async function translateBatch(settings, items, source, target) {
  if (!items?.length) return { ok: true, translations: [] };
  const srcLabel = source === "auto" ? "the source language" : (LANG_LABELS[source] || source);
  const tgtLabel = LANG_LABELS[target] || target;
  const sys = `You are a professional translation engine. Translate each input text from ${srcLabel} to ${tgtLabel}. ` +
    `Return ONLY a JSON array of strings, same length and order as the input array. ` +
    `Preserve meaning, tone, formatting placeholders, and code. Do not add explanations.`;
  const user = JSON.stringify(items);
  try {
    const res = await chatCompletion(settings, [
      { role: "system", content: sys },
      { role: "user", content: user }
    ], { temperature: 0.2, maxTokens: Math.min(4096, Math.max(512, items.length * 64)) });
    let parsed;
    try {
      parsed = JSON.parse(res.content);
    } catch {
      // try to extract JSON array
      const m = res.content.match(/\[[\s\S]*\]/);
      if (m) parsed = JSON.parse(m[0]);
      else throw new Error("Model did not return valid JSON array.");
    }
    if (!Array.isArray(parsed) || parsed.length !== items.length) {
      throw new Error("Translation count mismatch.");
    }
    return { ok: true, translations: parsed.map(String) };
  } catch (e) {
    return { ok: false, error: e?.message || String(e), translations: items.map(() => "") };
  }
}
