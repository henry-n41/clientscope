// End-to-end check of the Browser Wallet path through the dashboard API, with this script playing the wallet.
// It signs exactly what the wallet would: signMessage over the challenge, then the sender signature on the
// sponsor-signed payment (what sendSponsoredTransaction does), and submits it.
//   node wallet_e2e.mjs impostor   -> a random key claims the demo buyer account (no chain writes, nothing paid)
//   node wallet_e2e.mjs full       -> the demo buyer account (CCD_CLIENT_PRIVATE_KEY, read from env, never printed) does one real hire
import "./config.mjs";
import { generateKeyPairSync } from "node:crypto";
import { AccountAddress, buildBasicAccountSigner, signMessage } from "@concordium/web-sdk";
import { Transaction } from "@concordium/web-sdk/transactions";
import { CLIENT_ADDRESS, jsonSafe } from "./config.mjs";
import { grpc } from "./chain.mjs";

const API = "http://127.0.0.1:8000";
const mode = process.argv[2] || "impostor";
const post = async (p, b) => { const r = await fetch(API + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }); return [r.status, await r.json().catch(() => ({}))]; };
const run = async (id) => (await fetch(`${API}/api/runs/${id}`)).json();
const key = mode === "full" ? process.env.CCD_CLIENT_PRIVATE_KEY
  : Buffer.from(generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" }).d, "base64url").toString("hex");
const signer = buildBasicAccountSigner(key);

let [st, s] = await post("/api/wallet/start", { account: CLIENT_ADDRESS });
console.log("start", st, s.job_id, s.run_id);
if (st !== 200) process.exit(1);
console.log("challenge message:\n" + s.message.split("\n").map((l) => "   | " + l).join("\n"));
const sig = jsonSafe(await signMessage(AccountAddress.fromBase58(CLIENT_ADDRESS), s.message, signer));
const [vs, v] = await post("/api/wallet/verify", { run_id: s.run_id, signature: sig });
console.log("verify", vs, JSON.stringify(v));

const t0 = Date.now();
let r;
while (Date.now() - t0 < 900_000) {
  r = await run(s.run_id);
  if (r.finished || r.result?.payment_request) break;
  await new Promise((ok) => setTimeout(ok, 2000));
}
if (r.result?.payment_request) {
  const req = r.result.payment_request;
  console.log(`payment request received after delivery: sender=${req.header.sender} sponsor=${req.header.sponsor.account} nonce=${req.header.nonce} sponsorSigned=${Object.keys(req.signatures.sponsor).length > 0}`);
  const parsed = Transaction.signableFromJSON(req);
  const signed = await Transaction.sign(parsed, signer);                     // = the wallet's sender signature
  const hash = (await grpc().sendTransaction(Transaction.finalize(signed))).toString();  // = the wallet submitting
  console.log("submitted tx", hash);
  const [ps, p] = await post("/api/wallet/pay", { run_id: s.run_id, tx_hash: hash });
  console.log("pay", ps, JSON.stringify(p));
  while (Date.now() - t0 < 900_000) { r = await run(s.run_id); if (r.finished) break; await new Promise((ok) => setTimeout(ok, 2000)); }
}
console.log("\nRUN", s.run_id, "outcome:", r.outcome, "status:", r.status);
for (const x of r.steps) console.log(`  ${x.key.padEnd(9)} ${x.status.padEnd(8)} ${x.detail || ""}${x.tx ? " tx=" + x.tx : ""}`);
console.log("result:", JSON.stringify({ sheet: r.result.sheet_url, payment_tx: r.result.payment_tx, anchor_tx: r.result.anchor_tx, receipt_verified: r.result.receipt_verified, charged: r.result.charged }));
process.exit(0);
