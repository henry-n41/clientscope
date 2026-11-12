// Shared ClientScope x402 settings (public values only, no keys).
// The box's network only lets gRPC (port 20000) out through its egress tunnel,
// so point grpc-js at it unless the caller already set a proxy.
if (!process.env.grpc_proxy && !process.env.GRPC_PROXY && process.env.SAND_EGRESS_TUNNEL_PROXY_ADDR) {
  process.env.grpc_proxy = `http://${process.env.SAND_EGRESS_TUNNEL_PROXY_ADDR}`;
}

export const NETWORK = "ccd:4221332d34e1694168c2a0c0b3fd0f27"; // Concordium testnet (CAIP-2)
// Concordium gRPC node. Defaults to the public testnet node over TLS; override with CCD_GRPC_HOST, CCD_GRPC_PORT, CCD_GRPC_TLS.
export const GRPC = {
  host: process.env.CCD_GRPC_HOST || "grpc.testnet.concordium.com",
  port: Number(process.env.CCD_GRPC_PORT || 20000),
  useTls: (process.env.CCD_GRPC_TLS || "true").toLowerCase() !== "false",
};
export const ASSET = "EUDemo";             // PLT stablecoin, 6 decimals
export const DECIMALS = 6;
export const PRICE_ATOMIC = "1000000";      // 1 EUDemo
export const CLIENTSCOPE_PAYTO = "3qYSik7b8w9NsgeAk91Mrpapq9T5S7EGvmsa3Ecf4449xiJ8cX";
export const SPONSOR_ADDRESS = "3N9s8YUN2pxMuP5bszXUUk9vZ3ks7tDgxgzhG5arGr5qGYe6fn";
export const CLIENT_ADDRESS = "4j6RhVCWEG3GDQcwcgSQRxu7nmXSC4V834YrsVtudomCG6ueMH";
export const PORT = Number(process.env.CLIENTSCOPE_X402_PORT || 4021);
export const explorerTx = (h) => `https://ccdexplorer.io/testnet/transaction/${h}`;
export const fmt = (atomic, d = DECIMALS) => {
  const s = BigInt(atomic).toString().padStart(d + 1, "0");
  return `${s.slice(0, -d)}.${s.slice(-d)}`;
};
export const jsonSafe = (v) => JSON.parse(JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x)));
