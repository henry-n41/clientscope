// Feature 6: the client approves with their OWN Concordium Browser Wallet.
//
// Why this differs from the demo buyer's x402 flow: the Browser Wallet cannot sign a transaction without submitting it.
// Its only sponsored-transaction call, sendSponsoredTransaction, takes a transaction the SPONSOR has already signed,
// adds the user's signature and submits it straight away. So an up-front "sign now, submit later" x402 authorization
// is not possible from the wallet. To keep "pay only on delivery":
//   1. The buyer signs ClientScope's one-time challenge in the wallet (signMessage). The challenge also states the order:
//      job id, 1 EUDemo, ClientScope's account, pay only after the delivery check passes. Verified exactly like the demo
//      buyer (on-chain keys, identity-backed credential, allow list), plus an EUDemo balance check.
//   2. ClientScope runs the job and the same delivery check. Nothing has been signed for payment yet.
//   3. Only if delivery passes: ClientScope builds the EUDemo transfer (memo = job id, fee sponsored), the sponsor
//      signs it, and the buyer approves and submits it from the wallet (sendSponsoredTransaction).
//   4. ClientScope checks the finalized transaction on chain (payer, payee, token, amount, memo, sponsor, nonce),
//      writes it to the Audit Log and anchors the receipt. If delivery fails, no payment is ever requested.
import { AccountAddress, buildBasicAccountSigner, CborAccountAddress, CborMemo, Cbor, TokenAmount, TokenId,
  TokenOperationType, TransactionExpiry, TransactionHash, SequenceNumber } from "@concordium/web-sdk";
import { Transaction } from "@concordium/web-sdk/transactions";
import { ASSET, DECIMALS, PRICE_ATOMIC, CLIENTSCOPE_PAYTO, SPONSOR_ADDRESS, explorerTx, fmt, jsonSafe } from "./config.mjs";

export const WALLET_PAYMENT_WINDOW_SECONDS = 600;
export const orderLines = (jobId) =>
  `order: pay ${fmt(PRICE_ATOMIC)} ${ASSET} to ${CLIENTSCOPE_PAYTO} for job ${jobId}, only after the delivery check passes; network fee paid by ClientScope`;

export const memoHex = (jobId) => Buffer.from(CborMemo.fromString(jobId).content).toString("hex");

/** The EUDemo transfer the buyer will approve: sender = buyer, sponsor = ClientScope's fee sponsor, memo = job id. */
export function buildPaymentTransaction({ buyer, jobId, nonce, nowSeconds = Math.floor(Date.now() / 1000), windowSeconds = WALLET_PAYMENT_WINDOW_SECONDS }) {
  const ops = [{ [TokenOperationType.Transfer]: {
    amount: TokenAmount.create(BigInt(PRICE_ATOMIC), DECIMALS),
    recipient: CborAccountAddress.fromAccountAddress(AccountAddress.fromBase58(CLIENTSCOPE_PAYTO)),
    memo: CborMemo.fromString(jobId),
  } }];
  return Transaction.tokenUpdate({ tokenId: TokenId.fromString(ASSET), operations: Cbor.encode(ops) })
    .addMetadata({ sender: AccountAddress.fromBase58(buyer), nonce: typeof nonce === "object" ? nonce : SequenceNumber.create(BigInt(nonce)), expiry: TransactionExpiry.fromEpochSeconds(nowSeconds + windowSeconds) })
    .addSponsor(AccountAddress.fromBase58(SPONSOR_ADDRESS))
    .build();
}

/** Sponsor signs first (the wallet requires it), then the JSON goes to the browser for Transaction.signableFromJSON. */
export async function sponsorSign(signable, sponsorKeyHex) {
  return Transaction.sponsor(signable, buildBasicAccountSigner(sponsorKeyHex));
}
export const toWalletJSON = (signed) => JSON.parse(Transaction.toJSONString(signed));

/** Checks a finalized block item summary against what ClientScope asked for. Pure, so it can be unit tested. */
export function checkSettledPayment(status, { buyer, jobId }) {
  const sum = status?.outcome?.summary || {};
  const ev = (sum.events || []).find((e) => e.tag === "TokenTransfer");
  const amt = ev?.amount ? BigInt(String(ev.amount.value ?? ev.amount)) : null;
  const checks = {
    finalized: status?.status === "finalized",
    token_update: sum.transactionType === "tokenUpdate",
    payer_is_verified_buyer: String(sum.sender) === buyer && ev?.from?.address === buyer,
    paid_to_clientscope: ev?.to?.address === CLIENTSCOPE_PAYTO,
    token_is_eudemo: String(ev?.tokenId) === ASSET,
    amount_is_price: amt === BigInt(PRICE_ATOMIC) && Number(ev?.amount?.decimals ?? DECIMALS) === DECIMALS,
    memo_is_job_id: String(ev?.memo || "").toLowerCase() === memoHex(jobId),
    fee_sponsored_by_clientscope: String(sum.sponsor?.sponsor || "") === SPONSOR_ADDRESS,
    buyer_paid_no_fee: String(sum.cost ?? "") === "0",
  };
  return { ok: Object.values(checks).every(Boolean), checks, sponsor_fee_ccd: sum.sponsor?.cost != null ? fmt(String(sum.sponsor.cost)) : null };
}

/**
 * Routes on the job server (localhost only; the dashboard proxies them).
 * deps: { log, py, anchorJob, grpc, txStatus, issueChallenge, verifyBuyer, sessionFor, buyerLog, now, usedJobIds, sponsorKey }
 */
export function registerWalletRoutes(app, d) {
  const pending = new Map(); // jobId -> { job, buyer, nonce, expiry, settled }

  app.post("/wallet/challenge", (req, res) => {
    try {
      const { account, jobId } = req.body || {};
      const c = d.issueChallenge(account, jobId, orderLines(jobId));
      d.log(`wallet buyer challenge issued: job=${jobId} account=${account.slice(0, 10)}... nonce=${c.nonce.slice(0, 8)}...`);
      res.json(c);
    } catch { res.status(400).json({ error: "bad_account" }); }
  });

  app.post("/wallet/verify", async (req, res) => {
    const r = await d.verifyBuyer(d.grpc(), req.body || {});
    const bal = r.facts?.eudemo_balance != null ? BigInt(Math.round(Number(r.facts.eudemo_balance) * 10 ** DECIMALS)) : 0n;
    r.checks.has_funds = bal >= BigInt(PRICE_ATOMIC);
    if (!r.checks.has_funds) { r.verified = false; r.failed = [...(r.failed || []), "has_funds"]; r.session = null; }
    const short = Object.entries(r.checks).map(([k, v]) => `${k}=${v}`).join(" ");
    d.log(`buyer ${r.verified ? "VERIFIED" : "REJECTED"} (wallet): ${String(req.body?.account).slice(0, 10)}... ${short}`);
    const { session, ...pub } = r;
    d.buyerLog({ at: new Date().toISOString(), event: r.verified ? "buyer_verified" : "buyer_rejected", via: "browser_wallet", ...pub });
    res.status(r.verified ? 200 : 403).json(r);
  });

  app.post("/wallet/job", async (req, res) => {
    const { jobId, url, client, audit_rows } = req.body || {};
    const s = d.sessionFor(req.get("x-buyer-session"), jobId);
    if (!s) return res.status(403).json({ error: "buyer_not_verified" });
    if (d.usedJobIds.has(jobId)) return res.status(409).json({ error: "job_already_used" });
    d.usedJobIds.add(jobId);
    const b = s.result, t = d.now();
    const rows = [
      ...(audit_rows || []),
      [t, "buyer_verified", `account=${b.facts.account} via Concordium Browser Wallet: challenge signed + checked on chain: identity_provider=${b.facts.identity_provider?.id} (${b.facts.identity_provider?.name}) credential_valid_to=${b.facts.credential_valid_to} anonymity_revokers=${b.facts.anonymity_revokers} eudemo_allow_listed=true eudemo_balance=${b.facts.eudemo_balance} policy="${b.policy}"`],
      [t, "order_signed", `buyer signed the order in their wallet (${orderLines(jobId).replace(/^order: /, "")}). No payment signed yet.`],
    ];
    d.log("wallet order accepted -> running agent_job.py + delivery check (payment is only requested from the wallet if delivery passes)");
    let r;
    try { r = await d.py("run_job.py", { url, client, audit_rows: rows }); }
    catch (e) { d.log("job crashed:", e.message); return res.status(500).json({ job_id: jobId, status: "job_error", charged: false }); }
    const c = r.check;
    d.log(`delivery check: sheet=${c.sheet_exists} auditLog=${c.audit_log_present} products=${c.products_rows} complete=${c.products_rows_complete} pageRows=${c.supplier_page_rows} -> ${r.passed ? "PASS" : "FAIL"}`);
    const job = { jobId, sheetId: r.sheet_id, sheetUrl: r.sheet_url, delivered: r.passed, buyer: s.account, buyerVerification: b };
    if (!r.passed) {
      d.log("delivery FAILED -> no payment requested from the wallet (buyer not charged)");
      const a = r.sheet_id ? await d.anchorJob(job, null) : null;
      return res.status(422).json({ job_id: jobId, status: "delivery_failed", charged: false, sheet_url: r.sheet_url, check: c,
        anchor: a && { tx_hash: a.anchor.tx_hash, receipt_sha256: a.receipt_sha256, log_sha256: a.log_sha256 } });
    }
    try {
      const { nonce } = await d.grpc().getNextAccountNonce(AccountAddress.fromBase58(s.account));
      const signable = buildPaymentTransaction({ buyer: s.account, jobId, nonce });
      const sponsored = await sponsorSign(signable, d.sponsorKey);
      const expiry = Math.floor(Date.now() / 1000) + WALLET_PAYMENT_WINDOW_SECONDS;
      pending.set(jobId, { job, buyer: s.account, nonce: String(nonce), expiry, settled: false });
      try { await d.py("append_audit.py", { sheet_id: r.sheet_id, rows: [[d.now(), "payment_requested", `delivery passed: sponsor signed a ${fmt(PRICE_ATOMIC)} ${ASSET} transfer (memo=${jobId}, nonce=${nonce}) for the buyer to approve in their wallet`]] }); } catch {}
      d.log(`delivery passed -> payment request sent to the buyer's wallet (sponsor signed for the fee, nonce ${nonce}, valid ${WALLET_PAYMENT_WINDOW_SECONDS}s)`);
      res.json({ job_id: jobId, status: "delivered", sheet_url: r.sheet_url, check: c, sponsored_transaction: toWalletJSON(sponsored), expires: new Date(expiry * 1000).toISOString() });
    } catch (e) {
      d.log("payment request could not be built:", e.message);
      res.status(502).json({ job_id: jobId, status: "delivered_payment_request_failed", sheet_url: r.sheet_url, check: c });
    }
  });

  app.post("/wallet/settled", async (req, res) => {
    const { jobId, txHash } = req.body || {};
    const p = pending.get(jobId);
    if (!p || p.settled) return res.status(404).json({ error: "no_pending_payment" });
    if (!/^[0-9a-f]{64}$/i.test(txHash || "")) return res.status(400).json({ error: "bad_tx_hash" });
    d.log(`wallet submitted payment tx=${txHash}, waiting for finality ...`);
    let st = null;
    try {
      const client = d.grpc();
      await client.waitForTransactionFinalization(TransactionHash.fromHexString(txHash), 120_000);
      st = jsonSafe(await d.txStatus(client, txHash));
    } catch (e) { d.log("settle -> success=false reason=not_finalized", e.message); return res.status(504).json({ error: "not_finalized" }); }
    const v = checkSettledPayment(st, { buyer: p.buyer, jobId });
    if (!v.ok) {
      const bad = Object.entries(v.checks).filter(([, ok]) => !ok).map(([k]) => k).join(",");
      d.log(`settle -> success=false tx=${txHash} reason=payment_does_not_match(${bad})`);
      return res.status(422).json({ error: "payment_does_not_match", checks: v.checks });
    }
    p.settled = true;
    d.log(`settle -> success=true tx=${txHash} (approved and submitted from the buyer's wallet, AFTER delivery)`);
    d.log(`fee ${v.sponsor_fee_ccd} CCD paid by sponsor; buyer fee 0.000000 CCD`);
    const t = d.now();
    const rows = [
      [t, "payment_settled", `tx=${txHash} status=finalized amount=${fmt(PRICE_ATOMIC)} ${ASSET} payer=${p.buyer} memo=${jobId} (approved in the buyer's wallet AFTER delivery; checked on chain: ${Object.keys(v.checks).join(", ")})`],
      [t, "fee_sponsored", `sponsor=${SPONSOR_ADDRESS} paid fee=${v.sponsor_fee_ccd} CCD, buyer fee=0.000000 CCD`],
      [t, "payment_receipt", explorerTx(txHash)],
    ];
    try { await d.py("append_audit.py", { sheet_id: p.job.sheetId, rows }); d.log("receipt written to Audit Log"); } catch (e) { d.log("audit append failed:", e.message); }
    const a = await d.anchorJob(p.job, txHash);
    res.json({ job_id: jobId, status: "paid", payment: { tx_hash: txHash, explorer: explorerTx(txHash), status: "finalized", amount: `${fmt(PRICE_ATOMIC)} ${ASSET}`,
      payer: p.buyer, pay_to: CLIENTSCOPE_PAYTO, sponsor: SPONSOR_ADDRESS, sponsor_fee_ccd: v.sponsor_fee_ccd, buyer_fee_ccd: "0.000000", memo: jobId, checks: v.checks },
      anchor: a && { tx_hash: a.anchor.tx_hash, receipt_sha256: a.receipt_sha256, log_sha256: a.log_sha256 } });
  });

  app.post("/wallet/declined", async (req, res) => {
    const { jobId, reason } = req.body || {};
    const p = pending.get(jobId);
    if (!p || p.settled) return res.status(404).json({ error: "no_pending_payment" });
    pending.delete(jobId);
    const why = reason === "expired" ? "the payment request expired before the buyer approved it" : "the buyer did not approve the payment in their wallet";
    d.log(`payment not approved: ${why}`);
    try { await d.py("append_audit.py", { sheet_id: p.job.sheetId, rows: [[d.now(), "payment_not_approved", `${why}. Nothing was submitted; the sponsor-signed request is void after its expiry.`]] }); } catch {}
    const a = await d.anchorJob(p.job, null);
    res.json({ job_id: jobId, status: "payment_not_approved", anchor: a && { tx_hash: a.anchor.tx_hash } });
  });
}
