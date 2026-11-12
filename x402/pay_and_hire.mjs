// Client agent payment helper: hires ClientScope over x402 and pays in EUDemo.
// Called by client_agent.py after the Concordium badge check passes.
// stdin: {"jobId","url","client","audit_rows"}   stdout: log lines, then one line "RESULT <json>"
import { NETWORK, ASSET, PRICE_ATOMIC, CLIENTSCOPE_PAYTO, CLIENT_ADDRESS, PORT, fmt, jsonSafe } from "./config.mjs";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { ExactConcordiumScheme } from "@x402/concordium/exact/client";
import { AccountAddress, buildBasicAccountSigner, CborMemo, TokenOperationType, TokenAmount, CborAccountAddress, Cbor, TokenId } from "@concordium/web-sdk";
import { Transaction } from "@concordium/web-sdk/transactions";
import { grpc, balances, txStatus } from "./chain.mjs";
import { signMessage } from "@concordium/web-sdk";
import { generateKeyPairSync } from "node:crypto";
import { SPONSOR_ADDRESS, explorerTx } from "./config.mjs";

// Spend policy (soft cap, enforced in this client before anything is signed)
const MAX_PER_JOB_ATOMIC = BigInt(process.env.CLIENTSCOPE_MAX_ATOMIC || "2000000"); // refuse anything above 2 EUDemo (env override only for testing the refusal)
const ALLOWED_PAYTO = CLIENTSCOPE_PAYTO;        // only pay ClientScope's known account
const ALLOWED_ASSET = ASSET;

const OK = "\u2705", BAD = "\u274c";
const say = (s = "") => console.log(s);
const out = { steps: [] };
const step = (name, data) => out.steps.push({ at: new Date().toISOString(), name, ...jsonSafe(data || {}) });

// The stock client scheme sends no memo; this subclass puts the job id in the PLT transfer memo.
class MemoConcordiumScheme extends ExactConcordiumScheme {
  constructor(signer, memo) { super(signer); this.memo = memo; }
  buildPltTransfer(payTo, amount, tokenId, decimals) {
    const ops = [{ [TokenOperationType.Transfer]: {
      amount: TokenAmount.create(BigInt(amount), decimals),
      recipient: CborAccountAddress.fromAccountAddress(AccountAddress.fromBase58(payTo)),
      memo: CborMemo.fromString(this.memo),
    } }];
    return Transaction.tokenUpdate({ tokenId: TokenId.fromString(tokenId), operations: Cbor.encode(ops) });
  }
}

let input = "";
for await (const chunk of process.stdin) input += chunk;
const job = JSON.parse(input || "{}");
const jobId = job.jobId;
if (!/^[0-9a-f]{64}$/i.test(process.env.CCD_CLIENT_PRIVATE_KEY || "")) { say(`${BAD} CCD_CLIENT_PRIVATE_KEY missing`); process.exit(1); }

const chain = grpc();
const before = await balances(chain, CLIENT_ADDRESS);
const sponsorBefore = await balances(chain, SPONSOR_ADDRESS);
const payToBefore = await balances(chain, CLIENTSCOPE_PAYTO);
step("client_balance_before", before);
say(`      Wallet ${CLIENT_ADDRESS.slice(0, 10)}...: ${fmt(before.eudemoAtomic)} EUDemo, ${fmt(before.ccdMicro)} CCD`);

const signer = { accountAddress: AccountAddress.fromBase58(CLIENT_ADDRESS), signer: buildBasicAccountSigner(process.env.CCD_CLIENT_PRIVATE_KEY) };
const scheme = new MemoConcordiumScheme(signer, jobId);
const client = new x402Client()
  .register("ccd:*", scheme)
  .setSpendControls({ allowedAssets: [{ network: "ccd:*", asset: ALLOWED_ASSET, maxAmountPerPayment: MAX_PER_JOB_ATOMIC.toString() }] })
  .registerPolicy((_v, reqs) => reqs.filter((r) => r.payTo === ALLOWED_PAYTO && r.asset === ALLOWED_ASSET && BigInt(r.amount) <= MAX_PER_JOB_ATOMIC));
client.onBeforePaymentCreation(async ({ selectedRequirements: r }) => {
  const okPayTo = r.payTo === ALLOWED_PAYTO, okAsset = r.asset === ALLOWED_ASSET, okCap = BigInt(r.amount) <= MAX_PER_JOB_ATOMIC;
  say(`      ${okPayTo ? OK : BAD} payTo is ClientScope's known account (${r.payTo.slice(0, 10)}...)`);
  say(`      ${okAsset ? OK : BAD} asset is ${ALLOWED_ASSET}`);
  say(`      ${okCap ? OK : BAD} price ${fmt(r.amount)} ${r.asset} is within my cap of ${fmt(MAX_PER_JOB_ATOMIC)} ${ALLOWED_ASSET}`);
  say(`      ${OK} fee payer (sponsor) named by ClientScope: ${r.extra?.feePayer?.slice(0, 10)}...`);
  step("spend_policy", { payTo_ok: okPayTo, asset_ok: okAsset, cap_ok: okCap, cap_atomic: MAX_PER_JOB_ATOMIC.toString(), amount: r.amount, feePayer: r.extra?.feePayer });
  if (!(okPayTo && okAsset && okCap)) return { abort: true, reason: "spend policy refused" };
  say(`\n[8/8] Signing the payment (sender signature only, sponsor slot left empty)`);
});
client.onAfterPaymentCreation(async ({ paymentPayload: p }) => {
  const h = p.payload.signedTransaction.header;
  say(`      ${OK} Signed V1 sponsored tx: sender=${h.sender.slice(0, 10)}... sponsor=${(h.sponsor.account || h.sponsor.address).slice(0, 10)}... nonce=${h.nonce} expiry=${new Date(h.expiry * 1000).toISOString().slice(11, 19)}Z`);
  say(`      ${OK} Memo: "${jobId}"   Signatures: sender only (sponsor adds theirs)`);
  say(`      -> Sending PAYMENT-SIGNATURE. ClientScope verifies it, does the job, checks delivery; only then the sponsor co-signs + submits ...`);
  step("payment_signed", { header: h, memo: jobId });
  if (process.env.CLIENTSCOPE_SAVE_PAYMENT) { // test only: keep the signed payment to prove it cannot be replayed
    const { writeFileSync } = await import("node:fs");
    writeFileSync(process.env.CLIENTSCOPE_SAVE_PAYMENT, JSON.stringify({ jobId, payment: p }), { mode: 0o600 });
  }
});

// Log the raw 402 the server sends back.
const http = new x402HTTPClient(client);
const loggingFetch = async (req) => {
  const r = await fetch(req);
  if (r.status === 402 && !req.headers.get("payment-signature")) {
    const pr = http.getPaymentRequiredResponse((n) => r.headers.get(n), undefined);
    const a = pr.accepts[0];
    say(`      <- HTTP 402 Payment Required (x402 v${pr.x402Version})`);
    say(`         scheme=${a.scheme} network=${a.network}`);
    say(`         price=${fmt(a.amount)} ${a.asset} (atomic ${a.amount})  payTo=${a.payTo}`);
    say(`         feePayer(sponsor)=${a.extra?.feePayer}  flow=${a.extra?.paymentFlow || "authorization (pay on delivery)"}  timeout=${a.maxTimeoutSeconds}s`);
    step("payment_required", { status: 402, x402Version: pr.x402Version, accepts: pr.accepts });
    say(`\n[7/8] Checking the price against my spend policy`);
  }
  return r;
};
const payFetch = wrapFetchWithPayment(loggingFetch, client);

// ---- Feature 3: prove who I am to ClientScope (signed challenge), before any payment ----
const SIM = process.env.CLIENTSCOPE_SIMULATE_BUYER || "";
let buyerAddr = CLIENT_ADDRESS, buyerSigner = signer.signer;
if (SIM === "impostor") { // fresh random key that claims the real client account (test only; key never leaves memory)
  const jwk = generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" });
  buyerSigner = buildBasicAccountSigner(Buffer.from(jwk.d, "base64url").toString("hex"));
} else if (SIM === "not-allowlisted") { // a real identity-backed account that is NOT on the EUDemo allow list (test only)
  buyerAddr = SPONSOR_ADDRESS; buyerSigner = buildBasicAccountSigner(process.env.CCD_SPONSOR_PRIVATE_KEY);
}
say(`\n[5/8] Proving who I am to ClientScope (signed challenge, no private data shared)`);
if (SIM) say(`      MODE: simulate unverified buyer = ${SIM}${SIM === "impostor" ? " (fresh random key, claims my account)" : " (real account, not on the EUDemo allow list)"}`);
const base = `http://localhost:${PORT}`;
const chal = await (await fetch(`${base}/buyer/challenge`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ account: buyerAddr, jobId }) })).json();
say(`      <- challenge for job ${jobId}, nonce ${chal.nonce.slice(0, 12)}..., expires ${chal.expires.slice(11, 19)}Z`);
const sig = jsonSafe(await signMessage(AccountAddress.fromBase58(buyerAddr), chal.message, buyerSigner));
say(SIM === "impostor" ? `      signed it with a fresh random key, claiming to be account ${buyerAddr.slice(0, 10)}...` : `      ${OK} signed it with account ${buyerAddr.slice(0, 10)}...'s key (Concordium signed-message format)`);
const vr = await fetch(`${base}/buyer/verify`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ account: buyerAddr, jobId, nonce: chal.nonce, signature: sig }) });
const v = await vr.json();
const LBL = { challenge_fresh: "challenge fresh + single use", account_exists: "account exists on chain", challenge_signed: "signature matches the account's on-chain keys",
  identity_backed: "identity-backed credential (normal, from an identity provider)", known_identity_provider: "identity provider registered on chain",
  credential_valid: "identity credential not expired", anonymity_revocation: ">= 2 anonymity revokers (identity recoverable under legal process)", eudemo_allow_listed: "on the EUDemo allow list (EU-nationality ZK proof via faucet)" };
for (const [k, ok] of Object.entries(v.checks || {})) say(`      ${ok ? OK : BAD} ${LBL[k] || k}`);
if (v.facts?.identity_provider) say(`         identity provider #${v.facts.identity_provider.id} "${v.facts.identity_provider.name}", credential valid to ${v.facts.credential_valid_to}, ${v.facts.revealed_attributes} attributes revealed`);
step("buyer_verification", { http: vr.status, verified: v.verified, checks: v.checks, failed: v.failed, facts: v.facts });
if (!v.verified) {
  say(`      ${BAD} ClientScope REJECTED me as a buyer (HTTP ${vr.status}): failed ${v.failed.join(", ")}`);
  const r2 = await fetch(`${base}/jobs/scrape`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jobId }) });
  say(`      ${r2.status === 403 ? OK : BAD} job endpoint without a verified session -> HTTP ${r2.status} (no 402, so no payment can even be signed)`);
  const after = await balances(chain, CLIENT_ADDRESS), sA = await balances(chain, SPONSOR_ADDRESS), pA = await balances(chain, CLIENTSCOPE_PAYTO);
  say(`\n      On-chain proof (read back from the Concordium node):`);
  const ln = (n, b, a) => say(`      ${n.padEnd(12)} EUDemo ${fmt(b.eudemoAtomic)} -> ${fmt(a.eudemoAtomic)}   CCD ${fmt(b.ccdMicro)} -> ${fmt(a.ccdMicro)}   nonce ${b.nonce} -> ${a.nonce}`);
  ln("client", before, after); ln("sponsor", sponsorBefore, sA); ln("clientscope", payToBefore, pA);
  const same = [[before, after], [sponsorBefore, sA], [payToBefore, pA]].every(([b, a]) => b.eudemoAtomic === a.eudemoAtomic && b.ccdMicro === a.ccdMicro && b.nonce === a.nonce);
  say(`      ${same ? OK : BAD} ${same ? "Nothing changed on chain: no payment, no fee, no transaction" : "Something changed on chain!"}`);
  out.ok = same; out.buyer_rejected = true; out.failed = v.failed;
  out.balances = { before: { client: before, sponsor: sponsorBefore, clientscope: payToBefore }, after: { client: after, sponsor: sA, clientscope: pA } };
  console.log("RESULT " + JSON.stringify(out)); process.exit(7);
}
say(`      ${OK} ClientScope accepted me as a buyer ("${v.policy}")`);
const BUYER_SESSION = v.session;

say(`\n[6/8] Asking ClientScope for the job: POST http://localhost:${PORT}/jobs/scrape  (job ${jobId})`);
const t0 = Date.now();
let res;
try {
  res = await payFetch(`http://localhost:${PORT}/jobs/scrape`, {
    method: "POST", headers: { "content-type": "application/json", "x-buyer-session": BUYER_SESSION },
    body: JSON.stringify({ jobId, url: job.url, client: job.client, audit_rows: job.audit_rows || [] }),
  });
} catch (e) {
  say(`      ${BAD} Payment not made: ${e.message}`);
  out.ok = false; out.error = e.message; console.log("RESULT " + JSON.stringify(out)); process.exit(3);
}
const body = await res.json().catch(() => ({}));
const settle = res.headers.get("payment-response") ? http.getPaymentSettleResponse((n) => res.headers.get(n)) : null;
out.http_status = res.status; out.response = body; out.payment_response_header = settle;
const after = await balances(chain, CLIENT_ADDRESS);
const sponsorAfter = await balances(chain, SPONSOR_ADDRESS);
const payToAfter = await balances(chain, CLIENTSCOPE_PAYTO);
out.balances = { before: { client: before, sponsor: sponsorBefore, clientscope: payToBefore }, after: { client: after, sponsor: sponsorAfter, clientscope: payToAfter } };
const line = (n, b, a) => say(`      ${n.padEnd(12)} EUDemo ${fmt(b.eudemoAtomic)} -> ${fmt(a.eudemoAtomic)}   CCD ${fmt(b.ccdMicro)} -> ${fmt(a.ccdMicro)}   nonce ${b.nonce} -> ${a.nonce}`);
if (res.status === 422) {
  const c = body.check || {};
  say(`      ${BAD} ClientScope answered 422: delivery check FAILED`);
  say(`         sheet=${c.sheet_exists} auditLog=${c.audit_log_present} products=${c.products_rows} complete=${c.products_rows_complete} supplierPageRows=${c.supplier_page_rows}`);
  say(`      ${OK} No PAYMENT-RESPONSE: the sponsor never co-signed, nothing was submitted`);
  say(`\n      On-chain proof (read back from the Concordium node):`);
  line("client", before, after); line("sponsor", sponsorBefore, sponsorAfter); line("clientscope", payToBefore, payToAfter);
  const unchanged = [[before, after], [sponsorBefore, sponsorAfter], [payToBefore, payToAfter]].every(([b, a]) => b.eudemoAtomic === a.eudemoAtomic && b.ccdMicro === a.ccdMicro && b.nonce === a.nonce);
  say(`      ${unchanged ? OK : BAD} ${unchanged ? "All balances and nonces unchanged: no transaction went on chain, buyer NOT charged" : "Something changed on chain!"}`);
  out.ok = unchanged; out.charged = false; out.delivery_failed = true; out.sheet_url = body.sheet_url;
  console.log("RESULT " + JSON.stringify(out)); process.exit(unchanged ? 5 : 6);
}
if (res.status !== 200 || !settle?.success) {
  say(`      ${BAD} ClientScope answered HTTP ${res.status}: ${JSON.stringify(body)}`);
  out.ok = false; console.log("RESULT " + JSON.stringify(out)); process.exit(4);
}
const c = body.check;
say(`      ${OK} Delivered: sheet + Audit Log present, ${c.products_rows_complete}/${c.products_rows} product rows complete, matches supplier page (${c.supplier_page_rows})`);
const st = jsonSafe(await txStatus(chain, settle.transaction)); const sum = st.outcome.summary;
const p = { tx_hash: settle.transaction, explorer: explorerTx(settle.transaction), status: st.status, block_hash: st.outcome.blockHash,
  amount: `${fmt(PRICE_ATOMIC)} ${ASSET}`, payer: sum.sender, pay_to: CLIENTSCOPE_PAYTO, sponsor: sum.sponsor?.sponsor,
  sponsor_fee_ccd: fmt(String(sum.sponsor?.cost ?? 0)), buyer_fee_ccd: fmt(String(sum.cost ?? 0)), memo: jobId };
out.payment = p;
say(`      ${OK} THEN the sponsor co-signed and submitted; transaction ${String(st.status).toUpperCase()} (${((Date.now() - t0) / 1000).toFixed(1)}s total)`);
say(`      Tx hash:  ${p.tx_hash}`);
say(`      Amount:   ${p.amount}  ->  ClientScope ${p.pay_to.slice(0, 10)}...   memo ${jobId}`);
say(`      Fee:      ${p.sponsor_fee_ccd} CCD paid by sponsor ${String(p.sponsor).slice(0, 10)}...  |  buyer fee: ${p.buyer_fee_ccd} CCD`);
say(`      Explorer: ${p.explorer}`);
line("client", before, after); line("sponsor", sponsorBefore, sponsorAfter); line("clientscope", payToBefore, payToAfter);
const dE = BigInt(before.eudemoAtomic) - BigInt(after.eudemoAtomic), dC = BigInt(before.ccdMicro) - BigInt(after.ccdMicro);
say(`      ${dE === 1_000_000n && dC === 0n ? OK : BAD} Buyer paid ${fmt(dE)} EUDemo and ${fmt(dC)} CCD in fees`);
out.ok = true; out.charged = true; out.sheet_url = body.sheet_url;
console.log("RESULT " + JSON.stringify(out));
process.exit(0);
