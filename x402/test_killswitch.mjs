// Kill switch tests, against the RUNNING job server and live Concordium testnet state.
//   node test_killswitch.mjs [--live]
// Without --live nothing here sends a transaction. With --live it also runs one full hire with a throwaway demo agent
// through client_agent.py --simulate-kill-switch (one revoke + one halt anchor on testnet) and checks the outcome.
// Exit 0 only if every expectation holds.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { AccountAddress, buildBasicAccountSigner, signMessage } from "@concordium/web-sdk";
import { CLIENT_ADDRESS, PORT, jsonSafe } from "./config.mjs";
import { grpc } from "./chain.mjs";
import { readAgent } from "./agent_trust.mjs";
import { assertRevocable, loadPool, PROTECTED_AGENTS, verifyRevoke } from "./killswitch.mjs";

const base = `http://127.0.0.1:${PORT}`;
const client = grpc();
const results = [];
const OK = "\u2705", BAD = "\u274c";
const post = async (url, body) => { const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
function expect(name, cond, detail) { results.push({ name, pass: !!cond, detail }); console.log(`${cond ? OK : BAD} ${name}${detail ? `\n     ${detail}` : ""}`); }
const refuses = async (id) => { try { await assertRevocable(client, id); return null; } catch (e) { return e.message; } };

console.log(`Kill switch tests against ${base} (${new Date().toISOString()})\n`);
console.log("== Safety: what the kill switch code will never revoke ==");
for (const id of ["1010", "1211"]) {
  const why = await refuses(id);
  const a = await readAgent(client, id);
  expect(`Protected agent #${id} can never be revoked by this code, and is still Active on chain`, why?.includes("protected") && a?.status === "Active", `${why}; on chain: ${a?.status}`);
}
const why999 = await refuses("1100");
expect("An agent that is not a throwaway pool agent is refused", why999?.includes("not a throwaway"), why999);
const pool = loadPool().agents;
expect("The pool holds only throwaway agents, none of them protected", pool.length > 0 && pool.every((a) => a.throwaway && !PROTECTED_AGENTS.has(String(a.token_id))), `${pool.length} agents: ${pool.map((a) => a.token_id).join(", ")}`);
const revokedEntry = [];
for (const e of pool) { const a = await readAgent(client, e.token_id); if (a?.status === "Revoked") revokedEntry.push(e); }
if (revokedEntry.length) {
  const why2 = await refuses(revokedEntry[0].token_id);
  expect(`An already revoked demo agent (#${revokedEntry[0].token_id}) is not revoked twice`, why2?.includes("already Revoked"), why2);
}

console.log("\n== A revoked agent cannot start a new job ==");
if (revokedEntry.length) {
  const id = revokedEntry[0].token_id, job = `CS-T${Date.now().toString(36).toUpperCase()}`;
  const ch = await post(`${base}/buyer/challenge`, { account: CLIENT_ADDRESS, jobId: job, agentId: String(id) });
  const sig = jsonSafe(await signMessage(AccountAddress.fromBase58(CLIENT_ADDRESS), ch.body.message, buildBasicAccountSigner(process.env.CCD_CLIENT_PRIVATE_KEY)));
  const v = await post(`${base}/buyer/verify`, { account: CLIENT_ADDRESS, jobId: job, nonce: ch.body.nonce, signature: sig });
  expect(`Revoked demo agent #${id} with its real owner key is refused before any payment`, v.status === 403 && v.body.failed?.includes("buyer_agent_active"), `HTTP ${v.status}, failed=[${v.body.failed}]`);
}

console.log("\n== Independent re-check of past revokes on chain ==");
const ev = JSON.parse(readFileSync(new URL("../build-log/killswitch/revokes.json", import.meta.url), "utf8"));
for (const r of ev.revokes) {
  const v = await verifyRevoke(client, r.tx_hash, r.token_id);
  expect(`Revoke ${r.tx_hash.slice(0, 12)}... is a finalized CIS-8004 revoke of #${r.token_id}, agent now Revoked`, v.ok, JSON.stringify(v.checks));
}
const fake = await verifyRevoke(client, pool[0].register_tx, pool[0].token_id);
expect("A registry transaction that is NOT a revoke (the agent's register tx) fails the revoke check", !fake.ok && !fake.checks.is_registry_revoke_for_token, JSON.stringify(fake.checks));

if (process.argv.includes("--live")) {
  console.log("\n== Live: full hire, owner revokes mid-job ==");
  const p = spawnSync(new URL("../.venv/bin/python", import.meta.url).pathname, ["client_agent.py", "--simulate-kill-switch"], { cwd: new URL("..", import.meta.url).pathname, encoding: "utf8", env: process.env, timeout: 400000 });
  const out = p.stdout || "";
  const m = out.match(/HALTED ([0-9.]+) s after/);
  expect("The job halted, the buyer was charged 0 EUDemo, and the halt receipt verified VALID (exit 8)", p.status === 8 && /halted_agent_revoked, log of/.test(out), `exit ${p.status}, detected in ${m?.[1]} s`);
  console.log(out.split("\n").filter((l) => /Revoke tx|Halt receipt|charged 0/.test(l)).map((l) => "     " + l.trim()).join("\n"));
}

const passed = results.filter((r) => r.pass).length;
console.log(`\n${passed}/${results.length} passed`);
console.log("RESULT " + JSON.stringify({ at: new Date().toISOString(), passed, total: results.length, results }));
process.exit(passed === results.length ? 0 : 1);
