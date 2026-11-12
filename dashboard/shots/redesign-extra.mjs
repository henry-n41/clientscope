// Extra checks without starting a hire: failure picker, and the 409 message (the hire request is intercepted in the browser).
import { chromium } from "playwright-core";
const OUT = "/workspace/clientscope/build-log/";
const b = await chromium.launch({ executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox"] });
const p = await b.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
let hits = 0;
await p.route("**/api/hire", (r) => { hits++; r.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ detail: "a hire is already running, try again in a moment" }) }); });
await p.goto("http://127.0.0.1:8000/", { waitUntil: "networkidle" });
await p.waitForSelector("text=Verified by Concordium"); await p.waitForSelector("text=Job server online");
await p.click("text=Simulate a failure");
await p.selectOption("select", "impostor");
await p.click("button:has-text('Hire ClientScope')");
await p.waitForSelector("text=Another hire is already running");
await p.waitForTimeout(800);
const card = await p.$("main section");
await card.screenshot({ path: OUT + "redesign-e-failure-picker-and-409.png" });
console.log("hire requests intercepted:", hits, "| progress visible:", await p.$$eval("text=Job progress", (e) => e.length));
await b.close();
