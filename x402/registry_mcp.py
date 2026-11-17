# Minimal client for Concordium's hosted Agent Registry MCP (read tools and sign-ready payload builders; it holds no keys).
# python3 registry_mcp.py <tool> '<json args>'
import json,sys,requests
U="https://agent-registry-mcp.concordium.com/mcp"
def call(method, params=None):
    h={"content-type":"application/json","accept":"application/json, text/event-stream"}
    r=requests.post(U,json={"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"cs","version":"1"}}},headers=h,timeout=30)
    sid=r.headers.get("mcp-session-id")
    if sid:h["mcp-session-id"]=sid
    requests.post(U,json={"jsonrpc":"2.0","method":"notifications/initialized"},headers=h,timeout=30)
    r=requests.post(U,json={"jsonrpc":"2.0","id":2,"method":method,"params":params or {}},headers=h,timeout=60)
    b=r.text
    if b.lstrip().startswith(("event:","data:")): b=next(l[5:] for l in b.splitlines() if l.startswith("data:"))
    return json.loads(b)
if __name__=="__main__":
    m=sys.argv[1]
    if m=="list":
        for t in call("tools/list")["result"]["tools"]: print(t["name"],"|",t["description"][:300].replace("\n"," "))
    else:
        res=call("tools/call",{"name":m,"arguments":json.loads(sys.argv[2] if len(sys.argv)>2 else "{}")})["result"]
        print(res["content"][0]["text"])
