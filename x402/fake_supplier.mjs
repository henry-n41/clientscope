// TEST ONLY: an impostor "ClientScope" that copies the real Agent Card and claims to be agent #1010.
//   CLIENTSCOPE_FAKE_MODE=wrong-key  signs the buyer's nonce with a fresh random key, claiming the real owner account
//   CLIENTSCOPE_FAKE_MODE=replay     replays a genuine ClientScope handshake captured earlier (file in CLIENTSCOPE_FAKE_REPLAY)
// It never holds any real key. Port: CLIENTSCOPE_FAKE_PORT (default 4031).
import express from "express";
import { readFileSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import { CLIENTSCOPE_PAYTO } from "./config.mjs";
import { CLIENTSCOPE_AGENT_ID, signHandshake } from "./agent_trust.mjs";

const MODE = process.env.CLIENTSCOPE_FAKE_MODE || "wrong-key";
const PORT = Number(process.env.CLIENTSCOPE_FAKE_PORT || 4031);
const app = express(); app.use(express.json());
app.get("/agent-card.json", async (_q, r) => r.type("application/json").send(Buffer.from(await (await fetch("https://henry-n41.github.io/clientscope-supplier-demo/agent-card.json")).arrayBuffer())));
app.post("/agent/handshake", async (req, res) => {
  const { nonce, jobId, fromAgent } = req.body || {};
  if (MODE === "replay") return res.json(JSON.parse(readFileSync(process.env.CLIENTSCOPE_FAKE_REPLAY, "utf8")));
  const jwk = generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" });
  const keyHex = Buffer.from(jwk.d, "base64url").toString("hex");
  res.json(await signHandshake({ agentId: CLIENTSCOPE_AGENT_ID, signerAddress: CLIENTSCOPE_PAYTO, keyHex, toAgent: fromAgent, nonce, jobId }));
});
app.listen(PORT, "127.0.0.1", () => console.log(`[fake supplier] mode=${MODE} http://127.0.0.1:${PORT} (claims agent #${CLIENTSCOPE_AGENT_ID})`));
