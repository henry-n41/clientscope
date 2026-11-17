// DOMAIN PROOF: a supplier's website, its Concordium account and its CIS-8004 badge must all point to each other
// before ClientScope will scrape it.
//
//   site  --/.well-known/concordium-agent.json-->  account + badge   (the proof file, signed by the account's key)
//   badge --on-chain owner-->                      account           (CIS-8004 agentOf, Active, card hash == chain)
//   badge --card provider.url-->                   site              (the card pinned on chain names the same site)
//
// A lookalike can copy the page, the name and even the proof file, and can register a real badge of its own, but it cannot
// make all three agree: either the proof names another site, the signature does not match the badge owner's keys, or the
// badge's card claims a site whose own proof names a different agent.
//
//   node domain_proof.mjs verify <site_url> [--expect <agent_id>] [--tamper] [--require]   -> JSON verdict
//   node domain_proof.mjs make <site_url> <agent_id> <client|sponsor> [--claim <site>]      -> proof JSON (key from env)
//   node domain_proof.mjs anchor < verdict.json                                             -> anchors the verdict (RegisterData)
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AccountAddress, buildBasicAccountSigner, signMessage, verifyMessageSignature } from "@concordium/web-sdk";
import { NETWORK, CLIENT_ADDRESS, SPONSOR_ADDRESS, jsonSafe, explorerTx } from "./config.mjs";
import { grpc } from "./chain.mjs";
import { readAgent, verifyAgentBadge, tokenAddressOf } from "./agent_trust.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const PROOF_PATH = ".well-known/concordium-agent.json";
export const PROOF_TYPE = "ConcordiumDomainProof";
export const REGISTRY_ID = "12802,0";
export const REAL_SUPPLIER_SITE = "https://henry-n41.github.io/clientscope-supplier-demo/";
export const REAL_SUPPLIER_AGENT = "1211";
export const LOOKALIKE_SITE = "https://raw.githubusercontent.com/henry-n41/clientscope/agent-cards/lookalike/";
export const LOOKALIKE_COPY_SITE = "https://raw.githubusercontent.com/henry-n41/clientscope/agent-cards/lookalike-copy/";

/** Canonical form of a site: https://host/path/ (lower-case host, trailing slash, no query or fragment). */
export function normSite(u) {
  try {
    const x = new URL(String(u));
    let p = x.pathname.replace(/index\.html?$/i, "");
    if (!p.endsWith("/")) p += "/";
    return `${x.protocol}//${x.host.toLowerCase()}${p}`;
  } catch { return null; }
}
export const proofUrlOf = (site) => normSite(site) + PROOF_PATH;

/** The exact text the supplier's account signs (Concordium signMessage, same format as the Browser Wallet's). */
export function proofMessage({ site, tokenId, account, issued }) {
  return ["Concordium domain proof v1", `site: ${site}`, `network: ${NETWORK}`, `registry: CIS-8004 ${REGISTRY_ID}`,
    `agent: #${tokenId} ${tokenAddressOf(tokenId)}`, `account: ${account}`, `issued: ${issued}`].join("\n");
}

export async function makeProof({ site, tokenId, account, keyHex }) {
  const s = normSite(site); const issued = new Date().toISOString();
  const message = proofMessage({ site: s, tokenId, account, issued });
  const signature = jsonSafe(await signMessage(AccountAddress.fromBase58(account), message, buildBasicAccountSigner(keyHex)));
  return { type: PROOF_TYPE, version: 1, site: s, network: NETWORK, registry: `CIS-8004 ${REGISTRY_ID}`,
    agent: { token_id: String(tokenId), token_address: tokenAddressOf(tokenId) }, account, issued, message, signature,
    how_to_verify: "Rebuild `message` from the fields, verify `signature` against the account's on-chain keys (Concordium signMessage), " +
      "then check the CIS-8004 agent is owned by that account, Active, and that its on-chain card names this site as provider.url." };
}

async function fetchJson(url, ms = 12000) {
  const bust = url + (url.includes("?") ? "&" : "?") + "t=" + Date.now();
  const r = await fetch(bust, { signal: AbortSignal.timeout(ms), cache: "no-store", headers: { "cache-control": "no-cache" } });
  if (!r.ok) return { status: r.status, json: null };
  const text = await r.text();
  try { return { status: r.status, json: JSON.parse(text), sha256: createHash("sha256").update(text).digest("hex") }; } catch { return { status: r.status, json: null, not_json: true }; }
}

/** What an attacker who edits the proof (or alters it in transit) would do: point the domain at another badge. */
function tamperProof(p) {
  const t = JSON.parse(JSON.stringify(p));
  t.agent = { token_id: "1010", token_address: tokenAddressOf(1010) };        // claim a different badge...
  t.message = proofMessage({ site: t.site, tokenId: 1010, account: t.account, issued: t.issued }); // ...and re-write the text, keeping the old signature
  return t;
}

/**
 * Verify a supplier site. Returns { verdict: verified | refused | unproven, steps:[{id,label,pass,detail}], facts }.
 * opts.fetchBase: fetch the files from here instead of the site (tests only: a local mirror of exactly what is published).
 * opts.tamper:    alter the downloaded proof before checking it (the dashboard's Tamper button).
 * opts.expectAgent: the buyer's pinned supplier agent; opts.requireProof: refuse a site that publishes no proof.
 * opts.onStep:    called after each step (live ticks).
 */
export async function verifyDomain(client, siteUrl, opts = {}) {
  const site = normSite(siteUrl);
  const steps = []; const facts = { site, proof_url: site ? proofUrlOf(site) : null, tampered: !!opts.tamper, checked_at: new Date().toISOString() };
  const add = (id, label, pass, detail) => { const s = { id, label, pass, detail }; steps.push(s); opts.onStep?.(s); return pass; };
  const done = (verdict) => {
    const out = { verdict, ok: verdict === "verified", site, steps, failed: steps.filter((s) => s.pass === false).map((s) => s.id), facts };
    out.verdict_sha256 = createHash("sha256").update(JSON.stringify({ verdict, site, steps: steps.map(({ id, pass }) => [id, pass]), facts: { ...facts, checked_at: undefined } })).digest("hex");
    return out;
  };
  if (!site) { add("site_url_valid", "Supplier URL is a valid web address", false, String(siteUrl)); return done("refused"); }

  // 1. the site publishes a proof
  const base = opts.fetchBase ? normSite(opts.fetchBase) : site;
  let got = null; try { got = await fetchJson(base + PROOF_PATH); } catch (e) { got = { status: 0, error: e.message }; }
  let proof = got?.json;
  facts.proof_http_status = got?.status ?? 0;
  if (!proof || proof.type !== PROOF_TYPE) {
    add("proof_published", `Site publishes /${PROOF_PATH}`, false, got?.status ? `HTTP ${got.status}${got.not_json ? " (not JSON)" : ""}` : `unreachable: ${got?.error || "?"}`);
    return done(opts.requireProof ? "refused" : "unproven");
  }
  if (opts.tamper) proof = tamperProof(proof);
  facts.proof_sha256 = got.sha256; facts.proof_account = proof.account ?? null; facts.proof_agent = proof.agent?.token_id ?? null;
  add("proof_published", `Site publishes /${PROOF_PATH}`, true, `HTTP 200, names agent #${proof.agent?.token_id} and account ${String(proof.account).slice(0, 10)}...`);

  // 2. the proof is about THIS site (a copied proof names the site it was copied from)
  add("proof_names_this_site", "The proof is for this exact site", normSite(proof.site) === site,
    normSite(proof.site) === site ? site : `proof says ${proof.site}, but it was served by ${site}`);

  // 3. the account really signed it (keys read from chain)
  let sigOk = false, sigDetail = "";
  try {
    const tokenId = String(proof.agent?.token_id ?? "");
    const rebuilt = proofMessage({ site: proof.site, tokenId, account: proof.account, issued: proof.issued });
    if (rebuilt !== proof.message) sigDetail = "message does not match the proof's own fields";
    else if (String(proof.agent?.token_address) !== tokenAddressOf(tokenId)) sigDetail = "token address does not match token id";
    else {
      const info = await client.getAccountInfo(AccountAddress.fromBase58(String(proof.account)));
      sigOk = await verifyMessageSignature(rebuilt, proof.signature, info);
      sigDetail = sigOk ? `signed by ${proof.account} (keys read from chain)` : `signature does not match ${String(proof.account).slice(0, 10)}...'s on-chain keys`;
    }
  } catch (e) { sigDetail = `cannot verify: ${e.message}`; }
  add("proof_signature_valid", "Signed by the account's on-chain key", sigOk, sigDetail);

  // 4. the badge belongs to that account and is valid (Active, card hash == chain)
  let b = null; try { b = await verifyAgentBadge(client, proof.agent?.token_id, { registryCheck: false }); } catch (e) { facts.badge_error = e.message; }
  const agent = b?.agent;
  const owned = !!agent && (agent.owner === proof.account || agent.agent_wallet === proof.account);
  add("badge_owned_by_account", "The badge is owned by that account", owned,
    agent ? `agent #${agent.token_id} owner ${agent.owner.slice(0, 10)}...${owned ? "" : `, not ${String(proof.account).slice(0, 10)}...`}` : "agent not found in the registry");
  const badgeOk = !!b && ["registered", "active", "card_fetched", "card_hash_matches_chain", "card_names_this_agent"].every((k) => b.checks[k]);
  add("badge_valid", "Badge Active, card hash matches chain", badgeOk,
    b ? `status ${b.facts.status}, card ${String(b.facts.card_sha256 || "").slice(0, 12)}... ${b.checks.card_hash_matches_chain ? "==" : "!="} on-chain hash` : "no badge");
  facts.badge = b ? { token_id: b.facts.token_id, token_address: b.facts.token_address, name: b.facts.name, owner: b.facts.owner, status: b.facts.status, card_url: b.facts.agent_uri } : null;

  // 5. the badge's card names this site, and the site it names proves this same badge
  let card = null; try { if (agent?.agent_uri) card = (await fetchJson(agent.agent_uri)).json; } catch {}
  const claimed = normSite(card?.provider?.url);
  facts.card_claims_site = claimed;
  add("card_names_this_site", "The badge's card names this site", claimed === site, claimed ? (claimed === site ? `provider.url = ${claimed}` : `card claims ${claimed}, not ${site}`) : "card has no provider.url");
  if (claimed && claimed !== site) {
    let back = null; try { back = (await fetchJson(proofUrlOf(claimed))).json; } catch {}
    const backAgent = back?.agent?.token_id;
    const pointsBack = !!back && String(backAgent) === String(agent?.token_id) && normSite(back.site) === claimed;
    add("claimed_site_points_back", "The site the card claims proves this badge", pointsBack,
      pointsBack ? `${claimed} proves agent #${backAgent}, but this copy is served from ${site}` : back ? `${claimed} proves agent #${backAgent}, not #${agent?.token_id}` : `${claimed} publishes no proof for agent #${agent?.token_id}`);
  }

  // 6. optional: the buyer pinned which supplier it expects
  if (opts.expectAgent != null) add("expected_supplier", `This is the buyer's supplier (agent #${opts.expectAgent})`, String(proof.agent?.token_id) === String(opts.expectAgent),
    `proof names agent #${proof.agent?.token_id}`);

  return done(steps.every((s) => s.pass) ? "verified" : "refused");
}

/** Anchor a verdict on Concordium (RegisterData from the operator account, same CBOR anchor as job receipts). */
export function anchorVerdict(v, label) {
  const req = { receipt_sha256: v.verdict_sha256, public: { job: String(label || "DOMAIN").slice(0, 40), agent: `#${v.facts?.proof_agent ?? "-"}`,
    log_sha256: v.verdict_sha256, result: v.verdict === "verified" ? "domain_verified" : v.verdict === "unproven" ? "domain_unproven" : "domain_refused" } };
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [join(HERE, "anchor_tool.mjs"), "send"], { env: process.env });
    let out = "", err = ""; p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (err += d));
    p.stdin.end(JSON.stringify(req));
    p.on("close", (c) => { if (c !== 0) return reject(new Error(err.slice(-300))); try { const r = JSON.parse(out.trim().split("\n").pop()); resolve({ ...r, explorer: explorerTx(r.tx_hash) }); } catch (e) { reject(e); } });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2); const flag = (f) => { const i = args.indexOf(f); return i >= 0 ? (args.splice(i, 1), true) : false; };
  const opt = (f) => { const i = args.indexOf(f); if (i < 0) return undefined; const v = args[i + 1]; args.splice(i, 2); return v; };
  const tamper = flag("--tamper"), require = flag("--require"), expect = opt("--expect"), claim = opt("--claim"), fetchBase = opt("--fetch-base");
  const [cmd, a1, a2, a3] = args;
  if (cmd === "verify") {
    const v = await verifyDomain(grpc(), a1, { tamper, requireProof: require, expectAgent: expect, fetchBase });
    console.log(JSON.stringify(v, null, 1)); process.exit(v.ok ? 0 : v.verdict === "unproven" ? 2 : 1);
  } else if (cmd === "make") {
    const who = a3 === "sponsor" ? { account: SPONSOR_ADDRESS, key: process.env.CCD_SPONSOR_PRIVATE_KEY } : { account: CLIENT_ADDRESS, key: process.env.CCD_CLIENT_PRIVATE_KEY };
    if (!/^[0-9a-f]{64}$/i.test(who.key || "")) { console.error("key missing in env"); process.exit(2); }
    const p = await makeProof({ site: claim || a1, tokenId: a2, account: who.account, keyHex: who.key });
    console.log(JSON.stringify(p, null, 2));
  } else if (cmd === "anchor") {
    let s = ""; for await (const c of process.stdin) s += c; const v = JSON.parse(s);
    console.log(JSON.stringify(await anchorVerdict(v, a1)));
  } else { console.error("usage: verify|make|anchor"); process.exit(2); }
  process.exit(0);
}
