"""ClientScope Work Agent - job: scrape a supplier page into a new Google Sheet, with an audit log."""
import json, os, hashlib, datetime, requests, gspread
from bs4 import BeautifulSoup
from google_creds import load_credentials

URL = "https://henry-n41.github.io/clientscope-supplier-demo/"
CLIENT = "Northgate Supplies (demo)"
now = lambda: datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")


class Halted(Exception):
    """Raised by halt_check() when ClientScope must stop the job now (kill switch: the buyer agent was revoked on chain)."""
    def __init__(self, info, stage, audit, sheet):
        super().__init__(f"halted at {stage}"); self.info, self.stage, self.audit, self.sheet = info, stage, audit, sheet


def run_job(url=URL, extra_audit_rows=None, client=CLIENT, quiet=False, halt_check=None, pace_seconds=0.0):
    """Run the job and return the new sheet URL.
    extra_audit_rows: optional [[time, action, detail], ...] written to the Audit Log before job_started.
    halt_check: optional callable, polled between every stage and every product row; returns None, or the halt info
      (kill switch) to stop the job at once. Then Halted is raised carrying the Audit Log so far and the sheet (if any).
    pace_seconds: write product rows one by one with this pause (only used for the kill-switch demo, so a person has
      time to press the button while the job is visibly running)."""
    import time
    audit = list(extra_audit_rows or [])
    progress = os.environ.get("CLIENTSCOPE_PROGRESS_FILE")  # optional: live progress for the dashboard (no secrets)
    def emit(row):
        if progress:
            with open(progress, "a") as f: f.write(json.dumps({"audit_row": row}) + "\n")
    for r in audit: emit(r)
    def log(action, detail):
        audit.append([now(), action, detail]); emit(audit[-1])

    sh = None
    rows_done = [0]; total = [None]
    def checkpoint(stage):
        info = halt_check() if halt_check else None
        if info:
            e = Halted(info, stage, audit, sh); e.rows_done, e.rows_total = rows_done[0], total[0]
            raise e

    # 1. Scrape
    log("job_started", f"client={client} url={url}")
    checkpoint("before_scrape")
    html = requests.get(url, timeout=15).text
    page_hash = hashlib.sha256(html.encode()).hexdigest()
    rows = [[tr.select_one("." + k).get_text(strip=True) for k in ["sku", "name", "price", "stock"]]
            for tr in BeautifulSoup(html, "html.parser").select("tr.product")]
    for r in rows: r[2] = float(r[2])
    total[0] = len(rows)
    log("page_scraped", f"{len(rows)} products, page sha256={page_hash[:16]}...")
    checkpoint("after_scrape")

    # 2. Create sheet in the client's own Drive
    creds = load_credentials()
    gc = gspread.authorize(creds)
    sh = gc.create(f"ClientScope - {client} - {datetime.date.today()}")
    log("sheet_created", sh.url)
    checkpoint("after_sheet_created")

    # 3. Write products
    ws = sh.sheet1
    ws.update_title("Products")
    if pace_seconds:
        ws.update([["SKU", "Product", "Price (GBP)", "Stock", "Scraped at"]], "A1")
        for i, r in enumerate(rows):
            checkpoint(f"writing_row_{i + 1}_of_{len(rows)}")
            ws.update([r + [now()]], f"A{i + 2}")
            rows_done[0] = i + 1
            log("row_written", f"row {i + 1}/{len(rows)}: {r[0]}")
            for _ in range(int(pace_seconds * 4)):
                time.sleep(0.25); checkpoint(f"after_row_{i + 1}_of_{len(rows)}")
    else:
        ws.update([["SKU", "Product", "Price (GBP)", "Stock", "Scraped at"]] + [r + [now()] for r in rows], "A1")
        rows_done[0] = len(rows)
    ws.format("A1:E1", {"textFormat": {"bold": True}})
    log("rows_written", f"{len(rows)} rows to Products tab")
    checkpoint("before_finish")

    # 4. Audit log tab
    log("job_finished", "status=success")
    al = sh.add_worksheet("Audit Log", rows=max(50, len(audit) + 10), cols=3)
    al.update([["Time", "Action", "Detail"]] + audit, "A1")
    al.format("A1:C1", {"textFormat": {"bold": True}})

    json.dump({"sheet_url": sh.url, "audit": audit}, open("last_run.json", "w"), indent=2)
    if not quiet:
        print(sh.url)
        for a in audit: print(a)
    return sh.url


if __name__ == "__main__":
    run_job()
