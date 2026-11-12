// Anchor / read ClientScope job receipts on Concordium (RegisterData), following the pattern of the
// Concordium SDK's Verification Audit Anchor (CBOR {type, version, hash, public}, see web-sdk audit-record).
//   node anchor_tool.mjs send  < {"receipt_sha256","public":{"job","agent","log_sha256","result"}}   (needs CCD_SPONSOR_PRIVATE_KEY)
//   node anchor_tool.mjs read <txhash>                                                               (read-only)
import { SPONSOR_ADDRESS, jsonSafe } from "./config.mjs";
import { grpc } from "./chain.mjs";
import { AccountAddress, AccountTransactionType, DataBlob, TransactionExpiry, TransactionHash, buildBasicAccountSigner, signTransaction, CcdAmount } from "@concordium/web-sdk";
import { encode, decode } from "cbor2";

export const ANCHOR_TYPE = "CSJRA"; // ClientScope Job Receipt Anchor
export const ANCHOR_VERSION = 1;
const hex = (u) => Buffer.from(u).toString("hex");

async function read(client, h) {
  const st = await client.getBlockItemStatus(TransactionHash.fromHexString(h));
  const out = { tx_hash: h, status: st.status };
  if (st.status !== "finalized") return out;
  const s = st.outcome.summary;
  const bi = await client.getBlockInfo(st.outcome.blockHash);
  Object.assign(out, { block_hash: st.outcome.blockHash.toString?.() ?? String(st.outcome.blockHash), block_height: String(bi.blockHeight),
    block_time: new Date(Number(bi.blockSlotTime)).toISOString(), type: s.transactionType, sender: s.sender?.address ?? String(s.sender),
    sender_cost_micro: String(s.cost), sponsor: s.sponsor ? (s.sponsor.sponsor?.address ?? String(s.sponsor.sponsor)) : null });
  if (s.transactionType === "registerData") {
    out.data_hex = s.dataRegistered.data;
    try {
      const d = decode(Buffer.from(out.data_hex, "hex"));
      out.anchor = { type: d.type, version: d.version, hash: d.hash instanceof Uint8Array ? hex(d.hash) : null,
        public: d.public ? { ...d.public, log_sha256: d.public.log instanceof Uint8Array ? hex(d.public.log) : null, log: undefined } : null };
    } catch (e) { out.anchor_error = e.message; }
  }
  if (s.transactionType === "tokenUpdate") {
    out.events = (s.events || []).map((e) => jsonSafe({ tag: e.tag, token: e.tokenId?.value ?? String(e.tokenId), from: e.from?.address?.address ?? String(e.from?.address ?? ""),
      to: e.to?.address?.address ?? String(e.to?.address ?? ""), amount: e.amount?.value?.toString(), decimals: e.amount?.decimals,
      memo: e.memo ? (() => { try { return String(decode(Buffer.from(e.memo.toString(), "hex"))); } catch { return e.memo.toString(); } })() : null }));
  }
  return out;
}

async function send(client, req) {
  const key = process.env.CCD_SPONSOR_PRIVATE_KEY;
  if (!/^[0-9a-f]{64}$/i.test(key || "")) throw new Error("CCD_SPONSOR_PRIVATE_KEY missing");
  const anchor = { type: ANCHOR_TYPE, version: ANCHOR_VERSION, hash: new Uint8Array(Buffer.from(req.receipt_sha256, "hex")),
    public: { job: req.public.job, agent: req.public.agent, log: new Uint8Array(Buffer.from(req.public.log_sha256, "hex")), result: req.public.result } };
  const data = encode(anchor);
  if (data.length > 256) throw new Error(`anchor too big: ${data.length} bytes`);
  const sender = AccountAddress.fromBase58(SPONSOR_ADDRESS);
  const { nonce } = await client.getNextAccountNonce(sender);
  const tx = { header: { sender, nonce, expiry: TransactionExpiry.futureMinutes(5) }, payload: { data: new DataBlob(Buffer.from(data)) }, type: AccountTransactionType.RegisterData };
  const sig = await signTransaction(tx, buildBasicAccountSigner(key));
  const th = await client.sendAccountTransaction(tx, sig);
  await client.waitForTransactionFinalization(th, 90_000);
  const r = await read(client, th.toString());
  const st = await client.getBlockItemStatus(th);
  r.fee_ccd = (Number(st.outcome.summary.cost) / 1e6).toFixed(6);
  r.data_bytes = data.length;
  return r;
}

const client = grpc();
const [cmd, arg] = process.argv.slice(2);
let res;
if (cmd === "read") res = await read(client, arg);
else if (cmd === "send") { let s = ""; for await (const c of process.stdin) s += c; res = await send(client, JSON.parse(s)); }
else if (cmd === "verifysig") { // stdin {"account","message","signature"} -> re-check a buyer's signed challenge against chain
  let s = ""; for await (const c of process.stdin) s += c; const q = JSON.parse(s);
  const { verifyMessageSignature } = await import("@concordium/web-sdk");
  const info = await client.getAccountInfo(AccountAddress.fromBase58(q.account));
  const cred = Object.values(info.accountCredentials)[0].value;
  res = { signature_valid: await verifyMessageSignature(q.message, q.signature, info), credential_type: cred.type, identity_provider: cred.contents.ipIdentity };
}
else { console.error("usage: send | read <tx> | verifysig"); process.exit(1); }
console.log(JSON.stringify(jsonSafe(res)));
process.exit(0);
