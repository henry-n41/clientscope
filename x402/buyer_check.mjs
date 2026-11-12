// Feature 3: verify the BUYER before ClientScope accepts a job (two-way trust).
// The buyer proves control of its Concordium account by signing a fresh ClientScope challenge with its account key
// (Concordium signed-message format, checked against the account's ON-CHAIN credential keys). ClientScope then checks
// on-chain facts about that account. Nothing private is learned: no name, no nationality, only public chain data.
import { randomBytes } from "node:crypto";
import { AccountAddress, Cbor, verifyMessageSignature } from "@concordium/web-sdk";
import { jsonSafe } from "./config.mjs";

export const BUYER_POLICY = {
  name: "ClientScope accepted-buyer policy v1",
  rules: [
    "challenge_signed: buyer signed a fresh single-use ClientScope challenge (job id + nonce, 5 min) with its account key, verified against its on-chain credential keys",
    "identity_backed: the account has a 'normal' credential (issued from a real identity by an identity provider), not an initial/test-only one",
    "known_identity_provider: that identity provider is registered on chain",
    "credential_valid: the identity credential has not expired",
    "anonymity_revocation: identity is recoverable by >= 2 anonymity revokers under legal process (regulated KYC chain)",
    "eudemo_allow_listed: the account is on the EUDemo stablecoin allow list (granted only after a ZK proof of EU nationality)",
  ],
};
const CHALLENGE_TTL_MS = 5 * 60_000;
const challenges = new Map(); // nonce -> { account, jobId, message, expires, used }
const sessions = new Map();   // session token -> { account, jobId, expires, result }

export function issueChallenge(account, jobId, extra = "") {
  AccountAddress.fromBase58(account); // throws on a bad address
  const nonce = randomBytes(16).toString("hex");
  const expires = new Date(Date.now() + CHALLENGE_TTL_MS).toISOString();
  const message = `ClientScope buyer verification\nservice: ClientScope Work Agent (Concordium agent #1010)\njob: ${jobId}\naccount: ${account}\nnonce: ${nonce}\nexpires: ${expires}${extra ? `\n${extra}` : ""}`;
  challenges.set(nonce, { account, jobId, message, expires: Date.now() + CHALLENGE_TTL_MS, used: false });
  return { nonce, message, expires };
}

async function identityProviders(client) {
  const out = {};
  for await (const ip of client.getIdentityProviders()) out[ip.ipIdentity] = ip.ipDescription?.name || String(ip.ipIdentity);
  return out;
}

export async function verifyBuyer(client, { account, jobId, nonce, signature }) {
  const checks = {}; const facts = { account, job_id: jobId };
  const ch = challenges.get(nonce);
  const fresh = !!ch && !ch.used && ch.expires > Date.now() && ch.account === account && ch.jobId === jobId;
  if (ch) ch.used = true; // single use, even on failure
  checks.challenge_fresh = fresh;
  let info = null;
  try { info = await client.getAccountInfo(AccountAddress.fromBase58(account)); } catch { /* not on chain */ }
  checks.account_exists = !!info;
  let sigOk = false;
  if (fresh && info) { try { sigOk = await verifyMessageSignature(ch.message, signature, info); } catch { sigOk = false; } }
  checks.challenge_signed = sigOk;
  const creds = info ? Object.values(info.accountCredentials || {}).map((c) => c.value) : [];
  const normal = creds.find((c) => c.type === "normal");
  checks.identity_backed = !!normal;
  if (normal) {
    const ips = await identityProviders(client);
    const ip = normal.contents.ipIdentity;
    facts.identity_provider = { id: ip, name: ips[ip] || null };
    checks.known_identity_provider = ip in ips;
    const vt = String(normal.contents.policy.validTo); // YYYYMM
    const nowYm = new Date().toISOString().slice(0, 7).replace("-", "");
    facts.credential_valid_to = `${vt.slice(0, 4)}-${vt.slice(4)}`; facts.credential_created = String(normal.contents.policy.createdAt).replace(/(\d{4})(\d{2})/, "$1-$2");
    checks.credential_valid = vt >= nowYm;
    const ars = Object.keys(normal.contents.arData || {}).length;
    facts.anonymity_revokers = ars; facts.revealed_attributes = Object.keys(normal.contents.policy.revealedAttributes || {}).length;
    checks.anonymity_revocation = ars >= 2;
  } else { checks.known_identity_provider = false; checks.credential_valid = false; checks.anonymity_revocation = false; }
  const tok = (info?.accountTokens || []).find((t) => t.id?.value === "EUDemo" || String(t.id) === "EUDemo");
  let ms = null; try { ms = tok?.state?.moduleState ? Cbor.decode(tok.state.moduleState) : null; } catch { ms = null; }
  checks.eudemo_allow_listed = ms?.allowList === true;
  if (tok) facts.eudemo_balance = (Number(tok.state.balance.value) / 1e6).toFixed(6);
  const gates = ["challenge_fresh", "account_exists", "challenge_signed", "identity_backed", "known_identity_provider", "credential_valid", "anonymity_revocation", "eudemo_allow_listed"];
  const passed = gates.every((g) => checks[g] === true);
  const result = jsonSafe({ verified: passed, policy: BUYER_POLICY.name, checks, failed: gates.filter((g) => checks[g] !== true), facts,
    challenge: ch?.message ?? null, signature: signature ?? null, checked_at: new Date().toISOString() });
  let session = null;
  if (passed) { session = randomBytes(24).toString("hex"); sessions.set(session, { account, jobId, expires: Date.now() + 15 * 60_000, result }); }
  return { ...result, session };
}

export function sessionFor(token, jobId) {
  const s = token && sessions.get(token);
  return s && s.jobId === jobId && s.expires > Date.now() ? s : null;
}
