"""Called by the x402 server once a signed payment has been VERIFIED (not submitted).
stdin: {"url","client","audit_rows"}. Runs agent_job.run_job, then a delivery check.
stdout (last line): {"sheet_url", "sheet_id", "check": {...}, "passed": bool}
If the check fails, the Audit Log gets 'delivery_failed' + 'payment_not_taken' rows."""
import json, os, sys, datetime, traceback
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT); os.chdir(ROOT)
import requests, gspread
from bs4 import BeautifulSoup
from google_creds import load_credentials
import agent_job

now = lambda: datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
req = json.load(sys.stdin)
url = req.get("url") or agent_job.URL
HALT_FILE = req.get("halt_file")   # kill switch: the x402 server writes this file the moment the buyer agent is revoked on chain
EXPLORER = "https://ccdexplorer.io/testnet/transaction/"

def halt_info():
    if not HALT_FILE or not os.path.exists(HALT_FILE): return None
    try: return json.load(open(HALT_FILE))
    except Exception: return None

def halt_rows(h, stage, rows_done, rows_total):
    tx = h.get("revoke_tx")
    return [
        [now(), "kill_switch_revoked", f"buyer agent #{h.get('token_id')} ({h.get('token_address')}) was REVOKED on chain by its owner "
                                       f"{h.get('sender') or '?'}: revoke_tx={tx or 'not found'} {EXPLORER + tx if tx else ''} block={h.get('block_height')} at {h.get('revoked_at')}"],
        [now(), "job_halted", f"ClientScope saw the revoke {h.get('detection_seconds')} s after the revoke's block, finality included (it polls the registry every second) and "
                              f"stopped the job at stage={stage}: {rows_done} of {rows_total if rows_total is not None else '?'} product rows written, work not delivered"],
        [now(), "payment_not_taken", "signed payment discarded, never submitted to chain; buyer not charged (a revoked agent's payment is never settled)"],
    ]

sheet_url, job_error, halted = None, None, None
try:
    sheet_url = agent_job.run_job(url, extra_audit_rows=req.get("audit_rows") or [],
                                  client=req.get("client") or agent_job.CLIENT, quiet=True,
                                  halt_check=halt_info if HALT_FILE else None, pace_seconds=float(req.get("pace_seconds") or 0))
except agent_job.Halted as h:
    halted = h
except Exception as e:
    job_error = f"{type(e).__name__}: {e}"

if halted:
    # Stop here: no delivery check, no settlement. Write what happened, so the server can anchor the halt receipt.
    gc = gspread.authorize(load_credentials())
    sh = halted.sheet
    if sh is None:
        sh = gc.create(f"ClientScope - {req.get('client') or agent_job.CLIENT} - {datetime.date.today()} (halted)")
        sh.sheet1.update_title("Products"); sh.sheet1.update([["SKU", "Product", "Price (GBP)", "Stock", "Scraped at"]], "A1")
        halted.audit.append([now(), "sheet_created", sh.url + " (to hold the halt receipt)"])
    audit = halted.audit + halt_rows(halted.info, halted.stage, halted.rows_done, halted.rows_total)
    progress = os.environ.get("CLIENTSCOPE_PROGRESS_FILE")
    if progress:
        with open(progress, "a") as f:
            for r in audit[-3:]: f.write(json.dumps({"audit_row": r}) + "\n")
    al = sh.add_worksheet("Audit Log", rows=max(50, len(audit) + 10), cols=3)
    al.update([["Time", "Action", "Detail"]] + audit, "A1", value_input_option="RAW")
    al.format("A1:C1", {"textFormat": {"bold": True}})
    print(json.dumps({"sheet_url": sh.url, "sheet_id": sh.id, "halted": True, "halt": halted.info, "stage": halted.stage,
                      "rows_done": halted.rows_done, "rows_total": halted.rows_total, "check": {"halted": True}, "passed": False}))
    sys.exit(0)

# ---- Delivery check ----
check = {"job_ran": job_error is None, "job_error": job_error}
gc = gspread.authorize(load_credentials())
sh = None
if sheet_url:
    try:
        sh = gc.open_by_url(sheet_url); check["sheet_exists"] = True
    except Exception as e:
        check["sheet_exists"] = False; check["sheet_error"] = str(e)
else:
    check["sheet_exists"] = False
titles = [w.title for w in sh.worksheets()] if sh else []
check["audit_log_present"] = "Audit Log" in titles
prod = sh.worksheet("Products").get_all_values()[1:] if sh and "Products" in titles else []
complete = [r for r in prod if len(r) >= 4 and r[1].strip() and r[2].strip() and r[3].strip()]
check["products_rows"] = len(prod)
check["products_rows_complete"] = len(complete)
try:
    html = requests.get(url, timeout=15).text
    page_count = len(BeautifulSoup(html, "html.parser").select("tr.product"))
except Exception as e:
    page_count = None; check["page_error"] = str(e)
check["supplier_page_rows"] = page_count
check["has_rows"] = len(complete) >= 1
check["all_rows_complete"] = len(prod) > 0 and len(complete) == len(prod)
check["row_count_matches_page"] = page_count is not None and page_count == len(prod)
gates = ["job_ran", "sheet_exists", "audit_log_present", "has_rows", "all_rows_complete", "row_count_matches_page"]
passed = all(check.get(g) is True for g in gates)
check["gates"] = gates
summary = (f"sheet={'yes' if check['sheet_exists'] else 'no'} audit_log={'yes' if check['audit_log_present'] else 'no'} "
           f"products={len(prod)} complete={len(complete)} page_rows={page_count}")

late_halt = halt_info()   # revoked after the last row but before the delivery decision: still halt, never settle
if late_halt and sh and check["audit_log_present"]:
    rows = halt_rows(late_halt, "after_job_finished", len(prod), page_count)
    sh.worksheet("Audit Log").append_rows(rows, value_input_option="RAW")
    print(json.dumps({"sheet_url": sheet_url, "sheet_id": sh.id, "halted": True, "halt": late_halt, "stage": "after_job_finished",
                      "rows_done": len(prod), "rows_total": page_count, "check": check, "passed": False}))
    sys.exit(0)
if sh and check["audit_log_present"]:
    al = sh.worksheet("Audit Log")
    if passed:
        rows = [[now(), "delivery_check_passed", summary + " -> releasing payment for settlement"]]
    else:
        failed = [g for g in gates if check.get(g) is not True]
        rows = [[now(), "delivery_failed", summary + f" failed={','.join(failed)}"],
                [now(), "payment_not_taken", "signed payment discarded, never submitted to chain; buyer not charged"]]
    al.append_rows(rows, value_input_option="RAW")
print(json.dumps({"sheet_url": sheet_url, "sheet_id": sh.id if sh else None, "check": check, "passed": passed}))
