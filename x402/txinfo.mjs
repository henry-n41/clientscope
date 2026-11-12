import { grpc, txStatus } from "./chain.mjs"; import { jsonSafe } from "./config.mjs";
const s = jsonSafe(await txStatus(grpc(), process.argv[2])); console.log(JSON.stringify(s, null, 1)); process.exit(0);
