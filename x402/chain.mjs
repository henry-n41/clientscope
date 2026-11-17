// Read-only chain helpers (balances, transaction status) over Concordium gRPC.
import "./config.mjs";
import { GRPC } from "./config.mjs";
import { ConcordiumGRPCNodeClient, credentials } from "@concordium/web-sdk/nodejs";
import { AccountAddress, TransactionHash, CcdAmount } from "@concordium/web-sdk";

const rawClient = () => new ConcordiumGRPCNodeClient(GRPC.host, GRPC.port, GRPC.useTls ? credentials.createSsl() : credentials.createInsecure(), { timeout: 20000 });
const READS = new Set(["getAccountInfo", "invokeContract", "getInstanceInfo", "getBlockItemStatus", "getNextAccountNonce", "getBlockInfo", "getConsensusStatus"]);
const transient = (e) => /UNAVAILABLE|DEADLINE_EXCEEDED|ECONNRESET|socket disconnected/i.test(`${e?.code} ${e?.message}`);

// Read calls are retried (up to 3 tries, fresh connection each time) when the connection drops: a dropped TLS handshake
// must never turn into a false "account does not exist" during a buyer or agent check. Writes are never retried here.
export function grpc() {
  let client = rawClient();
  return new Proxy(client, {
    get(target, prop) {
      const v = client[prop];
      if (typeof v !== "function") return v;
      if (!READS.has(prop)) return v.bind(client);
      return async (...args) => {
        for (let i = 0; ; i++) {
          try { return await client[prop](...args); }
          catch (e) { if (i >= 2 || !transient(e)) throw e; await new Promise((r) => setTimeout(r, 400 * (i + 1))); client = rawClient(); }
        }
      };
    },
  });
}

export async function balances(client, address, tokenId = "EUDemo") {
  const info = await client.getAccountInfo(AccountAddress.fromBase58(address));
  const tok = (info.accountTokens || []).find((t) => t.id?.value === tokenId || t.id?.toString?.() === tokenId);
  return {
    address,
    ccdMicro: CcdAmount.toMicroCcd(info.accountAmount).toString(),
    eudemoAtomic: tok ? tok.state.balance.value.toString() : "0",
    nonce: info.accountNonce.toString(),
  };
}

export async function txStatus(client, hash) {
  return client.getBlockItemStatus(TransactionHash.fromHexString(hash));
}
