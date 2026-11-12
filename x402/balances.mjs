// Usage: node balances.mjs  -> prints CCD and EUDemo for the three ClientScope accounts as JSON
import { CLIENT_ADDRESS, SPONSOR_ADDRESS, CLIENTSCOPE_PAYTO } from "./config.mjs";
import { grpc, balances } from "./chain.mjs";
const c = grpc();
const out = {};
for (const [k, a] of [["client", CLIENT_ADDRESS], ["sponsor", SPONSOR_ADDRESS], ["clientscope", CLIENTSCOPE_PAYTO]]) out[k] = await balances(c, a);
console.log(JSON.stringify(out, null, 2));
process.exit(0);
