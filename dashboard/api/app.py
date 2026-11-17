"""ClientScope live dashboard API (Feature 4).

A thin FastAPI layer over the code that already works. It does not re-implement any job, payment,
verification or anchoring logic:
  * starts the existing x402 job server (x402/server.mjs) as a child process,
  * runs the existing demo buyer agent (client_agent.py) for each hire,
  * turns their output into live step updates, streamed to the browser over Server-Sent Events,
  * reads the real Audit Log back from the delivered Google Sheet.

Keys (CCD_CLIENT_PRIVATE_KEY, CCD_SPONSOR_PRIVATE_KEY, and the Google token from .secrets/token.json or GOOGLE_TOKEN_JSON)
stay in this process's env and on disk.
They are only inherited by the child processes, never returned by any endpoint, and every line that reaches the
browser passes through redact().
"""
import asyncio, datetime, hashlib, json, os, re, subprocess, sys, threading, time, uuid
from pathlib import Path

import requests
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

ROOT = Path(__file__).resolve().parents[2]            # the project root (where client_agent.py lives)
RUN_DIR = ROOT / "dashboard" / ".run"; RUN_DIR.mkdir(parents=True, exist_ok=True)
PROGRESS = RUN_DIR / "progress.jsonl"
DIST = ROOT / "dashboard" / "web" / "dist"
_VENV_PY = ROOT / ".venv" / "bin" / "python"
PY = os.environ.get("CLIENTSCOPE_PYTHON") or (str(_VENV_PY) if _VENV_PY.exists() else sys.executable)
STALL_SECONDS = 180
X402_PORT = int(os.environ.get("CLIENTSCOPE_X402_PORT", "4021"))
EXPLORER = "https://ccdexplorer.io/testnet/transaction/"
ACCOUNT_EXPLORER = "https://ccdexplorer.io/testnet/account/"

sys.path.insert(0, str(ROOT))
import client_agent as CA
from google_creds import load_credentials, secret_values
CA_CLIENT = "4j6RhVCWEG3GDQcwcgSQRxu7nmXSC4V834YrsVtudomCG6ueMH"   # demo buyer account (public address, same as x402/config.mjs)  # public constants only (card URL, registry, token); its main() runs as a subprocess

# ---------------------------------------------------------------- secrets never leave the server
_SECRETS = [v for k, v in os.environ.items() if k.startswith("CCD_") and "KEY" in k and v and len(v) >= 16] + secret_values()
_HEX64 = re.compile(r"\b[0-9a-fA-F]{64}\b")

def redact(s: str) -> str:
    for v in _SECRETS:
        s = s.replace(v, "[redacted]")
    return s

now_iso = lambda: datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")

# ---------------------------------------------------------------- run state
STEPS = [
    ("badge", "Check agent badge", "Buyer agent checks ClientScope's Concordium badge and Agent Card hash, then ClientScope signs the buyer's fresh nonce"),
    ("buyer", "Verify buyer", "ClientScope checks the buyer agent's own badge, its signed challenge, identity and allow list"),
    ("hold", "Hold payment", "x402: buyer signs 1 EUDemo, ClientScope verifies it but does not submit"),
    ("scrape", "Scrape supplier", "Read the supplier's price page"),
    ("sheet", "Build Google Sheet", "Products and Audit Log written to a new sheet"),
    ("delivery", "Check delivery", "Sheet, Audit Log, every row complete, row count matches the page"),
    ("settle", "Settle payment", "Sponsor co-signs and submits only after delivery passes"),
    ("anchor", "Anchor receipt", "Audit Log fingerprint registered on Concordium"),
]
MODES = {
    "normal": ([], "Normal hire"),
    "delivery_fail": (["--simulate-delivery-fail"], "Delivery fails (broken supplier page)"),
    "impostor": (["--simulate-unverified-buyer", "impostor"], "Impostor buyer (wrong key)"),
    "not_allowlisted": (["--simulate-unverified-buyer", "not-allowlisted"], "Buyer not on the EUDemo allow list"),
    "bad_card": (["--simulate-bad"], "Tampered Agent Card"),
    "unregistered_buyer": (["--simulate-unverified-buyer", "unregistered"], "Buyer is not a registered agent"),
    "fake_supplier": (["--simulate-fake-supplier", "wrong-key"], "Fake ClientScope with a copied card"),
    "wallet": ([], "Your Concordium wallet"),     # Feature 6: not a client_agent.py mode; driven by /api/wallet/*
}

class Run:
    def __init__(self, mode):
        self.id = uuid.uuid4().hex[:10]
        self.mode = mode
        self.mode_label = MODES[mode][1]
        self.status = "running"                      # running | succeeded | failed
        self.outcome = None                          # delivered_paid | delivery_failed | buyer_rejected | agent_refused | error
        self.started = now_iso(); self.finished = None
        self.job_id = None
        self.steps = {k: {"key": k, "title": t, "hint": h, "status": "pending", "detail": "", "items": [], "at": None}
                      for k, t, h in STEPS}
        self.audit = []; self.audit_source = "live"  # live (as the agent writes it) | sheet (read back from the sheet)
        self.console = []
        self.result = {}
        self.version = 0; self.last_activity = time.time()
        self.lock = threading.RLock()
        self.account = None; self.session = None; self.nonce = None; self.awaiting = False; self.wallet_audit_rows = []

    def bump(self):
        self.version += 1; self.last_activity = time.time()

    def step(self, key, status=None, detail=None, item=None, **extra):
        with self.lock:
            s = self.steps[key]
            if status and s["status"] in ("done", "failed", "skipped") and status == "running":
                status = None                        # never move a finished step back to running (log lines can arrive out of order)
            if status:
                s["status"] = status; s["at"] = s["at"] or now_iso()
                if status in ("done", "failed", "skipped"): s["ended"] = now_iso()
            if detail is not None: s["detail"] = detail
            if item: s["items"].append(item)
            s.update(extra); self.bump()

    def snapshot(self):
        with self.lock:
            return {"id": self.id, "mode": self.mode, "mode_label": self.mode_label, "status": self.status,
                    "outcome": self.outcome, "account": self.account, "started": self.started, "finished": self.finished, "job_id": self.job_id,
                    "steps": [self.steps[k] for k, _, _ in STEPS], "audit": self.audit, "audit_source": self.audit_source,
                    "console": self.console[-400:], "result": self.result, "version": self.version}

RUNS: dict[str, Run] = {}
CURRENT: Run | None = None
HIRE_LOCK = threading.Lock()

# ---------------------------------------------------------------- the existing x402 job server, as a child process
SERVER = {"proc": None, "ready": False, "log": []}

def start_x402_server():
    env = dict(os.environ, CLIENTSCOPE_PROGRESS_FILE=str(PROGRESS))   # agent_job.py writes live audit rows here
    p = subprocess.Popen(["node", str(ROOT / "x402" / "server.mjs")], cwd=str(ROOT), env=env,
                         stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
    SERVER["proc"] = p
    def pump():
        for line in p.stdout:
            line = redact(line.rstrip("\n"))
            SERVER["log"].append(line); SERVER["log"][:] = SERVER["log"][-500:]
            if "x402 server" in line and "http://localhost" in line: SERVER["ready"] = True
            r = CURRENT
            if r and r.status == "running":
                on_server_line(r, line)
        SERVER["ready"] = False
    threading.Thread(target=pump, daemon=True).start()

def on_server_line(r: Run, line: str):
    msg = re.sub(r"^\[server [0-9:]+\]\s*", "", line)
    with r.lock:
        r.console.append({"src": "clientscope", "line": msg, "at": now_iso()}); r.bump()
    if msg.startswith("buyer VERIFIED"):
        r.step("buyer", item="ClientScope: buyer VERIFIED")
    elif msg.startswith("POST /jobs/scrape") and "-> 402" in msg:
        r.step("hold", "running", "ClientScope answered 402 Payment Required: 1 EUDemo, pay on delivery")
    elif msg.startswith("verify (no submit)"):
        ok = "isValid=true" in msg
        reason = (re.search(r"reason=(\S+)", msg) or [None, "unknown"])[1]
        r.step("hold", "done" if ok else "failed",
               "Signed payment verified by the facilitator and held. Nothing submitted to the chain yet." if ok
               else f"The facilitator could not verify the payment ({reason.replace('_', ' ')}). Nothing was submitted.")
    elif msg.startswith("payment held"):
        r.step("scrape", "running", "Fetching the supplier page")
    elif msg.startswith("delivery check:"):
        passed = msg.endswith("PASS")
        m = re.search(r"products=(\d+) complete=(\d+) pageRows=(\w+)", msg)
        d = f"{m.group(2)}/{m.group(1)} product rows complete, supplier page has {m.group(3)}" if m else msg
        if r.steps["sheet"]["status"] == "running": r.step("sheet", "done")
        r.step("delivery", "done" if passed else "failed", ("Passed: " if passed else "Failed: ") + d)
        if r.mode == "wallet":
            if passed: r.step("settle", "running", "Delivery passed. Preparing the payment request for your wallet")
            else: r.step("settle", "skipped", "Not charged. No payment was ever requested from your wallet.", protected=True)
        elif passed:
            r.step("settle", "running", "Delivery passed. Sponsor co-signs and submits, waiting for finality")
        else:
            r.step("settle", "skipped", "Not charged. The signed payment was discarded and never submitted.", protected=True)
        refresh_audit_async(r)
    elif msg.startswith("settle ->"):
        m = re.search(r"tx=([0-9a-f]{64})", msg)
        if "success=true" in msg and m:
            r.result["payment_tx"] = m.group(1)
            r.step("settle", "done", ("Approved in your wallet after delivery and finalized on chain: 1 EUDemo to ClientScope, fee paid by the sponsor"
                                      if r.mode == "wallet" else "Finalized on chain: 1 EUDemo to ClientScope, fee paid by the sponsor"), tx=m.group(1))
        else:
            r.step("settle", "failed", msg)
    elif msg.startswith("fee ") and "paid by sponsor" in msg:
        r.step("settle", item=msg)
    elif msg.startswith("receipt written to Audit Log"):
        refresh_audit_async(r)
    elif msg.startswith("anchoring receipt"):
        r.step("anchor", "running", "Hashing the Audit Log and Products, sending RegisterData")
    elif msg.startswith("anchored:"):
        m = re.search(r"tx=([0-9a-f]{64})", msg); lh = re.search(r"log_sha256=([0-9a-f]+)", msg)
        rows = re.search(r"\((\d+) rows\)", msg)
        if m:
            r.result["anchor_tx"] = m.group(1)
            r.step("anchor", "done", f"Audit Log fingerprint ({rows.group(1) if rows else '?'} rows) anchored on Concordium", tx=m.group(1))
        refresh_audit_async(r)
    elif msg.startswith("anchoring FAILED"):
        r.step("anchor", "running", "The chain node did not answer, retrying the anchor")
        r.result["anchor_retry_needed"] = True
    elif msg.startswith("job crashed"):
        r.step("scrape", "failed", "The job crashed. Payment discarded, buyer not charged.")

# ---------------------------------------------------------------- live audit rows from agent_job.py
def tail_progress(r: Run, stop: threading.Event):
    pos = 0
    while not stop.is_set():
        try:
            with open(PROGRESS) as f:
                f.seek(pos); data = f.read(); pos = f.tell()
        except FileNotFoundError:
            data = ""
        for line in data.splitlines():
            try: row = json.loads(line)["audit_row"]
            except Exception: continue
            on_audit_row(r, [redact(str(c)) for c in row])
        stop.wait(0.3)

def on_audit_row(r: Run, row):
    with r.lock:
        if r.audit_source == "live": r.audit.append(row)
        r.bump()
    action, detail = row[1], row[2] if len(row) > 2 else ""
    if action == "job_started":
        r.step("scrape", "running", "Fetching " + detail.split("url=")[-1])
    elif action == "page_scraped":
        n = int(re.match(r"(\d+)", detail).group(1)) if re.match(r"(\d+)", detail) else 0
        r.step("scrape", "done" if n else "failed", f"{n} products found" + ("" if n else ": the supplier page is broken or empty"),
               item=detail)
        r.step("sheet", "running", "Creating the sheet in the client's Google Drive")
    elif action == "sheet_created":
        r.result["sheet_url"] = detail
        r.step("sheet", "running", "Sheet created, writing rows", url=detail)
    elif action == "rows_written":
        r.step("sheet", "running", detail.replace("rows to Products tab", "product rows written, adding the Audit Log tab"))
    elif action == "job_finished":
        r.step("sheet", "done", "Products and Audit Log tabs written")
        r.step("delivery", "running", "Re-opening the sheet and comparing with the supplier page")

def read_sheet_audit(sheet_url):
    import gspread
    gc = gspread.authorize(load_credentials())
    sh = gc.open_by_url(sheet_url)
    vals = sh.worksheet("Audit Log").get_all_values()
    prods = sh.worksheet("Products").get_all_values() if "Products" in [w.title for w in sh.worksheets()] else []
    return [[redact(c) for c in v[:3]] for v in vals[1:] if any(v)], prods

def refresh_audit(r: Run):
    url = r.result.get("sheet_url")
    if not url: return
    for _ in range(3):
        try:
            rows, prods = read_sheet_audit(url)
            with r.lock:
                r.audit = rows; r.audit_source = "sheet"; r.result["products"] = prods; r.bump()
            return
        except Exception:
            time.sleep(1.5)

def refresh_audit_async(r: Run):
    threading.Thread(target=refresh_audit, args=(r,), daemon=True).start()

# ---------------------------------------------------------------- the demo buyer agent
def on_agent_line(r: Run, raw: str):
    line = redact(raw.rstrip("\n")); s = line.strip()
    if not s or set(s) == {"="}: return
    with r.lock:
        r.console.append({"src": "buyer", "line": s, "at": now_iso()}); r.bump()
    ok = s.startswith("\u2705"); bad = s.startswith("\u274c")
    text = s.lstrip("\u2705\u274c ").strip()
    cur = next((k for k in ("badge", "buyer", "hold") if r.steps[k]["status"] == "running"), None)

    if s.startswith("[1/8]"):
        r.step("badge", "running", "Fetching the Agent Card and asking the Concordium Agent Registry")
    elif s.startswith("[5/8]"):
        r.step("buyer", "running", "Signing a one-time challenge, ClientScope checks it on chain")
    elif s.startswith("[6/8]"):
        r.step("hold", "running", "Requesting the job")
    elif s.startswith("[7/8]"):
        r.step("hold", detail="Checking the price against the buyer's spend policy (max 2 EUDemo, ClientScope only)")
    elif s.startswith("[8/8]"):
        r.step("hold", detail="Signing the payment (buyer signature only, sponsor pays the fee)")
    elif "DECISION: HIRED" in s:
        r.step("badge", "done", r.result.get("badge_summary", "Verified by Concordium"))
    elif "DECISION: REFUSED" in s:
        r.step("badge", "failed", "Badge or handshake check failed: the buyer agent refused to hire. Nothing ran, nothing was paid.")
        r.outcome = "agent_refused"
    elif m := re.search(r"challenge for job (CS-[0-9A-Z-]+)", s):
        r.job_id = m.group(1); r.bump()
    elif "ClientScope accepted me as a buyer" in s:
        facts = r.result.get("buyer_facts", "")
        r.step("buyer", "done", "Verified: signature, identity-backed account, EUDemo allow list" + facts)
    elif "ClientScope REJECTED me as a buyer" in s:
        failed = [f.strip() for f in s.split("failed", 1)[-1].split(",")]
        why = ("The signature does not match the account's on-chain keys, so this is not the real account holder"
               if "challenge_signed" in failed and "account_exists" not in failed else
               "The account is not on the EUDemo allow list" if failed == ["eudemo_allow_listed"] else
               "The buyer is not a registered agent on Concordium's Agent Registry" if failed and "buyer_agent_registered" in failed else
               "The buyer's key does not control the registered agent it claims" if failed == ["buyer_agent_controlled_by_signer"] else
               "Failed: " + ", ".join(f.replace("_", " ") for f in failed))
        r.step("buyer", "failed", "Rejected before any payment. " + why)
        r.outcome = "buyer_rejected"
        return
    elif "identity provider #" in s:
        m = re.search(r'identity provider #(\d+) "([^"]+)", credential valid to (\S+), (\d+) attributes', s)
        if m: r.result["buyer_facts"] = f" (identity provider {m.group(2)}, {m.group(4)} private attributes shared)"
    elif "job endpoint without a verified session" in s:
        r.result["no_402"] = True
        r.step("hold", "skipped", "No 402 issued, so no payment could even be signed", protected=True)
    elif "Nothing changed on chain" in s or "buyer NOT charged" in s:
        r.result["no_chain_change"] = True; r.bump()
    elif "badge_valid:" in s:
        m = re.search(r"badge_valid: (\w+)\s+\((\d+)/(\d+) checks", s)
        if m: r.result["badge_summary"] = f"Verified by Concordium: {m.group(2)}/{m.group(3)} registry checks, card hash matches the chain"
    elif s.startswith("VALID") and " - job " in s:
        r.result["receipt_verified"] = True; r.bump()
    elif s.startswith("TAMPERED"):
        r.result["receipt_verified"] = False; r.bump()
    elif s.startswith("RpcError") or "code: 'UNAVAILABLE'" in s:
        r.result.setdefault("error_detail", "The Concordium testnet node did not answer (gRPC unavailable)"); r.bump()
    elif "ClientScope answered HTTP" in s and bad:
        r.result["error_detail"] = text; r.bump()
    elif "Payment not made" in s:
        r.step("hold", "failed", text)

    if cur and (ok or bad) and not s.startswith(("\u2705 DECISION", "\u274c DECISION")):
        r.step(cur, item={"ok": ok, "text": text})

def run_hire(r: Run):
    global CURRENT
    args, _ = MODES[r.mode]
    PROGRESS.write_text("")
    stop = threading.Event()
    threading.Thread(target=tail_progress, args=(r, stop), daemon=True).start()
    try:
        # Same client_agent.main(), only without its terminal pauses (they exist for screen recordings of the CLI).
        runner = "import sys, client_agent as c; c.say = lambda m='', pause=0: print(m, flush=True); c.main()"
        p = subprocess.Popen([PY, "-u", "-c", runner, *args], cwd=str(ROOT), env=dict(os.environ),
                             stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1, start_new_session=True)
        def watchdog():   # the testnet gRPC calls have no timeout of their own; stop a run that has gone silent
            while p.poll() is None:
                if time.time() - r.last_activity > STALL_SECONDS:
                    r.result["error_detail"] = f"The Concordium testnet node stopped answering for {STALL_SECONDS} s, so the buyer agent was stopped"
                    os.killpg(p.pid, 15); return
                time.sleep(2)
        threading.Thread(target=watchdog, daemon=True).start()
        for line in p.stdout: on_agent_line(r, line)
        code = p.wait()
        time.sleep(1.0); stop.set()
        finish(r, code)
    except Exception as e:
        stop.set(); r.status = "failed"; r.outcome = "error"; r.result["error"] = redact(str(e)); r.bump()
    finally:
        r.finished = now_iso(); r.bump()
        try: (RUN_DIR / f"run-{r.id}.json").write_text(json.dumps(r.snapshot(), indent=1))
        except Exception: pass
        HIRE_LOCK.release()

def retry_anchor(r: Run):
    """The x402 server anchors every job once. If the testnet node drops that call, anchor again with the same
    existing code (x402/receipt.py, which refuses a sheet that is already anchored), then re-verify the receipt."""
    sheet_id = r.result["sheet_url"].split("/d/")[1].split("/")[0]
    bv = None
    try:
        for line in (ROOT / "build-log" / "buyer-checks.jsonl").read_text().splitlines()[::-1]:
            e = json.loads(line)
            if e.get("event") == "buyer_verified" and (e.get("facts") or {}).get("job_id") == r.job_id:
                bv = e; break
    except Exception: pass
    req = {"sheet_id": sheet_id, "job_id": r.job_id, "buyer": (bv or {}).get("facts", {}).get("account") or CA_CLIENT,
           "payment_tx": r.result.get("payment_tx"), "delivered": r.steps["delivery"]["status"] == "done", "buyer_verification": bv}
    for attempt in range(3):
        time.sleep(4)
        p = subprocess.run([PY, "x402/receipt.py", "anchor"], cwd=str(ROOT), input=json.dumps(req), capture_output=True, text=True)
        if p.returncode == 0:
            a = json.loads(p.stdout.strip().splitlines()[-1])
            r.result["anchor_tx"] = a["anchor"]["tx_hash"]
            r.step("anchor", "done", f"Audit Log fingerprint ({a['rows_covered']} rows) anchored on Concordium (second attempt)", tx=a["anchor"]["tx_hash"])
            v = subprocess.run([PY, "verify_receipt.py", "--sheet", sheet_id], cwd=str(ROOT), capture_output=True, text=True)
            for line in v.stdout.splitlines(): on_agent_line(r, line)
            r.result["receipt_verified"] = v.returncode == 0; r.bump()
            return
        if "already anchored" in p.stderr: break
    r.step("anchor", "failed", "Could not anchor the receipt: the testnet node is not answering. The job and payment are unaffected.")

def finish(r: Run, code: int):
    try: trust = json.loads((ROOT / "trust_check.json").read_text())
    except Exception: trust = {}
    x = trust.get("x402") or {}
    if x.get("balances"): r.result["balances"] = x["balances"]
    if x.get("payment"): r.result["payment"] = x["payment"]
    if r.job_id:
        rec = ROOT / "build-log" / "receipts" / f"{r.job_id}.json"
        if rec.exists():
            d = json.loads(rec.read_text())
            r.result["receipt_sha256"] = d.get("receipt_sha256"); r.result["log_sha256"] = d["receipt"]["audit_log"]["sha256"]
            r.result.setdefault("anchor_tx", d.get("anchor", {}).get("tx_hash"))
    for k in ("payment_tx", "anchor_tx"):
        if r.result.get(k): r.result[k + "_url"] = EXPLORER + r.result[k]
    if r.result.get("anchor_retry_needed") and not r.result.get("anchor_tx") and r.result.get("sheet_url"):
        retry_anchor(r)
    for k in ("payment_tx", "anchor_tx"):
        if r.result.get(k): r.result[k + "_url"] = EXPLORER + r.result[k]
    refresh_audit(r)
    pending_to_skipped = lambda why: [r.step(k, "skipped", why) for k, _, _ in STEPS if r.steps[k]["status"] in ("pending", "running")]
    if code == 0:
        r.status, r.outcome = "succeeded", "delivered_paid"
    elif code == 5:
        r.status, r.outcome = "failed", "delivery_failed"; r.result["charged"] = False
    elif code == 7:
        r.status, r.outcome = "failed", "buyer_rejected"; r.result["charged"] = False
        pending_to_skipped("Not run: the buyer was refused before any payment")
    elif code == 2:
        r.status, r.outcome = "failed", "agent_refused"; r.result["charged"] = False
        pending_to_skipped("Not run: the buyer agent refused to hire")
    else:
        r.status, r.outcome = "failed", "error"; r.result["exit_code"] = code
        pending_to_skipped("Not run")
    if r.outcome != "delivered_paid":
        b = r.result.get("balances")
        if b:
            bb, ba = b["before"]["client"], b["after"]["client"]
            r.result["charged"] = not (bb["eudemoAtomic"] == ba["eudemoAtomic"] and bb["ccdMicro"] == ba["ccdMicro"])
    r.bump()


# ---------------------------------------------------------------- Feature 6: the client approves with their own Concordium Browser Wallet
# The browser signs (signMessage for the buyer challenge and order, sendSponsoredTransaction for the payment AFTER delivery).
# This process only relays to the job server (x402/server.mjs, wallet_flow.mjs), which does every check. The verified buyer
# session never reaches the browser.
ADDR_RE = re.compile(r"^[1-9A-HJ-NP-Za-km-z]{50}$")
TX_RE = re.compile(r"^[0-9a-fA-F]{64}$")
utc_row = lambda: datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
SIGN_TIMEOUT = 300
CHECK_LABELS = {"challenge_fresh": "Challenge fresh and single use", "account_exists": "Account exists on chain",
  "challenge_signed": "Your signature matches the account's on-chain keys", "identity_backed": "Account is backed by a real identity",
  "known_identity_provider": "Identity provider registered on chain", "credential_valid": "Identity credential not expired",
  "anonymity_revocation": "Identity recoverable under legal process (2 or more anonymity revokers)",
  "eudemo_allow_listed": "On the EUDemo allow list", "has_funds": "Holds at least 1 EUDemo"}

def x402_post(path, body, headers=None, timeout=30):
    return requests.post(f"http://127.0.0.1:{X402_PORT}{path}", json=body, headers=headers or {}, timeout=timeout)

def wallet_run(rid, need=None):
    r = RUNS.get(rid)
    if not r or r.mode != "wallet" or r.finished: raise HTTPException(404, "no active wallet hire with that id")
    if need == "sign" and r.steps["buyer"]["status"] != "running": raise HTTPException(409, "this hire is not waiting for a signature")
    if need == "pay" and not r.awaiting: raise HTTPException(409, "this hire is not waiting for a payment")
    return r

def finish_wallet(r: Run, outcome: str, detail: str | None = None):
    with r.lock:
        if r.finished or getattr(r, "_closing", False): return
        r._closing = True
    try:
        r.awaiting = False
        if detail: r.result["error_detail"] = redact(detail)
        time.sleep(1.0)                          # let the job server's last log lines land
        if r.job_id:
            rec = ROOT / "build-log" / "receipts" / f"{r.job_id}.json"
            if rec.exists():
                d = json.loads(rec.read_text())
                r.result["receipt_sha256"] = d.get("receipt_sha256"); r.result["log_sha256"] = d["receipt"]["audit_log"]["sha256"]
                r.result.setdefault("anchor_tx", d.get("anchor", {}).get("tx_hash"))
        if r.result.get("anchor_retry_needed") and not r.result.get("anchor_tx") and r.result.get("sheet_url"):
            retry_anchor(r)
        elif r.result.get("anchor_tx") and r.result.get("sheet_url"):
            sid = r.result["sheet_url"].split("/d/")[1].split("/")[0]
            v = subprocess.run([PY, "verify_receipt.py", "--sheet", sid], cwd=str(ROOT), capture_output=True, text=True)
            r.result["receipt_verified"] = v.returncode == 0
        for k in ("payment_tx", "anchor_tx"):
            if r.result.get(k): r.result[k + "_url"] = EXPLORER + r.result[k]
        refresh_audit(r)
        why = {"buyer_rejected": "Not run: you were not verified, so nothing was requested",
               "agent_refused": "Not run: the agent's badge was not valid",
               "cancelled": "Not run: the wallet signature was not given",
               "payment_declined": "Not run", "error": "Not run"}.get(outcome, "Not run")
        for k, _, _ in STEPS:
            if r.steps[k]["status"] in ("pending", "running"): r.step(k, "skipped", why)
        r.outcome = outcome
        r.status = "succeeded" if outcome == "delivered_paid" else "failed"
        r.result["charged"] = outcome == "delivered_paid"
        r.result.pop("payment_request", None)
        r.bump()
    except Exception as e:
        r.status = "failed"; r.outcome = r.outcome or "error"; r.result["error"] = redact(str(e))
    finally:
        r.finished = now_iso(); r.bump()
        try: (RUN_DIR / f"run-{r.id}.json").write_text(json.dumps(r.snapshot(), indent=1))
        except Exception: pass
        HIRE_LOCK.release()

def _sign_watchdog(r: Run):
    time.sleep(SIGN_TIMEOUT)
    if not r.finished and r.steps["buyer"]["status"] == "running":
        r.step("buyer", "failed", "No signature arrived from your wallet within 5 minutes, so the hire was cancelled. Nothing was paid.")
        finish_wallet(r, "cancelled")

def run_wallet_job(r: Run):
    PROGRESS.write_text("")
    stop = threading.Event()
    threading.Thread(target=tail_progress, args=(r, stop), daemon=True).start()
    r.step("scrape", "running", "Fetching the supplier page")
    try:
        resp = x402_post("/wallet/job", {"jobId": r.job_id, "url": CA.SUPPLIER_URL, "client": "Northgate Supplies (demo)",
                                         "audit_rows": r.wallet_audit_rows}, headers={"x-buyer-session": r.session}, timeout=900)
        body = resp.json()
    except Exception as e:
        stop.set(); finish_wallet(r, "error", f"The job server did not answer ({type(e).__name__})"); return
    time.sleep(1.0); stop.set()
    if body.get("sheet_url"): r.result["sheet_url"] = body["sheet_url"]
    if resp.status_code == 422:
        r.step("settle", "skipped", "Not charged. No payment was ever requested from your wallet.", protected=True)
        finish_wallet(r, "delivery_failed"); return
    if resp.status_code != 200 or not body.get("sponsored_transaction"):
        finish_wallet(r, "error", f"The job server answered {resp.status_code}: {body.get('status') or body.get('error')}"); return
    with r.lock:
        r.result["payment_request"] = body["sponsored_transaction"]; r.result["payment_request_expires"] = body.get("expires")
        r.awaiting = True; r.bump()
    r.step("settle", "running", "Delivery passed. Approve the 1 EUDemo payment in your wallet. ClientScope pays the network fee.")
    refresh_audit_async(r)
    try: wait = max(30, (datetime.datetime.fromisoformat(body["expires"].replace("Z", "+00:00")) - datetime.datetime.now(datetime.timezone.utc)).total_seconds())
    except Exception: wait = 600
    deadline = time.time() + wait
    while time.time() < deadline and r.awaiting and not r.finished: time.sleep(2)
    if r.awaiting and not r.finished:
        r.awaiting = False
        try: x402_post("/wallet/declined", {"jobId": r.job_id, "reason": "expired"}, timeout=180)
        except Exception: pass
        r.step("settle", "skipped", "Not charged. The payment request expired before it was approved in your wallet.", protected=True)
        finish_wallet(r, "payment_declined")

def wallet_settle(r: Run, tx: str):
    try:
        resp = x402_post("/wallet/settled", {"jobId": r.job_id, "txHash": tx}, timeout=300)
        body = resp.json()
    except Exception as e:
        r.step("settle", "failed", "Your payment was submitted, but ClientScope could not confirm it on chain yet. Check it in the explorer.", tx=tx)
        finish_wallet(r, "error", f"Could not confirm the payment ({type(e).__name__})"); return
    if resp.status_code == 200:
        r.result["payment_tx"] = tx; r.result["payment"] = body.get("payment")
        if (body.get("anchor") or {}).get("tx_hash"): r.result["anchor_tx"] = body["anchor"]["tx_hash"]
        if r.steps["settle"]["status"] != "done":
            r.step("settle", "done", "Approved in your wallet after delivery and finalized on chain: 1 EUDemo to ClientScope, fee paid by the sponsor", tx=tx)
        for k, ok in ((body.get("payment") or {}).get("checks") or {}).items():
            r.step("settle", item={"ok": bool(ok), "text": k.replace("_", " ").capitalize()})
        finish_wallet(r, "delivered_paid")
    else:
        bad = ", ".join(k.replace("_", " ") for k, ok in (body.get("checks") or {}).items() if not ok)
        r.step("settle", "failed", f"The submitted transaction does not match the payment ClientScope asked for{': ' + bad if bad else ''}.", tx=tx)
        finish_wallet(r, "error", "Payment did not match the request")

class WalletStartReq(BaseModel):
    account: str
class WalletVerifyReq(BaseModel):
    run_id: str
    signature: dict
class WalletPayReq(BaseModel):
    run_id: str
    tx_hash: str
class WalletStopReq(BaseModel):
    run_id: str
    reason: str = "declined"

# ---------------------------------------------------------------- live badge status
_BADGE = {"at": 0, "data": None}

def badge_status():
    if _BADGE["data"] and time.time() - _BADGE["at"] < 60: return _BADGE["data"]
    card_bytes = requests.get(CA.CARD_URL, timeout=20).content
    card = json.loads(card_bytes); my_hash = hashlib.sha256(card_bytes).hexdigest()
    cb = requests.get(f"{CA.REGISTRY}/v1/check-badge/{CA.TOKEN_ADDRESS}", params={"network": CA.NETWORK}, timeout=30).json()
    vr = requests.get(f"{CA.REGISTRY}/v1/verify-agent-card/{CA.TOKEN_ADDRESS}", params={"network": CA.NETWORK}, timeout=30).json()
    checks = cb.get("checks", {}); oc = cb.get("on_chain", {})
    chain_hash = vr.get("on_chain_hash_hex") or oc.get("metadata_hash_hex")
    d = {"checked_at": now_iso(), "name": card.get("name"), "version": card.get("version"), "description": card.get("description"),
         "skills": [{"id": s.get("id"), "name": s.get("name")} for s in card.get("skills", [])],
         "badge_valid": cb.get("badge_valid") is True, "checks_passed": sum(1 for v in checks.values() if v is not False),
         "checks_total": len(checks), "status": oc.get("status"), "token_id": CA.TOKEN_ID, "token_address": CA.TOKEN_ADDRESS,
         "owner": oc.get("owner_account"), "owner_url": ACCOUNT_EXPLORER + (oc.get("owner_account") or ""),
         "card_hash": my_hash, "chain_hash": chain_hash, "hash_match": my_hash == chain_hash and vr.get("match") is True,
         "card_url": CA.CARD_URL, "network": CA.NETWORK, "issues": [i.get("message") for i in cb.get("issues", [])],
         "price": "1 EUDemo", "flow": "Pay on delivery", "fee": "Sponsored by ClientScope"}
    d["verified"] = d["badge_valid"] and d["hash_match"] and d["status"] == "Active"
    _BADGE.update(at=time.time(), data=d)
    return d

# ---------------------------------------------------------------- HTTP
app = FastAPI(title="ClientScope Dashboard API")
app.add_middleware(CORSMiddleware, allow_origins=os.environ.get("CLIENTSCOPE_CORS", "http://localhost:5173").split(","),
                   allow_methods=["GET", "POST"], allow_headers=["content-type"])

@app.on_event("startup")
def _startup():
    start_x402_server()

@app.on_event("shutdown")
def _shutdown():
    if SERVER["proc"]: SERVER["proc"].terminate()

@app.get("/api/health")
def health():
    return {"ok": True, "x402_server": SERVER["ready"], "busy": HIRE_LOCK.locked(), "network": "Concordium testnet"}

@app.get("/api/agent")
def agent():
    try: return badge_status()
    except Exception as e: raise HTTPException(502, f"registry unreachable: {type(e).__name__}")

@app.get("/api/modes")
def modes():
    return [{"id": k, "label": v[1]} for k, v in MODES.items() if k != "wallet"]

@app.get("/api/balances")
def balances():
    p = subprocess.run(["node", "balances.mjs"], cwd=str(ROOT / "x402"), capture_output=True, text=True, timeout=60)
    if p.returncode: raise HTTPException(502, "chain read failed")
    return json.loads(p.stdout)

class HireReq(BaseModel):
    mode: str = "normal"

@app.post("/api/hire")
def hire(req: HireReq):
    global CURRENT
    if req.mode not in MODES or req.mode == "wallet": raise HTTPException(400, "unknown mode")
    if not SERVER["ready"]: raise HTTPException(503, "job server is still starting")
    if not HIRE_LOCK.acquire(blocking=False):
        raise HTTPException(409, "a hire is already running, try again in a moment")
    r = Run(req.mode); RUNS[r.id] = r; CURRENT = r
    threading.Thread(target=run_hire, args=(r,), daemon=True).start()
    return {"run_id": r.id}

@app.post("/api/wallet/start")
def wallet_start(req: WalletStartReq):
    global CURRENT
    if not ADDR_RE.match(req.account or ""): raise HTTPException(400, "that is not a Concordium account address")
    if not SERVER["ready"]: raise HTTPException(503, "job server is still starting")
    if not HIRE_LOCK.acquire(blocking=False):
        raise HTTPException(409, "a hire is already running, try again in a moment")
    r = Run("wallet"); r.account = req.account; RUNS[r.id] = r; CURRENT = r
    try:
        r.job_id = f"CS-{datetime.datetime.now(datetime.timezone.utc):%Y%m%d}-{uuid.uuid4().hex[:6].upper()}"
        r.step("badge", "running", "Checking ClientScope's badge with the Concordium Agent Registry")
        b = badge_status()
        for ok, text in ((b["badge_valid"], f"Badge valid: {b['checks_passed']}/{b['checks_total']} registry checks"),
                         (b["hash_match"], "Agent Card hash matches the one on chain"), (b["status"] == "Active", f"On-chain status: {b['status']}")):
            r.step("badge", item={"ok": bool(ok), "text": text})
        if not b["verified"]:
            r.step("badge", "failed", "The agent's badge is not valid, so the hire was stopped. Nothing was asked of your wallet.")
            threading.Thread(target=finish_wallet, args=(r, "agent_refused"), daemon=True).start()
            return {"run_id": r.id, "job_id": r.job_id, "refused": True}
        summary = f"Verified by Concordium: {b['checks_passed']}/{b['checks_total']} registry checks, card hash matches the chain"
        r.result["badge_summary"] = summary; r.step("badge", "done", summary)
        r.wallet_audit_rows = [
            [utc_row(), "client_badge_check", f"by=client browser (ClientScope dashboard) badge_valid=true checks={b['checks_passed']}/{b['checks_total']} token={b['token_address']} agent=#{b['token_id']} network={b['network']}"],
            [utc_row(), "card_hash_verified", f"sha256={b['card_hash']} matches on-chain metadata_hash"],
            [utc_row(), "job_requested", f"job_id={r.job_id} by account {r.account} through the Concordium Browser Wallet"],
        ]
        c = x402_post("/wallet/challenge", {"account": r.account, "jobId": r.job_id})
        if c.status_code != 200: raise RuntimeError(f"challenge refused ({c.status_code})")
        c = c.json(); r.nonce = c["nonce"]
        r.step("buyer", "running", "Waiting for you to sign ClientScope's one-time challenge and the order in your wallet")
        threading.Thread(target=_sign_watchdog, args=(r,), daemon=True).start()
        return {"run_id": r.id, "job_id": r.job_id, "message": c["message"], "expires": c["expires"]}
    except HTTPException: raise
    except Exception as e:
        threading.Thread(target=finish_wallet, args=(r, "error", f"Could not start the hire ({type(e).__name__})"), daemon=True).start()
        raise HTTPException(502, "could not start the hire, please try again")

@app.post("/api/wallet/verify")
def wallet_verify(req: WalletVerifyReq):
    r = wallet_run(req.run_id, "sign")
    try:
        resp = x402_post("/wallet/verify", {"account": r.account, "jobId": r.job_id, "nonce": r.nonce, "signature": req.signature}, timeout=90)
        v = resp.json()
    except Exception as e:
        r.step("buyer", "failed", "ClientScope could not check your signature: the chain node did not answer.")
        threading.Thread(target=finish_wallet, args=(r, "error", type(e).__name__), daemon=True).start()
        raise HTTPException(502, "could not check the signature, please try again")
    for k, ok in (v.get("checks") or {}).items():
        r.step("buyer", item={"ok": bool(ok), "text": CHECK_LABELS.get(k, k)})
    if not v.get("verified"):
        failed = v.get("failed") or []
        why = ("The signature does not match the account's on-chain keys" if "challenge_signed" in failed and "account_exists" not in failed else
               "The account is not on the EUDemo allow list" if failed == ["eudemo_allow_listed"] else
               "The buyer is not a registered agent on Concordium's Agent Registry" if failed and "buyer_agent_registered" in failed else
               "The buyer's key does not control the registered agent it claims" if failed == ["buyer_agent_controlled_by_signer"] else
               "The account holds less than 1 EUDemo" if failed == ["has_funds"] else
               "Failed: " + ", ".join(CHECK_LABELS.get(f, f).lower() for f in failed))
        r.step("buyer", "failed", "Not verified, so nothing was asked of your wallet. " + why)
        threading.Thread(target=finish_wallet, args=(r, "buyer_rejected"), daemon=True).start()
        return {"verified": False, "failed": failed}
    f = v.get("facts") or {}
    r.session = v.get("session")
    ip = (f.get("identity_provider") or {}).get("name")
    r.step("buyer", "done", f"Verified: your signature, identity-backed account{f' ({ip})' if ip else ''}, EUDemo allow list, balance {f.get('eudemo_balance')} EUDemo")
    r.step("hold", "done", "You signed the order in your wallet: 1 EUDemo, paid only after the delivery check passes. Nothing has been paid.")
    threading.Thread(target=run_wallet_job, args=(r,), daemon=True).start()
    return {"verified": True}

@app.post("/api/wallet/pay")
def wallet_pay(req: WalletPayReq):
    r = wallet_run(req.run_id, "pay")
    if not TX_RE.match(req.tx_hash or ""): raise HTTPException(400, "that is not a transaction hash")
    r.awaiting = False
    with r.lock: r.result.pop("payment_request", None); r.result["payment_submitted"] = req.tx_hash.lower(); r.bump()
    r.step("settle", "running", "Your wallet submitted the payment. Waiting for the chain to finalize it, then ClientScope checks it", tx=req.tx_hash.lower())
    threading.Thread(target=wallet_settle, args=(r, req.tx_hash.lower()), daemon=True).start()
    return {"ok": True}

@app.post("/api/wallet/stop")
def wallet_stop(req: WalletStopReq):
    """The wallet popup was closed or rejected: before verification this cancels the hire; after delivery it declines the payment."""
    r = wallet_run(req.run_id)
    if r.awaiting:
        r.awaiting = False
        def decline():
            try: x402_post("/wallet/declined", {"jobId": r.job_id, "reason": "declined"}, timeout=180)
            except Exception: pass
            r.step("settle", "skipped", "Not charged. You did not approve the payment in your wallet.", protected=True)
            finish_wallet(r, "payment_declined")
        threading.Thread(target=decline, daemon=True).start()
        return {"ok": True, "stopped": "payment"}
    if r.steps["buyer"]["status"] == "running":
        r.step("buyer", "failed", "The signature request was closed in your wallet, so the hire was cancelled. Nothing was paid.")
        threading.Thread(target=finish_wallet, args=(r, "cancelled"), daemon=True).start()
        return {"ok": True, "stopped": "hire"}
    raise HTTPException(409, "this hire can no longer be stopped")

# ---------------------------------------------------------------- custom job requests (draft plans, nothing runs)
CUSTOM_FILE = RUN_DIR / "custom-jobs.json"
CUSTOM_LOCK = threading.Lock()
LLM_ENV_NAMES = ("OPENAI_API_KEY", "ANTHROPIC_API_KEY", "XAI_API_KEY", "GEMINI_API_KEY", "MISTRAL_API_KEY")   # names only; none is set today

class CustomJobReq(BaseModel):
    task: str
    sources: str = ""
    deliverable: str = "sheet"
    frequency: str = "once"
    budget: float | None = None

def _source_kind(u: str):
    l = u.lower()
    if "docs.google.com/spreadsheets" in l: return "sheet", "Google Sheet"
    if l.endswith(".csv") or ".csv?" in l: return "file", "CSV file"
    if l.endswith(".pdf") or ".pdf?" in l: return "file", "PDF document"
    if any(x in l for x in ("/rss", "/feed", ".xml")): return "feed", "news or RSS feed"
    if any(x in l for x in ("amazon.", "ebay.", "etsy.", "shopify", "/product", "/shop", "/store")): return "store", "online shop page"
    return "web", "web page"

FIELD_HINTS = [(r"\bprice|cost|£|€|\$", "prices"), (r"\bstock|availability|in stock|inventory", "stock levels"),
               (r"\breview|rating|stars?\b", "reviews and ratings"), (r"\bemail|contact|phone|lead", "contact details"),
               (r"\bnews|article|headline|post", "headlines and links"), (r"\bjob|vacanc|hiring", "job listings"),
               (r"\binvoice|receipt|bill", "invoice lines"), (r"\bevent|date|deadline", "dates and events")]

def build_custom_plan(q: CustomJobReq):
    urls = [u.strip() for u in re.split(r"[\s,]+", q.sources or "") if re.match(r"^https?://\S+\.\S+", u.strip())][:20]
    kinds = [_source_kind(u) for u in urls]
    fields = [label for pat, label in FIELD_HINTS if re.search(pat, q.task, re.I)] or ["the details described in your request"]
    deliver = {"sheet": ("A new Google Sheet with one row per item and an Audit Log tab", 1.0),
               "email": ("An email summary of what was found, with the full data attached as a sheet", 1.5),
               "csv": ("A CSV file with one row per item, plus the Audit Log", 1.0)}[q.deliverable]
    n = max(1, len(urls))
    per_run = deliver[1] + 0.5 * (n - 1) + (0.5 if any(k[0] in ("file", "feed") for k in kinds) else 0)
    per_run = round(per_run * 2) / 2
    def and_join(xs): xs = list(xs); return xs[0] if len(xs) == 1 else ", ".join(xs[:-1]) + " and " + xs[-1]
    counts = {}
    for k in kinds: counts[k[1]] = counts.get(k[1], 0) + 1
    src_line = and_join([f"{c} {name}s" if c > 1 else f"1 {name}" for name, c in counts.items()]) if urls else "the sources you name (to be agreed)"
    steps = [
        {"title": "Verify each other", "text": "ClientScope's badge is checked on Concordium, and you sign a one-time challenge from your wallet."},
        {"title": f"Read {n} source{'s' if n > 1 else ''}", "text": f"Collect {and_join(fields)} from {src_line}."},
        {"title": "Tidy and structure the data", "text": "One row per item, with the source link and the time it was read."},
        {"title": "Deliver", "text": deliver[0] + "."},
        {"title": "Check the delivery", "text": "Every rule under “What done means” is checked automatically before any payment is asked for."},
        {"title": "Get paid and anchor the receipt", "text": "You approve the payment in your wallet, then the log's fingerprint is stored on Concordium."},
    ]
    if q.frequency != "once":
        steps.append({"title": f"Repeat {q.frequency}", "text": f"The same job runs again {'every day' if q.frequency == 'daily' else 'every week'}. Each run is checked and paid on its own."})
    rules = [f"Every listed source was read ({n} of {n})" if urls else "Every agreed source was read",
             "At least one item was found, and no row has an empty required field",
             "The number of rows matches the number of items found on the sources",
             "Each row records its source link and the time it was read",
             "An Audit Log of every step is included and its fingerprint is anchored on Concordium"]
    if q.deliverable == "email": rules.insert(3, "The summary email reached the address you confirm, and lists every source")
    if q.deliverable == "csv": rules.insert(3, "The CSV file opens and has the agreed column headings")
    if q.frequency != "once": rules.append(f"Each {q.frequency} run finishes on its scheduled day")
    plan = {"label": "Draft plan", "generated_by": "template", "summary": q.task.strip()[:280], "sources": [{"url": u, "kind": k[1]} for u, k in zip(urls, kinds)],
            "collect": fields, "steps": steps, "done_rules": rules, "deliverable": deliver[0], "frequency": q.frequency,
            "estimate": {"amount": per_run, "unit": "EUDemo", "per": "run" if q.frequency != "once" else "job",
                         "note": "Estimate only. ClientScope confirms a fixed price before anything runs."}}
    if q.budget is not None and q.budget < per_run:
        plan["budget_note"] = f"Your budget of {q.budget:g} EUDemo is below this estimate, so ClientScope may suggest a smaller scope."
    return plan

@app.post("/api/custom-jobs")
def custom_job(q: CustomJobReq):
    q.task = (q.task or "").strip()
    if len(q.task) < 15: raise HTTPException(400, "please describe the job in a sentence or two")
    if len(q.task) > 2000 or len(q.sources or "") > 3000: raise HTTPException(400, "that request is too long")
    if q.deliverable not in ("sheet", "email", "csv"): raise HTTPException(400, "unknown deliverable")
    if q.frequency not in ("once", "daily", "weekly"): raise HTTPException(400, "unknown frequency")
    if q.budget is not None and not (0 < q.budget <= 10000): raise HTTPException(400, "budget must be a positive number")
    rec = {"id": uuid.uuid4().hex[:10], "created": now_iso(), "status": "waiting_confirmation",
           "request": q.model_dump(), "plan": build_custom_plan(q)}
    with CUSTOM_LOCK:
        try: data = json.loads(CUSTOM_FILE.read_text())
        except Exception: data = []
        data.append(rec); CUSTOM_FILE.write_text(json.dumps(data[-500:], indent=1))
    return rec

@app.get("/api/custom-jobs/{cid}")
def custom_job_get(cid: str):
    try: data = json.loads(CUSTOM_FILE.read_text())
    except Exception: data = []
    for rec in data:
        if rec["id"] == cid: return rec
    raise HTTPException(404)

def load_run(rid: str):
    if rid in RUNS: return RUNS[rid]
    f = RUN_DIR / f"run-{rid}.json"
    if re.fullmatch(r"[0-9a-f]{10}", rid) and f.exists():
        d = json.loads(f.read_text()); r = Run(d["mode"]); r.id = rid
        for k in ("status", "outcome", "started", "finished", "job_id", "audit", "audit_source", "console", "result"): setattr(r, k, d[k])
        r.steps = {s["key"]: s for s in d["steps"]}; r.version = d["version"]; r.account = d.get("account"); RUNS[rid] = r
        return r
    return None

@app.get("/api/runs")
def runs_list():
    out = []
    for f in sorted(RUN_DIR.glob("run-*.json"), key=lambda f: f.stat().st_mtime, reverse=True)[:20]:
        d = json.loads(f.read_text())
        out.append({k: d.get(k) for k in ("id", "mode_label", "status", "outcome", "job_id", "started")})
    return out

@app.get("/api/runs/{rid}")
def run_state(rid: str):
    r = load_run(rid)
    if not r: raise HTTPException(404)
    return r.snapshot()

@app.get("/api/runs/{rid}/events")
async def run_events(rid: str):
    r = load_run(rid)
    if not r: raise HTTPException(404)
    async def gen():
        seen = -1
        while True:
            if r.version != seen:
                seen = r.version
                yield f"data: {json.dumps(r.snapshot())}\n\n"
            if r.finished and r.version == seen:
                yield "event: done\ndata: {}\n\n"; return
            await asyncio.sleep(0.25)
    return StreamingResponse(gen(), media_type="text/event-stream", headers={"cache-control": "no-cache", "x-accel-buffering": "no"})

def _dist_file(path: str):
    """Only files inside the web build. Rejects path traversal and anything outside DIST."""
    if not path:
        return None
    raw = Path(path)
    if raw.is_absolute() or ".." in raw.parts or path.startswith("/") or chr(92) in path:
        return None
    root = DIST.resolve()
    f = (root / path).resolve()
    try:
        f.relative_to(root)
    except ValueError:
        return None
    return f if f.is_file() else None

if DIST.exists():
    app.mount("/assets", StaticFiles(directory=DIST / "assets"), name="assets")
    @app.get("/{path:path}")
    def spa(path: str):
        f = _dist_file(path)
        return FileResponse(f if f else DIST / "index.html")
