# ClientScope x402 payment step (Concordium testnet, EUDemo, pay on delivery)

## How a paid job works now
1. Client agent checks ClientScope's Concordium badge, then calls `POST /jobs/scrape`.
2. Server answers **402**: 1 EUDemo to ClientScope, fee payer = sponsor, payment window 600 s.
3. Client checks its spend policy (only ClientScope's payTo, only EUDemo, max 2 EUDemo), signs a V1 sponsored
   transfer as sender only, with the job id in the memo.
4. Server checks memo == job id and replay rules, then the facilitator **verifies without submitting**
   (signature against on-chain keys, amount, token + decimals, payTo, expiry, nonce, buyer's EUDemo balance).
   Audit Log: `payment_authorized ... NOT submitted`.
5. ClientScope runs `agent_job.py`, then a **delivery check** (`run_job.py`): sheet exists, Audit Log tab present,
   at least 1 product row, every row has name + price + stock, and the row count equals the supplier page's.
6. Passed: the handler answers 200, and the x402 middleware then settles: the sponsor co-signs, submits and waits for
   finality. Receipt rows (`payment_settled`, `fee_sponsored`, `payment_receipt`) get appended to the Audit Log.
   Failed: the handler answers 422, the middleware skips settlement, the signed payment is discarded,
   and the Audit Log records `delivery_failed` + `payment_not_taken`. The settle wrapper also refuses any job not marked delivered.

This is the x402 "authorization" flow (verify before the handler, settle after it). The library already skips
settlement when the handler answers >= 400, so no custom middleware was needed. (The earlier version used "upfront",
which charged before the job ran.)

## Replay protection
- **On chain:** each payment is signed with the client account's next nonce. Concordium accepts a nonce once, so a
  settled payment can never be included again. The facilitator also pre-checks it (`preflight_nonce_mismatch`).
- **Only the sponsor can submit:** a V1 sponsored transaction is only valid with the sponsor's signature, so a
  discarded payment can't be pushed on chain by anyone else. It also dies at its expiry (<= 10 min), or as soon as the
  client uses that nonce for anything else.
- **Server:** the same signed payment (sha256 of the header) is refused (409). A job id can be used once.
  A sender+nonce is locked while in flight or settled, and unlocked only when the payment is discarded, so the buyer
  can retry with a new payment.
- **Memo binding:** the transfer memo must equal the job id in the request (400 otherwise), and it's visible on chain.
- Tested: the same payment again gives 409, with another job id gives 400, and straight to the facilitator gives `preflight_nonce_mismatch`.

## Tamper-proof Audit Log (Feature 2)
After every job, delivered or failed, ClientScope makes a **receipt** and anchors it on Concordium:
- `log_sha256` = sha256 of the canonical JSON of every Audit Log row above the `log_anchored` row, header included.
  `products_sha256` is the same for the Products tab. The receipt also lists one hash per row, so the verifier can say which row changed.
- The receipt is JSON with sorted keys and no spaces. It holds the job id, agent (registry `JyP9YTHUc6YFEXRdx9HKH`
  #1010 and card hash), buyer, payTo, payment tx (or `not_taken`), delivery result, the log and Products hashes, and timestamps.
  It's stored in the sheet's **Receipt** tab (cell A2, exact bytes) and in `build-log/receipts/<job>.json`.
- **On chain:** a `RegisterData` transaction from ClientScope's operator account `3N9s8…` with 155 bytes of CBOR
  `{type:"CSJRA", version:1, hash: sha256(receipt), public:{job, agent:1010, log: log_sha256, result}}`.
  ccdexplorer decodes and shows it.
- A final Audit Log row `log_anchored` carries the anchor tx and explorer link. It sits outside the hash by design:
  the hash covers everything before it.
- `verify_receipt.py --sheet <id>` (or `--file export.json`) re-hashes everything and reads the anchor from the chain.
  It checks the anchor is finalized and is RegisterData from the operator account, the format, the log hash, that no rows
  were added after the anchor, the receipt hash, the Products hash, the job and agent ids, and the payment tx (amount, parties, memo).
  It prints VALID or TAMPERED with reasons, including which row changed.

**Why this design?** The payment memo can't hold the log hash, because the buyer signs the payment before the job
runs, so the final log doesn't exist yet. Memos can't be changed after signing. A separate RegisterData anchor works the
same way for delivered and failed jobs, costs about 4.6 testnet CCD, and follows the Concordium SDK's own
"verification audit anchor" pattern (`VerificationAuditRecordV1`: CBOR `{type:"CCDVAA", version, hash, public}` sent as
RegisterData and checked by `verifyAnchor`), only with our own type tag. CIS-8004 itself defines no receipts or purchase
logs. Its per-agent metadata store could hold a pointer, but only the agent's owner can write it, and we leave the badge untouched.
Workshop 3 said auditable purchase logs would be covered in the next workshop (Wed 11 Nov). If Concordium publishes a
recommended format there, we should switch to it.

## Verify the buyer (Feature 3): two-way trust

The buyer already checks ClientScope's badge. Now ClientScope checks the buyer too, before it quotes a price.

1. `POST /buyer/challenge {account, jobId}` returns a fresh challenge naming the job, the account, a random nonce and a
   5-minute expiry. Each challenge works once.
2. The buyer signs it with its account key (Concordium's signed-message format) and sends `POST /buyer/verify`.
3. ClientScope checks the accepted-buyer policy (`GET /buyer/policy`, code in `buyer_check.mjs`), using only public chain data:
   - the signature matches the account's on-chain credential keys (proves the buyer controls the account)
   - the account has an identity-backed ("normal") credential
   - its identity provider is registered on chain
   - the credential has not expired
   - 2 or more anonymity revokers (the identity can be recovered under legal process)
   - the account is on the EUDemo allow list (Concordium's allow-list faucet adds accounts after a Concordium ID proof)
4. Pass: the buyer gets a 15-minute session for that one job. `/jobs/scrape` without a valid session answers 403 and never
   issues a 402, so no payment can be signed. With a payment, the payer must be the verified account.
5. Every result goes to `build-log/buyer-checks.jsonl`. A verified buyer also gets a `buyer_verified` row in the Audit Log,
   and the challenge, signature, checks and facts go into the anchored receipt. `verify_receipt.py` re-checks the
   signature on chain. Rejections cost nothing on chain: no sheet, no anchor, no transaction.

ClientScope learns no name, nationality or other private attribute (the credentials reveal 0 attributes).

Test it: `python client_agent.py --simulate-unverified-buyer impostor` (fresh random key claiming our account) or
`--simulate-unverified-buyer not-allowlisted` (a real identity-backed account not on the allow list). Both exit 7.

Options considered:
- Signed challenge plus on-chain checks: built. Strongest option that runs headless.
- ZK proof from the account key alone: not possible. Concordium identity proofs need the identity secrets that live in the
  wallet, not the account signing key, so this needs a wallet in the loop.
- CIS-8004 registration of the buyer agent: prepared in `../client-agent-card/`, not sent. It needs the card hosted on
  GitHub Pages first (a push by Henry).

## Files
- `buyer_check.mjs`: Feature 3 buyer challenge, on-chain checks and the accepted-buyer policy.
- `server.mjs`: Express + `@x402/express` + `@x402/concordium` server scheme + in-process facilitator (sponsor key).
- `pay_and_hire.mjs`: the client payment helper (`@x402/fetch`, Concordium client scheme on `ccd:*`, spend cap, memo).
- `run_job.py`: runs the job and the delivery check. `append_audit.py` adds the receipt rows.
- `receipt.py`: canonical hashing, receipt building, and the anchor and Receipt tab. `anchor_tool.mjs`: RegisterData send and read (CBOR).
- `../verify_receipt.py`: independent verifier, VALID or TAMPERED.
- `balances.mjs`, `txinfo.mjs`, `chain.mjs`, `config.mjs`: read-only chain helpers and public settings.
- `replay_test.mjs`: replays a saved payment (test only; it needs `CLIENTSCOPE_SAVE_PAYMENT` set on a run).

## Run (keys only from env)
```
CCD_SPONSOR_PRIVATE_KEY=... node x402/server.mjs                     # terminal 1
CCD_CLIENT_PRIVATE_KEY=...  .venv/bin/python client_agent.py          # terminal 2
   --simulate-delivery-fail   broken supplier URL: job fails its check, buyer not charged
   --simulate-bad             tampered Agent Card: client refuses to hire
   --direct                   legacy, no payment
```
Network note: on this box, gRPC port 20000 only works through the egress tunnel. `config.mjs` sets `grpc_proxy`
automatically when `SAND_EGRESS_TUNNEL_PROXY_ADDR` exists. On a normal machine no proxy is needed.
The node defaults to `grpc.testnet.concordium.com:20000` over TLS; set `CCD_GRPC_HOST`, `CCD_GRPC_PORT` and `CCD_GRPC_TLS` to use another one.

## Limits

- Buyer sessions and challenges live in memory: a server restart clears them (buyers just ask again).
- The allow-list rule ties buyers to EUDemo holders; the policy is code, not yet config.
- The anchor is signed by the operator account `3N9s8…` (also the fee sponsor), not by the badge owner `3qYSik…`, because
  we don't hold that key. The verifier pins `3N9s8…` as ClientScope's anchor account. Signing with the owner's key (or
  publishing the operator account in the Agent Card) would tie anchors to the badge more strongly.
- Sheet values are hashed as displayed. A pure formatting or locale change that alters the displayed values counts as tampering.
- Finding an anchor needs the `log_anchored` row (or the receipt file). If someone deletes that row, the verifier says TAMPERED
  ("no log_anchored row"). Scanning the operator account's history by job id isn't built yet.
- A hash proves the log wasn't edited after anchoring. It can't prove the log was truthful before that.
- Replay and job-id memory is in-process (lost on restart). On-chain nonce protection still holds. Use a DB for production.
- The spend cap is enforced client-side. Concordium plans protocol-level spending limits later.
- If settlement fails after a good delivery (e.g. the buyer moved their EUDemo away during the job), the client gets
  the sheet but ClientScope isn't paid. This is logged as `payment_failed`. That's the trade-off of pay on delivery.
- The 600 s window is the facilitator's maximum. Jobs that take longer would need a longer window or a different scheme.
