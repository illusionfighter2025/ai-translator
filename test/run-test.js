// End-to-end test for AI Translator extension via CDP.
const { spawn } = require("child_process");
const http = require("http");
const fs = require("fs");
const path = require("path");
const WS = require("ws");

const EXT_DIR = "H:\\ai translator";
const CHROME = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PROFILE_DIR = path.join(require("os").tmpdir(), "ait-e2e-" + Date.now());
const PORT = 9231;
const TEST_URL = "http://127.0.0.1:8765/test-page.html";

// Test credentials are read from environment variables (never committed).
// Copy .env.example values into your shell or a .env loader before running.
const TEST_API_KEY = process.env.AIT_TEST_API_KEY || "";
const TEST_BASE_URL = process.env.AIT_TEST_BASE_URL || "https://api.deepseek.com";
const TEST_MODEL = process.env.AIT_TEST_MODEL || "deepseek-v4-flash";
if (!TEST_API_KEY) {
  console.error("[test] AIT_TEST_API_KEY env var is not set. Set it before running, e.g.:\n  $env:AIT_TEST_API_KEY='sk-...'; node test/run-test.js");
  process.exit(1);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const httpJson = u => new Promise((res, rej) => { http.get(u, r => { let d=""; r.on("data",c=>d+=c); r.on("end",()=>res(JSON.parse(d))); }).on("error", rej); });

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.events = []; ws.on("message", m => this._on(m)); }
  _on(m) { const o = JSON.parse(m); if (o.id && this.pending.has(o.id)) { const { resolve } = this.pending.get(o.id); this.pending.delete(o.id); resolve(o); } else if (o.method) this.events.push(o); }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error("timeout: " + method)); } }, 90000);
    });
  }
  async waitForEvent(method, timeout = 30000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const idx = this.events.findIndex(e => e.method === method);
      if (idx >= 0) return this.events.splice(idx, 1)[0];
      await sleep(100);
    }
    throw new Error("event timeout: " + method);
  }
  async eval(expression, { awaitPromise = true } = {}) {
    const r = await this.send("Runtime.evaluate", { expression, awaitPromise, returnByValue: true, userGesture: true });
    const res = r.result;
    if (res.exceptionDetails) throw new Error("Eval error: " + (res.exceptionDetails.exception?.description || res.exceptionDetails.text));
    return res.result?.value;
  }
  async screenshot(file) {
    const s = await this.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(file, Buffer.from(s.result.data, "base64"));
  }
}
async function connect(url) { return new Promise((res, rej) => { const ws = new WS(url); ws.on("open", () => res(new CDP(ws))); ws.on("error", rej); }); }

const log = (...a) => console.log("[test]", ...a);
let failures = 0;
const fail = msg => { console.error("[test] FAIL:", msg); failures++; };
const pass = msg => console.log("[test] PASS:", msg);

async function main() {
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  const chrome = spawn(CHROME, [
    `--user-data-dir=${PROFILE_DIR}`, `--load-extension=${EXT_DIR}`,
    `--remote-debugging-port=${PORT}`, "--remote-allow-origins=*",
    "--no-first-run", "--no-default-browser-check", "--disable-features=DisableLoadExtensionCommandLineSwitch", "about:blank"
  ], { stdio: "ignore" });
  chrome.on("exit", c => log("chrome exited", c));

  let ver;
  for (let i = 0; i < 60; i++) { try { ver = await httpJson(`http://127.0.0.1:${PORT}/json/version`); break; } catch { await sleep(500); } }
  if (!ver) { fail("debug port unreachable"); return cleanup(); }
  log("Chrome:", ver.Browser);

  let ts, sw;
  for (let i = 0; i < 60; i++) {
    ts = await httpJson(`http://127.0.0.1:${PORT}/json`);
    // MY extension's service worker file is background.js (per manifest). Other extensions use service_worker.js.
    sw = ts.find(t => t.type === "service_worker" && t.url.endsWith("/background.js"));
    if (sw) break;
    await sleep(500);
  }
  if (!sw) { fail("no service worker (background.js)"); return cleanup(); }
  const extId = sw.url.match(/chrome-extension:\/\/([^/]+)/)[1];
  log("Extension ID:", extId);
  const swc = await connect(sw.webSocketDebuggerUrl);
  await swc.send("Runtime.enable");

  // Configure the extension by writing to chrome.storage.sync (available in MY extension's SW context).
  const cfgSet = await swc.eval(`new Promise(r=>chrome.storage.sync.set({apiKey:${JSON.stringify(TEST_API_KEY)},baseUrl:${JSON.stringify(TEST_BASE_URL)},model:${JSON.stringify(TEST_MODEL)},targetLang:'zh',autoSelection:true,temperature:0.3,maxTokens:2048},()=>r('ok')))`);
  log("storage.set:", cfgSet);
  const cfgGet = await swc.eval(`new Promise(r=>chrome.storage.sync.get(['apiKey','baseUrl','model'],v=>r(JSON.stringify(v))))`);
  log("storage.get:", cfgGet);
  await sleep(500);

  // Find the blank page and navigate it to the test page (content script injects on fresh nav)
  ts = await httpJson(`http://127.0.0.1:${PORT}/json`);
  let pageTarget = ts.find(t => t.type === "page" && (t.url === "about:blank" || t.url === ""));
  if (!pageTarget) pageTarget = ts.find(t => t.type === "page");
  const page = await connect(pageTarget.webSocketDebuggerUrl);
  await page.send("Page.enable");
  await page.send("Runtime.enable");
  log("Navigating to", TEST_URL);
  await page.send("Page.navigate", { url: TEST_URL });
  await page.waitForEvent("Page.loadEventFired", 20000);
  await sleep(2500);

  log("Page URL:", await page.eval("document.URL"));
  log("Before H1:", await page.eval("document.querySelector('h1')?document.querySelector('h1').innerText:'NO-H1'"));

  // ping content script via SW -> tab (chrome.tabs.* works in SW eval)
  const ping = await swc.eval(`new Promise(r=>chrome.tabs.query({active:true,currentWindow:true},t=>{if(!t||!t.length)return r('notab');chrome.tabs.sendMessage(t[0].id,{type:'ping'},resp=>{const e=chrome.runtime.lastError;r(e?('ERR:'+e.message):JSON.stringify(resp));});}))`);
  log("content ping:", ping);
  if (ping === '{"ok":true}') pass("content script alive (ping)"); else fail("content script ping: " + ping);

  // Verify settings present via background getSettings (background reads storage in its own context)
  if (cfgGet && cfgGet.includes('deepseek-v4-flash')) pass("settings configured in storage"); else fail("settings not configured: " + cfgGet);

  await test1Translate(page, swc);
  await test2Restore(page, swc);
  await test3Selection(page, swc);
  await test4Summary(page, swc);
  await test5Dashboard(swc);
  await test6InjectOnFailure(swc);

  await cleanup();
  async function cleanup() {
    try { chrome.kill("SIGTERM"); } catch {}
    try { // kill any lingering child chrome processes from this profile
      const { execSync } = require("child_process");
      execSync(`powershell -Command "Get-CimInstance Win32_Process -Filter \\"Name='msedge.exe' OR Name='chrome.exe'\\" | Where-Object { $_.CommandLine -match '${PROFILE_DIR.replace(/\\/g,'\\\\')}' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"`, { stdio: "ignore" });
    } catch {}
    try { fs.rmSync(PROFILE_DIR, { recursive: true, force: true }); } catch {}
    log("\n=== RESULT: " + (failures === 0 ? "ALL TESTS PASSED ✓" : failures + " TEST(S) FAILED ✗") + " ===");
    process.exit(failures === 0 ? 0 : 1);
  }
}

async function sendToTab(swc, type) {
  return swc.eval(`new Promise(r=>chrome.tabs.query({active:true,currentWindow:true},t=>{if(!t||!t.length)return r('notab');chrome.tabs.sendMessage(t[0].id,${JSON.stringify({type})},resp=>{const e=chrome.runtime.lastError;r(e?('ERR:'+e.message):'ack');});}))`);
}

async function test1Translate(page, swc) {
  log("\n=== TEST 1: Full-page translation ===");
  await sendToTab(swc, "translatePage");
  for (let i = 0; i < 150; i++) {
    await sleep(1000);
    const v = JSON.parse(await page.eval(`(function(){var h=document.querySelector("h1")?document.querySelector("h1").innerText:"";return JSON.stringify({h1:h,hasCjk:/[\\u4e00-\\u9fff]/.test(h),banner:!!document.querySelector(".ait-banner"),phase:document.documentElement.getAttribute("data-ait-phase")||"",inst:document.documentElement.getAttribute("data-ait-inst")||"0",tp:document.documentElement.getAttribute("data-ait-tp")||"0"});})()`) || "{}");
    if (i % 5 === 0) log(`  poll ${i}: h1="${(v.h1||"").slice(0,40)}" cjk=${v.hasCjk} banner=${v.banner} phase="${(v.phase||"")}" inst=${v.inst||"?"} tp=${v.tp||"?"}`);
    if (v.hasCjk && !v.banner) {
      pass("page translated to Chinese: " + (v.h1||"").slice(0, 40));
      await page.screenshot(path.join(__dirname, "shot-translate.png"));
      log("saved shot-translate.png");
      return;
    }
  }
  fail("page not translated (phase=" + (await page.eval("document.documentElement.getAttribute('data-ait-phase')||'none'")) + ", banner=" + (await page.eval("!!document.querySelector('.ait-banner')")) + ")");
  await page.screenshot(path.join(__dirname, "shot-translate-fail.png"));
}

async function test2Restore(page, swc) {
  log("\n=== TEST 2: Restore original ===");
  await sendToTab(swc, "restorePage");
  await sleep(1000);
  const h1 = await page.eval("document.querySelector('h1')?document.querySelector('h1').innerText:''");
  log("Restored H1:", h1);
  if ((h1 || "").includes("Artificial Intelligence")) pass("restore original"); else fail("restore: " + h1);
}

async function test3Selection(page, swc) {
  log("\n=== TEST 3: Selection translation ===");
  await page.eval(`(function(){var h=document.querySelector("h1");var range=document.createRange();range.selectNode(h);var sel=window.getSelection();sel.removeAllRanges();sel.addRange(range);document.dispatchEvent(new MouseEvent("mouseup",{bubbles:true,cancelable:true,view:window}));return sel.toString();})()`);
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    const v = JSON.parse(await page.eval(`(function(){var t=document.querySelector(".ait-tooltip");if(!t)return JSON.stringify({show:false});var b=t.querySelector(".ait-tooltip-body");return JSON.stringify({show:t.classList.contains("ait-show"),body:b?b.innerText:"",loading:t.classList.contains("ait-loading")});})()`) || "{}");
    if (i % 5 === 0) log(`  poll ${i}: show=${v.show} loading=${v.loading} body="${(v.body||"").slice(0,30)}"`);
    if (v.show && !v.loading && v.body) {
      if (/[\u4e00-\u9fff]/.test(v.body)) {
        pass("selection tooltip: " + v.body.slice(0, 40));
        await page.screenshot(path.join(__dirname, "shot-selection.png"));
        log("saved shot-selection.png");
      } else fail("selection not Chinese: " + v.body);
      return;
    }
  }
  fail("selection tooltip failed");
}

async function test4Summary(page, swc) {
  log("\n=== TEST 4: Webpage summary ===");
  await sendToTab(swc, "summarizePage");
  for (let i = 0; i < 90; i++) {
    await sleep(1000);
    const v = JSON.parse(await page.eval(`(function(){var m=document.querySelector(".ait-modal");if(!m)return JSON.stringify({show:false});var b=m.querySelector(".ait-modal-body");return JSON.stringify({show:m.classList.contains("ait-show"),text:b?b.innerText:"",loading:!!m.querySelector(".ait-modal-loading")});})()`) || "{}");
    if (i % 5 === 0) log(`  poll ${i}: show=${v.show} loading=${v.loading} text="${(v.text||"").slice(0,40)}"`);
    if (v.show && !v.loading && v.text && v.text.length > 20) {
      pass("summary modal shown (" + v.text.length + " chars)");
      log("\n=== Summary content ===\n" + v.text.slice(0, 800) + "\n");
      await page.screenshot(path.join(__dirname, "shot-summary.png"));
      log("saved shot-summary.png");
      return;
    }
  }
  fail("summary modal failed");
}

async function findPageTargetByUrl(urlFragment) {
  for (let i = 0; i < 40; i++) {
    const ts = await httpJson(`http://127.0.0.1:${PORT}/json`);
    const t = ts.find(t => t.type === "page" && t.url.includes(urlFragment));
    if (t) return t;
    await sleep(500);
  }
  return null;
}

async function test5Dashboard(swc) {
  log("\n=== TEST 5: Management dashboard ===");
  // Open the dashboard page in a new tab via the service worker.
  await swc.eval(`new Promise(r=>chrome.tabs.create({url:chrome.runtime.getURL('dashboard.html')},t=>r(String(t?t.id:'none'))))`);
  const target = await findPageTargetByUrl("dashboard.html");
  if (!target) { fail("dashboard tab not opened"); return; }
  const dash = await connect(target.webSocketDebuggerUrl);
  await dash.send("Page.enable");
  await dash.send("Runtime.enable");
  await sleep(1500);

  // --- Config tab: API key should be loaded from storage ---
  const apiKeyVal = await dash.eval(`document.getElementById('apiKey').value`);
  log("  dashboard apiKey:", (apiKeyVal || "").slice(0, 8) + "...");
  if (apiKeyVal && apiKeyVal.startsWith("sk-")) pass("dashboard config tab loaded with API key"); else fail("dashboard config: " + apiKeyVal);

  // --- Language tab: switch source to en, target to en, save ---
  // Click the "English" source button (2nd source seg-btn) and verify storage updates.
  await dash.eval(`(function(){var btns=document.querySelectorAll('#panel-language .field:nth-child(1) .seg-btn');btns[2].click();return 'clicked';})()`);
  await sleep(200);
  await dash.eval(`document.getElementById('saveLangBtn').click()`);
  await sleep(800);
  const srcLang = await swc.eval(`new Promise(r=>chrome.storage.sync.get('sourceLang',v=>r(v.sourceLang||'none')))`);
  log("  sourceLang after switch:", srcLang);
  if (srcLang === "en") pass("dashboard language tab switches source language"); else fail("dashboard language switch: " + srcLang);
  // restore to auto for cleanliness
  await swc.eval(`new Promise(r=>chrome.storage.sync.set({sourceLang:'auto'},()=>r('ok')))`);

  // --- Stats tab: should reflect the translations done in tests 1/3/4 ---
  await dash.eval(`(function(){var t=document.querySelector('.tab[data-tab=\\'stats\\']');t.click();return t.classList.contains('active');})()`);
  await sleep(1200);
  const stats = JSON.parse(await dash.eval(`(function(){return JSON.stringify({req:document.getElementById('statRequests').textContent,total:document.getElementById('statTotal').textContent,bd:document.getElementById('breakdownKind').children.length});})()`) || "{}");
  log("  stats:", JSON.stringify(stats));
  const reqNum = parseInt((stats.req || "0").replace(/,/g, ""), 10);
  const totalNum = parseInt((stats.total || "0").replace(/,/g, ""), 10);
  if (reqNum >= 3 && totalNum > 0 && stats.bd >= 3) pass(`dashboard stats tab shows usage (req=${reqNum}, tokens=${totalNum})`);
  else fail("dashboard stats: " + JSON.stringify(stats));
  await dash.screenshot(path.join(__dirname, "shot-dashboard-stats.png"));

  // --- History tab: should list records ---
  await dash.eval(`(function(){var t=document.querySelector('.tab[data-tab=\\'history\\']');t.click();return t.classList.contains('active');})()`);
  await sleep(1200);
  const hist = JSON.parse(await dash.eval(`(function(){var list=document.getElementById('historyList');var empty=document.getElementById('historyEmpty');return JSON.stringify({items:list?list.children.length:0,emptyShown:empty?empty.style.display:''});})()`) || "{}");
  log("  history:", JSON.stringify(hist));
  if (hist.items >= 3 && hist.emptyShown === "none") pass(`dashboard history tab lists ${hist.items} records`);
  else fail("dashboard history: " + JSON.stringify(hist));
  await dash.screenshot(path.join(__dirname, "shot-dashboard-history.png"));
  log("saved dashboard screenshots");
}

async function test6InjectOnFailure(swc) {
  log("\n=== TEST 6: Programmatic content-script injection (http page) ===");
  // The real "Cannot reach this page." bug: a tab open BEFORE the extension
  // loaded has no content script, so sendMessage fails. The fix injects
  // content.js programmatically. We can't reproduce "http page without
  // content script" here (the extension is always loaded and injects on
  // every http navigation), but we verify the injection mechanism itself is
  // PERMITTED and SUCCEEDS on a real http page (the actual user scenario).
  const tabIdStr = await swc.eval(`new Promise(r=>{chrome.tabs.create({url:'${TEST_URL}'},t=>r(String(t?t.id:'none')));})`);
  log("  created http tab:", tabIdStr);
  const tabId = parseInt(tabIdStr, 10);
  await sleep(3000);

  // 1. ping works (manifest injected the content script)
  const ping1 = await swc.eval(`new Promise(r=>{chrome.tabs.sendMessage(${tabId},{type:'ping'},resp=>{const e=chrome.runtime.lastError;r(e?('ERR:'+e.message):JSON.stringify(resp));});})`);
  log("  ping (manifest):", ping1);
  if (ping1 === '{"ok":true}') pass("content script reachable via manifest on http page"); else fail("ping failed on http page: " + ping1);

  // 2. Programmatically inject content.js + content.css (what ensureContentScript does on failure).
  //    The __aitInjected guard makes re-injection a no-op, but the call must NOT throw —
  //    this proves host permission allows injection on real http pages.
  const injectRes = await swc.eval(`new Promise(r=>{Promise.all([chrome.scripting.insertCSS({target:{tabId:${tabId}},files:['content.css']}).catch(()=>{}),chrome.scripting.executeScript({target:{tabId:${tabId}},files:['content.js']})]).then(()=>r('ok')).catch(e=>r('ERR:'+(e&&e.message||e)));})`);
  log("  programmatic inject:", injectRes);
  if (injectRes === "ok") pass("programmatic injection permitted on http page"); else fail("programmatic injection blocked: " + injectRes);

  // 3. ping still works after injection
  const ping2 = await swc.eval(`new Promise(r=>{chrome.tabs.sendMessage(${tabId},{type:'ping'},resp=>{const e=chrome.runtime.lastError;r(e?('ERR:'+e.message):JSON.stringify(resp));});})`);
  log("  ping (after inject):", ping2);
  if (ping2 === '{"ok":true}') pass("content script still reachable after programmatic injection"); else fail("ping failed after injection: " + ping2);

  // cleanup: close the tab
  try { await swc.eval(`new Promise(r=>{chrome.tabs.remove(${tabId},()=>r('closed'));})`); } catch {}
}

main().catch(e => { console.error("[test] fatal", e); process.exit(1); });
