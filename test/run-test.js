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
  const cfgSet = await swc.eval(`new Promise(r=>chrome.storage.sync.set({apiKey:'REDACTED_API_KEY',baseUrl:'https://api.deepseek.com',model:'deepseek-v4-flash',targetLang:'zh',autoSelection:true,temperature:0.3,maxTokens:2048},()=>r('ok')))`);
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

main().catch(e => { console.error("[test] fatal", e); process.exit(1); });
