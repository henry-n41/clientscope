// Replay test: present the already-settled signed payment again (1) to the server, (2) straight to the facilitator.
import { readFileSync } from "node:fs";
import { NETWORK, GRPC, SPONSOR_ADDRESS, PORT } from "./config.mjs";
import { x402HTTPClient, x402Client } from "@x402/core/client";
import { ExactConcordiumScheme as F } from "@x402/concordium/exact/facilitator";
import { toConcordiumFacilitatorSigner } from "@x402/concordium";
const { jobId, payment } = JSON.parse(readFileSync(process.argv[2], "utf8"));
const hdr = new x402HTTPClient(new x402Client()).encodePaymentSignatureHeader(payment);
console.log(`$ replay the settled payment for ${jobId} (nonce ${payment.payload.signedTransaction.header.nonce}) to the server`);
for (const body of [{ jobId }, { jobId: jobId + "-B" }]) {
  const r = await fetch(`http://localhost:${PORT}/jobs/scrape`, { method: "POST", headers: { "content-type": "application/json", ...hdr }, body: JSON.stringify(body) });
  console.log(`  jobId=${body.jobId} -> HTTP ${r.status} ${await r.text()}`);
}
console.log("$ same payment straight to the facilitator's verify() (skipping the server's own checks)");
const f = new F({ signer: toConcordiumFacilitatorSigner(SPONSOR_ADDRESS, process.env.CCD_SPONSOR_PRIVATE_KEY, { ...GRPC, network: NETWORK }) });
const v = await f.verify(payment, payment.accepted);
console.log(`  isValid=${v.isValid} reason=${v.invalidReason}`);
process.exit(0);
