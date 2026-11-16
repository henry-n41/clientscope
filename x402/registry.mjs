// CIS-8004 Agent Registry helpers (contract 12802,0 on testnet): send sign-ready payloads, read agents, check operators.
// Keys only come from the environment, by env var NAME (never a value on the command line).
//   node registry.mjs send <KEY_ENV_NAME> <SENDER> < {"receive_name","parameter_hex","suggested_energy"}
//   node registry.mjs operator <OWNER> <ADDRESS>     -> {"is_operator": bool}
import "./config.mjs";
import { grpc } from "./chain.mjs";
import { AccountAddress, AccountTransactionType, CcdAmount, ContractAddress, Energy, Parameter, ReceiveName, TransactionExpiry,
  buildBasicAccountSigner, signTransaction } from "@concordium/web-sdk";

export const REGISTRY = ContractAddress.create(12802n, 0n);
export const REGISTRY_CONTRACT_NAME = "CIS-8004";

/** Submit a sign-ready payload (from the Agent Registry MCP build_* tools) and wait for finality. */
export async function sendRegistryTx(client, { keyHex, sender, receiveName, parameterHex, energy }) {
  const from = AccountAddress.fromBase58(sender);
  const { nonce } = await client.getNextAccountNonce(from);
  const payload = { amount: CcdAmount.zero(), address: REGISTRY, receiveName: ReceiveName.fromString(receiveName),
    message: Parameter.fromHexString(parameterHex), maxContractExecutionEnergy: Energy.create(BigInt(energy || 30000)) };
  const tx = { header: { sender: from, nonce, expiry: TransactionExpiry.futureMinutes(5) }, payload, type: AccountTransactionType.Update };
  const sig = await signTransaction(tx, buildBasicAccountSigner(keyHex));
  const th = await client.sendAccountTransaction(tx, sig);
  const out = await client.waitForTransactionFinalization(th, 120_000);
  const s = out.summary;
  const rejected = s.transactionType === "failed" || s.rejectReason;
  return { tx_hash: th.toString(), block_hash: String(out.blockHash), outcome: rejected ? "rejected" : "success",
    reject_reason: s.rejectReason ? JSON.parse(JSON.stringify(s.rejectReason, (_, x) => (typeof x === "bigint" ? x.toString() : x))) : null,
    fee_ccd: (Number(s.cost) / 1e6).toFixed(6),
    events: JSON.parse(JSON.stringify(s.events || s.affectedContracts || [], (_, x) => (typeof x === "bigint" ? x.toString() : x))) };
}

// CIS-2 Address: 0x00 + 32-byte account | 0x01 + contract (u64 LE index, u64 LE subindex)
const addrBytes = (a) => Buffer.concat([Buffer.from([0]), Buffer.from(AccountAddress.fromBase58(a).decodedAddress)]);

/** CIS-2 operatorOf: is `address` an approved operator of `owner` on the registry? Read-only. */
export async function isOperator(client, owner, address) {
  const q = Buffer.concat([Buffer.from([1, 0]), addrBytes(owner), addrBytes(address)]); // u16 LE count = 1
  const r = await client.invokeContract({ contract: REGISTRY, method: ReceiveName.fromString(`${REGISTRY_CONTRACT_NAME}.operatorOf`), parameter: Parameter.fromBuffer(q) });
  if (r.tag !== "success") throw new Error(`operatorOf failed: ${JSON.stringify(r.reason, (_, x) => (typeof x === "bigint" ? x.toString() : x))}`);
  const b = Buffer.from(r.returnValue.buffer ?? r.returnValue);
  return b.readUInt16LE(0) === 1 && b[2] === 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, a1, a2] = process.argv.slice(2);
  const client = grpc();
  if (cmd === "send") {
    const keyHex = process.env[a1];
    if (!/^[0-9a-f]{64}$/i.test(keyHex || "")) { console.error(`${a1} missing`); process.exit(1); }
    let input = ""; for await (const c of process.stdin) input += c;
    const p = JSON.parse(input);
    console.log(JSON.stringify(await sendRegistryTx(client, { keyHex, sender: a2, receiveName: p.receive_name, parameterHex: p.parameter_hex, energy: p.suggested_energy }), null, 1));
  } else if (cmd === "operator") {
    console.log(JSON.stringify({ owner: a1, address: a2, is_operator: await isOperator(client, a1, a2) }));
  } else { console.error("usage: send|operator"); process.exit(2); }
}
