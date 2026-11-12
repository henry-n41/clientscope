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
sheet_url, job_error = None, None
try:
    sheet_url = agent_job.run_job(url, extra_audit_rows=req.get("audit_rows") or [],
                                  client=req.get("client") or agent_job.CLIENT, quiet=True)
except Exception as e:
    job_error = f"{type(e).__name__}: {e}"

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
