// Screenshots for Feature 6 (wallet) and the jobs list. The Concordium wallet is MOCKED in the screenshot browser only
// (window.concordium injected before load). No hire is started; the pending-approval state replays a finished run.
import { chromium } from "playwright-core";
const OUT = "/workspace/clientscope/build-log/";
const BASE = "http://127.0.0.1:8000/";
const ACC = "4j6RhVCWEG3GDQcwcgSQRxu7nmXSC4V834YrsVtudomCG6ueMH";
const only = process.argv[2];
const b = await chromium.launch({ executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox"] });

const mockWallet = ({ connected }) => `
  window.__calls = [];
  window.concordium = {
    getMostRecentlySelectedAccount: async () => ${connected ? `"${ACC}"` : "undefined"},
    requestAccounts: async () => ["${ACC}"],
    getSelectedChain: async () => "4221332d34e1694168c2a0c0b3fd0f273809612cb13d000d5c2e00e85f50f796",
    on() {},
    signMessage: async (a, m) => { window.__calls.push({ sign: String(a), message: m }); return { 0: { 0: "ab".repeat(64) } }; },
    sendSponsoredTransaction: async (a, tx) => { window.__calls.push({ pay: String(a.address ?? a), version: tx.version, sender: tx.header?.sender?.address,
      sponsor: tx.header?.sponsor?.account?.address, sponsorSigs: Object.keys(tx.signatures?.sponsor || {}).length, type: tx.payload?.type }); return "f".repeat(64); },
  };`;

const done = await (await fetch(BASE + "api/runs/5cc058e1bd")).json();
const pend = { ...done, id: "approvereplay", status: "running", outcome: null, finished: null, audit_source: "live",
  started: new Date(Date.now() - 31000).toISOString(),
  steps: done.steps.map((s) => s.key === "settle" ? { key: s.key, status: "running", items: [], at: s.at, detail: "Delivery passed. Approve the 1 EUDemo payment in your wallet. ClientScope pays the network fee." }
    : s.key === "anchor" ? { key: s.key, status: "pending", items: [] } : s),
  audit: done.audit.slice(0, 12), result: { sheet_url: done.result.sheet_url, products: done.result.products, badge_summary: done.result.badge_summary,
    payment_request_expires: new Date(Date.now() + 560000).toISOString(), payment_request: null } };

async function page({ w = 1440, h = 900, wallet, mock }) {
  const ctx = await b.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2 });
  const p = await ctx.newPage();
  if (wallet) await p.addInitScript(mockWallet(wallet));
  if (mock) for (const [url, fn] of mock) await p.route(url, fn);
  return [ctx, p];
}
const ready = async (p) => { await p.waitForSelector("text=Verified by Concordium", { timeout: 60000 }); await p.waitForSelector("text=Job server online", { timeout: 60000 }); };
const shotEl = async (p, name, sel) => { await (await p.$(sel)).screenshot({ path: OUT + `redesign2-${name}.png` }); console.log("saved", name); };
const shot = async (p, name, full = true) => { await p.screenshot({ path: OUT + `redesign2-${name}.png`, fullPage: full }); console.log("saved", name); };
const want = (n) => !only || n.includes(only);

// a/b/c: wallet states
for (const [name, wallet, w, h] of [["a-wallet-not-connected-desktop", { connected: false }, 1440, 900], ["a-wallet-not-connected-mobile", { connected: false }, 390, 844],
  ["b-wallet-connected-mocked-desktop", { connected: true }, 1440, 900], ["b-wallet-connected-mocked-mobile", { connected: true }, 390, 844],
  ["c-wallet-missing-desktop", null, 1440, 900], ["c-wallet-missing-mobile", null, 390, 844]]) {
  if (!want(name)) continue;
  const [ctx, p] = await page({ w, h, wallet });
  await p.goto(BASE, { waitUntil: "networkidle" }); await ready(p);
  await p.waitForSelector(wallet ? (wallet.connected ? "[data-wallet=connected]" : "[data-wallet=disconnected]") : "[data-wallet=missing]", { timeout: 10000 });
  await p.waitForTimeout(1200);
  await shot(p, name);
  if (name.startsWith("a-wallet-not-connected-desktop")) await shotEl(p, "a-jobs-list-card", "main section");
  await ctx.close();
}

// d/e: custom job form and draft plan (the POST goes to the real local API and is stored in dashboard/.run/custom-jobs.json)
for (const [sfx, w, h] of [["desktop", 1440, 900], ["mobile", 390, 844]]) {
  if (!want("custom")) continue;
  const [ctx, p] = await page({ w, h, wallet: { connected: false } });
  await p.goto(BASE, { waitUntil: "networkidle" }); await ready(p);
  await p.click("[data-job=custom] > button");
  await p.waitForSelector("[data-custom=form]");
  await p.fill("[data-custom=form] textarea >> nth=0", "Every Monday, collect the prices and stock of our 20 best-selling products from our two suppliers, and flag anything that went up since last week.");
  await p.fill("[data-custom=form] textarea >> nth=1", "https://henry-n41.github.io/clientscope-supplier-demo/\nhttps://www.example-supplier.co.uk/catalogue");
  await p.click("text=Email summary"); await p.click("button:has-text('Weekly')");
  await p.fill("[data-custom=form] input[type=number]", "2");
  await p.waitForTimeout(700);
  await p.evaluate(() => document.querySelector("[data-job=custom]").scrollIntoView({ block: "start" }));
  await p.waitForTimeout(500);
  await shot(p, `d-custom-form-${sfx}`, sfx === "mobile");
  if (sfx === "desktop") await shotEl(p, "d-custom-form-card", "[data-job=custom]");
  await p.click("button:has-text('Get a draft plan')");
  await p.waitForSelector("[data-custom=plan]"); await p.waitForTimeout(1200);
  await p.evaluate(() => document.querySelector("[data-job=custom]").scrollIntoView({ block: "start" }));
  await p.waitForTimeout(500);
  await shot(p, `e-custom-plan-${sfx}`, sfx === "mobile");
  if (sfx === "desktop") await shotEl(p, "e-custom-plan-card", "[data-job=custom]");
  await ctx.close();
}

// f: delivery passed, waiting for the client's approval (replay; the payment request JSON is a real sponsor-signed request
//    shape built locally with a throwaway key, never submitted). Clicking Approve exercises the browser code path with the mock.
if (want("approve")) {
  const { buildPaymentTransaction, sponsorSign, toWalletJSON } = await import("/workspace/clientscope/x402/wallet_flow.mjs");
  const { generateKeyPairSync } = await import("node:crypto");
  const k = Buffer.from(generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" }).d, "base64url").toString("hex");
  pend.result.payment_request = toWalletJSON(await sponsorSign(buildPaymentTransaction({ buyer: ACC, jobId: done.job_id, nonce: 99n }), k));
  let paid = null;
  for (const [sfx, w, h] of [["desktop", 1440, 900], ["mobile", 390, 844]]) {
    const [ctx, p] = await page({ w, h, wallet: { connected: true }, mock: [
      ["**/api/runs/approvereplay/events", (r) => r.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body: `data: ${JSON.stringify(pend)}\n\n` })],
      ["**/api/runs/approvereplay", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(pend) })],
      ["**/api/wallet/pay", (r) => { paid = r.request().postDataJSON(); r.fulfill({ status: 200, contentType: "application/json", body: "{\"ok\":true}" }); }],
    ] });
    await p.goto(BASE + "?run=approvereplay", { waitUntil: "networkidle" }); await ready(p);
    await p.waitForSelector("[data-approve=pending] >> visible=true"); await p.waitForTimeout(1800);
    if (sfx === "desktop") { await p.evaluate(() => document.querySelector("main").scrollIntoView({ block: "start" })); await p.waitForTimeout(600); await shot(p, "f-approve-payment-desktop", false); }
    else await shot(p, "f-approve-payment-mobile");
    if (sfx === "desktop") {
      await p.click("button:has-text('Approve in wallet') >> visible=true");
      await p.waitForFunction(() => window.__calls?.some((c) => c.pay), null, { timeout: 15000 });
      await p.waitForTimeout(800);
      console.log("wallet mock received:", JSON.stringify(await p.evaluate(() => window.__calls)));
      console.log("dashboard POST /api/wallet/pay:", JSON.stringify(paid));
    }
    await ctx.close();
  }
}

// g: a real finished wallet hire (run 5cc058e1bd, approved by the e2e script acting as the wallet)
if (want("finished")) {
  for (const [sfx, w, h] of [["desktop", 1440, 900], ["mobile", 390, 844]]) {
    const [ctx, p] = await page({ w, h, wallet: { connected: true } });
    await p.goto(BASE + "?run=5cc058e1bd", { waitUntil: "networkidle" }); await ready(p);
    await p.waitForSelector('main[data-run-status="finished"]'); await p.waitForTimeout(2000);
    if (sfx === "desktop") { await p.evaluate(() => document.querySelector("main").scrollIntoView({ block: "start" })); await p.waitForTimeout(500); await shot(p, "g-wallet-hire-finished-desktop", false); await shot(p, "g-wallet-hire-finished-desktop-full"); }
    else await shot(p, "g-wallet-hire-finished-mobile");
    await ctx.close();
  }
}

// h: the start of a wallet hire in the browser, with the wallet AND the hire API mocked (checks the sign step wiring; no hire starts)
if (want("flow")) {
  let started = null, verified = null;
  const [ctx, p] = await page({ wallet: { connected: true }, mock: [
    ["**/api/wallet/start", (r) => { started = r.request().postDataJSON(); r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ run_id: "flowtest01", job_id: "CS-TEST", message: "ClientScope buyer verification\njob: CS-TEST" }) }); }],
    ["**/api/wallet/verify", (r) => { verified = r.request().postDataJSON(); r.fulfill({ status: 200, contentType: "application/json", body: "{\"verified\":true}" }); }],
    ["**/api/runs/flowtest01**", (r) => r.fulfill({ status: 404, body: "" })],
  ] });
  await p.goto(BASE, { waitUntil: "networkidle" }); await ready(p);
  await p.waitForSelector("[data-wallet=connected]");
  await p.click("button:has-text('Hire ClientScope')");
  await p.waitForFunction(() => window.__calls?.some((c) => c.sign), null, { timeout: 10000 }); await p.waitForTimeout(800);
  console.log("start body:", JSON.stringify(started), "| wallet signMessage:", JSON.stringify(await p.evaluate(() => window.__calls)), "| verify body:", JSON.stringify(verified));
  await ctx.close();
}
await b.close();
