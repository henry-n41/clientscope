// Unit tests for the Browser Wallet flow (Feature 6). No wallet, no keys from env, nothing is submitted.
// Uses locally generated throwaway ed25519 keys that sign in exactly the format the wallet produces
// (signMessage: AccountTransactionSignature over the Concordium message digest; sendSponsoredTransaction: sender
// signature added to a sponsor-signed V1 transaction parsed with Transaction.signableFromJSON).
// The only network call is a READ of one already-finalized payment, to test the on-chain payment check.
import "./config.mjs";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { AccountAddress, buildBasicAccountSigner, signMessage, Cbor } from "@concordium/web-sdk";
import { Transaction } from "@concordium/web-sdk/transactions";
import { issueChallenge, verifyBuyer, sessionFor } from "./buyer_check.mjs";
import { orderLines, buildPaymentTransaction, sponsorSign, toWalletJSON, checkSettledPayment, memoHex } from "./wallet_flow.mjs";
import { CLIENT_ADDRESS, SPONSOR_ADDRESS, jsonSafe } from "./config.mjs";
import { grpc, txStatus } from "./chain.mjs";

let pass = 0, fail = 0;
const t = (name, ok) => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}`); ok ? pass++ : fail++; };
const keypair = () => { const k = generateKeyPairSync("ed25519"); const j = k.privateKey.export({ format: "jwk" });
  return { priv: Buffer.from(j.d, "base64url").toString("hex"), pub: Buffer.from(j.x, "base64url").toString("hex") }; };
const fakeAccount = (address, pub, { allowList = true, balance = 5_000_000n, type = "normal" } = {}) => ({
  accountAddress: AccountAddress.fromBase58(address), accountThreshold: 1,
  accountCredentials: { 0: { value: { type, contents: { credentialPublicKeys: { keys: { 0: { schemeId: "Ed25519", verifyKey: pub } }, threshold: 1 },
    ipIdentity: 0, policy: { validTo: 209912, createdAt: 202611, revealedAttributes: {} }, arData: { 1: {}, 2: {} } } } } },
  accountTokens: [{ id: { value: "EUDemo" }, state: { balance: { value: balance }, moduleState: Cbor.encode({ allowList }) } }],
});
const mockChain = (accounts) => ({
  getAccountInfo: async (a) => { const x = accounts[a.address]; if (!x) throw new Error("not found"); return x; },
  getIdentityProviders: async function* () { yield { ipIdentity: 0, ipDescription: { name: "Test IP" } }; },
});
const randomAddress = () => AccountAddress.fromBuffer(randomBytes(32)).address;

// ---------------------------------------------------------------- 1. buyer verification with a wallet-format signature
const buyer = keypair(), buyerAddr = randomAddress();
const chain = mockChain({ [buyerAddr]: fakeAccount(buyerAddr, buyer.pub) });
const jobId = "CS-20261112-TEST01";
let c = issueChallenge(buyerAddr, jobId, orderLines(jobId));
t("challenge states the order (amount, payee, pay only after delivery)", c.message.includes("order: pay 1.000000 EUDemo to 3qYSik7b8w9NsgeAk91Mrpapq9T5S7EGvmsa3Ecf4449xiJ8cX") && c.message.includes("only after the delivery check passes"));
let sig = jsonSafe(await signMessage(AccountAddress.fromBase58(buyerAddr), c.message, buildBasicAccountSigner(buyer.priv)));
t("signature has the wallet's shape {credentialIndex: {keyIndex: hex}}", typeof sig?.[0]?.[0] === "string" && sig[0][0].length === 128);
let v = await verifyBuyer(chain, { account: buyerAddr, jobId, nonce: c.nonce, signature: sig });
t("server accepts a correctly signed challenge (all 8 gates)", v.verified === true && v.failed.length === 0 && !!v.session);
t("verified session is bound to this job", !!sessionFor(v.session, jobId) && !sessionFor(v.session, "CS-OTHER"));
v = await verifyBuyer(chain, { account: buyerAddr, jobId, nonce: c.nonce, signature: sig });
t("same challenge cannot be replayed", v.verified === false && v.failed.includes("challenge_fresh"));

c = issueChallenge(buyerAddr, jobId, orderLines(jobId));
const impostor = keypair();
sig = jsonSafe(await signMessage(AccountAddress.fromBase58(buyerAddr), c.message, buildBasicAccountSigner(impostor.priv)));
v = await verifyBuyer(chain, { account: buyerAddr, jobId, nonce: c.nonce, signature: sig });
t("impostor key claiming the account is rejected", v.verified === false && v.failed.includes("challenge_signed"));

c = issueChallenge(buyerAddr, jobId, orderLines(jobId));
sig = jsonSafe(await signMessage(AccountAddress.fromBase58(buyerAddr), c.message.replace("1.000000 EUDemo", "0.000001 EUDemo"), buildBasicAccountSigner(buyer.priv)));
v = await verifyBuyer(chain, { account: buyerAddr, jobId, nonce: c.nonce, signature: sig });
t("signature over an edited order is rejected", v.verified === false && v.failed.includes("challenge_signed"));

const nal = keypair(), nalAddr = randomAddress();
const chain2 = mockChain({ [nalAddr]: fakeAccount(nalAddr, nal.pub, { allowList: false }) });
c = issueChallenge(nalAddr, jobId, orderLines(jobId));
sig = jsonSafe(await signMessage(AccountAddress.fromBase58(nalAddr), c.message, buildBasicAccountSigner(nal.priv)));
v = await verifyBuyer(chain2, { account: nalAddr, jobId, nonce: c.nonce, signature: sig });
t("account not on the EUDemo allow list is rejected", v.verified === false && v.failed.includes("eudemo_allow_listed"));

// ---------------------------------------------------------------- 2. the payment the wallet approves after delivery
const sponsorTest = keypair();   // throwaway key standing in for the sponsor (real sponsor key is never used here)
const signable = buildPaymentTransaction({ buyer: buyerAddr, jobId, nonce: 7n, nowSeconds: Math.floor(Date.now() / 1000) });
const sponsored = await sponsorSign(signable, sponsorTest.priv);
const wire = toWalletJSON(sponsored);
t("payment request is plain JSON (safe to send to the browser)", typeof JSON.stringify(wire) === "string");
const parsed = Transaction.signableFromJSON(wire);      // exactly what the browser does before sendSponsoredTransaction
t("browser can parse it with Transaction.signableFromJSON", parsed.version === 1);
const h = parsed.header;
t("header: sender is the verified buyer", h.sender.address === buyerAddr);
t("header: sponsor is ClientScope's fee sponsor", h.sponsor?.account?.address === SPONSOR_ADDRESS || h.sponsor?.address === SPONSOR_ADDRESS || String(h.sponsor?.account ?? h.sponsor) === SPONSOR_ADDRESS);
t("header: nonce as requested", BigInt(h.nonce.value ?? h.nonce) === 7n);
const sponsorInfo = fakeAccount(SPONSOR_ADDRESS, sponsorTest.pub);
t("sponsor signature survives the JSON round trip and verifies", await Transaction.verifySignature(parsed, parsed.signatures.sponsor, sponsorInfo));
const walletSigned = await Transaction.sign(parsed, buildBasicAccountSigner(buyer.priv));    // what the wallet adds
t("after the wallet signs: sender signature verifies against the buyer's key", await Transaction.verifySignature(walletSigned, walletSigned.signatures.sender, fakeAccount(buyerAddr, buyer.pub)));
t("after the wallet signs: sponsor signature still valid", await Transaction.verifySignature(walletSigned, walletSigned.signatures.sponsor, sponsorInfo));
let bytesOk = false; try { bytesOk = Transaction.serializeBlockItem(Transaction.finalize(walletSigned)).length > 100; } catch (e) { console.log("   ", e.message); }
t("fully signed transaction serializes as a block item (ready to submit)", bytesOk);
const ops = Cbor.decode(Cbor.fromJSON(wire.payload.operations ?? toWalletJSON(sponsored).payload.operations), "TokenOperation[]");
t("payload: 1 EUDemo transfer to ClientScope with memo = job id", JSON.stringify(jsonSafe(ops)).includes("3qYSik7b8w9NsgeAk91Mrpapq9T5S7EGvmsa3Ecf4449xiJ8cX") && Buffer.from(ops[0].transfer.memo.content).toString("hex") === memoHex(jobId));

// ---------------------------------------------------------------- 3. the on-chain payment check, against a real finalized payment (read only)
const real = jsonSafe(await txStatus(grpc(), "dece41cfd875a9306ebf42e94e7f3b629574ac2c549ed547537d2d96f1318dae"));
let s = checkSettledPayment(real, { buyer: CLIENT_ADDRESS, jobId: "CS-20261111-A5AD17" });
t("real settled payment passes every check", s.ok);
s = checkSettledPayment(real, { buyer: CLIENT_ADDRESS, jobId: "CS-20261111-XXXXXX" });
t("same payment presented for a different job is refused (memo)", !s.ok && !s.checks.memo_is_job_id);
s = checkSettledPayment(real, { buyer: buyerAddr, jobId: "CS-20261111-A5AD17" });
t("payment from a different account is refused (payer)", !s.ok && !s.checks.payer_is_verified_buyer);
s = checkSettledPayment({ ...real, status: "committed" }, { buyer: CLIENT_ADDRESS, jobId: "CS-20261111-A5AD17" });
t("not yet finalized is refused", !s.ok && !s.checks.finalized);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
