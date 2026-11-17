// LIVE KILL SWITCH: an agent's owner revokes its CIS-8004 badge mid-job; the job halts within seconds, nobody is charged,
// and the halt receipt anchored in the Audit Log names the revoke transaction.
//
// Only THROWAWAY demo agents from killswitch_pool.json can ever be revoked by this code. #1010 (ClientScope) and
// #1211 (the Northgate buyer agent) are hard-blocked, whatever the pool file says.
//
//   node killswitch.mjs provision <n>                 register n throwaway demo agents (owner = demo buyer account)
//   node killswitch.mjs pick                          first pool agent still Active on chain -> JSON
//   node killswitch.mjs pool                          pool with live on-chain status -> JSON
//   node killswitch.mjs revoke <token_id> [reason]    the owner's kill switch (CCD_CLIENT_PRIVATE_KEY)
//   node killswitch.mjs arm <token_id> <job_id> <base_url> [auto_seconds] [trigger_file]
//        waits until ClientScope reports the job running, then revokes when trigger_file appears or after auto_seconds
//   node killswitch.mjs verify-revoke <tx_hash> <token_id>   re-check a revoke transaction on chain -> JSON
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BlockHash, TransactionHash } from "@concordium/web-sdk";
import { CLIENT_ADDRESS, explorerTx, jsonSafe } from "./config.mjs";
import { grpc } from "./chain.mjs";
import { sendRegistryTx } from "./registry.mjs";
import { readAgent, tokenAddressOf } from "./agent_trust.mjs";
import { mcp } from "./registry_mcp.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const POOL_FILE = join(HERE, "killswitch_pool.json");
export const PROTECTED_AGENTS = new Set(["1010", "1211"]);   // NEVER revocable from this code
export const DEMO_NAME = "Northgate Kill-switch Demo Agent";
const CARDS_RAW = "https://raw.githubusercontent.com/henry-n41/clientscope/agent-cards/";
const u64le = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const loadPool = () => (existsSync(POOL_FILE) ? JSON.parse(readFileSync(POOL_FILE, "utf8")) : { agents: [] });
export const inPool = (id) => loadPool().agents.some((a) => String(a.token_id) === String(id));

/** Every rule that must hold before this code will revoke anything. */
export async function assertRevocable(client, tokenId) {
  const id = String(tokenId);
  if (PROTECTED_AGENTS.has(id)) throw new Error(`refusing: agent #${id} is a protected production agent`);
  const entry = loadPool().agents.find((a) => String(a.token_id) === id);
  if (!entry || !entry.throwaway) throw new Error(`refusing: agent #${id} is not a throwaway demo agent in killswitch_pool.json`);
  const a = await readAgent(client, id);
  if (!a) throw new Error(`agent #${id} not found on chain`);
  if (a.owner !== CLIENT_ADDRESS) throw new Error(`refusing: agent #${id} is not owned by the demo buyer account`);
  if (a.status !== "Active") throw new Error(`agent #${id} is already ${a.status}`);
  return { entry, agent: a };
}

export async function revoke(client, tokenId, reason = "owner kill switch: stop this agent now") {
  await assertRevocable(client, tokenId);
  const keyHex = process.env.CCD_CLIENT_PRIVATE_KEY;
  if (!/^[0-9a-f]{64}$/i.test(keyHex || "")) throw new Error("CCD_CLIENT_PRIVATE_KEY missing");
  const p = await mcp("build_revoke", { token_id: String(tokenId), reason, sender: CLIENT_ADDRESS, network: "testnet" });
  if (p.receive_name !== "CIS-8004.revoke" || !p.parameter_hex.startsWith("08" + u64le(tokenId).toString("hex")))
    throw new Error("unexpected revoke payload from the registry MCP");
  const t0 = Date.now();
  const r = await sendRegistryTx(client, { keyHex, sender: CLIENT_ADDRESS, receiveName: p.receive_name, parameterHex: p.parameter_hex, energy: p.suggested_energy });
  return { ...r, token_id: String(tokenId), reason, sent_at: new Date(t0).toISOString(), finalized_in_s: ((Date.now() - t0) / 1000).toFixed(1), explorer: explorerTx(r.tx_hash) };
}

const evMatchesRevoke = (ev, tokenId) => {
  const e = jsonSafe(ev);
  const rn = String(e.receiveName?.value ?? e.receiveName ?? "");
  const idx = String(e.address?.index ?? "");
  const msg = String(e.message?.buffer ? Buffer.from(ev.message.buffer).toString("hex") : (e.message?.value ?? e.message ?? ""));
  return e.tag === "Updated" && idx === "12802" && rn === "CIS-8004.revoke" && msg.startsWith("08" + u64le(tokenId).toString("hex"));
};

/** Find the revoke transaction for tokenId in finalized blocks (fromHeight, toHeight]. Read straight from the chain. */
export async function findRevokeTx(client, tokenId, fromHeight, toHeight) {
  for (let h = BigInt(toHeight); h > BigInt(fromHeight); h--) {
    const hashes = await client.getBlocksAtHeight(h);
    for (const bh of hashes) {
      for await (const item of client.getBlockTransactionEvents(bh)) {
        const evs = item.events || [];
        if (item.transactionType === "update" && evs.some((ev) => evMatchesRevoke(ev, tokenId))) {
          const info = await client.getBlockInfo(bh);
          return { revoke_tx: item.hash.toString(), block_hash: bh.toString(), block_height: h.toString(),
            revoked_at: new Date(info.blockSlotTime).toISOString(), sender: item.sender?.toString?.() || String(item.sender), explorer: explorerTx(item.hash.toString()) };
        }
      }
    }
  }
  return null;
}

/** Poll an agent's on-chain status every intervalMs. Calls onRevoked(info) once, with the revoke tx found on chain. */
export function watchAgent(client, tokenId, { intervalMs = 1000, onRevoked, onError, maxMs = 15 * 60_000 } = {}) {
  let stopped = false, lastActiveHeight = null, fired = false;
  const until = Date.now() + maxMs;
  (async () => {
    while (!stopped && Date.now() < until) {
      try {
        const cs = await client.getConsensusStatus();
        const height = cs.lastFinalizedBlockHeight;
        const a = await readAgent(client, tokenId);
        if (a?.status === "Active") lastActiveHeight = height;
        else if (a && lastActiveHeight !== null && !fired) {
          fired = true;
          const detected_at = new Date();
          let found = null;
          for (let i = 0; i < 4 && !found; i++) {
            const now = (await client.getConsensusStatus()).lastFinalizedBlockHeight;
            found = await findRevokeTx(client, tokenId, lastActiveHeight, now).catch(() => null);
            if (!found) await sleep(800);
          }
          const info = { token_id: String(tokenId), token_address: tokenAddressOf(tokenId), status: a.status, detected_at: detected_at.toISOString(),
            last_active_height: lastActiveHeight.toString(), ...(found || {}),
            detection_seconds: found ? Math.max(0, (detected_at - new Date(found.revoked_at)) / 1000).toFixed(1) : null };
          stopped = true; onRevoked?.(info); return;
        }
      } catch (e) { onError?.(e); }
      await sleep(intervalMs);
    }
  })();
  return () => { stopped = true; };
}

/** Independent check of a revoke transaction: finalized, success, CIS-8004.revoke on 12802,0 for this token, agent now Revoked. */
export async function verifyRevoke(client, txHash, tokenId) {
  const st = await client.getBlockItemStatus(TransactionHash.fromHexString(txHash));
  const sum = st?.outcome?.summary;
  const checks = {
    finalized: st?.status === "finalized",
    succeeded: sum?.transactionType === "update",
    is_registry_revoke_for_token: !!(sum?.events || []).some((ev) => evMatchesRevoke(ev, tokenId)),
  };
  const a = await readAgent(client, tokenId);
  checks.agent_now_revoked = a?.status === "Revoked";
  let revoked_at = null;
  if (st?.outcome?.blockHash) revoked_at = new Date((await client.getBlockInfo(BlockHash.fromHexString(String(st.outcome.blockHash)))).blockSlotTime).toISOString();
  return { tx_hash: txHash, token_id: String(tokenId), sender: sum?.sender?.toString?.() || null, revoked_at, checks, ok: Object.values(checks).every(Boolean) };
}

// ---------------------------------------------------------------- provisioning (box only: pushes cards to the agent-cards branch)
function cardTemplate(tokenId) {
  const base = JSON.parse(readFileSync(join(HERE, "..", "client-agent-card", "client-agent-card.json"), "utf8"));
  base.name = `${DEMO_NAME} #${tokenId} (throwaway)`;
  base.description = "Throwaway demo agent for ClientScope's live kill switch. It is a real CIS-8004 agent owned by the Northgate demo buyer account. " +
    "Its owner revokes it in the middle of a paid job to show that the job halts within seconds, nobody is charged, and the halt is anchored on Concordium.";
  base.url = `${CARDS_RAW}demo/killswitch-${tokenId}.json`;
  base.version = "1.0.0";
  return JSON.stringify(base, null, 2);
}

async function provision(n) {
  const client = grpc(); const keyHex = process.env.CCD_CLIENT_PRIVATE_KEY;
  const cardsRepo = process.env.CLIENTSCOPE_CARDS_CLONE || "/tmp/cards";
  const pool = loadPool();
  for (let i = 0; i < n; i++) {
    const reg = await mcp("build_register", { sender: CLIENT_ADDRESS, network: "testnet" });
    const tx = await sendRegistryTx(client, { keyHex, sender: CLIENT_ADDRESS, receiveName: reg.receive_name, parameterHex: reg.parameter_hex, energy: reg.suggested_energy });
    if (tx.outcome !== "success") throw new Error("register rejected " + JSON.stringify(tx.reject_reason));
    const evHex = tx.events[0].events.find((e) => e.startsWith("fe08"));
    const tokenId = Buffer.from(evHex.slice(4, 20), "hex").readBigUInt64LE().toString();
    const badge = await mcp("build_agent_badge", { card_json: cardTemplate(tokenId), owner_account: CLIENT_ADDRESS, token_id: tokenId, network: "testnet" });
    const rel = `demo/killswitch-${tokenId}.json`;
    mkdirSync(join(cardsRepo, "demo"), { recursive: true });
    writeFileSync(join(cardsRepo, rel), badge.agent_card_json);
    const set = await mcp("build_set_agent_uri", { token_id: tokenId, agent_uri: CARDS_RAW + rel, metadata_hash_hex: badge.metadata_hash_hex, sender: CLIENT_ADDRESS, network: "testnet" });
    const tx2 = await sendRegistryTx(client, { keyHex, sender: CLIENT_ADDRESS, receiveName: set.receive_name, parameterHex: set.parameter_hex, energy: set.suggested_energy });
    if (tx2.outcome !== "success") throw new Error("setAgentURI rejected " + JSON.stringify(tx2.reject_reason));
    const e = { token_id: tokenId, token_address: tokenAddressOf(tokenId), throwaway: true, card_url: CARDS_RAW + rel, card_sha256: badge.metadata_hash_hex,
      register_tx: tx.tx_hash, set_uri_tx: tx2.tx_hash, created: new Date().toISOString() };
    pool.agents.push(e); writeFileSync(POOL_FILE, JSON.stringify(pool, null, 1) + "\n");
    console.log(JSON.stringify(e));
  }
  console.log(`cards written under ${cardsRepo}/demo: commit and push the agent-cards branch before using them`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, a1, a2, a3, a4, a5] = process.argv.slice(2);
  const client = grpc();
  try {
    if (cmd === "provision") await provision(Number(a1 || 1));
    else if (cmd === "pool" || cmd === "pick") {
      const out = [];
      for (const e of loadPool().agents) {
        if (PROTECTED_AGENTS.has(String(e.token_id))) continue;
        const a = await readAgent(client, e.token_id).catch(() => null);
        const row = { ...e, status: a?.status || "unknown", owner_ok: a?.owner === CLIENT_ADDRESS };
        if (cmd === "pick" && row.status === "Active" && row.owner_ok) { console.log(JSON.stringify(row)); process.exit(0); }
        out.push(row);
      }
      if (cmd === "pick") { console.log(JSON.stringify({ error: "no Active throwaway demo agent left: run provision" })); process.exit(3); }
      console.log(JSON.stringify({ agents: out, active: out.filter((r) => r.status === "Active").length }, null, 1));
    } else if (cmd === "revoke") {
      console.log(JSON.stringify(await revoke(client, a1, a2 || undefined)));
    } else if (cmd === "arm") {
      const [id, jobId, base, autoS, trigger] = [a1, a2, a3, Number(a4 || 4), a5];
      await assertRevocable(client, id);
      const t0 = Date.now(); let running = false;
      while (Date.now() - t0 < 240_000) {
        try { const r = await fetch(`${base}/jobs/state/${jobId}`, { signal: AbortSignal.timeout(5000) }); if (r.ok && (await r.json()).stage === "running") { running = true; break; } } catch {}
        await sleep(500);
      }
      if (!running) { console.log("KILLSWITCH_ABORT job never started"); process.exit(4); }
      console.log(`KILLSWITCH_ARMED job ${jobId} is running; revoking agent #${id} ${trigger ? `when the button is pressed or ` : ""}in ${autoS}s`);
      const t1 = Date.now(); let how = "auto";
      while (Date.now() - t1 < autoS * 1000) { if (trigger && existsSync(trigger)) { how = "button"; break; } await sleep(200); }
      console.log(`KILLSWITCH_PRESSED by=${how} at=${new Date().toISOString()}`);
      const r = await revoke(client, id, `owner kill switch during job ${jobId}`);
      console.log(`KILLSWITCH_REVOKED ${JSON.stringify({ tx_hash: r.tx_hash, outcome: r.outcome, fee_ccd: r.fee_ccd, finalized_in_s: r.finalized_in_s, explorer: r.explorer, sent_at: r.sent_at, by: how })}`);
    } else if (cmd === "verify-revoke") {
      const v = await verifyRevoke(client, a1, a2); console.log(JSON.stringify(v)); process.exit(v.ok ? 0 : 1);
    } else { console.error("usage: provision|pick|pool|revoke|arm|verify-revoke"); process.exit(2); }
  } catch (e) { console.error(e.message); console.log(JSON.stringify({ error: e.message })); process.exit(1); }
  process.exit(0);
}
