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
import { BUYER_AGENT_ID } from "./agent_trust.mjs";
import { watchAgent } from "./killswitch.mjs";

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
// Gap 2: I am registered agent #1211. ClientScope checks my badge, card hash, Active status and that my signing key controls it.
let myAgent = String(process.env.CLIENTSCOPE_BUYER_AGENT_ID || BUYER_AGENT_ID);
if (SIM === "unregistered") myAgent = null;      // real account + real key + EU allow list, but no registered agent (test only)
if (SIM === "stolen-card") myAgent = "1010";     // claims ClientScope's own registered agent, which this account does not control (test only)
say(`\n[5/8] Proving who I am to ClientScope (signed challenge, no private data shared)`);
const SIM_TXT = { impostor: "fresh random key, claims my account", "not-allowlisted": "real account, not on the EUDemo allow list",
  unregistered: "real account and key, but no registered agent", "stolen-card": "real account and key, claims agent #1010 which it does not control" };
if (SIM) say(`      MODE: simulate unverified buyer = ${SIM} (${SIM_TXT[SIM] || "?"})`);
say(myAgent ? `      I am registered buyer agent #${myAgent} on Concordium's Agent Registry` : `      I present no registered agent`);
const base = `http://localhost:${PORT}`;
const chal = await (await fetch(`${base}/buyer/challenge`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ account: buyerAddr, jobId, agentId: myAgent }) })).json();
say(`      <- challenge for job ${jobId}, nonce ${chal.nonce.slice(0, 12)}..., expires ${chal.expires.slice(11, 19)}Z`);
const sig = jsonSafe(await signMessage(AccountAddress.fromBase58(buyerAddr), chal.message, buyerSigner));
say(SIM === "impostor" ? `      signed it with a fresh random key, claiming to be account ${buyerAddr.slice(0, 10)}...` : `      ${OK} signed it with account ${buyerAddr.slice(0, 10)}...'s key (Concordium signed-message format)`);
const vr = await fetch(`${base}/buyer/verify`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ account: buyerAddr, jobId, nonce: chal.nonce, signature: sig }) });
const v = await vr.json();
const LBL = { challenge_fresh: "challenge fresh + single use", account_exists: "account exists on chain", challenge_signed: "signature matches the account's on-chain keys",
  identity_backed: "identity-backed credential (normal, from an identity provider)", known_identity_provider: "identity provider registered on chain",
  credential_valid: "identity credential not expired", anonymity_revocation: ">= 2 anonymity revokers (identity recoverable under legal process)", eudemo_allow_listed: "on the EUDemo allow list (EU-nationality ZK proof via faucet)",
  buyer_agent_registered: "my buyer agent is registered in the CIS-8004 Agent Registry", buyer_agent_active: "my buyer agent is Active on chain",
  buyer_card_hash_matches: "my Agent Card hashes to the on-chain metadata_hash", buyer_card_names_agent: "my card's badge names the same token and owner as the chain",
  buyer_badge_valid: "Concordium's badge checker says my badge is valid", buyer_agent_controlled_by_signer: "the key that signed the challenge controls my registered agent" };
for (const [k, ok] of Object.entries(v.checks || {})) say(`      ${ok ? OK : BAD} ${LBL[k] || k}`);
if (v.facts?.identity_provider) say(`         identity provider #${v.facts.identity_provider.id} "${v.facts.identity_provider.name}", credential valid to ${v.facts.credential_valid_to}, ${v.facts.revealed_attributes} attributes revealed`);
if (v.facts?.buyer_agent?.token_address) say(`         buyer agent #${v.facts.buyer_agent.token_id} ${v.facts.buyer_agent.token_address}, card ${String(v.facts.buyer_agent.card_sha256 || "").slice(0, 16)}..., signer is its ${v.facts.buyer_agent.signer_is || "?"}`);
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
// Kill switch, my side: I watch my OWN badge too. If my owner revokes me, I stop acting for them at once.
const KILL = !!process.env.CLIENTSCOPE_KILLSWITCH;
let myHalt = null;
const stopMyWatch = KILL && myAgent ? watchAgent(grpc(), myAgent, { intervalMs: 1000, onRevoked: (i) => {
  myHalt = i;
  say(`      ${OK} KILL SWITCH (my side): my owner revoked me, agent #${myAgent}, on chain (tx ${String(i.revoke_tx || "?").slice(0, 16)}...), I saw it ${i.detection_seconds ?? "?"} s after the revoke's block`);
  say(`         I stop acting for my owner now. My held payment must never settle: the revoke used my account's next nonce, so it can no longer be submitted at all.`);
} }) : null;
let res;
try {
  res = await payFetch(`http://localhost:${PORT}/jobs/scrape`, {
    method: "POST", headers: { "content-type": "application/json", "x-buyer-session": BUYER_SESSION },
    body: JSON.stringify({ jobId, url: job.url, client: job.client, audit_rows: job.audit_rows || [], demo_pace: !!process.env.CLIENTSCOPE_DEMO_PACE }),
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
stopMyWatch?.();
if (res.status === 409 && body.status === "halted_agent_revoked") {
  const hh = body.halt || {};
  say(`      ${OK} ClientScope HALTED the job: buyer agent #${hh.token_id} was revoked on chain mid-job (HTTP 409)`);
  say(`         revoke tx:   ${hh.revoke_tx}  (block ${hh.block_height}, ${hh.revoked_at})`);
  say(`         detected:    ${hh.detection_seconds} s after the revoke's block (finality included); stopped at ${hh.stage} (${hh.rows_done}/${hh.rows_total ?? "?"} rows written)`);
  say(`         Explorer:    ${explorerTx(hh.revoke_tx)}`);
  if (body.anchor?.tx_hash) say(`         halt receipt anchored: ${explorerTx(body.anchor.tx_hash)}`);
  say(`      ${OK} No PAYMENT-RESPONSE: the sponsor never co-signed, nothing was submitted`);
  say(`\n      On-chain proof (read back from the Concordium node):`);
  line("client", before, after); line("sponsor", sponsorBefore, sponsorAfter); line("clientscope", payToBefore, payToAfter);
  // The buyer account is also the agent's owner, so its ONLY transaction is the owner's own revoke (fee paid by the owner).
  let revokeFee = null, revokeSender = null;
  try { const st = jsonSafe(await txStatus(chain, hh.revoke_tx)); revokeFee = BigInt(st.outcome.summary.cost); revokeSender = st.outcome.summary.sender; } catch {}
  const eudemoSame = before.eudemoAtomic === after.eudemoAtomic && payToBefore.eudemoAtomic === payToAfter.eudemoAtomic && sponsorBefore.eudemoAtomic === sponsorAfter.eudemoAtomic;
  const onlyRevoke = revokeFee !== null && revokeSender === CLIENT_ADDRESS && BigInt(before.ccdMicro) - BigInt(after.ccdMicro) === revokeFee && BigInt(after.nonce) - BigInt(before.nonce) === 1n;
  const payToSame = payToBefore.ccdMicro === payToAfter.ccdMicro && payToBefore.nonce === payToAfter.nonce;
  const sponsorOnlyAnchored = BigInt(sponsorAfter.nonce) - BigInt(sponsorBefore.nonce) <= 1n;
  say(`      ${eudemoSame ? OK : BAD} EUDemo unchanged for buyer, ClientScope and sponsor: buyer charged 0 EUDemo`);
  say(`      ${onlyRevoke ? OK : BAD} The buyer account's only transaction is the owner's revoke (fee ${revokeFee !== null ? fmt(revokeFee) : "?"} CCD, paid by the owner to press the kill switch), nonce ${before.nonce} -> ${after.nonce}`);
  say(`      ${payToSame && sponsorOnlyAnchored ? OK : BAD} ClientScope's account unchanged; the sponsor sent at most 1 transaction (the halt receipt anchor)`);
  const ok = eudemoSame && onlyRevoke && payToSame && sponsorOnlyAnchored;
  out.ok = ok; out.charged = false; out.halted = true; out.halt = hh; out.sheet_url = body.sheet_url; out.anchor = body.anchor; out.my_side = myHalt;
  out.revoke_fee_ccd = revokeFee !== null ? fmt(revokeFee) : null;
  console.log("RESULT " + JSON.stringify(out)); process.exit(ok ? 8 : 6);
}
if (res.status === 422) {
  const c = body.check || {};
  say(`      ${BAD} ClientScope answered 422: delivery check FAILED`);
  say(`         sheet=${c.sheet_exists} auditLog=${c.audit_log_present} products=${c.products_rows} complete=${c.products_rows_complete} supplierPageRows=${c.supplier_page_rows}`);
  say(`      ${OK} No PAYMENT-RESPONSE: the sponsor never co-signed, nothing was submitted`);
  say(`\n      On-chain proof (read back from the Concordium node):`);
  line("client", before, after); line("sponsor", sponsorBefore, sponsorAfter); line("clientscope", payToBefore, payToAfter);
  // The buyer and ClientScope's pay-to account must be untouched. The sponsor may have sent ONE RegisterData: the anchor of the
  // failed job's receipt (ClientScope pays that fee itself), never a payment, so its EUDemo must be unchanged.
  const same = (b, a) => b.eudemoAtomic === a.eudemoAtomic && b.ccdMicro === a.ccdMicro && b.nonce === a.nonce;
  const sponsorOnlyAnchored = sponsorBefore.eudemoAtomic === sponsorAfter.eudemoAtomic && BigInt(sponsorAfter.nonce) - BigInt(sponsorBefore.nonce) <= 1n;
  const unchanged = same(before, after) && same(payToBefore, payToAfter) && sponsorOnlyAnchored;
  if (sponsorBefore.nonce !== sponsorAfter.nonce) say(`      ${OK} Sponsor sent 1 transaction: the anchor of this failed job's receipt (fee paid by ClientScope, not the buyer)`);
  say(`      ${unchanged ? OK : BAD} ${unchanged ? "Buyer and ClientScope balances and nonces unchanged: no payment went on chain, buyer NOT charged" : "Something changed on chain!"}`);
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
