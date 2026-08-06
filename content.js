// Content script for AI Translator
// Handles: selection translation tooltip, full-page translation, webpage summary.

(() => {
  if (window.__aitInjected) return;
  window.__aitInjected = true;

  let settings = null;
  let tooltipEl = null;
  let lastSelectionText = "";

  // ---------- Settings ----------
  async function loadSettings() {
    const res = await chrome.runtime.sendMessage({ type: "getSettings" });
    settings = res?.ok ? res.settings : null;
    return settings;
  }

  // ---------- UI: floating tooltip ----------
  function ensureTooltip() {
    if (tooltipEl && document.body.contains(tooltipEl)) return tooltipEl;
    tooltipEl = document.createElement("div");
    tooltipEl.className = "ait-tooltip";
    tooltipEl.innerHTML = `
      <div class="ait-tooltip-head">
        <span class="ait-tooltip-title">AI Translate</span>
        <span class="ait-tooltip-actions">
          <button class="ait-btn ait-btn-copy" title="Copy">Copy</button>
          <button class="ait-btn ait-btn-close" title="Close">✕</button>
        </span>
      </div>
      <div class="ait-tooltip-body"></div>
      <div class="ait-tooltip-foot"></div>`;
    document.documentElement.appendChild(tooltipEl);
    tooltipEl.querySelector(".ait-btn-close").addEventListener("click", hideTooltip);
    tooltipEl.querySelector(".ait-btn-copy").addEventListener("click", () => {
      const txt = tooltipEl.querySelector(".ait-tooltip-body").innerText;
      navigator.clipboard?.writeText(txt).catch(() => {});
      flashCopied();
    });
    return tooltipEl;
  }

  function flashCopied() {
    const btn = tooltipEl.querySelector(".ait-btn-copy");
    const old = btn.textContent;
    btn.textContent = "Copied!";
    setTimeout(() => { btn.textContent = old; }, 1000);
  }

  function hideTooltip() {
    if (tooltipEl) tooltipEl.classList.remove("ait-show");
  }

  function showTooltipAt(rect, content, { loading = false, title = "AI Translate", foot = "" } = {}) {
    const t = ensureTooltip();
    t.querySelector(".ait-tooltip-title").textContent = title;
    t.querySelector(".ait-tooltip-body").innerHTML = content;
    t.querySelector(".ait-tooltip-foot").textContent = foot;
    t.classList.add("ait-show");
    if (loading) t.classList.add("ait-loading");
    else t.classList.remove("ait-loading");

    // Position
    const tt = t.getBoundingClientRect();
    let top = rect.bottom + window.scrollY + 8;
    let left = rect.left + window.scrollX;
    const margin = 8;
    if (left + tt.width > window.innerWidth - margin) left = window.innerWidth - tt.width - margin;
    if (left < margin) left = margin;
    if (top + tt.height > window.innerHeight + window.scrollY - margin) {
      top = rect.top + window.scrollY - tt.height - 8;
    }
    t.style.top = `${Math.max(margin, top)}px`;
    t.style.left = `${Math.max(margin, left)}px`;
  }

  function positionTooltipNearSelection() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return;
    showTooltipAt(rect, "", { loading: true });
  }

  // ---------- Selection translation ----------
  async function translateSelection(text) {
    if (!text || !text.trim()) return;
    await loadSettings();
    positionTooltipNearSelection();
    const target = settings?.targetLang || "zh";
    const source = (settings?.sourceLang && settings.sourceLang !== "auto") ? settings.sourceLang : detectLang(text);
    const other = target === "zh" ? "English" : "中文";
    const sys = `You are a professional translation engine. ` +
      `If the input is in English, translate it to 中文. If the input is in 中文, translate it to English. ` +
      `This request's target language is ${langLabel(target)} (so prefer ${langLabel(target)} unless the input is already in ${langLabel(target)}, then output ${other}). ` +
      `Output ONLY the translated text. No explanations, no transliteration, no rephrasing in the source language. Preserve formatting and punctuation.`;
    try {
      const res = await chrome.runtime.sendMessage({
        type: "chat",
        messages: [
          { role: "system", content: sys },
          { role: "user", content: text }
        ],
        options: { temperature: 0.2 },
        meta: { kind: "selection", source, target, sourceText: text, url: location.href, title: document.title }
      });
      if (!res?.ok) throw new Error(res?.error || "Translation failed");
      const body = tooltipEl.querySelector(".ait-tooltip-body");
      body.innerHTML = escapeHtml(res.content);
      tooltipEl.querySelector(".ait-tooltip-foot").textContent = `${langLabel(source)} → ${langLabel(target)}`;
      tooltipEl.classList.remove("ait-loading");
    } catch (e) {
      const body = tooltipEl.querySelector(".ait-tooltip-body");
      body.innerHTML = `<span class="ait-error">⚠ ${escapeHtml(e.message)}</span>`;
      tooltipEl.classList.remove("ait-loading");
    }
  }

  // ---------- Mouseup handler ----------
  let mouseupTimer = null;
  document.addEventListener("mouseup", (e) => {
    if (tooltipEl && tooltipEl.contains(e.target)) return;
    clearTimeout(mouseupTimer);
    mouseupTimer = setTimeout(async () => {
      const sel = window.getSelection();
      const text = sel ? sel.toString().trim() : "";
      lastSelectionText = text;
      if (!text || text.length < 1) {
        // don't hide if clicking inside tooltip
        if (tooltipEl && !tooltipEl.contains(e.target)) hideTooltip();
        return;
      }
      if (!settings) await loadSettings();
      if (settings?.autoSelection === false) {
        hideTooltip();
        return;
      }
      await translateSelection(text);
    }, 120);
  }, true);

  // hide tooltip when clicking elsewhere
  document.addEventListener("mousedown", (e) => {
    if (tooltipEl && tooltipEl.contains(e.target)) return;
    const sel = window.getSelection();
    if (sel && sel.toString().trim()) return;
    hideTooltip();
  }, true);

  // ---------- Full-page translation ----------
  let pageTranslating = false;
  let pageTranslated = false;
  let originalSnapshots = new WeakMap(); // element -> originalHTML

  async function translatePage() {
    if (pageTranslating) return;
    await loadSettings();
    pageTranslating = true;
    showStatusBanner("Translating page…");
    try {
      const nodes = collectTranslatableNodes(document.body);
      if (!nodes.length) {
        hideStatusBanner();
        showToast("No translatable text found on this page.");
        return;
      }
      const items = nodes.map(n => n.nodeValue);
      const target = settings?.targetLang || "zh";
      const source = settings?.sourceLang || "auto";
      const res = await chrome.runtime.sendMessage({
        type: "translateBatch",
        items,
        source,
        target,
        meta: { kind: "page", source, target, url: location.href, title: document.title, preview: items.slice(0, 3) }
      });
      if (!res?.ok) throw new Error(res?.error || "Batch translation failed");
      const translations = res.translations;
      // snapshot original + apply
      for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i];
        if (!node.__aitOriginal) node.__aitOriginal = node.nodeValue;
        if (translations[i]) node.nodeValue = translations[i];
      }
      pageTranslated = true;
      hideStatusBanner();
      showToast("Page translated. Click the extension to restore.");
    } catch (e) {
      hideStatusBanner();
      showToast("⚠ " + e.message, true);
    } finally {
      pageTranslating = false;
    }
  }

  function restorePage() {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const toRestore = [];
    while (walker.nextNode()) {
      const n = walker.currentNode;
      if (n.__aitOriginal !== undefined) toRestore.push(n);
    }
    if (!toRestore.length) {
      showToast("Page is not translated.");
      return;
    }
    for (const n of toRestore) {
      n.nodeValue = n.__aitOriginal;
      delete n.__aitOriginal;
    }
    pageTranslated = false;
    showToast("Original page restored.");
  }

  function collectTranslatableNodes(root) {
    const result = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const p = node.parentElement;
        if (!p) return NodeFilter.FILTER_REJECT;
        const tag = p.tagName;
        if (["SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "INPUT", "SELECT", "OPTION", "CODE", "KBD", "SAMP", "VAR"].includes(tag)) {
          return NodeFilter.FILTER_REJECT;
        }
        if (p.closest(".ait-tooltip, .ait-banner, .ait-toast, .ait-modal")) return NodeFilter.FILTER_REJECT;
        if (p.isContentEditable) return NodeFilter.FILTER_REJECT;
        const text = node.nodeValue.replace(/\s+/g, " ").trim();
        if (text.length < 2) return NodeFilter.FILTER_REJECT;
        if (!/[\p{L}]/u.test(text)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    while (walker.nextNode()) result.push(walker.currentNode);
    return result;
  }

  // ---------- Webpage summary ----------
  async function summarizePage() {
    await loadSettings();
    const content = extractMainText();
    if (!content || content.length < 200) {
      showToast("Not enough content on this page to summarize.");
      return;
    }
    openModal("Summarizing…", "<div class='ait-modal-loading'><span class='ait-spinner'></span> Analyzing page content…</div>");
    const sys = `You are a skilled summarizer. Summarize the given webpage content in a clear, structured way. ` +
      `Use the user's preferred language (${langLabel(settings?.targetLang || "zh")}). ` +
      `Output in Markdown with sections: ## Summary, ## Key Points (bullet list), ## Takeaways. Be concise and faithful to the source.`;
    const user = `Webpage title: ${document.title || "(none)"}\nURL: ${location.href}\n\nContent:\n${content.slice(0, 12000)}`;
    try {
      const res = await chrome.runtime.sendMessage({
        type: "chat",
        messages: [
          { role: "system", content: sys },
          { role: "user", content: user }
        ],
        options: { temperature: 0.3, maxTokens: 1024 },
        meta: { kind: "summary", source: "auto", target: settings?.targetLang || "zh", sourceText: content.slice(0, 500), url: location.href, title: document.title }
      });
      if (!res?.ok) throw new Error(res?.error || "Summary failed");
      openModal("Page Summary", renderMarkdown(res.content), { showCopy: true });
    } catch (e) {
      openModal("Summary Error", `<div class='ait-error'>⚠ ${escapeHtml(e.message)}</div>`);
    }
  }

  function extractMainText() {
    // Prefer article/main content; fallback to body innerText
    const main = document.querySelector("article, main, [role=main]") || document.body;
    // remove scripts/styles
    const clone = main.cloneNode(true);
    clone.querySelectorAll("script,style,noscript,svg").forEach(n => n.remove());
    const text = clone.innerText || clone.textContent || "";
    return text.replace(/\n{3,}/g, "\n\n").trim();
  }

  // ---------- Modal ----------
  let modalEl = null;
  function openModal(title, bodyHtml, { showCopy = false } = {}) {
    closeModal();
    modalEl = document.createElement("div");
    modalEl.className = "ait-modal ait-show";
    modalEl.innerHTML = `
      <div class="ait-modal-backdrop"></div>
      <div class="ait-modal-card">
        <div class="ait-modal-head">
          <span class="ait-modal-title">${escapeHtml(title)}</span>
          <span class="ait-modal-actions">
            ${showCopy ? `<button class="ait-btn ait-modal-copy">Copy</button>` : ""}
            <button class="ait-btn ait-modal-close">✕</button>
          </span>
        </div>
        <div class="ait-modal-body">${bodyHtml}</div>
      </div>`;
    document.documentElement.appendChild(modalEl);
    modalEl.querySelector(".ait-modal-close").addEventListener("click", closeModal);
    modalEl.querySelector(".ait-modal-backdrop").addEventListener("click", closeModal);
    const copyBtn = modalEl.querySelector(".ait-modal-copy");
    if (copyBtn) copyBtn.addEventListener("click", () => {
      const txt = modalEl.querySelector(".ait-modal-body").innerText;
      navigator.clipboard?.writeText(txt).catch(() => {});
      copyBtn.textContent = "Copied!";
      setTimeout(() => { copyBtn.textContent = "Copy"; }, 1200);
    });
  }
  function closeModal() {
    if (modalEl) { modalEl.remove(); modalEl = null; }
  }

  // ---------- Status banner / toast ----------
  let bannerEl = null, toastEl = null, toastTimer = null;
  function showStatusBanner(text) {
    hideStatusBanner();
    bannerEl = document.createElement("div");
    bannerEl.className = "ait-banner ait-show";
    bannerEl.innerHTML = `<span class="ait-spinner"></span> ${escapeHtml(text)}`;
    document.documentElement.appendChild(bannerEl);
  }
  function hideStatusBanner() {
    if (bannerEl) { bannerEl.remove(); bannerEl = null; }
  }
  function showToast(text, isError = false) {
    if (toastEl) toastEl.remove();
    toastEl = document.createElement("div");
    toastEl.className = "ait-toast ait-show" + (isError ? " ait-toast-error" : "");
    toastEl.textContent = text;
    document.documentElement.appendChild(toastEl);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      if (toastEl) { toastEl.classList.remove("ait-show"); setTimeout(() => toastEl?.remove(), 300); }
    }, 3000);
  }

  // ---------- Helpers ----------
  function langLabel(code) {
    return { zh: "中文", en: "English" }[code] || code;
  }
  function detectLang(text) {
    // simple heuristic: count CJK chars
    const cjk = (text.match(/[\u4e00-\u9fff]/g) || []).length;
    return cjk > text.length * 0.2 ? "zh" : "en";
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));
  }
  function renderMarkdown(md) {
    // minimal markdown: headings, bold, bullets, paragraphs, code
    let lines = escapeHtml(md).split(/\r?\n/);
    let html = "";
    let inList = false;
    for (let raw of lines) {
      const line = raw;
      if (/^######\s+/.test(line)) { if (inList) { html += "</ul>"; inList = false; } html += `<h6>${line.replace(/^######\s+/, "")}</h6>`; }
      else if (/^#####\s+/.test(line)) { if (inList) { html += "</ul>"; inList = false; } html += `<h5>${line.replace(/^#####\s+/, "")}</h5>`; }
      else if (/^####\s+/.test(line)) { if (inList) { html += "</ul>"; inList = false; } html += `<h4>${line.replace(/^####\s+/, "")}</h4>`; }
      else if (/^###\s+/.test(line)) { if (inList) { html += "</ul>"; inList = false; } html += `<h3>${line.replace(/^###\s+/, "")}</h3>`; }
      else if (/^##\s+/.test(line)) { if (inList) { html += "</ul>"; inList = false; } html += `<h2>${line.replace(/^##\s+/, "")}</h2>`; }
      else if (/^#\s+/.test(line)) { if (inList) { html += "</ul>"; inList = false; } html += `<h1>${line.replace(/^#\s+/, "")}</h1>`; }
      else if (/^\s*[-*]\s+/.test(line)) { if (!inList) { html += "<ul>"; inList = true; } html += `<li>${line.replace(/^\s*[-*]\s+/, "")}</li>`; }
      else if (/^\s*\d+\.\s+/.test(line)) { if (inList) { html += "</ul>"; inList = false; } html += `<ol><li>${line.replace(/^\s*\d+\.\s+/, "")}</li></ol>`; }
      else if (line.trim() === "") { if (inList) { html += "</ul>"; inList = false; } html += ""; }
      else { if (inList) { html += "</ul>"; inList = false; } html += `<p>${line}</p>`; }
    }
    if (inList) html += "</ul>";
    // bold
    html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
    return html;
  }

  // ---------- Message listener ----------
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    try {
      if (msg.type === "translateSelection") {
        translateSelection(msg.text);
        sendResponse({ ok: true });
      } else if (msg.type === "translateSelectionFromCommand") {
        const text = window.getSelection()?.toString().trim() || lastSelectionText;
        if (text) translateSelection(text);
        else showToast("Select some text first.");
        sendResponse({ ok: true });
      } else if (msg.type === "translatePage") {
        if (pageTranslated) restorePage();
        else translatePage();
        sendResponse({ ok: true });
      } else if (msg.type === "restorePage") {
        restorePage();
        sendResponse({ ok: true });
      } else if (msg.type === "summarizePage") {
        summarizePage();
        sendResponse({ ok: true });
      } else if (msg.type === "getState") {
        sendResponse({ ok: true, pageTranslated, pageTranslating });
      } else if (msg.type === "ping") {
        sendResponse({ ok: true });
      } else {
        sendResponse({ ok: false, error: "unknown message: " + msg.type });
      }
    } catch (e) {
      showToast("⚠ " + e.message, true);
      sendResponse({ ok: false, error: e.message });
    }
    return false; // synchronous response sent above
  });

  // init
  loadSettings().catch(() => {});
})();
