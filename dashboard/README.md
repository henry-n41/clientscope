# ClientScope live dashboard (Feature 4)

A web page where a buyer hires ClientScope and watches the whole trusted job happen live:
agent badge check, buyer verification, payment hold (x402, EUDemo), scrape, Google Sheet, delivery check,
settlement and the on-chain receipt anchor. Failed jobs show "Not charged" with balances read back from the chain.

## How it fits together
- `web/`: React + Vite + Tailwind CSS, a static site. It talks to the API over `fetch` and Server-Sent Events.
- `api/app.py`: FastAPI. It wraps the code that already works and does not re-implement it:
  - starts `x402/server.mjs` (the pay-on-delivery job server) as a child process,
  - runs the existing demo buyer agent (`client_agent.py`) for each hire, with the same flags as the CLI,
  - turns both processes' output, plus live Audit Log rows from `agent_job.py`, into step updates,
  - reads the real Audit Log back from the delivered Google Sheet,
  - re-sends the receipt anchor with `x402/receipt.py` if the testnet node dropped the first try, then re-verifies it with `verify_receipt.py`,
  - stops a run if the chain goes silent for 180 s (the gRPC calls have no timeout of their own).
- `agent_job.py` got one additive hook: if `CLIENTSCOPE_PROGRESS_FILE` is set, each Audit Log row is also written there as it happens.

Endpoints: `GET /api/health`, `GET /api/agent` (live badge check, cached 60 s), `GET /api/modes`, `POST /api/hire {mode}`,
`GET /api/runs`, `GET /api/runs/{id}`, `GET /api/runs/{id}/events` (SSE). Finished runs are saved in `.run/` and can be reopened with `?run=<id>`.

Scenarios: `normal`, `delivery_fail` (broken supplier URL), `impostor` (wrong key), `not_allowlisted`, `bad_card` (tampered Agent Card).

## Run locally
```
export CCD_CLIENT_PRIVATE_KEY=...  CCD_SPONSOR_PRIVATE_KEY=...      # never commit these
dashboard/run.sh                                                    # builds the page, serves page + API on http://127.0.0.1:8000
```
Front-end development with hot reload: run the API as above, then `cd dashboard/web && npm run dev` (http://localhost:5173, proxies /api).

## Keys
Keys stay in the API process's environment and in `.secrets/token.json` (or the `GOOGLE_TOKEN_JSON` environment variable on a host such as Render). They are only inherited by the child processes,
never returned by an endpoint, and every line sent to the browser goes through `redact()`.
The buyer's key is held by the demo buyer agent on the server; the page says so. In production the buyer would sign
the challenge and the payment in the Concordium Browser Wallet.

## Screenshots
`docs/images/dash-1-idle.png`, `dash-3-finished.png`, `dash-4-failed-delivery_fail.png`, `dash-4-failed-impostor.png`
(made with `shots/shoot.mjs`, headless Chrome).
