// Screenshots after restoring the ClientScope Work Agent card to the sidebar
// and removing the Encode Club footer line. Never starts a hire.
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
    sendSponsoredTransaction: async (a, tx) => { window.__calls.push({ pay: String(a.address ?? a), version: tx.version }); return "f".repeat(64); },
  };`;

async function page({ w = 1440, h = 900, wallet } = {}) {
  const ctx = await b.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2 });
  const p = await ctx.newPage();
  if (wallet) await p.addInitScript(mockWallet(wallet));
  return [ctx, p];
}
const ready = async (p) => {
  await p.waitForSelector("text=Verified by Concordium", { timeout: 60000 });
  await p.waitForSelector("text=Job server online", { timeout: 60000 });
  await p.locator("[data-agent=card]").filter({ visible: true }).first().waitFor({ timeout: 15000 });
  await p.locator("text=CIS-8004").filter({ visible: true }).first().waitFor({ timeout: 15000 });
};
const want = (n) => !only || n.includes(only);
const shot = async (p, name, full = true) => {
  await p.screenshot({ path: OUT + `redesign3-${name}.png`, fullPage: full });
  console.log("saved", name);
};
const shotEl = async (p, name, sel) => {
  const el = await p.$(sel);
  await el.screenshot({ path: OUT + `redesign3-${name}.png` });
  console.log("saved", name);
};

// a: idle — New Job centred, no job progress, agent card last in the sidebar, footer without Encode
for (const [name, w, h, full] of [
  ["a-idle-desktop-fold", 1440, 900, false],
  ["a-idle-desktop", 1440, 900, true],
  ["a-idle-mobile", 390, 844, true],
]) {
  if (!want(name) && !want("idle")) continue;
  const [ctx, p] = await page({ w, h, wallet: { connected: false } });
  await p.goto(BASE, { waitUntil: "networkidle" });
  await ready(p);
  await p.waitForTimeout(1400);
  const foot = await p.locator("footer").innerText();
  if (/encode|hackathon/i.test(foot)) throw new Error("footer still mentions Encode or the hackathon: " + foot);
  console.log("footer:", foot.trim());
  await shot(p, name, full);
  if (name === "a-idle-desktop") {
    await shotEl(p, "a-agent-card", "aside [data-agent=card]");
    await p.evaluate(() => document.querySelector("footer")?.scrollIntoView({ block: "end" }));
    await p.waitForTimeout(400);
    await shot(p, "a-idle-desktop-footer", false);
  }
  if (name === "a-idle-mobile") await shotEl(p, "a-agent-card-mobile", "[data-agent=card]");
  await ctx.close();
}

// b: finished wallet hire — job progress above the agent card, agent still last
if (want("finished") || !only) {
  for (const [sfx, w, h] of [["desktop", 1440, 900], ["mobile", 390, 844]]) {
    const [ctx, p] = await page({ w, h, wallet: { connected: true } });
    await p.goto(BASE + "?run=5cc058e1bd", { waitUntil: "networkidle" });
    await ready(p);
    await p.waitForSelector('main[data-run-status="finished"]');
    await p.waitForTimeout(1800);
    if (sfx === "desktop") {
      await p.evaluate(() => document.querySelector("main")?.scrollIntoView({ block: "start" }));
      await p.waitForTimeout(500);
      await shot(p, "b-finished-desktop-fold", false);
      await shot(p, "b-finished-desktop");
      await p.evaluate(() => document.querySelector("aside [data-agent=card]")?.scrollIntoView({ block: "center" }));
      await p.waitForTimeout(400);
      await shot(p, "b-finished-desktop-agent", false);
    } else {
      await shot(p, "b-finished-mobile");
    }
    await ctx.close();
  }
}

await b.close();
