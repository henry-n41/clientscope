"""Append rows to a sheet's Audit Log. stdin: {"sheet_id", "rows": [[time, action, detail], ...]}"""
import json, os, sys
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__))); os.chdir(ROOT); sys.path.insert(0, ROOT)
import gspread
from google_creds import load_credentials
req = json.load(sys.stdin)
gc = gspread.authorize(load_credentials())
gc.open_by_key(req["sheet_id"]).worksheet("Audit Log").append_rows(req["rows"], value_input_option="RAW")
print(json.dumps({"ok": True, "appended": len(req["rows"])}))
