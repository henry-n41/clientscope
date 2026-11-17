// Gap 2, buyer side: before hiring, the buyer agent checks the work agent (ClientScope, agent #1010) on chain AND makes it
// prove it controls that registered agent right now, by signing a fresh nonce the buyer just generated.
// A copied Agent Card is useless to an impostor: the card passes, but the signature over MY nonce cannot be produced without the key.
//   node verify_supplier.mjs <base_url> <job_id>      stdout: log lines, then one line "RESULT <json>"
import "./config.mjs";
import { grpc } from "./chain.mjs";
import { CLIENTSCOPE_AGENT_ID, BUYER_AGENT_ID, verifyAgentBadge, verifyHandshake, newNonce } from "./agent_trust.mjs";

const OK = "\u2705", BAD = "\u274c";
const [base, jobId] = process.argv.slice(2);
const supplierId = String(process.env.CLIENTSCOPE_SUPPLIER_AGENT_ID || CLIENTSCOPE_AGENT_ID);
const myAgent = String(process.env.CLIENTSCOPE_BUYER_AGENT_ID || BUYER_AGENT_ID);
const client = grpc();
const out = { supplier_agent: supplierId, my_agent: myAgent, base };

const b = await verifyAgentBadge(client, supplierId);
out.badge = { ok: b.ok, checks: b.checks, facts: b.facts };
console.log(`      ${b.checks.registered && b.checks.active ? OK : BAD} Read agent #${supplierId} straight from the registry contract: status ${b.facts.status}, owner ${String(b.facts.owner).slice(0, 10)}...`);
console.log(`      ${b.checks.card_hash_matches_chain ? OK : BAD} Card at the on-chain URI hashes to the on-chain value (${String(b.facts.card_sha256).slice(0, 16)}...)`);

const nonce = newNonce();
console.log(`      -> My fresh nonce ${nonce.slice(0, 12)}...: ClientScope must sign it with a key that controls agent #${supplierId}`);
let reply = null, http = null;
try {
  const r = await fetch(`${base}/agent/handshake`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ nonce, jobId, fromAgent: myAgent }), signal: AbortSignal.timeout(20000) });
  http = r.status; reply = await r.json().catch(() => null);
} catch (e) { out.error = String(e.message || e); }
const h = await verifyHandshake(client, reply, { expectAgentId: supplierId, myAgentId: myAgent, nonce, jobId, agent: b.agent });
out.handshake = { http, ...h, nonce };
console.log(`      ${h.checks.handshake_nonce_is_mine && h.checks.handshake_fresh ? OK : BAD} Signed message carries MY nonce, my agent id and this job (no replay)`);
console.log(`      ${h.checks.handshake_signature_valid ? OK : BAD} Signature matches the on-chain keys of signer ${h.signer ? h.signer.slice(0, 10) + "..." : "(none)"}`);
console.log(`      ${h.checks.handshake_signer_controls_agent ? OK : BAD} ${h.checks.handshake_signature_valid ? `Signer controls agent #${supplierId} on chain${h.via ? ` (as its ${h.via.replace(/_/g, " ")})` : ": it is not the owner, agentWallet or an approved operator"}` : `No valid signature, so the claim to control agent #${supplierId} proves nothing`}`);
out.ok = b.ok && h.ok;
console.log("RESULT " + JSON.stringify(out));
process.exit(out.ok ? 0 : 8);
