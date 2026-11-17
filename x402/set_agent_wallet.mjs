// Bind an agent's agentWallet (CIS-8004 setAgentWallet) to an account whose key ClientScope holds, with the contract's own
// proof of control: the NEW wallet signs the registry's 162-byte canonical message, the OWNER sends the transaction.
//   node set_agent_wallet.mjs <token_id> <new_wallet> <NEW_WALLET_KEY_ENV> <owner> [OWNER_KEY_ENV|-] [deadline_minutes]
// Without OWNER_KEY_ENV ("-") it only prints the sign-ready payload (for an owner who signs in the Browser Wallet).
// Tested on testnet 16 Nov 2026 with dry runs: the signature must be PLAIN ed25519 over the 162 bytes (the signMessage
// format is rejected), and the deadline must be close: +60 min is accepted, +180 min is rejected (InvalidAgentWalletProof).
import { createPrivateKey, sign } from "node:crypto";
import { execFileSync } from "node:child_process";
import { AccountAddress, Energy, Parameter, ReceiveName } from "@concordium/web-sdk";
import { grpc } from "./chain.mjs";
import { REGISTRY, sendRegistryTx } from "./registry.mjs";

const MCP = new URL("./registry_mcp.py", import.meta.url).pathname;
const mcp = (tool, args) => JSON.parse(execFileSync("python3", [MCP, tool, JSON.stringify(args)], { encoding: "utf8" }));

export async function walletProof({ tokenId, newWallet, newKeyHex, owner, minutes = 50 }) {
  if (!/^[0-9a-f]{64}$/i.test(newKeyHex || "")) throw new Error("new wallet key missing");
  const deadline = Date.now() + Number(minutes) * 60_000;
  const cb = mcp("set_agent_wallet_canonical_bytes", { network: "testnet", token_id: String(tokenId), new_wallet: newWallet, deadline_unix_ms: deadline });
  const msg = Buffer.from(cb.bytes_hex, "hex");
  if (msg.length !== 162 || cb.owner_account !== owner) throw new Error(`canonical bytes not as expected (owner ${cb.owner_account}, ${msg.length} bytes)`);
  const key = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(newKeyHex, "hex")]), format: "der", type: "pkcs8" });
  const sig = sign(null, msg, key).toString("hex");
  const built = mcp("build_set_agent_wallet", { network: "testnet", token_id: String(tokenId), new_wallet: newWallet, deadline_unix_ms: deadline, signature_hex: sig, sender: owner });
  // Dry run as the owner before anyone signs anything: the contract must accept it.
  const sim = await grpc().invokeContract({ contract: REGISTRY, invoker: AccountAddress.fromBase58(owner), method: ReceiveName.fromString(built.receive_name),
    parameter: Parameter.fromHexString(built.parameter_hex), energy: Energy.create(30000n) });
  return { deadline_unix_ms: deadline, deadline_iso: new Date(deadline).toISOString(), wallet_set_nonce: cb.wallet_set_nonce, canonical_hex: cb.bytes_hex,
    signature_hex: sig, built, dry_run: sim.tag === "success" ? "accepted" : `rejected ${JSON.stringify(sim.reason, (_, x) => (typeof x === "bigint" ? x.toString() : x)).match(/"rejectReason":(-?\d+)/)?.[1]}` };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [tokenId, newWallet, newKeyEnv, owner, ownerKeyEnv = "-", minutes = "50"] = process.argv.slice(2);
  const out = await walletProof({ tokenId, newWallet, newKeyHex: process.env[newKeyEnv], owner, minutes });
  if (ownerKeyEnv !== "-" && out.dry_run === "accepted") {
    out.tx = await sendRegistryTx(grpc(), { keyHex: process.env[ownerKeyEnv], sender: owner, receiveName: out.built.receive_name, parameterHex: out.built.parameter_hex, energy: out.built.suggested_energy });
  }
  console.log(JSON.stringify(out, null, 1));
}
