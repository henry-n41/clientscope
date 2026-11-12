// Screenshots of the local dashboard with headless Chrome. Usage: node shoot.mjs <idle|hire> [mode] [prefix]
import { chromium } from "playwright-core";
const [what, mode = "normal", prefix = "dash"] = process.argv.slice(2);
const OUT = "/workspace/clientscope/build-log/";
const b = await chromium.launch({ executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox"] });
const p = await b.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 });
const url = what === "view" ? `http://127.0.0.1:8000/?run=${mode}` : "http://127.0.0.1:8000/";
await p.goto(url, { waitUntil: "networkidle" });
await p.waitForSelector("text=Verified by Concordium", { timeout: 60000 });
await p.waitForSelector("text=Job server online", { timeout: 60000 });
if (what === "view") {
  await p.waitForSelector('main[data-run-status="finished"]', { timeout: 60000 });
  await p.waitForTimeout(1500);
  await p.screenshot({ path: OUT + `${prefix}.png`, fullPage: true });
} else if (what === "idle") {
  await p.screenshot({ path: OUT + `${prefix}-1-idle.png`, fullPage: true });
} else {
  if (mode !== "normal") {
    await p.click("text=Simulate a failure");
    await p.selectOption("select", mode);
  }
  await p.click("button:has-text('Hire ClientScope')");
  if (mode === "normal") {
    // mid-run: wait until the sheet is being built (or delivery is being checked)
    await p.waitForFunction(() => document.body.innerText.includes("Open sheet"), null, { timeout: 180000 });
    await p.waitForTimeout(1500);
    await p.screenshot({ path: OUT + `${prefix}-2-midrun.png`, fullPage: true });
  }
  await p.waitForSelector('main[data-run-status="finished"]', { timeout: 600000 });
  await p.waitForTimeout(4000);
  await p.screenshot({ path: OUT + `${prefix}-${mode === "normal" ? "3-finished" : "4-failed-" + mode}.png`, fullPage: true });
  const state = await p.evaluate(() => document.body.innerText);
  console.log(state.slice(0, 6000));
}
await b.close();
