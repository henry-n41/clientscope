"""ClientScope Work Agent - job: scrape a supplier page into a new Google Sheet, with an audit log."""
import json, os, hashlib, datetime, requests, gspread
from bs4 import BeautifulSoup
from google_creds import load_credentials

URL = "https://henry-n41.github.io/clientscope-supplier-demo/"
CLIENT = "Northgate Supplies (demo)"
now = lambda: datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")


def run_job(url=URL, extra_audit_rows=None, client=CLIENT, quiet=False):
    """Run the job and return the new sheet URL.
    extra_audit_rows: optional [[time, action, detail], ...] written to the Audit Log before job_started."""
    audit = list(extra_audit_rows or [])
    progress = os.environ.get("CLIENTSCOPE_PROGRESS_FILE")  # optional: live progress for the dashboard (no secrets)
    def emit(row):
        if progress:
            with open(progress, "a") as f: f.write(json.dumps({"audit_row": row}) + "\n")
    for r in audit: emit(r)
    def log(action, detail):
        audit.append([now(), action, detail]); emit(audit[-1])

    # 1. Scrape
    log("job_started", f"client={client} url={url}")
    html = requests.get(url, timeout=15).text
    page_hash = hashlib.sha256(html.encode()).hexdigest()
    rows = [[tr.select_one("." + k).get_text(strip=True) for k in ["sku", "name", "price", "stock"]]
            for tr in BeautifulSoup(html, "html.parser").select("tr.product")]
    for r in rows: r[2] = float(r[2])
    log("page_scraped", f"{len(rows)} products, page sha256={page_hash[:16]}...")

    # 2. Create sheet in the client's own Drive
    creds = load_credentials()
    gc = gspread.authorize(creds)
    sh = gc.create(f"ClientScope - {client} - {datetime.date.today()}")
    log("sheet_created", sh.url)

    # 3. Write products
    ws = sh.sheet1
    ws.update_title("Products")
    ws.update([["SKU", "Product", "Price (GBP)", "Stock", "Scraped at"]] + [r + [now()] for r in rows], "A1")
    ws.format("A1:E1", {"textFormat": {"bold": True}})
    log("rows_written", f"{len(rows)} rows to Products tab")

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
