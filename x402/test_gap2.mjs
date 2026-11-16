// Gap 2 tests: two-way agent verification and the signed fresh-challenge handshake, against the RUNNING job server
// (node server.mjs, or the dashboard which starts it) and live Concordium testnet state. Nothing here pays or changes chain state.
//   node test_gap2.mjs [--expect-supplier-pending]
// Exit 0 only if every expectation holds.
import { spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { AccountAddress, buildBasicAccountSigner, signMessage } from "@concordium/web-sdk";
import { CLIENT_ADDRESS, CLIENTSCOPE_PAYTO, PORT, jsonSafe } from "./config.mjs";
import { grpc } from "./chain.mjs";
import { BUYER_AGENT_ID, CLIENTSCOPE_AGENT_ID, newNonce, readAgent, signHandshake, verifyAgentBadge, verifyHandshake } from "./agent_trust.mjs";

const PENDING = process.argv.includes("--expect-supplier-pending");
const base = `http://127.0.0.1:${PORT}`;
const client = grpc();
const results = [];
const OK = "\u2705", BAD = "\u274c";
const post = async (url, body) => { const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
function expect(name, cond, detail) { results.push({ name, pass: !!cond, detail }); console.log(`${cond ? OK : BAD} ${name}${detail ? `\n     ${detail}` : ""}`); }
const randKey = () => Buffer.from(generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" }).d, "base64url").toString("hex");

async function buyerAttempt({ account, keyHex, agentId, label }) {
  const job = `CS-T${Date.now().toString(36).toUpperCase()}`;
  const ch = await post(`${base}/buyer/challenge`, { account, jobId: job, agentId });
  const sig = jsonSafe(await signMessage(AccountAddress.fromBase58(account), ch.body.message, buildBasicAccountSigner(keyHex)));
  const v = await post(`${base}/buyer/verify`, { account, jobId: job, nonce: ch.body.nonce, signature: sig });
  return { label, http: v.status, verified: v.body.verified, failed: v.body.failed, buyer_agent: v.body.facts?.buyer_agent, challenge: ch.body.message };
}

console.log(`Gap 2 tests against ${base} (${new Date().toISOString()})\n`);
console.log("== ClientScope checks the BUYER agent ==");
const good = await buyerAttempt({ account: CLIENT_ADDRESS, keyHex: process.env.CCD_CLIENT_PRIVATE_KEY, agentId: String(BUYER_AGENT_ID), label: "registered buyer agent #1211" });
expect("Real buyer agent #1211 is accepted (badge, card hash, Active, key controls agent, identity, allow list)", good.http === 200 && good.verified,
  `HTTP ${good.http}, failed=[${good.failed}], agent ${good.buyer_agent?.token_address} card ${String(good.buyer_agent?.card_sha256).slice(0, 16)}... signer is its ${good.buyer_agent?.signer_is}`);
const unreg = await buyerAttempt({ account: CLIENT_ADDRESS, keyHex: process.env.CCD_CLIENT_PRIVATE_KEY, agentId: null, label: "unregistered" });
expect("Unregistered buyer (real account, real key, on the allow list, but no registered agent) is refused", unreg.http === 403 && unreg.failed.every((f) => f.startsWith("buyer_")) && unreg.failed.includes("buyer_agent_registered"),
  `HTTP ${unreg.http}, failed=[${unreg.failed}]`);
const stolen = await buyerAttempt({ account: CLIENT_ADDRESS, keyHex: process.env.CCD_CLIENT_PRIVATE_KEY, agentId: String(CLIENTSCOPE_AGENT_ID), label: "stolen card #1010" });
expect("Buyer presenting someone else's registered agent (#1010, a valid card it does not control) is refused", stolen.http === 403 && stolen.failed.join() === "buyer_agent_controlled_by_signer",
  `HTTP ${stolen.http}, failed=[${stolen.failed}]`);
const imp = await buyerAttempt({ account: CLIENT_ADDRESS, keyHex: randKey(), agentId: String(BUYER_AGENT_ID), label: "impostor key" });
expect("Impostor with the buyer's copied card and address but a different key is refused", imp.http === 403 && imp.failed.includes("challenge_signed") && imp.failed.includes("buyer_agent_controlled_by_signer"),
  `HTTP ${imp.http}, failed=[${imp.failed}]`);
const nosess = await post(`${base}/jobs/scrape`, { jobId: "CS-NOSESSION" });
expect("Job endpoint without a verified buyer session answers 403 (no 402, so nothing can be paid)", nosess.status === 403, `HTTP ${nosess.status}`);

console.log("\n== The BUYER agent checks ClientScope ==");
const badge = await verifyAgentBadge(client, CLIENTSCOPE_AGENT_ID);
expect("ClientScope #1010 badge: registered, Active, card at the on-chain URI hashes to the on-chain value, registry agrees", badge.ok, JSON.stringify(badge.checks));
const nonce = newNonce(), job = "CS-TESTHANDSHAKE";
const real = await post(`${base}/agent/handshake`, { nonce, jobId: job, fromAgent: String(BUYER_AGENT_ID) });
const hv = await verifyHandshake(client, real.body, { expectAgentId: CLIENTSCOPE_AGENT_ID, myAgentId: BUYER_AGENT_ID, nonce, jobId: job, agent: badge.agent });
expect("ClientScope signs MY fresh nonce; signature matches its signer's on-chain keys", hv.checks.handshake_nonce_is_mine && hv.checks.handshake_signature_valid && hv.checks.handshake_fresh,
  `signer ${hv.signer}, checks ${JSON.stringify(hv.checks)}`);
if (PENDING) expect("(Pending owner approval) signer is not yet approved for #1010, so the buyer would refuse", hv.checks.handshake_signer_controls_agent === false, `via=${hv.via}`);
else expect("Signer controls agent #1010 on chain (owner, agentWallet or approved operator)", hv.checks.handshake_signer_controls_agent === true, `via=${hv.via}`);
const again = await post(`${base}/agent/handshake`, { nonce, jobId: job, fromAgent: String(BUYER_AGENT_ID) });
expect("ClientScope refuses to sign the same nonce twice", again.status === 409, `HTTP ${again.status}`);

// Fake suppliers: they copy ClientScope's real card (so the badge check passes) but cannot produce the right signature.
async function fake(mode, extraEnv = {}) {
  const port = 4031 + Math.floor(Math.random() * 500);
  const p = spawn("node", ["fake_supplier.mjs"], { env: { ...process.env, CLIENTSCOPE_FAKE_MODE: mode, CLIENTSCOPE_FAKE_PORT: String(port), ...extraEnv } });
  await new Promise((r) => p.stdout.once("data", r));
  const n = newNonce();
  const rep = await post(`http://127.0.0.1:${port}/agent/handshake`, { nonce: n, jobId: "CS-TESTFAKE", fromAgent: String(BUYER_AGENT_ID) });
  p.kill();
  return verifyHandshake(client, rep.body, { expectAgentId: CLIENTSCOPE_AGENT_ID, myAgentId: BUYER_AGENT_ID, nonce: n, jobId: "CS-TESTFAKE", agent: badge.agent });
}
const wk = await fake("wrong-key");
expect("Fake supplier with the copied card and a wrong key (claims the owner account) is refused", !wk.ok && wk.failed.includes("handshake_signature_valid"), `failed=[${wk.failed}]`);
const { writeFileSync } = await import("node:fs");
const capPath = "/tmp/clientscope-captured-handshake.json";
writeFileSync(capPath, JSON.stringify(real.body));
const rp = await fake("replay", { CLIENTSCOPE_FAKE_REPLAY: capPath });
expect("Fake supplier replaying a genuine ClientScope signature captured earlier is refused (not my nonce)", !rp.ok && rp.failed.includes("handshake_nonce_is_mine"), `failed=[${rp.failed}]`);

console.log("\n== Control: the verifier accepts a legitimate handshake ==");
const a1211 = await readAgent(client, BUYER_AGENT_ID);
const n2 = newNonce();
const legit = await signHandshake({ agentId: BUYER_AGENT_ID, signerAddress: CLIENT_ADDRESS, keyHex: process.env.CCD_CLIENT_PRIVATE_KEY, toAgent: CLIENTSCOPE_AGENT_ID, nonce: n2, jobId: "CS-TESTCONTROL" });
const lv = await verifyHandshake(client, legit, { expectAgentId: BUYER_AGENT_ID, myAgentId: CLIENTSCOPE_AGENT_ID, nonce: n2, jobId: "CS-TESTCONTROL", agent: a1211 });
expect("Buyer agent #1211's own handshake (signed by its owner key) passes every check", lv.ok, `via=${lv.via}`);
const owner1010 = (await readAgent(client, CLIENTSCOPE_AGENT_ID)).owner;
expect("ClientScope's owner on chain is Henry's account", owner1010 === CLIENTSCOPE_PAYTO, owner1010);

const passed = results.filter((r) => r.pass).length;
console.log(`\n${passed}/${results.length} passed`);
console.log("RESULT " + JSON.stringify({ at: new Date().toISOString(), passed, total: results.length, results }));
process.exit(passed === results.length ? 0 : 1);
