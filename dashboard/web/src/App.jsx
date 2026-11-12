import { useEffect, useRef, useState } from "react";
import { AnimatePresence, LayoutGroup, motion } from "framer-motion";
import {
  ArrowUpRight, BadgeCheck, Bot, Check, ChevronDown, CircleCheck, FileSpreadsheet, FlaskConical, HandCoins, Link2,
  LoaderCircle, Lock, Minus, Receipt, RotateCw, ScrollText, ShieldAlert, ShieldCheck, ShieldX, Sparkles, Store,
  Terminal, UserCheck, X, Zap,
} from "lucide-react";

const API = (import.meta.env.VITE_API_BASE || "").replace(/\/$/, "");
const EXPLORER = "https://ccdexplorer.io/testnet/transaction/";
const SUPPLIER = "https://henry-n41.github.io/clientscope-supplier-demo/";
const BUYER = "4j6RhVCWEG3GDQcwcgSQRxu7nmXSC4V834YrsVtudomCG6ueMH";
const EASE = [0.22, 1, 0.36, 1];

/* Plain-English labels shown in the tracker. The back end still sends its own detail for each step. */
const STEP_COPY = {
  badge: ["Check the agent's badge", "The buyer confirms ClientScope's identity badge on Concordium."],
  buyer: ["Verify the buyer", "ClientScope checks the buyer is real and allowed to pay."],
  hold: ["Hold the payment", "The buyer signs 1 EUDemo. It is held, not sent."],
  scrape: ["Read the supplier page", "Prices and stock are collected from the supplier's site."],
  sheet: ["Build the Google Sheet", "Products and an Audit Log go into a new Sheet."],
  delivery: ["Check the delivery", "Every row must be complete and match the supplier page."],
  settle: ["Release the payment", "Payment is sent only after the delivery check passes."],
  anchor: ["Anchor the receipt", "The log's fingerprint is stored on Concordium for good."],
};
const STEP_KEYS = Object.keys(STEP_COPY);
const IDLE_STEPS = STEP_KEYS.map((key) => ({ key, status: "pending", items: [] }));

const MODE_COPY = {
  delivery_fail: "Broken supplier page, so the delivery check fails",
  impostor: "An impostor tries to hire using the wrong key",
  not_allowlisted: "A buyer who is not approved to pay in EUDemo",
  bad_card: "The agent's ID card has been tampered with",
};

const short = (s, a = 8, b = 6) => (s && s.length > a + b + 1 ? `${s.slice(0, a)}…${s.slice(-b)}` : s || "");
const fmtTime = (iso) => (iso ? new Date(iso).toLocaleTimeString("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "");
const amt = (atomic, d = 6) => (Number(atomic) / 10 ** d).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 6 });

const fadeUp = { hidden: { opacity: 0, y: 16 }, show: { opacity: 1, y: 0, transition: { duration: 0.7, ease: EASE } } };
const stagger = { hidden: {}, show: { transition: { staggerChildren: 0.08, delayChildren: 0.05 } } };

/* ------------------------------------------------------------------ small parts */
function Logo() {
  return (
    <div className="flex items-center gap-2.5">
      <div className="relative grid h-8 w-8 place-items-center rounded-[10px] bg-gradient-to-br from-violet-400 via-indigo-500 to-sky-500 shadow-[0_0_24px_-4px_rgba(139,124,255,.7)]">
        <svg viewBox="0 0 32 32" className="h-[18px] w-[18px]"><circle cx="14" cy="14" r="7" fill="none" stroke="white" strokeWidth="3" /><path d="M19.5 19.5 25 25" stroke="white" strokeWidth="3" strokeLinecap="round" /></svg>
      </div>
      <span className="text-[15px] font-semibold tracking-tight text-white">ClientScope</span>
    </div>
  );
}

function Pill({ tone = "zinc", children, dot, pulse }) {
  const tones = {
    zinc: "bg-white/[.04] text-zinc-300 ring-white/10",
    green: "bg-emerald-400/10 text-emerald-300 ring-emerald-400/25",
    amber: "bg-amber-400/10 text-amber-200 ring-amber-400/25",
    red: "bg-rose-400/10 text-rose-200 ring-rose-400/25",
    violet: "bg-violet-400/10 text-violet-200 ring-violet-400/25",
  };
  const dots = { zinc: "bg-zinc-400", green: "bg-emerald-400", amber: "bg-amber-400", red: "bg-rose-400", violet: "bg-violet-400" };
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-[11.5px] font-medium ring-1 ${tones[tone]}`}>
      {dot && (
        <span className="relative flex h-1.5 w-1.5">
          {pulse && <span className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-70 ${dots[tone]}`} />}
          <span className={`relative inline-flex h-1.5 w-1.5 rounded-full ${dots[tone]}`} />
        </span>
      )}
      {children}
    </span>
  );
}

const Spin = ({ c = "h-4 w-4" }) => <LoaderCircle className={`${c} animate-spin`} />;

/* ------------------------------------------------------------------ hero */
const FEATURES = [
  [BadgeCheck, "Verified agent", "Its identity badge is checked live on Concordium before every job.", "from-violet-500/20 text-violet-300"],
  [HandCoins, "Pay on delivery", "Your payment is held, and only released once the work passes its checks.", "from-emerald-500/20 text-emerald-300"],
  [Receipt, "Tamper-proof receipt", "Every step is logged, and the log's fingerprint is stored on chain.", "from-sky-500/20 text-sky-300"],
  [UserCheck, "Verified buyers only", "Unknown or fake buyers are turned away before anything runs.", "from-amber-500/20 text-amber-200"],
];

function BadgePill({ agent, error }) {
  const ok = agent?.verified;
  return (
    <motion.a variants={fadeUp} href={agent?.owner_url || "#"} target="_blank" rel="noreferrer"
      className="group inline-flex items-center gap-2 rounded-full bg-white/[.04] py-1 pl-1 pr-3 text-[12.5px] ring-1 ring-white/10 backdrop-blur transition hover:bg-white/[.07]">
      <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11.5px] font-semibold ${ok ? "bg-emerald-400/15 text-emerald-300" : agent ? "bg-rose-400/15 text-rose-300" : "bg-white/10 text-zinc-300"}`}>
        <span className="relative flex h-1.5 w-1.5">
          <span className={`absolute inline-flex h-full w-full rounded-full opacity-75 ${ok ? "animate-ping bg-emerald-400" : agent ? "bg-rose-400" : "animate-ping bg-zinc-400"}`} />
          <span className={`relative inline-flex h-1.5 w-1.5 rounded-full ${ok ? "bg-emerald-400" : agent ? "bg-rose-400" : "bg-zinc-400"}`} />
        </span>
        {ok ? "Live" : agent ? "Alert" : error ? "Offline" : "Checking"}
      </span>
      <span className="text-zinc-300">{ok ? "Verified by Concordium" : agent ? "Badge not valid" : error ? "Couldn't reach the Concordium registry" : "Checking the agent's badge…"}</span>
      <span className="text-zinc-500">· Agent #{agent?.token_id || "1010"}</span>
    </motion.a>
  );
}

function Hero({ agent, agentErr }) {
  return (
    <motion.section variants={stagger} initial="hidden" animate="show" className="mx-auto max-w-[1100px] px-5 pb-10 pt-10 text-center sm:px-6 sm:pt-14">
      <BadgePill agent={agent} error={agentErr} />
      <motion.h1 variants={fadeUp} className="mx-auto mt-6 max-w-3xl text-[32px] font-semibold leading-[1.1] tracking-[-0.035em] text-white sm:text-[54px]">
        Hire an AI agent for one job.<br /><span className="text-gradient">Pay only when it delivers.</span>
      </motion.h1>
      <motion.p variants={fadeUp} className="mx-auto mt-5 max-w-xl text-[15.5px] leading-relaxed text-zinc-400 sm:text-[17px]">
        ClientScope does the work, checks its own delivery, and only then takes payment. Every step is logged and can be checked by anyone on Concordium.
      </motion.p>
      <motion.div variants={stagger} className="mx-auto mt-9 grid max-w-[1040px] grid-cols-1 gap-3 text-left sm:grid-cols-2 lg:grid-cols-4">
        {FEATURES.map(([Icon, title, text, tone]) => (
          <motion.div key={title} variants={fadeUp} whileHover={{ y: -4 }} transition={{ type: "spring", stiffness: 300, damping: 22 }}
            className="card group flex items-start gap-3 rounded-2xl p-3.5 transition-colors hover:border-white/15 sm:block sm:p-4">
            <div className={`grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-gradient-to-br to-transparent ring-1 ring-white/10 ${tone}`}><Icon className="h-[18px] w-[18px]" strokeWidth={1.8} /></div>
            <div className="min-w-0">
              <div className="text-[14px] font-semibold tracking-tight text-zinc-100 sm:mt-3">{title}</div>
              <p className="mt-0.5 text-[12.5px] leading-relaxed text-zinc-400 sm:mt-1 sm:text-[13px]">{text}</p>
            </div>
          </motion.div>
        ))}
      </motion.div>
    </motion.section>
  );
}

/* ------------------------------------------------------------------ new job */
function Credential({ ok, loading, children }) {
  return (
    <div className="flex items-center gap-2 text-[12.5px] text-zinc-300">
      {loading ? <Spin c="h-3.5 w-3.5 text-zinc-500" /> : ok ? <Check className="h-3.5 w-3.5 text-emerald-400" strokeWidth={2.5} /> : <X className="h-3.5 w-3.5 text-rose-400" strokeWidth={2.5} />}
      <span>{children}</span>
    </div>
  );
}

function NewJob({ agent, agentErr, agentLoading, onRefresh, modes, mode, setMode, onHire, busy, starting, serverReady, err }) {
  const failModes = modes.filter((m) => m.id !== "normal");
  const isFail = mode !== "normal";
  const agentOk = agent?.verified || mode === "bad_card";
  const disabled = busy || starting || !serverReady || !agentOk;
  return (
    <motion.section layout="position" transition={{ duration: 0.5, ease: EASE }} className="card card-hero overflow-hidden rounded-3xl">
      <div className="p-5 sm:p-7">
        <div className="grid items-start gap-4 sm:grid-cols-[minmax(0,1fr)_auto]">
          <div className="flex items-start gap-3.5">
            <div className="hidden h-11 w-11 shrink-0 place-items-center rounded-2xl sm:grid bg-gradient-to-br from-emerald-400/25 to-sky-500/10 text-emerald-300 ring-1 ring-white/10"><FileSpreadsheet className="h-5 w-5" strokeWidth={1.8} /></div>
            <div className="min-w-0">
              <div className="text-[11px] font-semibold uppercase tracking-[.16em] text-violet-300/80">New job</div>
              <h2 className="mt-1 text-[20px] font-semibold tracking-tight text-white sm:text-[22px]">Supplier price list to Google Sheet</h2>
              <p className="mt-1 text-[14px] leading-relaxed text-zinc-400">ClientScope reads a supplier's live prices and stock, and puts them in a new Google Sheet with a full log of what it did.</p>
            </div>
          </div>
          <div className="flex items-center gap-3 rounded-2xl bg-black/25 px-4 py-2.5 ring-1 ring-white/[.06] sm:block sm:text-right">
            <div className="text-[11px] font-medium text-zinc-500">Price</div>
            <div className="text-[22px] font-semibold leading-tight tracking-tight text-white">1 <span className="text-[14px] font-medium text-zinc-400">EUDemo</span></div>
            <div className="text-[11px] text-zinc-500">Test euro token, no fee</div>
          </div>
        </div>

        <div className="mt-6 grid gap-3 sm:grid-cols-2">
          <div className="rounded-2xl bg-black/20 p-4 ring-1 ring-white/[.06]">
            <div className="mb-2.5 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[.14em] text-zinc-500"><Store className="h-3.5 w-3.5" /> The job</div>
            <dl className="space-y-2 text-[13px]">
              <div className="flex justify-between gap-3"><dt className="text-zinc-500">Client</dt><dd className="font-medium text-zinc-200">Northgate Supplies (demo)</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-zinc-500">Supplier page</dt><dd><a className="inline-flex items-center gap-1 font-medium text-violet-300 hover:text-violet-200" href={SUPPLIER} target="_blank" rel="noreferrer">Open page <ArrowUpRight className="h-3.5 w-3.5" /></a></dd></div>
              <div className="flex justify-between gap-3"><dt className="text-zinc-500">You get</dt><dd className="font-medium text-zinc-200">A Google Sheet in your Drive</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-zinc-500">Buyer account</dt><dd className="font-mono text-[12px] text-zinc-400">{short(BUYER, 6, 4)}</dd></div>
            </dl>
          </div>
          <div className="rounded-2xl bg-black/20 p-4 ring-1 ring-white/[.06]">
            <div className="mb-2.5 flex items-center justify-between">
              <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[.14em] text-zinc-500"><ShieldCheck className="h-3.5 w-3.5" /> The agent</div>
              <button onClick={onRefresh} title="Check again now" className="rounded-md p-1 text-zinc-500 transition hover:bg-white/5 hover:text-zinc-300">
                {agentLoading ? <Spin c="h-3.5 w-3.5" /> : <RotateCw className="h-3.5 w-3.5" />}
              </button>
            </div>
            {agentErr && !agent ? (
              <div className="text-[12.5px] leading-relaxed text-rose-300">Couldn't reach the Concordium registry to check the badge. Press the refresh button to try again.</div>
            ) : (
              <div className="space-y-2">
                <Credential ok={agent?.badge_valid} loading={!agent}>{agent ? `Badge valid, ${agent.checks_passed} of ${agent.checks_total} registry checks passed` : "Checking the badge…"}</Credential>
                <Credential ok={agent?.hash_match} loading={!agent}>{agent ? (agent.hash_match ? "ID card matches the one on chain" : "ID card does not match the chain") : "Comparing the ID card…"}</Credential>
                <Credential ok={agent?.status === "Active"} loading={!agent}>{agent ? `Status on chain: ${agent.status || "unknown"}` : "Reading the status…"}</Credential>
                {agent && <div className="pt-0.5 text-[11.5px] text-zinc-500">Checked {fmtTime(agent.checked_at)} UK time</div>}
              </div>
            )}
          </div>
        </div>

        <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="grid grid-cols-2 gap-1 rounded-xl bg-black/30 p-1 text-[12.5px] font-medium ring-1 ring-white/[.06] sm:inline-grid sm:text-[13px]">
            {[["normal", "Real hire", Zap], ["fail", "Simulate a failure", FlaskConical]].map(([id, label, Icon]) => {
              const on = id === "normal" ? !isFail : isFail;
              return (
                <button key={id} onClick={() => (id === "normal" ? setMode("normal") : isFail || setMode("delivery_fail"))}
                  className={`relative flex items-center justify-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 py-1.5 sm:px-3.5 transition-colors ${on ? "text-white" : "text-zinc-500 hover:text-zinc-300"}`}>
                  {on && <motion.span layoutId="seg" className="absolute inset-0 rounded-lg bg-white/10 ring-1 ring-white/10" transition={{ type: "spring", stiffness: 400, damping: 32 }} />}
                  <Icon className="relative h-3.5 w-3.5" /><span className="relative">{label}</span>
                </button>
              );
            })}
          </div>
          <AnimatePresence initial={false}>
            {isFail && (
              <motion.div initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -8 }} className="relative sm:min-w-[320px]">
                <select value={mode} onChange={(e) => setMode(e.target.value)}
                  className="w-full appearance-none rounded-xl bg-black/30 py-2 pl-3 pr-9 text-[13px] text-zinc-200 outline-none ring-1 ring-white/10 focus:ring-2 focus:ring-violet-400/60">
                  {failModes.map((m) => <option key={m.id} value={m.id}>{MODE_COPY[m.id] || m.label}</option>)}
                </select>
                <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        <motion.button onClick={onHire} disabled={disabled} whileHover={disabled ? {} : { y: -1 }} whileTap={disabled ? {} : { scale: 0.985 }}
          className="btn-shine relative mt-4 flex w-full items-center justify-center gap-2 overflow-hidden rounded-2xl bg-gradient-to-r from-violet-500 via-indigo-500 to-sky-500 px-5 py-4 text-[15px] font-semibold text-white shadow-[0_10px_40px_-10px_rgba(124,108,255,.8)] ring-1 ring-white/20 transition-[filter,opacity] hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-45 disabled:shadow-none">
          {busy || starting ? <><Spin /> Job running…</> : <><Zap className="h-4 w-4" fill="currentColor" /> Hire ClientScope · 1 EUDemo</>}
        </motion.button>
        <p className="mt-3 flex items-center justify-center gap-1.5 text-center text-[12.5px] text-zinc-500">
          <Lock className="h-3.5 w-3.5" />
          {!serverReady ? "Starting the job server…" : !agentOk ? "Waiting for a valid badge check" : isFail ? "Demo of a failure. You will not be charged." : "Your payment is held, and only released after the delivery check passes."}
        </p>
        <AnimatePresence>
          {err && (
            <motion.div initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="mt-3 flex items-start gap-2 rounded-xl bg-amber-400/10 px-3.5 py-2.5 text-[13px] text-amber-200 ring-1 ring-amber-400/25">
              <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" /><span>{err}</span>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      <div className="flex items-start gap-2 border-t border-white/[.06] bg-black/20 px-5 py-3 text-[12px] leading-relaxed text-zinc-500 sm:px-7">
        <Bot className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>This demo uses a test buyer that signs on the server. In a live setup, each client signs from their own Concordium wallet. Everything runs on the Concordium test network, so no real money moves.</span>
      </div>
    </motion.section>
  );
}

/* ------------------------------------------------------------------ step tracker */
function StepIcon({ s, i }) {
  const base = "relative z-10 grid h-7 w-7 shrink-0 place-items-center rounded-full text-[11px] font-semibold ring-1 transition-colors duration-500";
  if (s.status === "done") return <motion.div initial={{ scale: 0.6 }} animate={{ scale: 1 }} className={`${base} bg-emerald-500 text-white ring-emerald-400/60 shadow-[0_0_16px_-2px_rgba(16,185,129,.7)]`}><Check className="h-3.5 w-3.5" strokeWidth={3} /></motion.div>;
  if (s.status === "failed") return <motion.div initial={{ scale: 0.6 }} animate={{ scale: 1 }} className={`${base} bg-rose-500 text-white ring-rose-400/60`}><X className="h-3.5 w-3.5" strokeWidth={3} /></motion.div>;
  if (s.status === "running") return <div className={`${base} pulse-ring bg-violet-500 text-white ring-violet-300/60`}><Spin c="h-3.5 w-3.5" /></div>;
  if (s.status === "skipped" && s.protected) return <div className={`${base} bg-amber-400/15 text-amber-300 ring-amber-400/40`}><ShieldCheck className="h-3.5 w-3.5" /></div>;
  if (s.status === "skipped") return <div className={`${base} bg-ink-900 text-zinc-600 ring-white/10`}><Minus className="h-3 w-3" /></div>;
  return <div className={`${base} bg-ink-900 text-zinc-500 ring-white/10`}>{i + 1}</div>;
}

function Duration({ s }) {
  if (!s.at || !s.ended || s.status === "skipped") return null;
  const d = (new Date(s.ended) - new Date(s.at)) / 1000;
  return <span className="font-mono text-[10.5px] text-zinc-600">{d < 1 ? "<1s" : `${d.toFixed(0)}s`}</span>;
}

function Checks({ items, failed }) {
  const [open, setOpen] = useState(false);
  const bad = items.filter((x) => !x.ok).length;
  const show = open || failed;
  return (
    <div className="mt-1.5">
      <button onClick={() => setOpen(!open)} className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium ring-1 transition ${bad ? "bg-rose-400/10 text-rose-300 ring-rose-400/25" : "bg-emerald-400/10 text-emerald-300 ring-emerald-400/20 hover:bg-emerald-400/15"}`}>
        {bad ? <X className="h-3 w-3" /> : <Check className="h-3 w-3" />}
        {bad ? `${bad} of ${items.length} checks failed` : `${items.length} checks passed`}
        {!failed && <ChevronDown className={`h-3 w-3 transition-transform ${open ? "rotate-180" : ""}`} />}
      </button>
      <AnimatePresence initial={false}>
        {show && (
          <motion.ul initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="mt-1.5 space-y-1 overflow-hidden">
            {items.map((it, j) => (
              <li key={j} className="flex items-start gap-1.5 text-[11.5px] leading-snug text-zinc-400">
                <span className={`mt-px ${it.ok ? "text-emerald-400" : "text-rose-400"}`}>{it.ok ? <Check className="h-3 w-3" /> : <X className="h-3 w-3" />}</span>
                <span>{it.text}</span>
              </li>
            ))}
          </motion.ul>
        )}
      </AnimatePresence>
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
        const [title, hint] = STEP_COPY[s.key] || [s.title, s.hint];
        return (
          <motion.li key={s.key} initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.15 + i * 0.05, duration: 0.45, ease: EASE }} className="relative flex gap-3.5 pb-4">
            {!last && (
              <div className="absolute left-[13px] top-8 h-[calc(100%-2.25rem)] w-px overflow-hidden bg-white/10">
                <motion.div className={`w-full ${s.status === "failed" ? "bg-rose-400/50" : "bg-emerald-400/70"}`} initial={false} animate={{ height: s.status === "done" || s.status === "failed" ? "100%" : "0%" }} transition={{ duration: 0.6, ease: EASE }} />
              </div>
            )}
            <StepIcon s={s} i={i} />
            <div className="min-w-0 flex-1 pt-0.5">
              <div className="flex items-center justify-between gap-2">
                <div className={`text-[13.5px] font-medium transition-colors ${active ? "text-zinc-100" : "text-zinc-500"} ${s.status === "skipped" && !s.protected ? "text-zinc-500" : ""}`}>
                  {title}
                  {s.status === "skipped" && s.protected && <span className="ml-2 rounded-full bg-amber-400/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-300">Not charged</span>}
                </div>
                <Duration s={s} />
              </div>
              <div className={`mt-0.5 text-[12px] leading-relaxed ${s.status === "failed" ? "text-rose-300" : active ? "text-zinc-400" : "text-zinc-600"}`}>{s.detail || hint}</div>
              {s.url && <a href={s.url} target="_blank" rel="noreferrer" className="mt-1 inline-flex items-center gap-1 text-[12px] font-medium text-violet-300 hover:text-violet-200"><FileSpreadsheet className="h-3.5 w-3.5" /> Open sheet <ArrowUpRight className="h-3 w-3" /></a>}
              {s.tx && <a href={EXPLORER + s.tx} target="_blank" rel="noreferrer" className="mt-1 flex items-center gap-1 font-mono text-[11px] text-violet-300 hover:text-violet-200"><Link2 className="h-3.5 w-3.5" /> {short(s.tx, 8, 6)} <ArrowUpRight className="h-3 w-3" /></a>}
              {items.length > 0 && <Checks items={items} failed={s.status === "failed"} />}
            </div>
          </motion.li>
        );
      })}
    </ol>
  );
}

/* ------------------------------------------------------------------ progress sidebar */
const OUTCOME_TITLE = {
  delivered_paid: "Delivered, then paid",
  delivery_failed: "Delivery failed, so you weren't charged",
  buyer_rejected: "Buyer not verified, so the job was refused",
  agent_refused: "Agent badge not valid, so the buyer walked away",
  error: "Something went wrong, and nothing was charged",
};

function Progress({ run, elapsed }) {
  const steps = run.steps?.length ? run.steps : IDLE_STEPS;
  const doneCount = steps.filter((s) => s.status === "done").length;
  const running = run.status === "running";
  const ok = run.outcome === "delivered_paid";
  const chip = running ? <Pill tone="violet" dot pulse>Running · {elapsed}s</Pill>
    : ok ? <Pill tone="green" dot>Delivered and paid · {elapsed}s</Pill> : <Pill tone="amber" dot>Not charged · {elapsed}s</Pill>;
  return (
    <section className="card overflow-hidden rounded-3xl">
      <header className="border-b border-white/[.06] px-5 pb-4 pt-5">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-[14px] font-semibold text-white"><Sparkles className="h-4 w-4 text-violet-300" /> Job progress</div>
          {chip}
        </div>
        <p className="mt-1 text-[12px] text-zinc-500">
          Job <span className="font-mono text-zinc-400">{run.job_id || "…"}</span> · {run.mode === "normal" ? "Real hire" : MODE_COPY[run.mode] || run.mode_label} · started {fmtTime(run.started)} UK
        </p>
        <div className="mt-3 flex items-center gap-2.5">
          <div className="h-1 flex-1 overflow-hidden rounded-full bg-white/[.06]">
            <motion.div className={`h-full rounded-full ${run.status === "failed" ? "bg-gradient-to-r from-amber-400 to-amber-300" : "bg-gradient-to-r from-violet-400 via-sky-400 to-emerald-400"}`}
              initial={{ width: 0 }} animate={{ width: `${(doneCount / steps.length) * 100}%` }} transition={{ duration: 0.8, ease: EASE }} />
          </div>
          <span className="font-mono text-[10.5px] text-zinc-500">{doneCount}/{steps.length}</span>
        </div>
      </header>
      <div className="px-5 pt-4"><StepTracker steps={steps} /></div>
    </section>
  );
}

function Side({ run, elapsed }) {
  const done = run.status !== "running";
  return (
    <div className="flex flex-col gap-5">
      {done && <Result run={run} />}
      <Progress run={run} elapsed={elapsed} />
    </div>
  );
}

function LinkTile({ icon: Icon, label, value, href, mono }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="group flex items-center gap-3 rounded-xl bg-white/[.03] px-3 py-2.5 ring-1 ring-white/[.07] transition hover:-translate-y-px hover:bg-white/[.06] hover:ring-violet-400/30">
      <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-violet-400/10 text-violet-300 ring-1 ring-violet-400/20"><Icon className="h-4 w-4" /></div>
      <div className="min-w-0">
        <div className="text-[11px] text-zinc-500">{label}</div>
        <div className={`truncate text-[12.5px] font-medium text-zinc-100 ${mono ? "font-mono" : ""}`}>{value}</div>
      </div>
      <ArrowUpRight className="ml-auto h-4 w-4 shrink-0 text-zinc-600 transition group-hover:text-violet-300" />
    </a>
  );
}

function BalanceRow({ name, b, a }) {
  if (!b || !a) return null;
  const dE = (Number(a.eudemoAtomic) - Number(b.eudemoAtomic)) / 1e6;
  const dC = (Number(a.ccdMicro) - Number(b.ccdMicro)) / 1e6;
  const d = (v, u) => <span className={v === 0 ? "text-zinc-500" : v > 0 ? "text-emerald-300" : "text-rose-300"}>{v === 0 ? "no change" : `${v > 0 ? "+" : ""}${v.toLocaleString("en-GB", { maximumFractionDigits: 6 })} ${u}`}</span>;
  return (
    <div className="flex items-start justify-between gap-3 py-2">
      <div>
        <div className="text-[12.5px] font-medium text-zinc-200">{name}</div>
        <div className="font-mono text-[10.5px] text-zinc-500">{amt(b.eudemoAtomic)} → {amt(a.eudemoAtomic)} EUDemo</div>
      </div>
      <div className="text-right font-mono text-[11px] leading-5">{d(dE, "EUDemo")}<br />{d(dC, "CCD")}</div>
    </div>
  );
}

function Result({ run }) {
  if (!run || run.status === "running") return null;
  const r = run.result || {};
  const ok = run.outcome === "delivered_paid";
  const bal = r.balances;
  const title = OUTCOME_TITLE[run.outcome] || "Finished";
  const sub = ok
    ? "The Sheet passed the delivery check, so the 1 EUDemo payment was released. The log's fingerprint is now stored on Concordium."
    : run.outcome === "delivery_failed"
      ? "The signed payment was thrown away and never sent. The failure is still logged and its fingerprint stored on chain."
      : run.outcome === "error"
        ? `${r.error_detail ? r.error_detail + ". " : ""}No payment was sent, and only ClientScope's fee sponsor can send one.${bal ? " Balances were read back from the chain to prove it." : ""}`
        : "No Sheet, no payment and no transaction. Balances were read back from the chain to prove it.";
  return (
    <motion.section initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, ease: EASE }}
      className={`card overflow-hidden rounded-3xl ${ok ? "!border-emerald-400/25" : "!border-amber-400/25"}`}>
      <div className={`relative px-5 py-5 ${ok ? "bg-gradient-to-br from-emerald-500/15 via-transparent to-transparent" : "bg-gradient-to-br from-amber-500/15 via-transparent to-transparent"}`}>
        <div className="flex items-start gap-3">
          <motion.div initial={{ scale: 0.5, rotate: -10 }} animate={{ scale: 1, rotate: 0 }} transition={{ type: "spring", stiffness: 260, damping: 16, delay: 0.1 }}
            className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl ${ok ? "bg-emerald-500 text-white shadow-[0_0_24px_-4px_rgba(16,185,129,.8)]" : "bg-amber-400 text-ink-950 shadow-[0_0_24px_-6px_rgba(251,191,36,.8)]"}`}>
            {ok ? <CircleCheck className="h-5 w-5" /> : <ShieldCheck className="h-5 w-5" />}
          </motion.div>
          <div className="min-w-0">
            <h3 className="text-[15.5px] font-semibold leading-snug tracking-tight text-white">{title}</h3>
            <p className="mt-1 text-[12.5px] leading-relaxed text-zinc-400">{sub}</p>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {ok ? <Pill tone="green">Paid 1.00 EUDemo · no fee for you</Pill>
            : <Pill tone="amber">{bal || run.outcome !== "error" ? "Charged 0 EUDemo · 0 CCD" : "Nothing sent"}</Pill>}
          {r.receipt_verified && <Pill tone="violet"><BadgeCheck className="h-3 w-3" /> Receipt checked: valid</Pill>}
        </div>
      </div>
      {(r.sheet_url || r.payment_tx || r.anchor_tx) && (
        <div className="space-y-2 border-t border-white/[.06] px-5 py-4">
          {r.sheet_url && <LinkTile icon={FileSpreadsheet} label={ok ? "Your finished Google Sheet" : "Sheet with the failure log"} value="Open in Google Sheets" href={r.sheet_url} />}
          {r.payment_tx && <LinkTile icon={HandCoins} label="Payment on Concordium" value={short(r.payment_tx, 10, 8)} href={r.payment_tx_url} mono />}
          {r.anchor_tx && <LinkTile icon={Receipt} label="Receipt stored on Concordium" value={short(r.anchor_tx, 10, 8)} href={r.anchor_tx_url} mono />}
        </div>
      )}
      {bal && (
        <div className="border-t border-white/[.06] px-5 py-3">
          <div className="text-[10.5px] font-semibold uppercase tracking-[.14em] text-zinc-500">Balances read back from the chain</div>
          <div className="divide-y divide-white/[.05]">
            <BalanceRow name="Buyer" b={bal.before.client} a={bal.after.client} />
            <BalanceRow name="ClientScope" b={bal.before.clientscope} a={bal.after.clientscope} />
            <BalanceRow name="Fee sponsor (ClientScope)" b={bal.before.sponsor} a={bal.after.sponsor} />
          </div>
        </div>
      )}
    </motion.section>
  );
}

/* ------------------------------------------------------------------ delivered products */
function Products({ rows }) {
  if (!rows || rows.length < 2) return null;
  const [head, ...body] = rows;
  const tone = (v) => (/out/i.test(v) ? "bg-rose-400/10 text-rose-300 ring-rose-400/20" : /low/i.test(v) ? "bg-amber-400/10 text-amber-200 ring-amber-400/20" : "bg-emerald-400/10 text-emerald-300 ring-emerald-400/20");
  return (
    <motion.section initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, ease: EASE }} className="card overflow-hidden rounded-3xl">
      <header className="flex items-center justify-between border-b border-white/[.06] px-5 py-4 sm:px-6">
        <div>
          <h3 className="flex items-center gap-2 text-[14px] font-semibold text-white"><FileSpreadsheet className="h-4 w-4 text-emerald-300" /> What was delivered</h3>
          <p className="mt-0.5 text-[12px] text-zinc-500">The Products tab of your new Sheet, {body.length} rows.</p>
        </div>
      </header>
      <div className="thin-scroll overflow-x-auto">
        <table className="w-full min-w-[520px] text-left text-[12.5px]">
          <thead className="text-[10.5px] uppercase tracking-wider text-zinc-500"><tr>{head.slice(0, 4).map((h) => <th key={h} className="px-5 py-2.5 font-semibold sm:px-6">{h}</th>)}</tr></thead>
          <tbody className="divide-y divide-white/[.05]">
            {body.map((row) => (
              <tr key={row[0]} className="text-zinc-300 hover:bg-white/[.02]">
                <td className="px-5 py-2.5 font-mono text-[11.5px] text-zinc-500 sm:px-6">{row[0]}</td>
                <td className="px-5 py-2.5 sm:px-6">{row[1]}</td>
                <td className="px-5 py-2.5 font-mono sm:px-6">£{Number(row[2]).toFixed(2)}</td>
                <td className="px-5 py-2.5 sm:px-6"><span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ${tone(row[3])}`}>{row[3]}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </motion.section>
  );
}

/* ------------------------------------------------------------------ audit log */
const ACTION_TONE = (a) =>
  /fail|not_taken|refus|reject/.test(a) ? "bg-rose-400/10 text-rose-300 ring-rose-400/20"
  : /payment|fee|settle/.test(a) ? "bg-violet-400/10 text-violet-300 ring-violet-400/20"
  : /anchor/.test(a) ? "bg-sky-400/10 text-sky-300 ring-sky-400/20"
  : /badge|verified|approved|card_hash/.test(a) ? "bg-emerald-400/10 text-emerald-300 ring-emerald-400/20"
  : "bg-white/[.04] text-zinc-300 ring-white/10";

function linkify(text) {
  return text.split(/(https:\/\/\S+)/g).map((p, i) => (p.startsWith("https://") ? <a key={i} href={p} target="_blank" rel="noreferrer" className="text-violet-300 hover:underline">{p.replace("https://", "").slice(0, 42)}…</a> : p));
}

function AuditLog({ rows, source, running, outcome, hasRun }) {
  return (
    <motion.section layout="position" transition={{ duration: 0.5, ease: EASE }} className="card overflow-hidden rounded-3xl">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-white/[.06] px-5 py-4 sm:px-6">
        <div>
          <h3 className="flex items-center gap-2 text-[14px] font-semibold text-white"><ScrollText className="h-4 w-4 text-sky-300" /> Audit Log</h3>
          <p className="mt-0.5 text-[12px] text-zinc-500">Every step is written into your Sheet, then its fingerprint is stored on Concordium.</p>
        </div>
        {rows.length > 0 && <Pill tone={source === "sheet" ? "green" : "violet"} dot pulse={source !== "sheet"}>{source === "sheet" ? "Read back from the Sheet" : "Live from the agent"} · {rows.length} rows</Pill>}
      </header>
      {rows.length === 0 ? (
        <div className="flex flex-col items-center px-6 py-12 text-center">
          <div className="grid h-12 w-12 place-items-center rounded-2xl bg-white/[.04] text-zinc-500 ring-1 ring-white/[.08]">
            {running ? <Spin c="h-5 w-5" /> : <ScrollText className="h-5 w-5" />}
          </div>
          <div className="mt-3 text-[14px] font-medium text-zinc-300">
            {outcome === "buyer_rejected" || outcome === "agent_refused" ? "Nothing to log" : running ? "Waiting for the first entry…" : "Nothing logged yet"}
          </div>
          <p className="mt-1 max-w-sm text-[13px] leading-relaxed text-zinc-500">
            {outcome === "buyer_rejected" || outcome === "agent_refused"
              ? "The hire was refused before any payment, so no Sheet or log was created."
              : hasRun ? "Entries appear here as the agent works." : "Hire ClientScope and each step it takes will appear here as it happens."}
          </p>
        </div>
      ) : (
        <div className="thin-scroll max-h-[440px] overflow-auto">
          <table className="w-full min-w-[640px] table-fixed text-left text-[12px]">
            <thead className="sticky top-0 z-10 bg-ink-850/95 text-[10.5px] uppercase tracking-wider text-zinc-500 backdrop-blur">
              <tr><th className="w-10 px-4 py-2.5 font-semibold sm:pl-6">#</th><th className="w-[84px] px-2 py-2.5 font-semibold">Time (UTC)</th><th className="w-[176px] px-2 py-2.5 font-semibold">Action</th><th className="px-2 py-2.5 pr-5 font-semibold">Detail</th></tr>
            </thead>
            <tbody className="divide-y divide-white/[.04]">
              {rows.map((r, i) => (
                <tr key={i + r[1] + r[0]} className="row-in align-top hover:bg-white/[.02]">
                  <td className="px-4 py-2.5 font-mono text-[11px] text-zinc-600 sm:pl-6">{i + 1}</td>
                  <td className="px-2 py-2.5 font-mono text-[11px] text-zinc-500">{(r[0] || "").slice(11, 19)}</td>
                  <td className="px-2 py-2.5"><span className={`inline-block max-w-full truncate rounded-md px-1.5 py-0.5 font-mono text-[10.5px] font-medium ring-1 ${ACTION_TONE(r[1] || "")}`}>{r[1]}</span></td>
                  <td className="break-words px-2 py-2.5 pr-5 font-mono text-[11px] leading-relaxed text-zinc-400">{linkify(r[2] || "")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </motion.section>
  );
}

/* ------------------------------------------------------------------ console */
function Console({ lines }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => { if (open && ref.current) ref.current.scrollTop = ref.current.scrollHeight; }, [lines, open]);
  return (
    <section className="overflow-hidden rounded-2xl bg-black/40 ring-1 ring-white/[.07]">
      <button onClick={() => setOpen(!open)} className="flex w-full items-center justify-between px-5 py-3 text-left sm:px-6">
        <span className="flex items-center gap-2 text-[13px] font-medium text-zinc-300"><Terminal className="h-4 w-4 text-zinc-500" /> Technical console <span className="font-normal text-zinc-600">· {lines.length} lines</span></span>
        <ChevronDown className={`h-4 w-4 text-zinc-500 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ height: 0 }} animate={{ height: "auto" }} exit={{ height: 0 }} className="overflow-hidden">
            <div ref={ref} className="thin-scroll max-h-72 overflow-auto border-t border-white/5 px-5 py-3 font-mono text-[11px] leading-relaxed sm:px-6">
              {lines.map((l, i) => (
                <div key={i} className="whitespace-pre-wrap"><span className={l.src === "buyer" ? "text-sky-400" : "text-violet-400"}>{l.src === "buyer" ? "buyer  " : "server "}</span><span className="text-zinc-400">{l.line}</span></div>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
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

function Background() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-[900px] overflow-hidden">
      <div className="dot-grid absolute inset-0" />
      <div className="aurora-a absolute -top-48 left-[12%] h-[520px] w-[620px] rounded-full bg-violet-600/25 blur-[120px]" />
      <div className="aurora-b absolute -top-32 right-[8%] h-[460px] w-[560px] rounded-full bg-sky-500/15 blur-[120px]" />
      <div className="aurora-a absolute top-[320px] left-1/2 h-[300px] w-[520px] -translate-x-1/2 rounded-full bg-emerald-500/[.07] blur-[110px]" />
    </div>
  );
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
  const [starting, setStarting] = useState(false);
  const sideRef = useRef(null);

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
    es.onerror = () => { es.close(); fetch(`${API}/api/runs/${id}`).then((r) => (r.ok ? r.json() : null)).then((d) => d && setRun(d)).catch(() => {}); };
  };
  const hire = async () => {
    setErr(null); setStarting(true);
    try {
      const r = await fetch(`${API}/api/hire`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode }) });
      if (!r.ok) {
        const detail = (await r.json().catch(() => ({}))).detail;
        setErr(r.status === 409 ? "Another hire is already running. Please try again in a moment." : detail ? `Couldn't start the job: ${detail}` : "Couldn't start the job. Please try again.");
        return;
      }
      const { run_id } = await r.json();
      history.replaceState(null, "", `?run=${run_id}`);
      setRun({ id: run_id, status: "running", steps: IDLE_STEPS, audit: [], console: [], result: {}, started: new Date().toISOString(), mode });
      follow(run_id);
      if (window.innerWidth < 1024) setTimeout(() => sideRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 350);
    } catch { setErr("Couldn't reach the server. Check your connection and try again."); }
    finally { setStarting(false); }
  };

  const elapsed = useElapsed(run);
  const busy = run?.status === "running" || health.busy;
  const hasRun = !!run;

  return (
    <div className="relative min-h-screen overflow-x-hidden text-zinc-200">
      <Background />

      <nav className="relative z-10 border-b border-white/[.06] bg-ink-950/40 backdrop-blur-xl">
        <div className="mx-auto flex max-w-[1240px] items-center justify-between gap-3 px-5 py-3.5 sm:px-6">
          <Logo />
          <div className="flex items-center gap-2">
            <Pill tone={health.x402_server ? "green" : "amber"} dot pulse={!!health.x402_server}>{health.x402_server ? "Job server online" : "Job server starting"}</Pill>
            <span className="hidden sm:inline-flex"><Pill tone="zinc" dot>Concordium testnet</Pill></span>
          </div>
        </div>
      </nav>

      <div className="relative z-10">
        <Hero agent={agent} agentErr={agentErr} />

        <LayoutGroup>
          <main data-run-status={run ? (run.status === "running" ? "running" : (run.finished ? "finished" : "ending")) : "idle"} data-run-outcome={run?.outcome || ""}
            className={`mx-auto grid items-start gap-5 px-5 pb-20 sm:px-6 ${hasRun ? "max-w-[1240px] lg:grid-cols-[minmax(0,1fr)_400px]" : "max-w-[860px]"}`}>
            <div className="flex min-w-0 flex-col gap-5">
              <NewJob agent={agent} agentErr={agentErr} agentLoading={agentLoading} onRefresh={loadAgent} modes={modes} mode={mode} setMode={setMode}
                onHire={hire} busy={busy} starting={starting} serverReady={health.x402_server} err={err} />
              {/* on narrow screens the progress sits right under New Job */}
              {hasRun && <div ref={sideRef} className="scroll-mt-4 lg:hidden"><Side run={run} elapsed={elapsed} /></div>}
              {run?.result?.products && <Products rows={run.result.products} />}
              <AuditLog rows={run?.audit || []} source={run?.audit_source} running={run?.status === "running"} outcome={run?.outcome} hasRun={hasRun} />
              {run && <Console lines={run.console || []} />}
            </div>

            <AnimatePresence>
              {hasRun && (
                <motion.aside key="side" initial={{ opacity: 0, x: 48 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 48 }} transition={{ duration: 0.6, ease: EASE }}
                  className="hidden min-w-0 lg:block">
                  <Side run={run} elapsed={elapsed} />
                </motion.aside>
              )}
            </AnimatePresence>
          </main>
        </LayoutGroup>

        <footer className="border-t border-white/[.06] py-6 text-center text-[12px] text-zinc-600">
          ClientScope runs on the Concordium test network. Built for the Encode Club and Concordium Trusted Agents hackathon.
        </footer>
      </div>
    </div>
  );
}
