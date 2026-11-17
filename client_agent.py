"""Agent B - the client's agent.
Before hiring ClientScope, it checks ClientScope's Verified by Concordium badge itself
(Agent Card hash + Concordium Agent Registry over REST and MCP). Only a verified agent gets the job."""
import argparse, datetime, hashlib, json, os, subprocess, sys, time, uuid
import requests

CARD_URL = "https://henry-n41.github.io/clientscope-supplier-demo/agent-card.json"
TOKEN_ADDRESS = "JyP9YTHUc6YFEXRdx9HKH"
TOKEN_ID = "1010"
NETWORK = "testnet"
REGISTRY = "https://agent-registry-mcp.concordium.com"
MCP_URL = f"{REGISTRY}/mcp"
REQUIRED_SKILL = "scrape-to-sheet"
SUPPLIER_URL = "https://henry-n41.github.io/clientscope-supplier-demo/"

OK, BAD = "\u2705", "\u274c"
now = lambda: datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")


def say(msg="", pause=0.4):
    print(msg, flush=True)
    time.sleep(pause)


def mcp_call(tool, arguments):
    """Call a tool on Concordium's hosted Agent Registry MCP server (streamable HTTP, JSON-RPC)."""
    h = {"content-type": "application/json", "accept": "application/json, text/event-stream"}
    init = {"jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": {"protocolVersion": "2025-03-26", "capabilities": {},
                       "clientInfo": {"name": "clientscope-client-agent", "version": "1.0"}}}
    r = requests.post(MCP_URL, json=init, headers=h, timeout=20); r.raise_for_status()
    sid = r.headers.get("mcp-session-id")
    if sid: h["mcp-session-id"] = sid
    requests.post(MCP_URL, json={"jsonrpc": "2.0", "method": "notifications/initialized"}, headers=h, timeout=20)
    r = requests.post(MCP_URL, json={"jsonrpc": "2.0", "id": 2, "method": "tools/call",
                                     "params": {"name": tool, "arguments": arguments}}, headers=h, timeout=30)
    r.raise_for_status()
    body = r.text
    if body.lstrip().startswith("event:") or body.lstrip().startswith("data:"):  # SSE framing
        body = next(l[5:] for l in body.splitlines() if l.startswith("data:"))
    res = json.loads(body)["result"]
    if res.get("isError"):
        raise RuntimeError(res["content"][0]["text"])
    return json.loads(res["content"][0]["text"])


def verify_anchor(sheet_url):
    """Buyer-side: independently re-hash the delivered sheet and check its Concordium anchor."""
    sid = sheet_url.split("/d/")[1].split("/")[0]
    say("\n>> Verifying the job receipt against its Concordium anchor (verify_receipt.py)")
    p = subprocess.run([sys.executable, os.path.join(os.path.dirname(os.path.abspath(__file__)), "verify_receipt.py"), "--sheet", sid],
                       capture_output=True, text=True)
    for line in p.stdout.rstrip().splitlines(): say("   " + line, 0.05)
    return p.returncode == 0


def main():
    ap = argparse.ArgumentParser(description="Client agent: verify ClientScope on Concordium, then hire it.")
    ap.add_argument("--simulate-bad", action="store_true",
                    help="Tamper with the downloaded Agent Card locally to show the refusal path (nothing on-chain changes).")
    ap.add_argument("--simulate-delivery-fail", action="store_true",
                    help="Send ClientScope a broken supplier URL so the job fails its delivery check (buyer must not be charged).")
    ap.add_argument("--simulate-unverified-buyer", nargs="?", const="impostor", choices=["impostor", "not-allowlisted", "unregistered", "stolen-card"],
                    help="Test the buyer check: 'impostor' signs with a fresh random key while claiming our account; "
                         "'not-allowlisted' uses a real identity-backed account that is not on the EUDemo allow list; "
                         "'unregistered' is the real buyer account and key but presents no registered agent; "
                         "'stolen-card' presents ClientScope's own registered agent #1010, which the buyer does not control. "
                         "ClientScope must refuse before any payment.")
    ap.add_argument("--simulate-fake-supplier", nargs="?", const="wrong-key", choices=["wrong-key", "replay"],
                    help="Test the supplier handshake: an impostor that copies ClientScope's real Agent Card answers the handshake, "
                         "either signing with the wrong key ('wrong-key') or replaying a genuine ClientScope signature captured earlier ('replay'). "
                         "The buyer must refuse before any payment.")
    ap.add_argument("--direct", action="store_true",
                    help="Legacy: run the job without the x402 payment step.")
    args = ap.parse_args()

    say("=" * 64, 0)
    say("  CLIENT AGENT  -  Northgate Supplies (demo)")
    say("  Task: hire an agent to put the supplier price list in a Google Sheet")
    say("  Rule: only hire an agent with a valid Verified by Concordium badge")
    if args.simulate_bad:
        say("  MODE: --simulate-bad (the card will be tampered with locally)")
    say("=" * 64, 0.6)

    trust = {"checked_at": now(), "network": NETWORK, "token_address": TOKEN_ADDRESS, "token_id": TOKEN_ID,
             "card_url": CARD_URL, "simulate_bad": args.simulate_bad}
    reasons = []

    # Step 1 - fetch the Agent Card from the URI pinned on chain, and hash it ourselves
    say("\n[1/8] Fetching ClientScope's Agent Card")
    card_url = CARD_URL
    try:
        card_url = requests.get(f"{REGISTRY}/v1/check-badge/{TOKEN_ADDRESS}", params={"network": NETWORK}, timeout=30).json()["on_chain"]["agent_uri"] or CARD_URL
    except Exception:
        pass
    trust["card_url"] = card_url
    card_bytes = requests.get(card_url, timeout=20).content
    if args.simulate_bad:
        card_bytes = card_bytes.replace(b'"scrape-to-sheet"', b'"scrape-to-sheet-and-email-the-data-elsewhere"')
    card = json.loads(card_bytes)
    my_hash = hashlib.sha256(card_bytes).hexdigest()
    skills = [s.get("id") for s in card.get("skills", [])]
    badge = next((e for e in card.get("capabilities", {}).get("extensions", [])
                  if "concordium-badge" in e.get("uri", "")), None)
    say(f"      {OK} Agent:  {card.get('name')}  (v{card.get('version')})")
    say(f"      {OK} Skills: {', '.join(s.get('name', s.get('id')) + ' [' + s.get('id') + ']' for s in card.get('skills', []))}")
    say(f"      {OK} Card SHA-256 (computed by me): {my_hash[:16]}...")
    say(f"      {OK if badge else BAD} Concordium badge extension in card: {'yes' if badge else 'no'}")
    trust["card"] = {"name": card.get("name"), "version": card.get("version"), "skills": skills,
                     "sha256_computed": my_hash, "byte_length": len(card_bytes), "badge_extension_present": bool(badge)}

    # Step 2 - Concordium badge check (REST)
    say("\n[2/8] Asking the Concordium Agent Registry (REST) to check the badge")
    cb = requests.get(f"{REGISTRY}/v1/check-badge/{TOKEN_ADDRESS}", params={"network": NETWORK}, timeout=30).json()
    checks = cb.get("checks", {})
    passed = sum(1 for v in checks.values() if v is not False)
    on_chain = cb.get("on_chain", {})
    say(f"      {OK if cb.get('badge_valid') else BAD} badge_valid: {cb.get('badge_valid')}  ({passed}/{len(checks)} checks passed)")
    say(f"      {OK if on_chain.get('status') == 'Active' else BAD} On-chain status: {on_chain.get('status')}  (Agent #{cb.get('token_id')})")
    say(f"      {OK} Owner account: {on_chain.get('owner_account', '')[:12]}...")
    for i in cb.get("issues", []):
        say(f"      {BAD} Registry issue: {i.get('message')}")
    trust["check_badge_rest"] = cb

    # Step 3 - verify the card over REST and MCP, and compare with our own hash
    say("\n[3/8] Verifying the Agent Card against the on-chain hash")
    vr = requests.get(f"{REGISTRY}/v1/verify-agent-card/{TOKEN_ADDRESS}", params={"network": NETWORK}, timeout=30).json()
    vr.get("fetched", {}).pop("body_preview", None)
    trust["verify_agent_card_rest"] = vr
    say(f"      {OK if vr.get('match') else BAD} Registry (REST) verify-agent-card: match={vr.get('match')}")
    try:
        vm = mcp_call("verify_agent_card", {"token_id": TOKEN_ID, "network": NETWORK})
        vm.get("fetched", {}).pop("body_preview", None)
        trust["verify_agent_card_mcp"] = vm
        say(f"      {OK if vm.get('match') else BAD} Registry (MCP tool verify_agent_card): match={vm.get('match')}")
    except Exception as e:
        vm = None
        trust["verify_agent_card_mcp"] = {"error": str(e)}
        say(f"      {BAD} MCP verify_agent_card failed: {e}")
    chain_hash = vr.get("on_chain_hash_hex") or on_chain.get("metadata_hash_hex")
    own_match = (my_hash == chain_hash)
    say(f"      On-chain metadata hash:  {chain_hash[:16]}...")
    say(f"      Hash I computed myself:  {my_hash[:16]}...")
    say(f"      {OK if own_match else BAD} My own hash check: {'MATCH' if own_match else 'MISMATCH'}")
    trust["own_hash_check"] = {"on_chain_hash": chain_hash, "computed": my_hash, "match": own_match}

    # Step 4 - live handshake: ClientScope must prove it controls agent #1010 by signing MY fresh nonce, then the hiring policy
    say("\n[4/8] Handshake: ClientScope signs my fresh nonce, then I apply my hiring policy")
    job_id = f"CS-{datetime.datetime.now(datetime.timezone.utc):%Y%m%d}-{uuid.uuid4().hex[:6].upper()}"
    here = os.path.dirname(os.path.abspath(__file__))
    port = os.environ.get("CLIENTSCOPE_X402_PORT", "4021")
    supplier_base = f"http://127.0.0.1:{port}"
    fake = None
    if args.simulate_fake_supplier:
        say(f"      MODE: --simulate-fake-supplier {args.simulate_fake_supplier} (an impostor with ClientScope's copied card answers)")
        fenv = dict(os.environ, CLIENTSCOPE_FAKE_MODE=args.simulate_fake_supplier, CLIENTSCOPE_FAKE_PORT="4031")
        if args.simulate_fake_supplier == "replay":  # the impostor captured a genuine ClientScope handshake meant for someone else
            cap = requests.post(supplier_base + "/agent/handshake", json={"nonce": uuid.uuid4().hex, "jobId": "CS-EAVESDROPPED", "fromAgent": "1211"}, timeout=20).json()
            cap_path = os.path.join(here, "build-log", "gap2", "captured-genuine-handshake.json")
            os.makedirs(os.path.dirname(cap_path), exist_ok=True)
            json.dump(cap, open(cap_path, "w"), indent=1)
            fenv["CLIENTSCOPE_FAKE_REPLAY"] = cap_path
        fake = subprocess.Popen(["node", os.path.join(here, "x402", "fake_supplier.mjs")], cwd=os.path.join(here, "x402"), env=fenv, stdout=subprocess.PIPE, text=True)
        fake.stdout.readline()  # wait until it listens
        supplier_base = "http://127.0.0.1:4031"
    p = subprocess.run(["node", os.path.join(here, "x402", "verify_supplier.mjs"), supplier_base, job_id], cwd=os.path.join(here, "x402"), capture_output=True, text=True)
    if fake: fake.terminate()
    hs = None
    for line in p.stdout.splitlines():
        if line.startswith("RESULT "): hs = json.loads(line[7:])
        else: say(line, 0.1)
    trust["supplier_handshake"] = hs
    hs_ok = bool(hs and hs.get("ok"))
    policy = {
        "badge_valid": cb.get("badge_valid") is True,
        "card_hash_matches_chain": own_match and vr.get("match") is True,
        "agent_active": on_chain.get("status") == "Active" and card.get("active") is True,
        "has_required_skill": REQUIRED_SKILL in skills,
        "supplier_handshake": hs_ok,
    }
    labels = {"badge_valid": "Concordium badge is valid",
              "card_hash_matches_chain": "Agent Card matches the on-chain hash",
              "agent_active": "Agent is active on-chain",
              "has_required_skill": f"Agent offers the '{REQUIRED_SKILL}' skill",
              "supplier_handshake": f"Agent proved it controls registered agent #{TOKEN_ID} (signed my fresh nonce)"}
    for k, v in policy.items():
        say(f"      {OK if v else BAD} {labels[k]}")
        if not v: reasons.append(labels[k] + ": FAILED")
    approved = all(policy.values())
    trust["policy"] = policy
    trust["decision"] = "hire" if approved else "refuse"
    trust["refusal_reasons"] = reasons
    json.dump(trust, open("trust_check.json", "w"), indent=2)

    if not approved:
        say("\n" + "=" * 64, 0)
        say(f"  {BAD} DECISION: REFUSED. ClientScope is NOT hired. No job was run.")
        for r in reasons: say(f"     - {r}", 0.1)
        say("  Full trust check saved to trust_check.json")
        say("=" * 64, 0)
        sys.exit(2)

    say("\n" + "=" * 64, 0)
    say(f"  {OK} DECISION: HIRED. ClientScope is verified on Concordium.")
    say("=" * 64, 0.6)

    audit_rows = [
        [trust["checked_at"], "client_badge_check",
         f"by=client-agent badge_valid=true checks={passed}/{len(checks)} token={TOKEN_ADDRESS} agent=#{TOKEN_ID} network={NETWORK}"],
        [now(), "card_hash_verified",
         f"sha256={my_hash} matches on-chain metadata_hash (REST match=true, MCP match={vm.get('match') if vm else 'n/a'})"],
        [now(), "supplier_handshake_verified",
         f"by=client-agent #{hs['my_agent']}: ClientScope agent #{hs['supplier_agent']} signed my fresh nonce {hs['handshake']['nonce']} for job {job_id}; "
         f"signer={hs['handshake']['signer']} ({hs['handshake']['via']} of agent #{hs['supplier_agent']}, checked on chain), signature matches its on-chain keys"],
        [now(), "hire_approved", f"policy passed: {', '.join(policy)}"],
    ]
    if args.direct:
        say("\n>> --direct: handing the job to ClientScope without payment (legacy demo)")
        import agent_job
        sheet_url = agent_job.run_job(SUPPLIER_URL, extra_audit_rows=audit_rows, quiet=True)
        payment = None
    else:
        # Pay ClientScope over x402 in EUDemo (fee sponsored), via the Node helper.
        audit_rows.append([now(), "job_requested", f"job_id={job_id} via x402 POST /jobs/scrape"])
        job_url = SUPPLIER_URL + ("this-page-does-not-exist/" if args.simulate_delivery_fail else "")
        if args.simulate_delivery_fail:
            say(f"\n  MODE: --simulate-delivery-fail (job URL is broken: {job_url})")
        req = {"jobId": job_id, "url": job_url, "client": "Northgate Supplies (demo)", "audit_rows": audit_rows}
        here = os.path.dirname(os.path.abspath(__file__))
        env = dict(os.environ)
        if args.simulate_unverified_buyer:
            env["CLIENTSCOPE_SIMULATE_BUYER"] = args.simulate_unverified_buyer
            say(f"\n  MODE: --simulate-unverified-buyer {args.simulate_unverified_buyer}")
        proc = subprocess.Popen(["node", os.path.join(here, "x402", "pay_and_hire.mjs")], cwd=os.path.join(here, "x402"),
                                stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, env=env)
        proc.stdin.write(json.dumps(req)); proc.stdin.close()
        result = None
        for line in proc.stdout:
            if line.startswith("RESULT "):
                result = json.loads(line[7:])
            else:
                say(line.rstrip("\n"), 0.15)
        proc.wait()
        trust["x402"] = result
        if result and result.get("buyer_rejected"):
            json.dump(trust, open("trust_check.json", "w"), indent=2)
            say("\n" + "=" * 64, 0)
            say(f"  {BAD} CLIENTSCOPE REFUSED THE JOB: buyer not verified ({', '.join(result.get('failed', []))})")
            say(f"  {OK if result.get('ok') else BAD} Refused before any payment: " + ("no 402 issued, nothing signed, nothing changed on chain" if result.get("ok") else "CHECK CHAIN"))
            say("=" * 64, 0)
            sys.exit(7)
        if result and result.get("delivery_failed"):
            json.dump(trust, open("trust_check.json", "w"), indent=2)
            say("\n" + "=" * 64, 0)
            say(f"  {BAD} JOB NOT DELIVERED, so NOT PAID. " + (f"{OK} buyer charged 0 EUDemo, 0 CCD" if result.get("ok") else "CHECK CHAIN"))
            say(f"  Sheet (shows delivery_failed in Audit Log): {result.get('sheet_url')}")
            say("=" * 64, 0)
            if result.get("sheet_url"): verify_anchor(result["sheet_url"])
            sys.exit(5)
        if not result or not result.get("ok"):
            json.dump(trust, open("trust_check.json", "w"), indent=2)
            say(f"\n  {BAD} Payment or job failed, nothing more was done. See trust_check.json")
            sys.exit(3)
        sheet_url = result["response"]["sheet_url"]
        payment = result["payment"]
    trust["sheet_url"] = sheet_url
    json.dump(trust, open("trust_check.json", "w"), indent=2)
    say("\n" + "=" * 64, 0)
    say(f"  {OK} JOB DELIVERED" + (f", THEN PAID: {payment['amount']} (buyer fee {payment['buyer_fee_ccd']} CCD)" if payment else ""))
    say(f"      {OK} Supplier page scraped, new Google Sheet created in the client's Drive")
    say(f"      {OK} Products and Audit Log written (trust check" + (" + payment receipt" if payment else "") + " in the Audit Log)")
    say(f"\n  Sheet: {sheet_url}")
    if payment:
        say(f"  Tx:    {payment['explorer']}")
    say("=" * 64, 0)
    if payment: verify_anchor(sheet_url)
    say("  Full trust check saved to trust_check.json", 0)


if __name__ == "__main__":
    main()
