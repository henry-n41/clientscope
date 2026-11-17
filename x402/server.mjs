// ClientScope paid job server: x402 on Concordium testnet, priced in EUDemo, PAY ON DELIVERY.
//  1. 402 -> client signs a sponsored EUDemo transfer (sender signature only).
//  2. Facilitator VERIFIES it (signature, amount, token, payTo, expiry, nonce, balance) but does NOT submit.
//  3. ClientScope runs the job and a delivery check.
//  4. Only if the check passes does the sponsor co-sign + submit (x402 "authorization" flow: settle after handler,
//     and the middleware skips settlement when the handler answers >= 400). If it fails, the payment is discarded.
import { NETWORK, GRPC, ASSET, PRICE_ATOMIC, CLIENTSCOPE_PAYTO, SPONSOR_ADDRESS, PORT, explorerTx, fmt, jsonSafe } from "./config.mjs";
import express from "express";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { x402Facilitator } from "@x402/core/facilitator";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactConcordiumScheme as ConcordiumServerScheme } from "@x402/concordium/exact/server";
import { ExactConcordiumScheme as ConcordiumFacilitatorScheme } from "@x402/concordium/exact/facilitator";
import { toConcordiumFacilitatorSigner } from "@x402/concordium";
import { Cbor, CborMemo } from "@concordium/web-sdk";
import { grpc, txStatus } from "./chain.mjs";
import { issueChallenge, verifyBuyer, sessionFor, BUYER_POLICY } from "./buyer_check.mjs";
import { CLIENTSCOPE_AGENT_ID, signHandshake, readAgent } from "./agent_trust.mjs";
import { watchAgent, inPool } from "./killswitch.mjs";
import { appendFileSync, existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { registerWalletRoutes } from "./wallet_flow.mjs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Project root and Python interpreter: the local .venv if there is one, otherwise CLIENTSCOPE_PYTHON or python3 (e.g. on Render).
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const VENV_PY = join(ROOT, ".venv", "bin", "python");
const PYTHON = process.env.CLIENTSCOPE_PYTHON || (existsSync(VENV_PY) ? VENV_PY : "python3");
const BUILD_LOG = join(ROOT, "build-log");
mkdirSync(BUILD_LOG, { recursive: true });

const PAYMENT_WINDOW_SECONDS = 600; // signed payment stays valid 10 min (max the facilitator allows) to cover the job
const now = () => new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC";
const log = (...a) => console.log(`[server ${new Date().toISOString().slice(11, 19)}]`, ...a);

if (!/^[0-9a-f]{64}$/i.test(process.env.CCD_SPONSOR_PRIVATE_KEY || "")) {
  console.error("CCD_SPONSOR_PRIVATE_KEY missing or not 64 hex chars"); process.exit(1);
}

const sponsorSigner = toConcordiumFacilitatorSigner(SPONSOR_ADDRESS, process.env.CCD_SPONSOR_PRIVATE_KEY, { ...GRPC, network: NETWORK });
const facilitator = new x402Facilitator();
facilitator.register(NETWORK, new ConcordiumFacilitatorScheme({
  signer: sponsorSigner, requireFinalization: true, finalizationTimeoutMs: 90_000, maxExpiryOffsetSeconds: PAYMENT_WINDOW_SECONDS,
}));

// ---- replay protection + job context ----
const keyOf = (p) => { const h = p?.payload?.signedTransaction?.header || {}; return `${h.sender}:${h.nonce}`; };
const usedJobIds = new Set();        // a job id can be used once
const seenPayments = new Set();      // sha256 of each signed payment: the exact same payment can never be presented twice
const lockedNonces = new Set();      // sender:nonce in flight or settled; released only if the payment is discarded
const jobs = new Map();              // payment key -> { jobId, sheetId, sheetUrl, delivered }

function py(script, input, args = []) {
  return new Promise((resolve, reject) => {
    const p = spawn(PYTHON, [`x402/${script}`, ...args], { cwd: ROOT, env: process.env });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (err += d));
    p.stdin.end(JSON.stringify(input));
    p.on("close", (code) => code === 0 ? resolve(JSON.parse(out.trim().split("\n").pop())) : reject(new Error(err.slice(-600))));
  });
}

// Feature 2: hash the finished Audit Log + Products into a receipt and anchor it on Concordium (RegisterData).
async function anchorJob(job, paymentTx, halt = null) {
  try {
    log("anchoring receipt: hashing Audit Log + Products, RegisterData from operator account ...");
    const a = await py("receipt.py", { sheet_id: job.sheetId, job_id: job.jobId, buyer: job.buyer, payment_tx: paymentTx || null, delivered: job.delivered, buyer_verification: job.buyerVerification, halt }, ["anchor"]);
    log(`anchored: log_sha256=${a.log_sha256.slice(0, 16)}... (${a.rows_covered} rows) receipt_sha256=${a.receipt_sha256.slice(0, 16)}... tx=${a.anchor.tx_hash} fee=${a.anchor.fee_ccd} CCD`);
    job.anchor = a; return a;
  } catch (e) { log("anchoring FAILED:", e.message); return null; }
}

const resourceServer = new x402ResourceServer({
  verify: async (p, r) => {
    const v = await facilitator.verify(p, r);
    log(`verify (no submit) -> isValid=${v.isValid}${v.invalidReason ? " reason=" + v.invalidReason : ""} payer=${(v.payer || "").slice(0, 10)}...`);
    return v;
  },
  settle: async (p, r) => {
    const job = jobs.get(keyOf(p));
    if (!job?.delivered) { // defence in depth: never settle an undelivered job
      log("settle refused: job not delivered");
      return { success: false, network: r.network, transaction: "", payer: "", errorReason: "not_delivered" };
    }
    // Kill switch, last line of defence: re-read the buyer agent on chain right before the sponsor co-signs.
    let revoked = job.halted;
    if (!revoked && job.buyerAgentId) {
      let a = null; try { a = await readAgent(grpc(), job.buyerAgentId); } catch {}
      revoked = a?.status !== "Active";
      if (revoked) log(`buyer agent #${job.buyerAgentId} is ${a?.status || "unreadable"} on chain`);
    }
    if (revoked) {
      job.stopWatch?.();
      log("settle refused: KILL SWITCH, the buyer agent was revoked after delivery and before settlement -> payment never submitted");
      const hh = job.haltInfo?.() || { reason: "buyer_agent_revoked", token_id: job.buyerAgentId, stage: "before_settlement" };
      const t = now();
      const rows = [[t, "kill_switch_revoked", `buyer agent #${job.buyerAgentId} revoked on chain before settlement: revoke_tx=${hh.revoke_tx || "not found"} ${hh.revoke_tx ? explorerTx(hh.revoke_tx) : ""}`],
        [t, "job_halted", "delivered work withheld from settlement: a revoked agent's payment is never settled"],
        [t, "payment_not_taken", "signed payment discarded, never submitted to chain; buyer not charged"]];
      try { await py("append_audit.py", { sheet_id: job.sheetId, rows }); } catch (e) { log("audit append failed:", e.message); }
      job.delivered = false;
      await anchorJob(job, null, { ...hh, stage: hh.stage || "before_settlement" });
      return { success: false, network: r.network, transaction: "", payer: "", errorReason: "buyer_agent_revoked" };
    }
    job.stopWatch?.();
    log("delivery passed -> sponsor co-signs, submits, waits for finality ...");
    const t0 = Date.now();
    const s = await facilitator.settle(p, r);
    const secs = (Date.now() - t0) / 1000;
    log(`settle -> success=${s.success} tx=${s.transaction || "-"}${s.errorReason ? " reason=" + s.errorReason : ""} (${secs.toFixed(1)}s)`);
    const t = now();
    let rows;
    if (s.success) {
      const st = jsonSafe(await txStatus(grpc(), s.transaction));
      const sum = st?.outcome?.summary || {};
      const sponsor = typeof sum.sponsor?.sponsor === "string" ? sum.sponsor.sponsor : SPONSOR_ADDRESS;
      const fee = sum.sponsor?.cost != null ? fmt(String(sum.sponsor.cost)) : "?";
      rows = [
        [t, "payment_settled", `tx=${s.transaction} status=${st?.status} amount=${fmt(PRICE_ATOMIC)} ${ASSET} payer=${s.payer} memo=${job.jobId} (settled AFTER delivery)`],
        [t, "fee_sponsored", `sponsor=${sponsor} paid fee=${fee} CCD, buyer fee=${fmt(String(sum.cost ?? 0))} CCD`],
        [t, "payment_receipt", explorerTx(s.transaction)],
      ];
      log(`fee ${fee} CCD paid by sponsor; buyer fee ${fmt(String(sum.cost ?? 0))} CCD`);
    } else {
      rows = [[t, "payment_failed", `delivered but settlement failed: ${s.errorReason}`]];
    }
    try { await py("append_audit.py", { sheet_id: job.sheetId, rows }); log("receipt written to Audit Log"); }
    catch (e) { log("audit append failed:", e.message); }
    await anchorJob(job, s.success ? s.transaction : null);
    return s;
  },
  getSupported: async () => facilitator.getSupported(),
}).register(NETWORK, new ConcordiumServerScheme());

const app = express();
app.use(express.json({ limit: "256kb" }));
// Kill switch: a public, read-only job stage so the agent's owner (or the dashboard) knows when the job is running.
const jobStates = new Map();
app.get("/jobs/state/:jobId", (req, res) => { const st = jobStates.get(req.params.jobId); res.status(st ? 200 : 404).json(st || { stage: "unknown" }); });
app.get("/health", (_q, r) => r.json({ ok: true, network: NETWORK, asset: ASSET, price: PRICE_ATOMIC, payTo: CLIENTSCOPE_PAYTO, sponsor: SPONSOR_ADDRESS, flow: "pay-on-delivery", agent: `#${CLIENTSCOPE_AGENT_ID}`, handshake_signer: HANDSHAKE_SIGNER }));

function decodePayment(h) {
  const payload = JSON.parse(Buffer.from(h, "base64").toString("utf8"));
  const ops = Cbor.decode(Cbor.fromJSON(payload.payload.signedTransaction.payload.operations), "TokenOperation[]");
  const m = ops?.[0]?.transfer?.memo;
  let memo = null; try { memo = m ? String(CborMemo.parse(m)) : null; } catch {}
  return { payload, memo };
}
// ---- Feature 3: verify the buyer BEFORE any 402 / payment ----
const buyerLog = (entry) => appendFileSync(join(BUILD_LOG, "buyer-checks.jsonl"), JSON.stringify(entry) + "\n");
app.get("/buyer/policy", (_q, r) => r.json(BUYER_POLICY));
app.post("/buyer/challenge", (req, res) => {
  try { const c = issueChallenge(req.body.account, req.body.jobId, "", req.body.agentId ?? null); log(`buyer challenge issued: job=${req.body.jobId} account=${req.body.account.slice(0, 10)}... agent=#${req.body.agentId ?? "none"} nonce=${c.nonce.slice(0, 8)}...`); res.json(c); }
  catch (e) { res.status(400).json({ error: "bad_account" }); }
});
// Gap 2: ClientScope proves to a buyer agent that it controls registered agent #1010, by signing the BUYER's fresh nonce
// with its operating account key (an operator approved on the registry by #1010's owner; the buyer checks that on chain).
const HANDSHAKE_SIGNER = process.env.CLIENTSCOPE_HANDSHAKE_SIGNER || SPONSOR_ADDRESS;
const HANDSHAKE_KEY = process.env[process.env.CLIENTSCOPE_HANDSHAKE_KEY_ENV || "CCD_SPONSOR_PRIVATE_KEY"];
// Rehearsal only (local test runs): sign as another registered agent, e.g. #1211 with its owner key. Never set in production.
const HANDSHAKE_AGENT = BigInt(process.env.CLIENTSCOPE_HANDSHAKE_AGENT_ID || CLIENTSCOPE_AGENT_ID);
const handshakeNonces = new Set();
app.post("/agent/handshake", async (req, res) => {
  const { nonce, jobId, fromAgent } = req.body || {};
  if (!/^[0-9a-f]{32,64}$/i.test(String(nonce || "")) || !/^CS-[0-9A-Za-z-]{1,40}$/.test(String(jobId || "")) || !/^[0-9]{1,20}$/.test(String(fromAgent ?? ""))) return res.status(400).json({ error: "bad_request" });
  if (handshakeNonces.has(nonce)) return res.status(409).json({ error: "nonce_already_used" });
  if (handshakeNonces.size > 10000) handshakeNonces.clear();
  handshakeNonces.add(nonce);
  const h = await signHandshake({ agentId: HANDSHAKE_AGENT, signerAddress: HANDSHAKE_SIGNER, keyHex: HANDSHAKE_KEY, toAgent: fromAgent, nonce, jobId });
  log(`agent handshake signed for buyer agent #${fromAgent}: job=${jobId} nonce=${nonce.slice(0, 8)}... signer=${HANDSHAKE_SIGNER.slice(0, 10)}...`);
  res.json(h);
});
app.post("/buyer/verify", async (req, res) => {
  const r = await verifyBuyer(grpc(), req.body, { requireAgent: true });
  const short = Object.entries(r.checks).map(([k, v]) => `${k}=${v}`).join(" ");
  log(`buyer ${r.verified ? "VERIFIED" : "REJECTED"}: ${req.body.account?.slice(0, 10)}... ${short}`);
  const { session, ...pub } = r;
  buyerLog({ at: new Date().toISOString(), event: r.verified ? "buyer_verified" : "buyer_rejected", ...pub });
  res.status(r.verified ? 200 : 403).json(r);
});
app.use("/jobs/scrape", (req, res, next) => {
  const s = sessionFor(req.get("x-buyer-session"), req.body?.jobId);
  if (!s) { log(`POST /jobs/scrape job=${req.body?.jobId} -> 403 buyer not verified (no 402 issued, no payment possible)`); return res.status(403).json({ error: "buyer_not_verified" }); }
  const h = req.get("payment-signature");
  if (h) {
    try { const p = JSON.parse(Buffer.from(h, "base64").toString("utf8")); if (p.payload.signedTransaction.header.sender !== s.account) return res.status(403).json({ error: "payer_is_not_the_verified_buyer" }); }
    catch { return res.status(400).json({ error: "bad_payment_header" }); }
  }
  req.buyer = s.result; next();
});

// Memo binding + replay protection, before anything is verified.
app.use("/jobs/scrape", (req, res, next) => {
  const h = req.get("payment-signature");
  if (!h) { log(`POST /jobs/scrape job=${req.body?.jobId} (no payment) -> 402 Payment Required`); return next(); }
  let d; try { d = decodePayment(h); } catch (e) { return res.status(400).json({ error: "bad_payment_header" }); }
  const key = keyOf(d.payload);
  log(`POST /jobs/scrape job=${req.body?.jobId} with signed payment (nonce ${d.payload.payload.signedTransaction.header.nonce}), memo="${d.memo}"`);
  if (!req.body?.jobId || d.memo !== req.body.jobId) return res.status(400).json({ error: "memo_job_mismatch" });
  const digest = createHash("sha256").update(h).digest("hex");
  if (seenPayments.has(digest) || usedJobIds.has(req.body.jobId) || lockedNonces.has(key)) {
    log(`replay refused (${seenPayments.has(digest) ? "same signed payment" : usedJobIds.has(req.body.jobId) ? "job id already used" : "nonce in flight/settled"})`);
    return res.status(409).json({ error: "payment_or_job_already_used" });
  }
  seenPayments.add(digest); usedJobIds.add(req.body.jobId); lockedNonces.add(key);
  req.paymentKey = key; req.paymentMemo = d.memo; req.paymentHeader = d.payload.payload.signedTransaction.header;
  next();
});

app.use(paymentMiddleware({
  "POST /jobs/scrape": {
    accepts: [{
      scheme: "exact", network: NETWORK, payTo: CLIENTSCOPE_PAYTO,
      price: { amount: PRICE_ATOMIC, asset: ASSET, extra: { name: "EUDemo", decimals: 6 } }, // default flow = authorization (settle after delivery)
      maxTimeoutSeconds: PAYMENT_WINDOW_SECONDS,
    }],
    description: "ClientScope job (pay on delivery): scrape a supplier price page into a new Google Sheet with an Audit Log",
    mimeType: "application/json",
  },
}, resourceServer));

// Runs only after the payment VERIFIED. Nothing has been submitted yet.
app.post("/jobs/scrape", async (req, res) => {
  const h = req.paymentHeader;
  const t = now();
  const b = req.buyer;
  const auditRows = [
    ...(req.body.audit_rows || []),
    [t, "buyer_verified", `account=${b.facts.account} challenge signed + checked on chain: identity_provider=${b.facts.identity_provider?.id} (${b.facts.identity_provider?.name}) credential_valid_to=${b.facts.credential_valid_to} anonymity_revokers=${b.facts.anonymity_revokers} eudemo_allow_listed=true policy="${b.policy}"`],
    [t, "buyer_agent_verified", `by=ClientScope buyer agent #${b.facts.buyer_agent?.token_id} (${b.facts.buyer_agent?.token_address}) "${b.facts.buyer_agent?.name}" status=${b.facts.buyer_agent?.status} card_sha256=${b.facts.buyer_agent?.card_sha256} == on-chain metadata_hash, registry badge_valid=true, fresh challenge signed by its ${b.facts.buyer_agent?.signer_is} account ${b.facts.account}`],
    [t, "payment_required", `x402 402: ${fmt(PRICE_ATOMIC)} ${ASSET} (atomic ${PRICE_ATOMIC}) to payTo=${CLIENTSCOPE_PAYTO}, pay on delivery`],
    [t, "payment_authorized", `signed sponsored payment verified, NOT submitted: payer=${h.sender} nonce=${h.nonce} memo=${req.paymentMemo} expires=${new Date(h.expiry * 1000).toISOString().slice(0, 19).replace("T", " ")} UTC`],
  ];
  log("payment held (verified, not submitted) -> running agent_job.py + delivery check");
  // KILL SWITCH: while the job runs, watch the buyer agent's status on chain every second. If its owner revokes it,
  // the job is halted at the next checkpoint, the held payment is never settled, and the halt (naming the revoke tx) is anchored.
  const jobId = req.body.jobId;
  const buyerAgentId = b.facts.buyer_agent?.token_id ? String(b.facts.buyer_agent.token_id) : null;
  const haltFile = join(tmpdir(), `clientscope-halt-${jobId}.json`);
  rmSync(haltFile, { force: true });
  let halt = null;
  const stopWatch = buyerAgentId ? watchAgent(grpc(), buyerAgentId, { intervalMs: 1000, onRevoked: (info) => {
    halt = { reason: "buyer_agent_revoked", ...info };
    writeFileSync(haltFile, JSON.stringify(halt));
    log(`KILL SWITCH: buyer agent #${buyerAgentId} is ${info.status} on chain (revoke tx ${info.revoke_tx || "?"}, block ${info.block_height || "?"}), detected ${info.detection_seconds ?? "?"} s after the revoke's block -> halting job ${jobId}`);
  } }) : null;
  // Demo pacing: only for the throwaway kill-switch agents, so a person can watch the rows arrive and press the button.
  const pace = buyerAgentId && inPool(buyerAgentId) && req.body.demo_pace ? 4 : 0;
  jobStates.set(jobId, { stage: "running", buyer_agent: buyerAgentId, watching: !!stopWatch, pace_seconds: pace, started: new Date().toISOString() });
  let r;
  try { r = await py("run_job.py", { url: req.body.url, client: req.body.client, audit_rows: auditRows, halt_file: buyerAgentId ? haltFile : null, pace_seconds: pace }); }
  catch (e) { stopWatch?.(); jobStates.set(jobId, { stage: "error" }); log("job crashed:", e.message); lockedNonces.delete(req.paymentKey); return res.status(500).json({ job_id: req.body.jobId, status: "job_error", charged: false }); }
  if (r.halted) {
    stopWatch?.();
    jobStates.set(jobId, { stage: "halted" });
    const job = { jobId, sheetId: r.sheet_id, sheetUrl: r.sheet_url, delivered: false, halted: true, buyer: h.sender, buyerVerification: req.buyer, buyerAgentId };
    jobs.set(req.paymentKey, job);
    log(`job HALTED at ${r.stage} (${r.rows_done}/${r.rows_total ?? "?"} rows) -> signed payment discarded, never submitted (buyer not charged)`);
    lockedNonces.delete(req.paymentKey);
    const hh = { ...r.halt, stage: r.stage, rows_done: r.rows_done, rows_total: r.rows_total };
    let a = null;
    try {
      log("anchoring receipt: hashing Audit Log + Products, RegisterData from operator account ...");
      a = await py("receipt.py", { sheet_id: r.sheet_id, job_id: jobId, buyer: h.sender, payment_tx: null, delivered: false, buyer_verification: req.buyer, halt: hh }, ["anchor"]);
      log(`anchored: log_sha256=${a.log_sha256.slice(0, 16)}... (${a.rows_covered} rows) receipt_sha256=${a.receipt_sha256.slice(0, 16)}... tx=${a.anchor.tx_hash} fee=${a.anchor.fee_ccd} CCD`);
    } catch (e) { log("anchoring FAILED:", e.message); }
    rmSync(haltFile, { force: true });
    return res.status(409).json({ job_id: jobId, status: "halted_agent_revoked", charged: false, sheet_url: r.sheet_url, halt: hh,
      anchor: a && { tx_hash: a.anchor.tx_hash, receipt_sha256: a.receipt_sha256, log_sha256: a.log_sha256 } });
  }
  jobStates.set(jobId, { stage: "checked" });
  const c = r.check;
  log(`delivery check: sheet=${c.sheet_exists} auditLog=${c.audit_log_present} products=${c.products_rows} complete=${c.products_rows_complete} pageRows=${c.supplier_page_rows} -> ${r.passed ? "PASS" : "FAIL"}`);
  const job = { jobId: req.body.jobId, sheetId: r.sheet_id, sheetUrl: r.sheet_url, delivered: r.passed, buyer: h.sender, buyerVerification: req.buyer,
    buyerAgentId, stopWatch, get halted() { return !!halt; }, haltInfo: () => halt };
  jobs.set(req.paymentKey, job);
  if (!r.passed) {
    stopWatch?.();
    log("delivery FAILED -> signed payment discarded, never submitted (buyer not charged)");
    lockedNonces.delete(req.paymentKey); // the buyer may sign a new payment with the same nonce; the old one is dead
    const a = r.sheet_id ? await anchorJob(job, null) : null;
    return res.status(422).json({ job_id: req.body.jobId, status: "delivery_failed", charged: false, sheet_url: r.sheet_url, check: c,
      anchor: a && { tx_hash: a.anchor.tx_hash, receipt_sha256: a.receipt_sha256, log_sha256: a.log_sha256 } });
  }
  res.json({ job_id: req.body.jobId, status: "delivered", sheet_url: r.sheet_url, check: c, payment: "settles after this response is approved (see PAYMENT-RESPONSE header)" });
});

// Feature 6: buyers who approve with their own Concordium Browser Wallet (see wallet_flow.mjs for why the flow differs).
registerWalletRoutes(app, { log, py, anchorJob, grpc, txStatus, issueChallenge, verifyBuyer, sessionFor, buyerLog, now, usedJobIds,
  sponsorKey: process.env.CCD_SPONSOR_PRIVATE_KEY });

// Bind host: all interfaces by default (as before); set CLIENTSCOPE_X402_HOST=127.0.0.1 to keep the job server private
// when it runs behind the dashboard on a host such as Render (only the dashboard's $PORT is public there).
const X402_HOST = process.env.CLIENTSCOPE_X402_HOST;
const onListen = () => log(`ClientScope x402 server (pay on delivery) http://localhost:${PORT} price=${fmt(PRICE_ATOMIC)} ${ASSET} payTo=${CLIENTSCOPE_PAYTO.slice(0, 10)}... sponsor=${SPONSOR_ADDRESS.slice(0, 10)}... window=${PAYMENT_WINDOW_SECONDS}s`);
if (X402_HOST) app.listen(PORT, X402_HOST, onListen); else app.listen(PORT, onListen);
