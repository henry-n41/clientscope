// Read-only chain helpers (balances, transaction status) over Concordium gRPC.
import "./config.mjs";
import { GRPC } from "./config.mjs";
import { ConcordiumGRPCNodeClient, credentials } from "@concordium/web-sdk/nodejs";
import { AccountAddress, TransactionHash, CcdAmount } from "@concordium/web-sdk";

export function grpc() {
  return new ConcordiumGRPCNodeClient(GRPC.host, GRPC.port, GRPC.useTls ? credentials.createSsl() : credentials.createInsecure(), { timeout: 20000 });
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
