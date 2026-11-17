// DOMAIN PROOF tests. Offline-safe parts use a local web server that serves exactly the files a site would publish.
//   node test_domainproof.mjs          checks the verifier against real chain data (badges, keys) and the live lookalikes
//   node test_domainproof.mjs --live   also runs a real lookalike hire through ClientScope (needs the job server on :4021)
import http from "node:http";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { grpc } from "./chain.mjs";
import { readAgent } from "./agent_trust.mjs";
import { CLIENT_ADDRESS, SPONSOR_ADDRESS } from "./config.mjs";
import { verifyDomain, makeProof, REAL_SUPPLIER_SITE, LOOKALIKE_SITE, LOOKALIKE_COPY_SITE, PROOF_PATH } from "./domain_proof.mjs";

const HERE = dirname(fileURLToPath(import.meta.url)); const ROOT = join(HERE, "..");
const LIVE = process.argv.includes("--live");
const client = grpc(); const results = [];
const t = async (name, fn) => { try { const [pass, detail] = await fn(); results.push({ name, pass: !!pass, detail }); console.log(`${pass ? "PASS" : "FAIL"}  ${name}\n      ${detail}`); }
  catch (e) { results.push({ name, pass: false, detail: e.message }); console.log(`FAIL  ${name}\n      ${e.message}`); } };
const sum = (v) => `${v.verdict}; failed=[${v.failed.join(",")}]`;

// local "web hosts": /real/ = the exact file Henry uploads; /forged/ = a proof for the real site signed by the WRONG key
const realProof = readFileSync(join(ROOT, "supplier-proof", PROOF_PATH), "utf8");
const forged = await makeProof({ site: REAL_SUPPLIER_SITE, tokenId: 1211, account: SPONSOR_ADDRESS, keyHex: process.env.CCD_SPONSOR_PRIVATE_KEY });
forged.account = CLIENT_ADDRESS; // claims Northgate's account, but the signature is the operator's key
forged.message = forged.message.replace(SPONSOR_ADDRESS, CLIENT_ADDRESS);
const files = { "/real/": realProof, "/forged/": JSON.stringify(forged) };
const srv = http.createServer((q, r) => { const u = q.url.split("?")[0]; const k = Object.keys(files).find((p) => u === p + PROOF_PATH);
  if (!k) { r.writeHead(404); return r.end(); } r.writeHead(200, { "content-type": "application/json" }); r.end(files[k]); });
await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
const L = `http://127.0.0.1:${srv.address().port}`;

await t("Real supplier: the proof file Henry publishes makes site, account 4j6Rh and badge #1211 point to each other (served from a local copy)", async () => {
  const v = await verifyDomain(client, REAL_SUPPLIER_SITE, { fetchBase: `${L}/real/`, requireProof: true, expectAgent: 1211 });
  return [v.verdict === "verified" && v.steps.length === 7, `${sum(v)}; ${v.steps.map((s) => s.id).join(", ")}`];
});
await t("Real supplier, live site: if the proof is published it verifies; until then it is reported as missing (not passed)", async () => {
  const v = await verifyDomain(client, REAL_SUPPLIER_SITE, {});
  return [v.verdict === "verified" || (v.verdict === "unproven" && v.failed[0] === "proof_published"), `${sum(v)} (HTTP ${v.facts.proof_http_status})`];
});
await t("Tampered real proof (points the site at badge #1010, old signature kept) is refused: signature and owner fail", async () => {
  const v = await verifyDomain(client, REAL_SUPPLIER_SITE, { fetchBase: `${L}/real/`, tamper: true });
  return [v.verdict === "refused" && v.failed.includes("proof_signature_valid") && v.failed.includes("badge_owned_by_account"), sum(v)];
});
await t("Forged proof for the real site (claims Northgate's account, signed by another key) is refused", async () => {
  const v = await verifyDomain(client, REAL_SUPPLIER_SITE, { fetchBase: `${L}/forged/` });
  return [v.verdict === "refused" && v.failed.includes("proof_signature_valid"), sum(v)];
});
await t("Lookalike 'Northgate Supplies' with its own REAL badge #1230 and a validly signed proof is refused (wrong site)", async () => {
  const v = await verifyDomain(client, LOOKALIKE_SITE, { requireProof: true });
  const sig = v.steps.find((s) => s.id === "proof_signature_valid")?.pass, badge = v.steps.find((s) => s.id === "badge_valid")?.pass;
  return [v.verdict === "refused" && sig && badge && v.failed.includes("proof_names_this_site") && v.failed.includes("card_names_this_site") && v.failed.includes("claimed_site_points_back"),
    `${sum(v)}; its signature valid=${sig}, its badge valid=${badge}`];
});
await t("Lookalike that copies the real page and the real proof file byte for byte is refused", async () => {
  const v = await verifyDomain(client, LOOKALIKE_COPY_SITE, { requireProof: true });
  return [v.verdict === "refused" && v.failed.includes("proof_names_this_site") && v.failed.includes("card_names_this_site"), sum(v)];
});
await t("Buyer pins its supplier (#1211): a proof for any other badge fails expected_supplier", async () => {
  const v = await verifyDomain(client, REAL_SUPPLIER_SITE, { fetchBase: `${L}/real/`, expectAgent: 1230 });
  return [v.verdict === "refused" && v.failed.join() === "expected_supplier", sum(v)];
});
await t("A site with no proof is 'unproven' (allowed by default) and refused when the buyer requires a proof", async () => {
  const a = await verifyDomain(client, `${L}/nothing/`, {}); const b = await verifyDomain(client, `${L}/nothing/`, { requireProof: true });
  return [a.verdict === "unproven" && b.verdict === "refused", `default: ${a.verdict}; required: ${b.verdict}`];
});
await t("Production agents #1010 and #1211 are untouched and still Active", async () => {
  const a = await readAgent(client, 1010), b = await readAgent(client, 1211);
  return [a?.status === "Active" && b?.status === "Active", `#1010 ${a?.status}, #1211 ${b?.status}`];
});
if (LIVE) {
  await t("LIVE: hiring ClientScope for the lookalike site is refused before any 402, nothing is signed or paid, the refusal is anchored", async () => {
    const p = spawnSync(join(ROOT, ".venv", "bin", "python"), ["client_agent.py", "--simulate-lookalike-supplier"], { cwd: ROOT, encoding: "utf8", timeout: 300000, env: process.env });
    mkdirSync(join(ROOT, "build-log", "domainproof"), { recursive: true });
    writeFileSync(join(ROOT, "build-log", "domainproof", "test-live-lookalike.txt"), p.stdout + p.stderr);
    const tx = (p.stdout.match(/Refusal anchored: (\S+)/) || [])[1];
    return [p.status === 10 && !!tx, `exit ${p.status}, refusal anchor ${tx || "none"}`];
  });
}
srv.close();
const passed = results.filter((r) => r.pass).length;
console.log(`\n${passed}/${results.length} passed`);
console.log("RESULT " + JSON.stringify({ at: new Date().toISOString(), passed, total: results.length, results }));
process.exit(passed === results.length ? 0 : 1);
