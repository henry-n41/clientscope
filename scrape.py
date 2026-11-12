import requests
from bs4 import BeautifulSoup
URL = "https://henry-n41.github.io/clientscope-supplier-demo/"
html = requests.get(URL, timeout=15).text
rows = []
for tr in BeautifulSoup(html, "html.parser").select("tr.product"):
    rows.append({k: tr.select_one("." + k).get_text(strip=True) for k in ["sku", "name", "price", "stock"]})
for r in rows: print(r)
