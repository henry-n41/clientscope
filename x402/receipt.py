"""ClientScope job receipts: canonical hashing of a sheet's Audit Log + Products, and anchoring on Concordium.

Canonical form (anyone can recompute it):
  audit_rows  = Audit Log values as shown (gspread get_all_values), header included, every row ABOVE the first
                'log_anchored' row, trailing empty cells removed.
  products    = Products tab values as shown, same rules.
  canon(x)    = json.dumps(x, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode("utf-8")
  log_sha256  = sha256(canon(audit_rows)); products_sha256 = sha256(canon(products))
  receipt     = JSON object below; receipt_sha256 = sha256(canon(receipt))
  on chain    = RegisterData from ClientScope's operator account, CBOR
                {type:"CSJRA", version:1, hash:receipt_sha256, public:{job, agent:1010, log:log_sha256, result}}

CLI (used by the x402 server):  python receipt.py anchor  < {"sheet_id","job_id","buyer","payment_tx"|null,"delivered":bool}
"""
import hashlib, json, os, subprocess, sys, datetime
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
AGENT = {"registry_token_address": "JyP9YTHUc6YFEXRdx9HKH", "token_id": 1010, "network": "testnet",
         "card_sha256": "fb3fb839cc10db8ad6b53bf90c3c04cbf11bc6cda7c27e5790a161492be0a9e8"}
ANCHOR_ACCOUNT = "3N9s8YUN2pxMuP5bszXUUk9vZ3ks7tDgxgzhG5arGr5qGYe6fn"   # ClientScope operator (also the fee sponsor)
PAY_TO = "3qYSik7b8w9NsgeAk91Mrpapq9T5S7EGvmsa3Ecf4449xiJ8cX"
EXPLORER = "https://ccdexplorer.io/testnet/transaction/"
ANCHOR_ACTION = "log_anchored"

canon = lambda x: json.dumps(x, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode("utf-8")
sha = lambda b: hashlib.sha256(b).hexdigest()
now = lambda: datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")

def clean(rows):
    out = []
    for r in rows:
        r = list(r)
        while r and r[-1] == "": r.pop()
        out.append(r)
    while out and not out[-1]: out.pop()
    return out

def split_audit(audit):
    """-> (covered rows above the anchor row, anchor row or None, rows after the anchor row)"""
    audit = clean(audit)
    for i, r in enumerate(audit):
        if len(r) > 1 and r[1] == ANCHOR_ACTION:
            return audit[:i], r, audit[i + 1:]
    return audit, None, []

def hashes(audit_covered, products):
    return {"log_sha256": sha(canon(audit_covered)), "log_rows": len(audit_covered),
            "products_sha256": sha(canon(clean(products))), "products_rows": max(0, len(clean(products)) - 1)}

def build_receipt(job_id, buyer, payment_tx, delivered, sheet_id, audit_covered, products, buyer_verification=None):
    h = hashes(audit_covered, products)
    times = [r[0] for r in audit_covered[1:] if r]
    return {
        "type": "ClientScopeJobReceipt", "version": 1, "job_id": job_id, "agent": AGENT,
        "buyer": buyer, "pay_to": PAY_TO, "sheet_id": sheet_id,
        "delivery": {"result": "delivered" if delivered else "delivery_failed"},
        "payment": {"tx_hash": payment_tx, "asset": "EUDemo", "amount": "1.000000" if payment_tx else "0",
                    "status": "settled" if payment_tx else "not_taken"},
        "audit_log": {"sha256": h["log_sha256"], "rows_covered": h["log_rows"],
                      "row_sha256": [sha(canon(r)) for r in audit_covered], "covers": "every Audit Log row above the log_anchored row, header included"},
        "products": {"sha256": h["products_sha256"], "rows": h["products_rows"]},
        "timestamps": {"first_log_entry": times[0] if times else None, "last_log_entry": times[-1] if times else None, "issued_at": now()},
        "anchor": {"chain": "concordium-testnet", "method": "RegisterData CBOR CSJRA v1", "account": ANCHOR_ACCOUNT},
        **({"buyer_verification": {k: buyer_verification.get(k) for k in ("verified", "policy", "checks", "facts", "challenge", "signature", "checked_at")}}
           if buyer_verification else {}),
    }

def open_sheet(sheet_id):
    os.chdir(ROOT)
    import gspread
    if ROOT not in sys.path: sys.path.insert(0, ROOT)
    from google_creds import load_credentials
    gc = gspread.authorize(load_credentials())
    return gc.open_by_key(sheet_id)

def export_sheet(sheet_id):
    sh = open_sheet(sheet_id)
    tabs = {w.title: w for w in sh.worksheets()}
    rec = tabs["Receipt"].acell("A2").value if "Receipt" in tabs else None
    return {"sheet_id": sheet_id, "title": sh.title, "audit_log": tabs["Audit Log"].get_all_values(),
            "products": tabs["Products"].get_all_values() if "Products" in tabs else [], "receipt_json": rec}

def node(args, stdin=None, tries=3):
    import time
    for i in range(tries if args[0] == "read" else 1):   # reads retry on transient gRPC errors; sends never retry
        p = subprocess.run(["node", os.path.join(ROOT, "x402", "anchor_tool.mjs")] + args, input=stdin, capture_output=True, text=True, cwd=os.path.join(ROOT, "x402"))
        if p.returncode == 0: return json.loads(p.stdout.strip().splitlines()[-1])
        time.sleep(2)
    raise RuntimeError(p.stderr.strip().splitlines()[-1][-300:] if p.stderr.strip() else "anchor_tool failed")

def anchor(req):
    sh = open_sheet(req["sheet_id"])
    al = sh.worksheet("Audit Log")
    covered, anchor_row, _ = split_audit(al.get_all_values())
    if anchor_row: raise RuntimeError("already anchored")
    products = sh.worksheet("Products").get_all_values()
    receipt = build_receipt(req["job_id"], req["buyer"], req.get("payment_tx"), req["delivered"], req["sheet_id"], covered, products, req.get("buyer_verification"))
    rbytes = canon(receipt); rhash = sha(rbytes)
    tx = node(["send"], json.dumps({"receipt_sha256": rhash, "public": {"job": req["job_id"], "agent": 1010,
              "log_sha256": receipt["audit_log"]["sha256"], "result": receipt["delivery"]["result"]}}))
    # Receipt tab (exact canonical bytes in A2) + the final Audit Log row (not covered by the hash, by design).
    try: ws = sh.worksheet("Receipt")
    except Exception: ws = sh.add_worksheet("Receipt", rows=10, cols=2)
    ws.update([["receipt (canonical JSON, sha256 below is anchored on Concordium)"], [rbytes.decode("utf-8")],
               [f"receipt_sha256={rhash}"], [f"anchor_tx={tx['tx_hash']}"], [EXPLORER + tx["tx_hash"]]], "A1", value_input_option="RAW")
    al.append_rows([[now(), ANCHOR_ACTION,
        f"log_sha256={receipt['audit_log']['sha256']} covers rows 1-{len(covered)} (all rows above) receipt_sha256={rhash} "
        f"anchor_tx={tx['tx_hash']} {EXPLORER}{tx['tx_hash']}"]], value_input_option="RAW")
    os.makedirs(os.path.join(ROOT, "build-log", "receipts"), exist_ok=True)
    json.dump({"receipt": receipt, "receipt_sha256": rhash, "anchor": tx}, open(os.path.join(ROOT, "build-log", "receipts", f"{req['job_id']}.json"), "w"), indent=2)
    return {"receipt_sha256": rhash, "log_sha256": receipt["audit_log"]["sha256"], "rows_covered": len(covered), "anchor": tx}

if __name__ == "__main__" and len(sys.argv) > 1 and sys.argv[1] == "anchor":
    print(json.dumps(anchor(json.load(sys.stdin))))
