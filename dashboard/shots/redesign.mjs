// Redesign screenshots. Never starts a hire: mid-run is a replay of a finished run with later steps reset (mocked in the browser only).
import { chromium } from "playwright-core";
const OUT = "/workspace/clientscope/build-log/";
const BASE = "http://127.0.0.1:8000/";
const only = process.argv[2];
const b = await chromium.launch({ executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox"] });

const ok = await (await fetch(BASE + "api/runs/09d5ff9ea1")).json();
const keep = ["badge", "buyer", "hold", "scrape"];
const mid = {
  ...ok, id: "midreplay", status: "running", outcome: null, finished: null, result: {}, audit_source: "live",
  started: new Date(Date.now() - 22000).toISOString(),
  steps: ok.steps.map((s) => keep.includes(s.key) ? s : s.key === "sheet" ? { key: s.key, title: s.title, hint: s.hint, status: "running", items: [], at: s.at } : { key: s.key, title: s.title, hint: s.hint, status: "pending", items: [] }),
  audit: ok.audit.slice(0, 9), console: ok.console.slice(0, 60),
};

async function shot(name, { w = 1440, h = 900, run, mock, full = true, scroll } = {}) {
  if (only && !name.includes(only)) return;
  const ctx = await b.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2 });
  const p = await ctx.newPage();
  if (mock) {
    await p.route("**/api/runs/midreplay/events", (r) => r.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body: `data: ${JSON.stringify(mid)}\n\n` }));
    await p.route("**/api/runs/midreplay", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(mid) }));
  }
  await p.goto(BASE + (run ? `?run=${run}` : ""), { waitUntil: "networkidle" });
  await p.waitForSelector("text=Verified by Concordium", { timeout: 60000 });
  await p.waitForSelector("text=Job server online", { timeout: 60000 });
  if (run && !mock) await p.waitForSelector('main[data-run-status="finished"]', { timeout: 60000 });
  if (mock) await p.waitForSelector('main[data-run-status="running"]', { timeout: 60000 });
  await p.waitForTimeout(2200);
  if (scroll) { await p.evaluate((s) => document.querySelector(s)?.scrollIntoView({ block: "start" }), scroll); await p.waitForTimeout(800); }
  await p.screenshot({ path: OUT + `redesign-${name}.png`, fullPage: full });
  console.log("saved", name);
  await ctx.close();
}

await shot("a-idle-desktop-fold", { full: false });
await shot("a-idle-desktop");
await shot("a-idle-mobile", { w: 390, h: 844 });
await shot("b-midrun-desktop", { run: "midreplay", mock: true });
await shot("b-midrun-desktop-fold", { run: "midreplay", mock: true, full: false, scroll: "main" });
await shot("b-midrun-mobile", { run: "midreplay", mock: true, w: 390, h: 844 });
await shot("c-finished-desktop", { run: "09d5ff9ea1" });
await shot("c-finished-desktop-fold", { run: "09d5ff9ea1", full: false, scroll: "main" });
await shot("c-finished-mobile", { run: "09d5ff9ea1", w: 390, h: 844 });
await shot("d-notcharged-delivery-desktop", { run: "6bc61e9c4c" });
await shot("d-refused-impostor-desktop", { run: "46332d1d9a" });
await shot("d-notcharged-mobile", { run: "6bc61e9c4c", w: 390, h: 844 });
await b.close();
