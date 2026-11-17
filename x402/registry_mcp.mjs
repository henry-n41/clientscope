// Minimal client for Concordium's hosted Agent Registry MCP (JSON-RPC over streamable HTTP). It holds no keys:
// it only returns read results and sign-ready payloads that the caller signs with a key from its own environment.
export const MCP_URL = process.env.CLIENTSCOPE_REGISTRY_MCP || "https://agent-registry-mcp.concordium.com/mcp";

export async function mcp(tool, args, tries = 3) {
  for (let i = 0; ; i++) {
    try {
      const h = { "content-type": "application/json", accept: "application/json, text/event-stream" };
      const post = (body) => fetch(MCP_URL, { method: "POST", headers: h, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
      const r0 = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "clientscope", version: "1" } } });
      const sid = r0.headers.get("mcp-session-id"); if (sid) h["mcp-session-id"] = sid; await r0.text();
      await (await post({ jsonrpc: "2.0", method: "notifications/initialized" })).text();
      let b = await (await post({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: tool, arguments: args } })).text();
      if (/^\s*(event:|data:)/.test(b)) b = b.split("\n").find((l) => l.startsWith("data:")).slice(5);
      const res = JSON.parse(b).result;
      if (res.isError) throw new Error(res.content[0].text);
      return JSON.parse(res.content[0].text);
    } catch (e) { if (i >= tries - 1) throw e; await new Promise((r) => setTimeout(r, 800 * (i + 1))); }
  }
}
