"""Verify a ClientScope job receipt against its Concordium anchor.
  python verify_receipt.py --sheet <sheet_id>        read the live sheet (read-only)
  python verify_receipt.py --file export.json        verify a local export (python verify_receipt.py --sheet ID --export out.json)
Prints VALID or TAMPERED with reasons. Exit code 0 = VALID, 1 = TAMPERED."""
import argparse, json, os, re, sys
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "x402"))
import receipt as R

OK, BAD = "\u2705", "\u274c"
def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--sheet"); ap.add_argument("--file"); ap.add_argument("--export")
    a = ap.parse_args()
    data = R.export_sheet(a.sheet) if a.sheet else json.load(open(a.file))
    if a.export:
        json.dump(data, open(a.export, "w"), indent=1, ensure_ascii=False); print(f"exported to {a.export}"); return 0
    reasons, checks = [], []
    def check(ok, label, why=None):
        checks.append((ok, label)); print(f"  {OK if ok else BAD} {label}")
        if not ok: reasons.append(why or label)
    print(f"Verifying sheet {data['sheet_id']}  ({'local export ' + a.file if a.file else 'live sheet'})")
    covered, arow, after = R.split_audit(data["audit_log"])
    if not arow:
        print(f"TAMPERED\n  - no '{R.ANCHOR_ACTION}' row found"); return 1
    m = re.search(r"anchor_tx=([0-9a-f]{64})", arow[2]); tx_hash = m.group(1) if m else None
    print(f"\n[1] Anchor on Concordium: {tx_hash}")
    try: tx = R.node(["read", tx_hash]) if tx_hash else {}
    except Exception as e: tx = {}; print(f"      could not read anchor tx: {e}")
    an = tx.get("anchor") or {}
    check(tx.get("status") == "finalized", f"anchor tx is finalized (block {tx.get('block_height')}, {tx.get('block_time')})", "anchor tx not finalized or not found")
    check(tx.get("type") == "registerData", "anchor tx is a RegisterData transaction", "anchor tx is not RegisterData")
    check(tx.get("sender") == R.ANCHOR_ACCOUNT, f"anchored by ClientScope's operator account {R.ANCHOR_ACCOUNT[:10]}...", f"anchor sent by unknown account {tx.get('sender')}")
    check(an.get("type") == "CSJRA" and an.get("version") == 1, "anchor format CSJRA v1", "anchor data not CSJRA v1")
    pub = an.get("public") or {}
    print(f"\n[2] Audit Log ({len(covered)} rows above the anchor row)")
    h = R.hashes(covered, data["products"])
    print(f"      recomputed log_sha256 = {h['log_sha256']}")
    print(f"      on-chain   log_sha256 = {pub.get('log_sha256')}")
    check(h["log_sha256"] == pub.get("log_sha256"), "Audit Log matches the on-chain hash", "Audit Log hash does not match the on-chain anchor (log was edited)")
    check(not after, "no rows added after the anchor row", f"{len(after)} row(s) added after anchoring")
    print("\n[3] Receipt")
    rj = data.get("receipt_json")
    rec = json.loads(rj) if rj else {}
    rh = R.sha(rj.encode("utf-8")) if rj else None
    check(rh is not None and rh == an.get("hash"), f"receipt sha256 matches the anchor ({str(rh)[:16]}...)", "Receipt tab does not match the anchored receipt hash")
    check(rec.get("audit_log", {}).get("sha256") == h["log_sha256"], "receipt's log hash matches the recomputed log", "receipt's log hash differs from the log")
    check(rec.get("products", {}).get("sha256") == h["products_sha256"], f"Products data matches the receipt ({h['products_rows']} rows)", "Products tab was edited after the receipt")
    check(rec.get("job_id") == pub.get("job") and rec.get("agent", {}).get("token_id") == 1010 == pub.get("agent"), f"job {rec.get('job_id')} / agent #1010 match the anchor", "job id or agent id mismatch")
    rows_h = rec.get("audit_log", {}).get("row_sha256")
    if rows_h and rh == an.get("hash") and h["log_sha256"] != pub.get("log_sha256"):
        for i, r in enumerate(covered):
            if i >= len(rows_h): reasons.append(f"row {i + 1} ({r[1] if len(r) > 1 else ''}) was inserted"); continue
            if R.sha(R.canon(r)) != rows_h[i]:
                reasons.append(f"row {i + 1} ({r[1] if len(r) > 1 else '?'}) was changed: now reads \"{(r[2] if len(r) > 2 else '')[:140]}\"")
        if len(covered) < len(rows_h): reasons.append(f"{len(rows_h) - len(covered)} row(s) deleted")
    pay = rec.get("payment", {})
    if pay.get("tx_hash"):
        print(f"\n[4] Payment {pay['tx_hash']}")
        try: p = R.node(["read", pay["tx_hash"]])
        except Exception as e: p = {}; print(f"      could not read payment tx: {e}")
        ev = (p.get("events") or [{}])[0]
        check(p.get("status") == "finalized" and ev.get("token") == "EUDemo" and ev.get("amount") == "1000000", "payment finalized: 1.000000 EUDemo", "payment tx missing or wrong amount/token")
        check(ev.get("from") == rec.get("buyer") and ev.get("to") == R.PAY_TO, "payment from the receipt's buyer to ClientScope", "payment parties differ from receipt")
        check(ev.get("memo") == rec.get("job_id"), f"payment memo = job id ({ev.get('memo')})", "payment memo does not match the job id")
    else:
        print(f"\n[4] Payment: none (receipt says delivery={rec.get('delivery', {}).get('result')}, payment {pay.get('status')})")
    bv = rec.get("buyer_verification")
    if bv:
        print(f"\n[5] Buyer verification (re-checked on chain)")
        acct = bv.get("facts", {}).get("account")
        try: sv = R.node(["verifysig"], json.dumps({"account": acct, "message": bv.get("challenge"), "signature": bv.get("signature")}))
        except Exception as e: sv = {}; print(f"      could not re-check buyer signature: {e}")
        check(acct == rec.get("buyer"), f"verified buyer {str(acct)[:10]}... is the payer in the receipt", "verified buyer differs from the payer")
        check(sv.get("signature_valid") is True, "buyer's signed challenge verifies against its on-chain keys", "buyer signature does not verify")
        check(sv.get("credential_type") == "normal" and sv.get("identity_provider") == bv.get("facts", {}).get("identity_provider", {}).get("id"),
              f"identity-backed credential from identity provider {sv.get('identity_provider')}", "buyer credential differs from receipt")
        check(bv.get("verified") is True and rec.get("job_id") in (bv.get("challenge") or ""), "challenge was for this job and the buyer policy passed", "buyer policy did not pass for this job")
    halt = rec.get("halt")
    if halt:
        print(f"\n[6] Kill switch: buyer agent #{halt.get('token_id')} revoked mid-job (re-checked on chain)")
        rv = {}
        if halt.get("revoke_tx"):
            p = __import__("subprocess").run(["node", os.path.join(os.path.dirname(os.path.abspath(__file__)), "x402", "killswitch.mjs"), "verify-revoke",
                                              halt["revoke_tx"], str(halt.get("token_id"))], capture_output=True, text=True, cwd=os.path.join(os.path.dirname(os.path.abspath(__file__)), "x402"))
            try: rv = json.loads(p.stdout.strip().splitlines()[-1])
            except Exception: rv = {}
        c = rv.get("checks") or {}
        check(bool(halt.get("revoke_tx")) and c.get("finalized") and c.get("succeeded"), f"revoke tx {str(halt.get('revoke_tx'))[:16]}... is finalized and succeeded", "revoke tx not found on chain")
        check(c.get("is_registry_revoke_for_token"), f"it is a CIS-8004 revoke of agent #{halt.get('token_id')} on the registry 12802,0", "tx is not a registry revoke of this agent")
        check(c.get("agent_now_revoked"), f"agent #{halt.get('token_id')} is Revoked on chain now", "agent is not revoked on chain")
        check(rv.get("revoked_at") == halt.get("revoked_at"), f"revoke time in the receipt matches the block ({halt.get('revoked_at')})", "revoke time differs from the chain")
        check(not pay.get("tx_hash") and pay.get("status") == "not_taken", "no payment was taken for the halted job", "a halted job has a payment")
        check(any(len(r) > 2 and r[1] == "kill_switch_revoked" and str(halt.get("revoke_tx")) in r[2] for r in covered),
              "the anchored Audit Log names the revoke tx", "Audit Log has no kill_switch_revoked row for this tx")
    print()
    if reasons:
        print("TAMPERED"); [print(f"  - {r}") for r in reasons]; return 1
    print(f"VALID  - job {rec.get('job_id')}, {rec.get('delivery', {}).get('result')}, log of {len(covered)} rows anchored in tx {tx_hash}")
    return 0

if __name__ == "__main__":
    sys.exit(main())
