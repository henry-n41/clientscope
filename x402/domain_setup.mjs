// One-off setup for the DOMAIN PROOF demo (box only; writes into the agent-cards clone, then push that branch).
//   node domain_setup.mjs lookalike     register the lookalike "Northgate Supplies" badge (owner: the stand-in attacker
//                                       account = the demo operator account 3N9s8, because we hold no third testnet key),
//                                       pin its card, and write the lookalike site + its proof
//   node domain_setup.mjs copy-site     write the second lookalike: the real page and a byte-for-byte copy of the real proof
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SPONSOR_ADDRESS } from "./config.mjs";
import { grpc } from "./chain.mjs";
import { sendRegistryTx } from "./registry.mjs";
import { tokenAddressOf } from "./agent_trust.mjs";
import { mcp } from "./registry_mcp.mjs";
import { makeProof, REAL_SUPPLIER_SITE, LOOKALIKE_SITE, PROOF_PATH } from "./domain_proof.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CARDS = process.env.CLIENTSCOPE_CARDS_CLONE || "/tmp/cards";
const CARDS_RAW = "https://raw.githubusercontent.com/henry-n41/clientscope/agent-cards/";
const STATE = join(HERE, "domain_demo.json");
const state = () => (existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {});
const save = (s) => writeFileSync(STATE, JSON.stringify(s, null, 1) + "\n");

async function realPage() {
  const r = await fetch(REAL_SUPPLIER_SITE, { cache: "no-store" }); if (!r.ok) throw new Error("real page " + r.status);
  return (await r.text()).replace("<head>", "<head>\n<!-- DEMO LOOKALIKE of the Northgate Supplies page, used by ClientScope's domain proof demo. Not a real supplier. -->");
}

function lookalikeCard(tokenId) {
  const base = JSON.parse(readFileSync(join(HERE, "..", "client-agent-card", "client-agent-card.json"), "utf8"));
  base.name = "Northgate Supplies";
  base.description = "DEMO LOOKALIKE (not the real supplier). A real CIS-8004 badge that copies Northgate Supplies' name and claims its website, " +
    "used to show ClientScope's domain proof refusing a supplier whose website, account and badge do not all point to each other.";
  base.url = `${CARDS_RAW}lookalike/agent-card.json`;
  base.version = "1.0.0"; base.role = "supplier";
  base.provider = { organization: "Northgate Supplies", url: REAL_SUPPLIER_SITE };   // the impersonation: it claims the real site
  base.skills = [{ id: "price-list", name: "Trade price list", description: "Publishes a trade price list.", tags: ["supplier"] }];
  return JSON.stringify(base, null, 2);
}

const [cmd] = process.argv.slice(2);
const s = state();
if (cmd === "lookalike") {
  const client = grpc(); const keyHex = process.env.CCD_SPONSOR_PRIVATE_KEY;
  let tokenId = s.lookalike?.token_id;
  if (!tokenId) {
    const reg = await mcp("build_register", { sender: SPONSOR_ADDRESS, network: "testnet" });
    const tx = await sendRegistryTx(client, { keyHex, sender: SPONSOR_ADDRESS, receiveName: reg.receive_name, parameterHex: reg.parameter_hex, energy: reg.suggested_energy });
    if (tx.outcome !== "success") throw new Error("register rejected " + JSON.stringify(tx.reject_reason));
    tokenId = Buffer.from(tx.events[0].events.find((e) => e.startsWith("fe08")).slice(4, 20), "hex").readBigUInt64LE().toString();
    s.lookalike = { token_id: tokenId, token_address: tokenAddressOf(tokenId), owner: SPONSOR_ADDRESS, register_tx: tx.tx_hash }; save(s);
  }
  const badge = await mcp("build_agent_badge", { card_json: lookalikeCard(tokenId), owner_account: SPONSOR_ADDRESS, token_id: tokenId, network: "testnet" });
  mkdirSync(join(CARDS, "lookalike", ".well-known"), { recursive: true });
  writeFileSync(join(CARDS, "lookalike", "agent-card.json"), badge.agent_card_json);
  const set = await mcp("build_set_agent_uri", { token_id: tokenId, agent_uri: `${CARDS_RAW}lookalike/agent-card.json`, metadata_hash_hex: badge.metadata_hash_hex, sender: SPONSOR_ADDRESS, network: "testnet" });
  const tx2 = await sendRegistryTx(client, { keyHex, sender: SPONSOR_ADDRESS, receiveName: set.receive_name, parameterHex: set.parameter_hex, energy: set.suggested_energy });
  if (tx2.outcome !== "success") throw new Error("setAgentURI rejected " + JSON.stringify(tx2.reject_reason));
  // its proof is genuinely signed by its own account for its own badge, but copies the real site's address (it wants to look real)
  const proof = await makeProof({ site: REAL_SUPPLIER_SITE, tokenId, account: SPONSOR_ADDRESS, keyHex });
  writeFileSync(join(CARDS, "lookalike", PROOF_PATH), JSON.stringify(proof, null, 2) + "\n");
  writeFileSync(join(CARDS, "lookalike", "index.html"), await realPage());
  Object.assign(s.lookalike, { card_url: `${CARDS_RAW}lookalike/agent-card.json`, card_sha256: badge.metadata_hash_hex, set_uri_tx: tx2.tx_hash, site: LOOKALIKE_SITE });
  save(s); console.log(JSON.stringify(s.lookalike));
} else if (cmd === "copy-site") {
  mkdirSync(join(CARDS, "lookalike-copy", ".well-known"), { recursive: true });
  writeFileSync(join(CARDS, "lookalike-copy", PROOF_PATH), readFileSync(join(HERE, "..", "supplier-proof", PROOF_PATH)));
  writeFileSync(join(CARDS, "lookalike-copy", "index.html"), await realPage());
  console.log("lookalike-copy written");
} else { console.error("usage: lookalike|copy-site"); process.exit(2); }
process.exit(0);
