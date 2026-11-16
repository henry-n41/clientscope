// Gap 2: two-way agent verification on Concordium's CIS-8004 Agent Registry (testnet contract 12802,0).
// Used by BOTH sides:
//   - ClientScope checks the buyer agent's badge, Agent Card hash and Active status before it accepts a job.
//   - The buyer agent checks ClientScope the same way before it hires.
// On top of the badge, each side proves it controls the registered agent by signing the OTHER side's fresh nonce
// with an account key, so nobody can replay a copied Agent Card. Signatures use Concordium's signed-message format
// and are checked against the signer account's ON-CHAIN keys. The signer must be the agent's owner, its agentWallet,
// or an operator the owner approved on the registry (CIS-2 operatorOf), all read from chain here, not from the card.
import { readFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AccountAddress, ContractAddress, ContractName, EntrypointName, Parameter, ReceiveName, buildBasicAccountSigner,
  deserializeReceiveReturnValue, signMessage, tokenAddressToBase58, verifyMessageSignature } from "@concordium/web-sdk";
import { NETWORK, jsonSafe } from "./config.mjs";
import { isOperator, REGISTRY, REGISTRY_CONTRACT_NAME } from "./registry.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA = Buffer.from(readFileSync(join(HERE, "registry_schema.b64"), "utf8").trim(), "base64");
export const REGISTRY_API = process.env.CLIENTSCOPE_REGISTRY_API || "https://agent-registry-mcp.concordium.com";
export const CLIENTSCOPE_AGENT_ID = 1010n;   // ClientScope Work Agent
export const BUYER_AGENT_ID = 1211n;         // Northgate Supplies Buyer Agent (demo)
export const HANDSHAKE_TTL_MS = 5 * 60_000;

const u64le = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
export const tokenAddressOf = (id) => tokenAddressToBase58({ contract: REGISTRY, id: u64le(id).toString("hex") });
const some = (o) => (o && "Some" in o ? o.Some[0] : null);

/** Read one agent record straight from the registry contract (no indexer, no third-party API). */
export async function readAgent(client, tokenId) {
  let id; try { id = BigInt(tokenId); } catch { return null; }
  if (id < 0n || id > 0xffffffffffffffffn) return null;
  const param = Buffer.concat([Buffer.from([8]), u64le(id)]); // CIS-2 TokenIdU64: length byte + u64 LE
  const r = await client.invokeContract({ contract: REGISTRY, method: ReceiveName.fromString(`${REGISTRY_CONTRACT_NAME}.agentOf`), parameter: Parameter.fromBuffer(param) });
  if (r.tag !== "success") throw new Error("agentOf call failed");
  const v = deserializeReceiveReturnValue(r.returnValue.buffer, SCHEMA, ContractName.fromString(REGISTRY_CONTRACT_NAME), EntrypointName.fromString("agentOf"));
  const a = some(v);
  if (!a) return null;
  const h = some(a.metadata_hash);
  return { token_id: id.toString(), token_address: tokenAddressOf(id), owner: String(a.owner_account), agent_wallet: some(a.agent_wallet) ? String(some(a.agent_wallet)) : null,
    agent_uri: some(a.agent_uri), metadata_hash_hex: h ? Buffer.from(h.map(Number)).toString("hex") : null,
    status: Object.keys(a.status || {})[0] || null, registered_at: a.registered_at };
}

/** Badge check of any agent: on-chain record, Active, card fetched from the on-chain URI, SHA-256 == on-chain hash,
 *  card's badge block names the same token and owner, and (second opinion) Concordium's own badge checker agrees. */
export async function verifyAgentBadge(client, tokenId, { registryCheck = true } = {}) {
  const checks = {}; const facts = { token_id: String(tokenId) };
  let agent = null; try { agent = await readAgent(client, tokenId); } catch (e) { facts.error = e.message; }
  checks.registered = !!agent;
  checks.active = agent?.status === "Active";
  let card = null, sha = null;
  if (agent?.agent_uri) {
    try {
      const r = await fetch(agent.agent_uri, { signal: AbortSignal.timeout(15000), cache: "no-store" });
      if (r.ok) { const bytes = Buffer.from(await r.arrayBuffer()); sha = createHash("sha256").update(bytes).digest("hex"); card = JSON.parse(bytes.toString("utf8")); }
    } catch { /* unreachable or not JSON */ }
  }
  checks.card_fetched = !!card;
  checks.card_hash_matches_chain = !!sha && sha === agent?.metadata_hash_hex;
  const badge = (card?.capabilities?.extensions || []).find((e) => String(e.uri || "").includes("concordium-badge"));
  const p = badge?.params || {};
  checks.card_names_this_agent = !!agent && String(p.tokenAddress || "").endsWith(`:${agent.token_address}`) && String(p.owner?.account || "").endsWith(`:${agent.owner}`)
    && String(p.tokenAddress || "").startsWith(`${NETWORK}/`);
  checks.card_active = card?.active === true;
  if (registryCheck && agent) {
    try {
      const cb = await (await fetch(`${REGISTRY_API}/v1/check-badge/${agent.token_address}?network=testnet`, { signal: AbortSignal.timeout(20000) })).json();
      checks.registry_badge_valid = cb.badge_valid === true; facts.registry_issues = cb.issues || [];
    } catch (e) { checks.registry_badge_valid = false; facts.registry_error = String(e.message || e); }
  }
  Object.assign(facts, { token_address: agent?.token_address ?? null, name: card?.name ?? null, owner: agent?.owner ?? null, agent_wallet: agent?.agent_wallet ?? null,
    agent_uri: agent?.agent_uri ?? null, on_chain_hash: agent?.metadata_hash_hex ?? null, card_sha256: sha, status: agent?.status ?? null, role: card?.role ?? null });
  const failed = Object.entries(checks).filter(([, v]) => v !== true).map(([k]) => k);
  return { ok: failed.length === 0, checks, failed, facts, agent };
}

/** Does `signer` control this agent? Owner, the agent's agentWallet, or an operator approved by the owner on the registry. */
export async function signerControlsAgent(client, agent, signer) {
  if (!agent) return { ok: false, via: null };
  if (signer === agent.owner) return { ok: true, via: "owner" };
  if (agent.agent_wallet && signer === agent.agent_wallet) return { ok: true, via: "agent_wallet" };
  try { if (await isOperator(client, agent.owner, signer)) return { ok: true, via: "registry_operator" }; } catch { /* fall through */ }
  return { ok: false, via: null };
}

export const newNonce = () => randomBytes(16).toString("hex");

/** The exact text an agent signs to prove it controls its registered account. Binds both agents, the job and the verifier's nonce. */
export function handshakeMessage({ agentId, signer, toAgent, nonce, jobId, issued }) {
  return ["Concordium agent handshake v1", `network: ${NETWORK}`, `registry: CIS-8004 ${REGISTRY.index},${REGISTRY.subindex}`,
    `agent: #${agentId} ${tokenAddressOf(agentId)}`, `signer: ${signer}`, `verifier agent: #${toAgent}`, `job: ${jobId}`, `nonce: ${nonce}`, `issued: ${issued}`].join("\n");
}

/** Sign a handshake for `agentId` with an account key. */
export async function signHandshake({ agentId, signerAddress, keyHex, toAgent, nonce, jobId }) {
  const issued = new Date().toISOString();
  const message = handshakeMessage({ agentId, signer: signerAddress, toAgent, nonce, jobId, issued });
  const signature = jsonSafe(await signMessage(AccountAddress.fromBase58(signerAddress), message, buildBasicAccountSigner(keyHex)));
  return { agent_id: String(agentId), token_address: tokenAddressOf(agentId), signer: signerAddress, message, signature, issued };
}

/** Verify a handshake reply against the nonce WE generated. Every input from the other side is re-derived or checked on chain. */
export async function verifyHandshake(client, reply, { expectAgentId, myAgentId, nonce, jobId, agent }) {
  const checks = {};
  const signer = String(reply?.signer || "");
  let issuedMs = NaN; try { issuedMs = Date.parse(reply?.issued); } catch { /* bad date */ }
  let validAddr = true; try { AccountAddress.fromBase58(signer); } catch { validAddr = false; }
  const rebuilt = validAddr ? handshakeMessage({ agentId: expectAgentId, signer, toAgent: myAgentId, nonce, jobId, issued: reply?.issued }) : null;
  checks.handshake_for_expected_agent = String(reply?.agent_id) === String(expectAgentId);
  checks.handshake_nonce_is_mine = rebuilt !== null && reply?.message === rebuilt; // our fresh nonce, our job, our agent id, this agent
  checks.handshake_fresh = Number.isFinite(issuedMs) && Math.abs(Date.now() - issuedMs) < HANDSHAKE_TTL_MS;
  let info = null; if (validAddr) { try { info = await client.getAccountInfo(AccountAddress.fromBase58(signer)); } catch { info = null; } }
  checks.handshake_signer_on_chain = !!info;
  let sigOk = false;
  if (info && checks.handshake_nonce_is_mine) { try { sigOk = await verifyMessageSignature(rebuilt, reply.signature, info); } catch { sigOk = false; } }
  checks.handshake_signature_valid = sigOk;
  const ctl = sigOk ? await signerControlsAgent(client, agent, signer) : { ok: false, via: null }; // a claim without a valid signature proves nothing
  checks.handshake_signer_controls_agent = ctl.ok;
  const failed = Object.entries(checks).filter(([, v]) => v !== true).map(([k]) => k);
  return { ok: failed.length === 0, checks, failed, signer, via: ctl.via, message: reply?.message ?? null, signature: reply?.signature ?? null };
}
