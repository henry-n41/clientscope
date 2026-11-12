import { useEffect, useMemo, useRef, useState } from "react";

const API = (import.meta.env.VITE_API_BASE || "").replace(/\/$/, "");
const EXPLORER = "https://ccdexplorer.io/testnet/transaction/";
const SUPPLIER = "https://henry-n41.github.io/clientscope-supplier-demo/";
const BUYER = "4j6RhVCWEG3GDQcwcgSQRxu7nmXSC4V834YrsVtudomCG6ueMH";

const STEP_KEYS = [
  ["badge", "Check agent badge", "Buyer agent checks ClientScope's Concordium badge and Agent Card hash"],
  ["buyer", "Verify buyer", "ClientScope checks the buyer's signed challenge, identity and allow list"],
  ["hold", "Hold payment", "x402: buyer signs 1 EUDemo, ClientScope verifies it but does not submit"],
  ["scrape", "Scrape supplier", "Read the supplier's price page"],
  ["sheet", "Build Google Sheet", "Products and Audit Log written to a new sheet"],
  ["delivery", "Check delivery", "Sheet, Audit Log, every row complete, row count matches the page"],
  ["settle", "Settle payment", "Sponsor co-signs and submits only after delivery passes"],
  ["anchor", "Anchor receipt", "Audit Log fingerprint registered on Concordium"],
];
const IDLE_STEPS = STEP_KEYS.map(([key, title, hint]) => ({ key, title, hint, status: "pending", items: [] }));

const short = (s, a = 8, b = 6) => (s && s.length > a + b + 1 ? `${s.slice(0, a)}…${s.slice(-b)}` : s || "");
const fmtTime = (iso) => (iso ? new Date(iso).toLocaleTimeString("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "");
const amt = (atomic, d = 6) => (Number(atomic) / 10 ** d).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 6 });

/* ------------------------------------------------------------------ icons */
const I = {
  check: (c = "") => <svg viewBox="0 0 20 20" className={c} fill="currentColor"><path fillRule="evenodd" d="M16.7 5.3a1 1 0 0 1 0 1.4l-8 8a1 1 0 0 1-1.4 0l-4-4a1 1 0 1 1 1.4-1.4L8 12.6l7.3-7.3a1 1 0 0 1 1.4 0Z" clipRule="evenodd" /></svg>,
  x: (c = "") => <svg viewBox="0 0 20 20" className={c} fill="currentColor"><path d="M5.3 5.3a1 1 0 0 1 1.4 0L10 8.6l3.3-3.3a1 1 0 1 1 1.4 1.4L11.4 10l3.3 3.3a1 1 0 0 1-1.4 1.4L10 11.4l-3.3 3.3a1 1 0 0 1-1.4-1.4L8.6 10 5.3 6.7a1 1 0 0 1 0-1.4Z" /></svg>,
  shield: (c = "") => <svg viewBox="0 0 24 24" className={c} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3 4.5 6v5.5c0 4.6 3.2 8.4 7.5 9.5 4.3-1.1 7.5-4.9 7.5-9.5V6L12 3Z" /><path d="m8.8 12 2.2 2.2 4.2-4.4" /></svg>,
  shieldX: (c = "") => <svg viewBox="0 0 24 24" className={c} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3 4.5 6v5.5c0 4.6 3.2 8.4 7.5 9.5 4.3-1.1 7.5-4.9 7.5-9.5V6L12 3Z" /><path d="m9.5 9.5 5 5m0-5-5 5" /></svg>,
  ext: (c = "") => <svg viewBox="0 0 20 20" className={c} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M11 3h6v6M17 3l-8 8M8 5H5a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2v-3" /></svg>,
  sheet: (c = "") => <svg viewBox="0 0 24 24" className={c} fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="4" y="3" width="16" height="18" rx="2.5" /><path d="M4 9h16M4 15h16M10 9v12" /></svg>,
  chain: (c = "") => <svg viewBox="0 0 24 24" className={c} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" /><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" /></svg>,
  refresh: (c = "") => <svg viewBox="0 0 20 20" className={c} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M16 10a6 6 0 1 1-1.8-4.3M16 3v3.5h-3.5" /></svg>,
  bolt: (c = "") => <svg viewBox="0 0 20 20" className={c} fill="currentColor"><path d="M11.3 1.5 3.5 11h5l-1 7.5L15.5 9h-5l.8-7.5Z" /></svg>,
};

const Spinner = ({ c = "h-4 w-4" }) => (
  <svg className={`${c} animate-spin`} viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity=".2" strokeWidth="3" /><path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" /></svg>
);

function Logo() {
  return (
    <div className="flex items-center gap-3">
      <div className="grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-br from-indigo-400 to-indigo-700 shadow-lg shadow-indigo-900/40 ring-1 ring-white/20">
        <svg viewBox="0 0 32 32" className="h-5 w-5"><circle cx="14" cy="14" r="7" fill="none" stroke="white" strokeWidth="3" /><path d="M19.5 19.5 25 25" stroke="white" strokeWidth="3" strokeLinecap="round" /></svg>
      </div>
      <div>
        <div className="text-[15px] font-semibold tracking-tight text-white">ClientScope</div>
        <div className="text-[11px] font-medium text-indigo-200/70">Trusted work agent on Concordium</div>
      </div>
    </div>
  );
}

function Pill({ tone = "slate", children, dot }) {
  const tones = {
    slate: "bg-white/5 text-slate-200 ring-white/10",
    green: "bg-emerald-400/10 text-emerald-300 ring-emerald-400/20",
    amber: "bg-amber-400/10 text-amber-200 ring-amber-400/20",
    red: "bg-rose-400/10 text-rose-200 ring-rose-400/20",
  };
  const dots = { slate: "bg-slate-400", green: "bg-emerald-400", amber: "bg-amber-400", red: "bg-rose-400" };
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium ring-1 ${tones[tone]}`}>
      {dot && <span className={`h-1.5 w-1.5 rounded-full ${dots[tone]}`} />}
      {children}
    </span>
  );
}

/* ------------------------------------------------------------------ agent card */
function AgentCard({ agent, error, onRefresh, loading }) {
  const ok = agent?.verified;
  return (
    <section className="overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-slate-900/5">
      <div className={`relative px-5 pb-5 pt-5 ${ok ? "bg-gradient-to-br from-emerald-50 via-white to-white" : agent ? "bg-gradient-to-br from-rose-50 to-white" : ""}`}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-[.14em] text-slate-400">Agent</div>
            <h2 className="mt-1 text-lg font-semibold tracking-tight text-slate-900">{agent?.name || "ClientScope Work Agent"}</h2>
            <div className="mt-0.5 text-[13px] text-slate-500">Agent #{agent?.token_id || "1010"} · v{agent?.version || "1.0.0"} · CIS-8004</div>
          </div>
          <button onClick={onRefresh} title="Re-check now" className="rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600">
            {loading ? <Spinner /> : I.refresh("h-4 w-4")}
          </button>
        </div>

        <div className={`mt-4 flex items-center gap-3 rounded-xl px-3.5 py-3 ring-1 ${ok ? "bg-emerald-600 text-white ring-emerald-700/20 shadow-md shadow-emerald-600/20" : agent ? "bg-rose-600 text-white ring-rose-700" : "bg-slate-100 text-slate-500 ring-slate-200"}`}>
          {agent ? (ok ? I.shield("h-7 w-7 shrink-0") : I.shieldX("h-7 w-7 shrink-0")) : <Spinner c="h-6 w-6" />}
          <div className="min-w-0">
            <div className="text-[14px] font-semibold">{agent ? (ok ? "Verified by Concordium" : "Badge not valid") : error ? "Registry unreachable" : "Checking badge…"}</div>
            <div className={`text-[12px] ${ok ? "text-emerald-50/90" : "opacity-80"}`}>
              {agent ? `Live check ${fmtTime(agent.checked_at)} UK · ${agent.checks_passed}/${agent.checks_total} registry checks` : "Concordium Agent Registry, testnet"}
            </div>
          </div>
        </div>
      </div>

      <dl className="divide-y divide-slate-100 border-t border-slate-100 text-[13px]">
        {[
          ["Registry checks", agent ? `${agent.checks_passed} of ${agent.checks_total} passed` : "…", agent?.badge_valid],
          ["Agent Card hash", agent ? (agent.hash_match ? `Matches chain · ${agent.card_hash.slice(0, 8)}` : "Does not match") : "…", agent?.hash_match],
          ["On-chain status", agent?.status || "…", agent?.status === "Active"],
        ].map(([k, v, good, sub]) => (
          <div key={k} className="flex items-center justify-between gap-3 px-5 py-2.5">
            <dt className="whitespace-nowrap text-slate-500">{k}</dt>
            <dd className="flex items-center gap-1.5 text-right font-medium text-slate-800">
              {agent && (good ? <span className="text-emerald-600">{I.check("h-4 w-4")}</span> : <span className="text-rose-600">{I.x("h-4 w-4")}</span>)}
              <span>{v}{sub && <span className="ml-1.5 font-mono text-[11px] font-normal text-slate-400">{sub}</span>}</span>
            </dd>
          </div>
        ))}
        <div className="flex items-center justify-between gap-3 px-5 py-2.5">
          <dt className="text-slate-500">Owner</dt>
          <dd>{agent?.owner ? <a href={agent.owner_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-mono text-[12px] text-indigo-600 hover:underline">{short(agent.owner, 8, 6)}{I.ext("h-3 w-3")}</a> : "…"}</dd>
        </div>
      </dl>

      <div className="border-t border-slate-100 px-5 py-4">
        <div className="flex flex-wrap gap-1.5">
          {(agent?.skills || [{ id: "scrape-to-sheet", name: "Scrape to Sheet" }]).map((s) => (
            <span key={s.id} className="rounded-md bg-indigo-50 px-2 py-1 text-[11.5px] font-medium text-indigo-700 ring-1 ring-indigo-100">{s.name}</span>
          ))}
          <span className="rounded-md bg-slate-50 px-2 py-1 text-[11.5px] font-medium text-slate-600 ring-1 ring-slate-200">Pay on delivery</span>
          <span className="rounded-md bg-slate-50 px-2 py-1 text-[11.5px] font-medium text-slate-600 ring-1 ring-slate-200">Fees sponsored</span>
        </div>
        <a href={agent?.card_url} target="_blank" rel="noreferrer" className="mt-3 inline-flex items-center gap-1 text-[12px] font-medium text-slate-500 hover:text-indigo-600">View Agent Card {I.ext("h-3 w-3")}</a>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ hire card */
function HireCard({ modes, mode, setMode, onHire, busy, serverReady, agentOk }) {
  const failModes = modes.filter((m) => m.id !== "normal");
  const isFail = mode !== "normal";
  return (
    <section className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-900/5">
      <div className="text-[11px] font-semibold uppercase tracking-[.14em] text-slate-400">New job</div>
      <h3 className="mt-1 text-[15px] font-semibold text-slate-900">Supplier price list to Google Sheet</h3>
      <p className="mt-1 text-[13px] leading-relaxed text-slate-500">Scrape the supplier's live prices and stock into a new sheet in your Drive, with a tamper-proof Audit Log.</p>

      <dl className="mt-4 space-y-2 rounded-xl bg-slate-50 p-3.5 text-[12.5px] ring-1 ring-slate-100">
        <div className="flex justify-between gap-2"><dt className="text-slate-500">Client</dt><dd className="font-medium text-slate-800">Northgate Supplies (demo)</dd></div>
        <div className="flex justify-between gap-2"><dt className="text-slate-500">Supplier page</dt><dd><a className="inline-flex items-center gap-1 font-medium text-indigo-600 hover:underline" href={SUPPLIER} target="_blank" rel="noreferrer">clientscope-supplier-demo {I.ext("h-3 w-3")}</a></dd></div>
        <div className="flex justify-between gap-2"><dt className="text-slate-500">Buyer account</dt><dd className="font-mono text-[11.5px] text-slate-700">{short(BUYER, 8, 6)}</dd></div>
        <div className="flex justify-between gap-2 border-t border-slate-200/70 pt-2"><dt className="text-slate-500">Price</dt><dd className="font-semibold text-slate-900">1.00 EUDemo <span className="font-normal text-slate-400">· network fee 0</span></dd></div>
      </dl>

      <div className="mt-4">
        <div className="mb-1.5 text-[12px] font-medium text-slate-600">Scenario</div>
        <div className="grid grid-cols-2 gap-1 rounded-xl bg-slate-100 p-1 text-[12.5px] font-medium">
          <button onClick={() => setMode("normal")} className={`rounded-lg px-3 py-1.5 transition ${!isFail ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-700"}`}>Real hire</button>
          <button onClick={() => isFail || setMode("delivery_fail")} className={`rounded-lg px-3 py-1.5 transition ${isFail ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-700"}`}>Simulate a failure</button>
        </div>
        {isFail && (
          <select value={mode} onChange={(e) => setMode(e.target.value)} className="mt-2 w-full rounded-lg border-0 bg-white px-3 py-2 text-[13px] text-slate-800 ring-1 ring-slate-200 focus:ring-2 focus:ring-indigo-500">
            {failModes.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
        )}
      </div>

      <button onClick={onHire} disabled={busy || !serverReady || !agentOk}
        className="group mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-b from-indigo-500 to-indigo-600 px-4 py-3 text-[14px] font-semibold text-white shadow-lg shadow-indigo-600/25 ring-1 ring-indigo-700/40 transition hover:from-indigo-500 hover:to-indigo-700 disabled:cursor-not-allowed disabled:opacity-50">
        {busy ? <><Spinner /> Job running…</> : <>{I.bolt("h-4 w-4")} Hire ClientScope · 1 EUDemo</>}
      </button>
      <p className="mt-2.5 text-center text-[11.5px] leading-relaxed text-slate-400">
        {!serverReady ? "Starting the job server…" : !agentOk ? "Waiting for a valid badge check" : "Payment is held, and only released after the delivery check passes."}
      </p>
      <div className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-[11.5px] leading-relaxed text-amber-800 ring-1 ring-amber-200/60">
        <span className="font-semibold">Demo buyer agent.</span> The buyer's key is held by a demo agent on the server, which signs the challenge and payment. In production the buyer signs in their own Concordium wallet.
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ step tracker */
function StepIcon({ s, i }) {
  const base = "grid h-8 w-8 shrink-0 place-items-center rounded-full text-[12px] font-semibold ring-1 transition";
  if (s.status === "done") return <div className={`${base} bg-emerald-500 text-white ring-emerald-600`}>{I.check("h-4 w-4")}</div>;
  if (s.status === "failed") return <div className={`${base} bg-rose-500 text-white ring-rose-600`}>{I.x("h-4 w-4")}</div>;
  if (s.status === "running") return <div className={`${base} pulse-ring bg-indigo-600 text-white ring-indigo-700`}><Spinner c="h-4 w-4" /></div>;
  if (s.status === "skipped" && s.protected) return <div className={`${base} bg-amber-50 text-amber-600 ring-amber-300`}>{I.shield("h-4 w-4")}</div>;
  if (s.status === "skipped") return <div className={`${base} bg-slate-50 text-slate-300 ring-slate-200`}>–</div>;
  return <div className={`${base} bg-white text-slate-400 ring-slate-200`}>{i + 1}</div>;
}

function Duration({ s }) {
  if (!s.at || !s.ended || s.status === "skipped") return null;
  const d = (new Date(s.ended) - new Date(s.at)) / 1000;
  return <span className="font-mono text-[11px] text-slate-400">{d < 1 ? "<1s" : `${d.toFixed(0)}s`}</span>;
}

function Checks({ items, failed }) {
  const [open, setOpen] = useState(false);
  const bad = items.filter((x) => !x.ok).length;
  const show = open || failed;
  return (
    <div className="mt-2">
      <button onClick={() => setOpen(!open)} className={`inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-[11px] font-medium ring-1 transition ${bad ? "bg-rose-50 text-rose-700 ring-rose-200" : "bg-emerald-50 text-emerald-700 ring-emerald-200 hover:bg-emerald-100"}`}>
        {bad ? I.x("h-3 w-3") : I.check("h-3 w-3")}
        {bad ? `${bad} of ${items.length} checks failed` : `${items.length} checks passed`}
        {!failed && <span className="text-slate-400">{open ? "· hide" : "· show"}</span>}
      </button>
      {show && (
        <ul className="mt-2 grid gap-x-4 gap-y-1 sm:grid-cols-2">
          {items.map((it, j) => (
            <li key={j} className="flex items-start gap-1.5 text-[11.5px] leading-snug text-slate-500">
              <span className={`mt-px ${it.ok ? "text-emerald-500" : "text-rose-500"}`}>{it.ok ? I.check("h-3.5 w-3.5") : I.x("h-3.5 w-3.5")}</span>
              <span>{it.text}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function StepTracker({ steps }) {
  return (
    <ol className="relative">
      {steps.map((s, i) => {
        const last = i === steps.length - 1;
        const items = (s.items || []).filter((x) => typeof x === "object");
        const active = s.status !== "pending";
        return (
          <li key={s.key} className="relative flex gap-4 pb-5">
            {!last && <div className={`absolute left-4 top-9 -ml-px h-[calc(100%-2.5rem)] w-0.5 rounded ${s.status === "done" ? "bg-emerald-300" : s.status === "failed" ? "bg-rose-200" : "bg-slate-200"}`} />}
            <StepIcon s={s} i={i} />
            <div className="min-w-0 flex-1 pt-1">
              <div className="flex items-center justify-between gap-3">
                <div className={`text-[14px] font-semibold ${active ? "text-slate-900" : "text-slate-400"}`}>
                  {s.title}
                  {s.status === "skipped" && s.protected && <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide text-amber-700">Not charged</span>}
                </div>
                <Duration s={s} />
              </div>
              <div className={`mt-0.5 text-[12.5px] leading-relaxed ${s.status === "failed" ? "text-rose-600" : active ? "text-slate-600" : "text-slate-400"}`}>{s.detail || s.hint}</div>
              {s.url && <a href={s.url} target="_blank" rel="noreferrer" className="mt-1 inline-flex items-center gap-1 text-[12px] font-medium text-indigo-600 hover:underline">{I.sheet("h-3.5 w-3.5")} Open sheet {I.ext("h-3 w-3")}</a>}
              {s.tx && <a href={EXPLORER + s.tx} target="_blank" rel="noreferrer" className="mt-1 inline-flex items-center gap-1 font-mono text-[11.5px] text-indigo-600 hover:underline">{I.chain("h-3.5 w-3.5")} {short(s.tx, 10, 8)} {I.ext("h-3 w-3")}</a>}
              {items.length > 0 && <Checks items={items} failed={s.status === "failed"} />}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/* ------------------------------------------------------------------ audit log */
const ACTION_TONE = (a) =>
  /fail|not_taken|refus|reject/.test(a) ? "bg-rose-50 text-rose-700 ring-rose-200"
  : /payment|fee|settle/.test(a) ? "bg-violet-50 text-violet-700 ring-violet-200"
  : /anchor/.test(a) ? "bg-sky-50 text-sky-700 ring-sky-200"
  : /badge|verified|approved|card_hash/.test(a) ? "bg-emerald-50 text-emerald-700 ring-emerald-200"
  : "bg-slate-50 text-slate-700 ring-slate-200";

function linkify(text) {
  const parts = text.split(/(https:\/\/\S+)/g);
  return parts.map((p, i) => (p.startsWith("https://") ? <a key={i} href={p} target="_blank" rel="noreferrer" className="text-indigo-600 hover:underline">{p.replace("https://", "").slice(0, 42)}…</a> : p));
}

function AuditLog({ rows, source, running, outcome }) {
  return (
    <section className="rounded-2xl bg-white shadow-sm ring-1 ring-slate-900/5">
      <header className="flex items-center justify-between border-b border-slate-100 px-5 py-3.5">
        <div>
          <h3 className="text-[14px] font-semibold text-slate-900">Audit Log</h3>
          <p className="text-[12px] text-slate-500">Every step is written to the sheet, then its fingerprint is anchored on chain.</p>
        </div>
        {rows.length > 0 && (
          <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium ring-1 ${source === "sheet" ? "bg-emerald-50 text-emerald-700 ring-emerald-200" : "bg-indigo-50 text-indigo-700 ring-indigo-200"}`}>
            <span className={`h-1.5 w-1.5 rounded-full ${source === "sheet" ? "bg-emerald-500" : "bg-indigo-500 animate-pulse"}`} />
            {source === "sheet" ? "Read back from the sheet" : "Live from the agent"} · {rows.length} rows
          </span>
        )}
      </header>
      {rows.length === 0 ? (
        <div className="px-5 py-10 text-center text-[13px] text-slate-400">
          {outcome === "buyer_rejected" || outcome === "agent_refused"
            ? "No job was started, so no sheet or Audit Log exists. The refusal happened before any payment."
            : running ? "Waiting for the first entry…" : "Rows appear here as the agent works."}
        </div>
      ) : (
        <div className="max-h-[420px] overflow-auto">
          <table className="w-full table-fixed text-left text-[12px]">
            <thead className="sticky top-0 z-10 bg-slate-50/95 text-[10.5px] uppercase tracking-wider text-slate-500 backdrop-blur">
              <tr><th className="w-10 px-3 py-2 font-semibold">#</th><th className="w-[88px] px-2 py-2 font-semibold">Time (UTC)</th><th className="w-[170px] px-2 py-2 font-semibold">Action</th><th className="px-2 py-2 font-semibold">Detail</th></tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((r, i) => (
                <tr key={i + r[1] + r[0]} className="row-in align-top hover:bg-slate-50/60">
                  <td className="px-3 py-2 font-mono text-[11px] text-slate-400">{i + 1}</td>
                  <td className="px-2 py-2 font-mono text-[11px] text-slate-500">{(r[0] || "").slice(11, 19)}</td>
                  <td className="px-2 py-2"><span className={`inline-block rounded-md px-1.5 py-0.5 font-mono text-[11px] font-medium ring-1 ${ACTION_TONE(r[1] || "")}`}>{r[1]}</span></td>
                  <td className="break-words px-2 py-2 font-mono text-[11px] leading-relaxed text-slate-600">{linkify(r[2] || "")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ result */
function BalanceRow({ name, b, a }) {
  if (!b || !a) return null;
  const dE = (Number(a.eudemoAtomic) - Number(b.eudemoAtomic)) / 1e6;
  const dC = (Number(a.ccdMicro) - Number(b.ccdMicro)) / 1e6;
  const d = (v, u) => <span className={v === 0 ? "text-slate-400" : v > 0 ? "text-emerald-600" : "text-rose-600"}>{v === 0 ? "no change" : `${v > 0 ? "+" : ""}${v.toLocaleString("en-GB", { maximumFractionDigits: 6 })} ${u}`}</span>;
  return (
    <tr className="border-t border-slate-100">
      <td className="py-1.5 pr-3 font-medium text-slate-700">{name}</td>
      <td className="py-1.5 pr-3 font-mono text-[11.5px] text-slate-500">{amt(b.eudemoAtomic)} → {amt(a.eudemoAtomic)}</td>
      <td className="py-1.5 pr-3 font-mono text-[11.5px]">{d(dE, "EUDemo")}</td>
      <td className="py-1.5 font-mono text-[11.5px]">{d(dC, "CCD")}</td>
    </tr>
  );
}

function Result({ run }) {
  if (!run || run.status === "running") return null;
  const r = run.result || {};
  const ok = run.outcome === "delivered_paid";
  const bal = r.balances;
  const title = { delivered_paid: "Delivered, then paid", delivery_failed: "Delivery failed, so you were not charged", buyer_rejected: "Buyer not verified, job refused before any payment", agent_refused: "Agent badge not valid, so the buyer refused to hire", error: "Something went wrong, nothing was charged" }[run.outcome] || "Finished";
  const sub = ok
    ? "The sheet passed the delivery check, then the sponsor co-signed and submitted the 1 EUDemo payment. The Audit Log fingerprint is anchored on Concordium."
    : run.outcome === "delivery_failed"
      ? "The signed payment was discarded and never submitted. The failure itself is still recorded in the Audit Log and anchored on chain."
      : run.outcome === "error"
        ? `${r.error_detail ? r.error_detail + ". " : ""}No payment was submitted, and only ClientScope's sponsor can submit one.${bal ? " Balances were read back from the chain to prove it." : ""}`
        : "No sheet, no payment and no transaction. Balances were read back from the chain to prove it.";
  return (
    <section className={`overflow-hidden rounded-2xl shadow-sm ring-1 ${ok ? "bg-white ring-emerald-200" : "bg-white ring-amber-200"}`}>
      <div className={`flex items-start gap-4 px-5 py-4 ${ok ? "bg-gradient-to-r from-emerald-50 to-white" : "bg-gradient-to-r from-amber-50 to-white"}`}>
        <div className={`grid h-11 w-11 shrink-0 place-items-center rounded-xl ${ok ? "bg-emerald-600 text-white" : "bg-amber-500 text-white"}`}>{ok ? I.check("h-6 w-6") : I.shield("h-6 w-6")}</div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-[16px] font-semibold text-slate-900">{title}</h3>
            {ok ? <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-semibold text-emerald-700">Paid 1.00 EUDemo · fee 0</span>
              : <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-800">{bal || run.outcome !== "error" ? "Charged 0 EUDemo · 0 CCD" : "Nothing submitted"}</span>}
            {r.receipt_verified && <span className="rounded-full bg-sky-100 px-2 py-0.5 text-[11px] font-semibold text-sky-700">Receipt re-verified: VALID</span>}
          </div>
          <p className="mt-1 text-[13px] leading-relaxed text-slate-600">{sub}</p>
        </div>
      </div>
      {(r.sheet_url || r.payment_tx || r.anchor_tx) && <div className="grid gap-3 px-5 py-4 sm:grid-cols-3">
        {r.sheet_url && <LinkTile icon={I.sheet("h-5 w-5")} label={ok ? "Finished Google Sheet" : "Sheet with the failure log"} value="Open in Google Sheets" href={r.sheet_url} />}
        {r.payment_tx && <LinkTile icon={I.chain("h-5 w-5")} label="Payment transaction" value={short(r.payment_tx, 10, 8)} href={r.payment_tx_url} mono />}
        {r.anchor_tx && <LinkTile icon={I.shield("h-5 w-5")} label="Audit Log anchor" value={short(r.anchor_tx, 10, 8)} href={r.anchor_tx_url} mono />}
      </div>}
      {bal && (
        <div className="border-t border-slate-100 px-5 py-3.5">
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-[.12em] text-slate-400">Balances read back from the chain</div>
          <table className="w-full text-left text-[12.5px]"><tbody>
            <BalanceRow name="Buyer" b={bal.before.client} a={bal.after.client} />
            <BalanceRow name="ClientScope" b={bal.before.clientscope} a={bal.after.clientscope} />
            <BalanceRow name="Fee sponsor (ClientScope)" b={bal.before.sponsor} a={bal.after.sponsor} />
          </tbody></table>
        </div>
      )}
    </section>
  );
}

function LinkTile({ icon, label, value, href, mono }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="group flex items-center gap-3 rounded-xl bg-slate-50 px-3.5 py-3 ring-1 ring-slate-200/70 transition hover:bg-indigo-50 hover:ring-indigo-200">
      <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-white text-indigo-600 ring-1 ring-slate-200">{icon}</div>
      <div className="min-w-0">
        <div className="text-[11px] font-medium text-slate-500">{label}</div>
        <div className={`truncate text-[12.5px] font-semibold text-slate-900 group-hover:text-indigo-700 ${mono ? "font-mono" : ""}`}>{value}</div>
      </div>
      <span className="ml-auto text-slate-300 group-hover:text-indigo-500">{I.ext("h-4 w-4")}</span>
    </a>
  );
}

/* ------------------------------------------------------------------ console */
function Console({ lines }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => { if (open && ref.current) ref.current.scrollTop = ref.current.scrollHeight; }, [lines, open]);
  return (
    <section className="overflow-hidden rounded-2xl bg-ink-900 shadow-sm ring-1 ring-slate-900/10">
      <button onClick={() => setOpen(!open)} className="flex w-full items-center justify-between px-5 py-3 text-left">
        <span className="text-[13px] font-semibold text-slate-200">Agent console <span className="ml-2 font-normal text-slate-500">{lines.length} lines · buyer agent and ClientScope server</span></span>
        <span className="text-[12px] text-slate-400">{open ? "Hide" : "Show"}</span>
      </button>
      {open && (
        <div ref={ref} className="max-h-72 overflow-auto border-t border-white/5 px-5 py-3 font-mono text-[11px] leading-relaxed">
          {lines.map((l, i) => (
            <div key={i} className="whitespace-pre-wrap"><span className={l.src === "buyer" ? "text-sky-400" : "text-violet-400"}>{l.src === "buyer" ? "buyer  " : "server "}</span><span className="text-slate-300">{l.line}</span></div>
          ))}
        </div>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ app */
function useElapsed(run) {
  const [, tick] = useState(0);
  useEffect(() => { if (run?.status !== "running") return; const t = setInterval(() => tick((x) => x + 1), 1000); return () => clearInterval(t); }, [run?.status]);
  if (!run) return null;
  const end = run.finished ? new Date(run.finished) : new Date();
  return Math.max(0, Math.round((end - new Date(run.started)) / 1000));
}

export default function App() {
  const [agent, setAgent] = useState(null);
  const [agentErr, setAgentErr] = useState(null);
  const [agentLoading, setAgentLoading] = useState(false);
  const [health, setHealth] = useState({});
  const [modes, setModes] = useState([{ id: "normal", label: "Normal hire" }]);
  const [mode, setMode] = useState("normal");
  const [run, setRun] = useState(null);
  const [err, setErr] = useState(null);

  const loadAgent = async () => {
    setAgentLoading(true);
    try { const r = await fetch(`${API}/api/agent`); if (!r.ok) throw new Error(); setAgent(await r.json()); setAgentErr(null); }
    catch { setAgentErr(true); } finally { setAgentLoading(false); }
  };
  useEffect(() => {
    loadAgent();
    fetch(`${API}/api/modes`).then((r) => r.json()).then(setModes).catch(() => {});
    const h = () => fetch(`${API}/api/health`).then((r) => r.json()).then(setHealth).catch(() => setHealth({}));
    h(); const t = setInterval(h, 3000);
    const rid = new URLSearchParams(location.search).get("run");
    if (rid) follow(rid);
    return () => clearInterval(t);
  }, []);

  const follow = (id) => {
    const es = new EventSource(`${API}/api/runs/${id}/events`);
    es.onmessage = (e) => setRun(JSON.parse(e.data));
    es.addEventListener("done", () => es.close());
    es.onerror = () => { es.close(); fetch(`${API}/api/runs/${id}`).then((r) => r.json()).then(setRun).catch(() => {}); };
  };
  const hire = async () => {
    setErr(null);
    const r = await fetch(`${API}/api/hire`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode }) });
    if (!r.ok) { setErr((await r.json().catch(() => ({}))).detail || "Could not start the job"); return; }
    const { run_id } = await r.json();
    history.replaceState(null, "", `?run=${run_id}`);
    setRun({ id: run_id, status: "running", steps: IDLE_STEPS, audit: [], console: [], result: {}, started: new Date().toISOString(), mode });
    follow(run_id);
  };

  const elapsed = useElapsed(run);
  const steps = run?.steps || IDLE_STEPS;
  const doneCount = steps.filter((s) => s.status === "done").length;
  const busy = run?.status === "running" || health.busy;
  const statusChip = !run ? null : run.status === "running" ? <Pill tone="slate" dot>Running · {elapsed}s</Pill>
    : run.outcome === "delivered_paid" ? <Pill tone="green" dot>Delivered and paid · {elapsed}s</Pill> : <Pill tone="amber" dot>Not charged · {elapsed}s</Pill>;

  return (
    <div className="min-h-screen">
      <header className="relative overflow-hidden bg-ink-950">
        <div className="grid-bg absolute inset-0" />
        <div className="absolute -top-40 right-0 h-80 w-[40rem] rounded-full bg-indigo-600/25 blur-3xl" />
        <div className="relative mx-auto max-w-[1280px] px-6">
          <div className="flex items-center justify-between py-4">
            <Logo />
            <div className="flex items-center gap-2">
              <Pill tone={health.x402_server ? "green" : "amber"} dot>{health.x402_server ? "Job server online" : "Job server starting"}</Pill>
              <Pill tone="slate" dot>Concordium testnet</Pill>
            </div>
          </div>
          <div className="flex flex-wrap items-end justify-between gap-6 pb-8 pt-6">
            <div className="max-w-2xl">
              <h1 className="text-[28px] font-semibold leading-tight tracking-tight text-white">Hire an AI agent you can verify,<br /><span className="text-indigo-300">and only pay when the work is delivered.</span></h1>
              <p className="mt-3 text-[14px] leading-relaxed text-slate-400">Both sides prove who they are on Concordium. Payment is held in EUDemo until the delivery check passes, and every step is logged and anchored on chain.</p>
            </div>
            <div className="flex gap-6 text-[12px]">
              {[["Identity", "CIS-8004 badge"], ["Payment", "x402 · EUDemo"], ["Receipts", "Anchored on chain"]].map(([k, v]) => (
                <div key={k}><div className="text-slate-500">{k}</div><div className="mt-0.5 font-medium text-slate-200">{v}</div></div>
              ))}
            </div>
          </div>
        </div>
      </header>

      <main data-run-status={run ? (run.status === "running" ? "running" : (run.finished ? "finished" : "ending")) : "idle"} data-run-outcome={run?.outcome || ""} className="mx-auto -mt-2 grid max-w-[1280px] gap-6 px-6 pb-16 pt-6 lg:grid-cols-[360px_1fr]">
        <aside className="space-y-6">
          <AgentCard agent={agent} error={agentErr} loading={agentLoading} onRefresh={loadAgent} />
          <HireCard modes={modes} mode={mode} setMode={setMode} onHire={hire} busy={busy} serverReady={health.x402_server} agentOk={agent?.verified || mode === "bad_card"} />
          {err && <div className="rounded-xl bg-rose-50 px-4 py-3 text-[13px] text-rose-700 ring-1 ring-rose-200">{err}</div>}
        </aside>

        <div className="min-w-0 space-y-6">
          <section className="rounded-2xl bg-white shadow-sm ring-1 ring-slate-900/5">
            <header className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-5 py-3.5">
              <div>
                <h3 className="text-[14px] font-semibold text-slate-900">Job progress</h3>
                <p className="text-[12px] text-slate-500">
                  {run ? <>Job <span className="font-mono text-slate-700">{run.job_id || "…"}</span> · {run.mode_label || "Normal hire"} · started {fmtTime(run.started)} UK</> : "No job yet. Press Hire to start one."}
                </p>
              </div>
              <div className="flex items-center gap-3">
                <div className="hidden items-center gap-2 sm:flex">
                  <div className="h-1.5 w-32 overflow-hidden rounded-full bg-slate-100"><div className={`h-full rounded-full transition-all duration-700 ${run?.status === "failed" ? "bg-amber-400" : "bg-emerald-500"}`} style={{ width: `${(doneCount / steps.length) * 100}%` }} /></div>
                  <span className="font-mono text-[11px] text-slate-400">{doneCount}/{steps.length}</span>
                </div>
                {statusChip && <div className="[&>span]:bg-slate-900 [&>span]:text-white [&>span]:ring-slate-900">{statusChip}</div>}
              </div>
            </header>
            <div className="px-5 pt-5"><StepTracker steps={steps} /></div>
          </section>

          <Result run={run} />
          <AuditLog rows={run?.audit || []} source={run?.audit_source} running={run?.status === "running"} outcome={run?.outcome} />
          {run && <Console lines={run.console || []} />}
        </div>
      </main>
    </div>
  );
}
