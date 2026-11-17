import { useEffect, useRef, useState } from "react";
import { AnimatePresence, LayoutGroup, motion } from "framer-motion";
import {
  ArrowUpRight, BadgeCheck, Bot, Check, ChevronDown, CircleCheck, FileSpreadsheet, FlaskConical, HandCoins, Link2,
  LoaderCircle, Lock, Minus, Receipt, RotateCw, ScrollText, ShieldAlert, ShieldCheck, ShieldX, Sparkles, Store,
  Terminal, UserCheck, X, Zap, Wallet, Mail, FileText, PenLine, LineChart, PackageSearch, CalendarClock,
  Power, OctagonX, Siren, Globe, Undo2, ShieldOff,
} from "lucide-react";
import { INSTALL_URL, useWallet } from "./wallet.js";

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
const WALLET_STEP_COPY = {
  ...STEP_COPY,
  buyer: ["Verify you", "ClientScope checks your wallet signature and account on Concordium."],
  hold: ["Sign the order", "You confirm the job and price in your wallet. Nothing is paid yet."],
  settle: ["Approve the payment", "After delivery passes, you approve 1 EUDemo in your wallet."],
};
const STEP_KEYS = Object.keys(STEP_COPY);
const IDLE_STEPS = STEP_KEYS.map((key) => ({ key, status: "pending", items: [] }));

const MODE_COPY = {
  delivery_fail: "Broken supplier page, so the delivery check fails",
  impostor: "An impostor tries to hire using the wrong key",
  not_allowlisted: "A buyer who is not approved to pay in EUDemo",
  bad_card: "The agent's ID card has been tampered with",
  unregistered_buyer: "A real, approved buyer account with no registered agent",
  fake_supplier: "A fake ClientScope copies the real ID card but has the wrong key",
  kill_switch: "Live kill switch: the buyer's owner revokes its agent in the middle of the job",
  lookalike_supplier: "A lookalike supplier site with a real badge but the wrong website",
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
  [HandCoins, "Pay on delivery", "You only pay once the work has passed its checks.", "from-emerald-500/20 text-emerald-300"],
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

/* ------------------------------------------------------------------ jobs */
function Credential({ ok, loading, children }) {
  return (
    <div className="flex items-center gap-2 text-[12.5px] text-zinc-300">
      {loading ? <Spin c="h-3.5 w-3.5 text-zinc-500" /> : ok ? <Check className="h-3.5 w-3.5 text-emerald-400" strokeWidth={2.5} /> : <X className="h-3.5 w-3.5 text-rose-400" strokeWidth={2.5} />}
      <span>{children}</span>
    </div>
  );
}

function Segmented({ value, onChange, options, id }) {
  return (
    <div className="grid grid-cols-2 gap-1 rounded-xl bg-black/30 p-1 text-[12.5px] font-medium ring-1 ring-white/[.06] sm:inline-grid sm:text-[13px]">
      {options.map(([v, label, Icon]) => {
        const on = v === value;
        return (
          <button key={v} type="button" onClick={() => onChange(v)}
            className={`relative flex items-center justify-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 py-1.5 transition-colors sm:px-3.5 ${on ? "text-white" : "text-zinc-500 hover:text-zinc-300"}`}>
            {on && <motion.span layoutId={id} className="absolute inset-0 rounded-lg bg-white/10 ring-1 ring-white/10" transition={{ type: "spring", stiffness: 400, damping: 32 }} />}
            <Icon className="relative h-3.5 w-3.5" /><span className="relative">{label}</span>
          </button>
        );
      })}
    </div>
  );
}

function HireButton({ onClick, disabled, busy, children }) {
  return (
    <motion.button onClick={onClick} disabled={disabled} whileHover={disabled ? {} : { y: -1 }} whileTap={disabled ? {} : { scale: 0.985 }}
      className="btn-shine relative flex w-full items-center justify-center gap-2 overflow-hidden rounded-2xl bg-gradient-to-r from-violet-500 via-indigo-500 to-sky-500 px-5 py-4 text-[15px] font-semibold text-white shadow-[0_10px_40px_-10px_rgba(124,108,255,.8)] ring-1 ring-white/20 transition-[filter,opacity] hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-45 disabled:shadow-none">
      {busy ? <><Spin /> Job running…</> : children}
    </motion.button>
  );
}

function WalletPanel({ wallet, onConnect, connecting, onUseDemo }) {
  if (wallet.status === "checking") return <div className="flex items-center gap-2 rounded-2xl bg-black/20 px-4 py-3.5 text-[13px] text-zinc-400 ring-1 ring-white/[.06]"><Spin c="h-4 w-4" /> Looking for the Concordium Browser Wallet…</div>;
  if (wallet.status === "missing") return (
    <div className="rounded-2xl bg-black/20 p-4 ring-1 ring-white/[.06]" data-wallet="missing">
      <div className="flex items-start gap-3">
        <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-amber-400/10 text-amber-300 ring-1 ring-amber-400/20"><Wallet className="h-[18px] w-[18px]" /></div>
        <div className="min-w-0">
          <div className="text-[14px] font-semibold text-zinc-100">Concordium Browser Wallet not found</div>
          <p className="mt-0.5 text-[12.5px] leading-relaxed text-zinc-400">To hire with your own account, add the Concordium Wallet extension to Chrome, Edge or Brave, switch it to Testnet, then reload this page.</p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <a href={INSTALL_URL} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 rounded-lg bg-white/10 px-3 py-1.5 text-[12.5px] font-medium text-white ring-1 ring-white/15 transition hover:bg-white/15">Install the wallet <ArrowUpRight className="h-3.5 w-3.5" /></a>
            <button onClick={onUseDemo} className="rounded-lg px-3 py-1.5 text-[12.5px] font-medium text-violet-300 transition hover:bg-white/5 hover:text-violet-200">Try with a demo buyer instead</button>
          </div>
        </div>
      </div>
    </div>
  );
  if (wallet.status === "connected") return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-black/20 px-4 py-3 ring-1 ring-white/[.06]" data-wallet="connected">
      <div className="flex items-center gap-3">
        <div className="relative grid h-9 w-9 place-items-center rounded-full bg-gradient-to-br from-violet-400 to-sky-500 text-white"><Wallet className="h-4 w-4" />
          <span className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full bg-emerald-400 ring-2 ring-ink-900" /></div>
        <div>
          <div className="text-[11.5px] text-zinc-500">Connected wallet</div>
          <div className="font-mono text-[13px] font-medium text-zinc-100">{short(wallet.account, 6, 6)}</div>
        </div>
      </div>
      {wallet.testnet ? <Pill tone="green" dot>Testnet</Pill> : <Pill tone="amber" dot>Switch your wallet to Testnet</Pill>}
    </div>
  );
  return (
    <div className="rounded-2xl bg-black/20 p-4 ring-1 ring-white/[.06]" data-wallet="disconnected">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-violet-400/10 text-violet-300 ring-1 ring-violet-400/20"><Wallet className="h-[18px] w-[18px]" /></div>
          <div>
            <div className="text-[14px] font-semibold text-zinc-100">Connect your Concordium wallet</div>
            <p className="mt-0.5 text-[12.5px] leading-relaxed text-zinc-400">You'll need a Testnet account on the EUDemo allow list, holding at least 1 EUDemo.</p>
          </div>
        </div>
        <button onClick={onConnect} disabled={connecting} className="inline-flex items-center gap-2 rounded-xl bg-white px-4 py-2 text-[13px] font-semibold text-ink-950 shadow-lg shadow-black/30 transition hover:bg-zinc-200 disabled:opacity-60">
          {connecting ? <Spin c="h-4 w-4" /> : <Wallet className="h-4 w-4" />} Connect wallet
        </button>
      </div>
    </div>
  );
}

function SupplierJob({ agent, agentErr, agentLoading, onRefresh, modes, mode, setMode, payWith, setPayWith, wallet, onConnect, connecting,
  onHire, onHireWallet, busy, starting, serverReady, err, prompt }) {
  const failModes = modes.filter((m) => m.id !== "normal" && m.id !== "kill_switch");
  const hasKill = modes.some((m) => m.id === "kill_switch");
  const isKill = mode === "kill_switch";
  const isFail = mode !== "normal" && !isKill;
  const agentOk = agent?.verified || (payWith === "demo" && mode === "bad_card");
  const walletReady = wallet.status === "connected" && wallet.testnet;
  const disabled = busy || starting || !serverReady || !agentOk || (payWith === "wallet" && !walletReady);
  return (
    <div className="space-y-5 px-5 pb-5 sm:px-6 sm:pb-6">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-2xl bg-black/20 p-4 ring-1 ring-white/[.06]">
          <div className="mb-2.5 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[.14em] text-zinc-500"><Store className="h-3.5 w-3.5" /> The job</div>
          <dl className="space-y-2 text-[13px]">
            <div className="flex justify-between gap-3"><dt className="text-zinc-500">Client</dt><dd className="font-medium text-zinc-200">Northgate Supplies (demo)</dd></div>
            <div className="flex justify-between gap-3"><dt className="text-zinc-500">Supplier page</dt><dd><a className="inline-flex items-center gap-1 font-medium text-violet-300 hover:text-violet-200" href={SUPPLIER} target="_blank" rel="noreferrer">Open page <ArrowUpRight className="h-3.5 w-3.5" /></a></dd></div>
            <div className="flex justify-between gap-3"><dt className="shrink-0 text-zinc-500">You get</dt><dd className="text-right font-medium text-zinc-200">A Google Sheet with the results</dd></div>
            <div className="flex justify-between gap-3"><dt className="text-zinc-500">Price</dt><dd className="font-medium text-zinc-200">1 EUDemo, no fee for you</dd></div>
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

      <div>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <div className="text-[12px] font-medium text-zinc-400">Pay with</div>
          <Segmented id="paywith" value={payWith} onChange={setPayWith} options={[["wallet", "Your wallet", Wallet], ["demo", "Demo buyer", Bot]]} />
        </div>
        <AnimatePresence mode="wait" initial={false}>
          {payWith === "wallet" ? (
            <motion.div key="w" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.25 }}>
              <WalletPanel wallet={wallet} onConnect={onConnect} connecting={connecting} onUseDemo={() => setPayWith("demo")} />
            </motion.div>
          ) : (
            <motion.div key="d" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.25 }}
              className="rounded-2xl bg-black/20 p-4 ring-1 ring-white/[.06]">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <Segmented id="scenario" value={isKill ? "kill" : isFail ? "fail" : "normal"} onChange={(v) => setMode(v === "normal" ? "normal" : v === "kill" ? "kill_switch" : isFail ? mode : "delivery_fail")}
                  options={[["normal", "Real hire", Zap], ["fail", "Simulate a failure", FlaskConical], ...(hasKill ? [["kill", "Kill switch", Power]] : [])]} />
                <AnimatePresence initial={false}>
                  {isFail && (
                    <motion.div initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -8 }} className="relative sm:min-w-[300px]">
                      <select value={mode} onChange={(e) => setMode(e.target.value)}
                        className="w-full appearance-none rounded-xl bg-black/30 py-2 pl-3 pr-9 text-[13px] text-zinc-200 outline-none ring-1 ring-white/10 focus:ring-2 focus:ring-violet-400/60">
                        {failModes.map((m) => <option key={m.id} value={m.id}>{MODE_COPY[m.id] || m.label}</option>)}
                      </select>
                      <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
              {isKill && <KillSwitchIntro />}
              <p className="mt-3 flex items-start gap-1.5 text-[12px] leading-relaxed text-zinc-500"><Bot className="mt-0.5 h-3.5 w-3.5 shrink-0" />No wallet needed. A demo buyer account signs on ClientScope's server, so you can see the whole flow. Testnet only, no real money.</p>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <div>
        <HireButton onClick={payWith === "wallet" ? onHireWallet : onHire} disabled={disabled} busy={busy || starting}>
          <Zap className="h-4 w-4" fill="currentColor" /> Hire ClientScope · 1 EUDemo
        </HireButton>
        <p className="mt-3 flex items-center justify-center gap-1.5 text-center text-[12.5px] text-zinc-500">
          <Lock className="h-3.5 w-3.5 shrink-0" />
          {!serverReady ? "Starting the job server…"
            : !agentOk ? "Waiting for a valid badge check"
            : payWith === "wallet" ? (walletReady ? "You sign once to confirm the order, and approve the payment only after the delivery check passes." : wallet.status === "connected" ? "Switch your wallet to Testnet to continue." : wallet.status === "missing" ? "Install the wallet, or try with a demo buyer." : "Connect your wallet to hire.")
            : isKill ? "Press the red button while the rows are being written. Nothing will be charged."
            : isFail ? "Demo of a failure. Nothing will be charged." : "The payment is held, and only released after the delivery check passes."}
        </p>
        <AnimatePresence>
          {prompt && (
            <motion.div initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="mt-3 flex items-center gap-2.5 rounded-xl bg-violet-400/10 px-3.5 py-2.5 text-[13px] text-violet-100 ring-1 ring-violet-400/25">
              <Spin c="h-4 w-4 shrink-0 text-violet-300" /><span>{prompt}</span>
            </motion.div>
          )}
          {err && (
            <motion.div initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="mt-3 flex items-start gap-2 rounded-xl bg-amber-400/10 px-3.5 py-2.5 text-[13px] text-amber-200 ring-1 ring-amber-400/25">
              <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" /><span>{err}</span>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

function Chips({ value, onChange, options }) {
  return (
    <div className="flex flex-wrap gap-2">
      {options.map(([v, label, Icon]) => (
        <button key={v} type="button" onClick={() => onChange(v)}
          className={`inline-flex items-center gap-1.5 rounded-xl px-3 py-2 text-[13px] font-medium ring-1 transition ${value === v ? "bg-violet-400/15 text-white ring-violet-400/50" : "bg-black/20 text-zinc-400 ring-white/[.08] hover:text-zinc-200 hover:ring-white/15"}`}>
          {Icon && <Icon className="h-3.5 w-3.5" />}{label}
        </button>
      ))}
    </div>
  );
}

const field = "w-full rounded-xl bg-black/30 px-3.5 py-2.5 text-[13.5px] text-zinc-100 placeholder:text-zinc-600 outline-none ring-1 ring-white/10 transition focus:ring-2 focus:ring-violet-400/60";

function CustomJob() {
  const [f, setF] = useState({ task: "", sources: "", deliverable: "sheet", frequency: "once", budget: "" });
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState(null);
  const [rec, setRec] = useState(null);
  const set = (k) => (v) => setF((x) => ({ ...x, [k]: v?.target ? v.target.value : v }));
  const submit = async (e) => {
    e.preventDefault(); setErr(null);
    if (f.task.trim().length < 15) { setErr("Please describe the job in a sentence or two."); return; }
    setSending(true);
    try {
      const body = { task: f.task, sources: f.sources, deliverable: f.deliverable, frequency: f.frequency, budget: f.budget ? Number(f.budget) : null };
      const r = await fetch(`${API}/api/custom-jobs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setErr(typeof d.detail === "string" ? d.detail.charAt(0).toUpperCase() + d.detail.slice(1) + "." : "Please check the form and try again."); return; }
      setRec(d);
    } catch { setErr("Couldn't reach ClientScope. Please try again."); }
    finally { setSending(false); }
  };
  if (rec) return <DraftPlan rec={rec} onEdit={() => setRec(null)} onNew={() => { setRec(null); setF({ task: "", sources: "", deliverable: "sheet", frequency: "once", budget: "" }); }} />;
  return (
    <form onSubmit={submit} className="space-y-4 px-5 pb-5 sm:px-6 sm:pb-6" data-custom="form">
      <label className="block">
        <span className="mb-1.5 block text-[12.5px] font-medium text-zinc-300">What do you need done?</span>
        <textarea rows={3} value={f.task} onChange={set("task")} className={field + " resize-none"}
          placeholder="For example: every Monday, collect the prices of my 20 best sellers from my two suppliers and flag anything that went up." />
      </label>
      <label className="block">
        <span className="mb-1.5 block text-[12.5px] font-medium text-zinc-300">Websites or source links <span className="font-normal text-zinc-500">(one per line)</span></span>
        <textarea rows={2} value={f.sources} onChange={set("sources")} className={field + " resize-none font-mono text-[12.5px]"} placeholder={"https://supplier-one.co.uk/prices\nhttps://supplier-two.com/catalogue"} />
      </label>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <span className="mb-1.5 block text-[12.5px] font-medium text-zinc-300">What should you receive?</span>
          <Chips value={f.deliverable} onChange={set("deliverable")} options={[["sheet", "Google Sheet", FileSpreadsheet], ["email", "Email summary", Mail], ["csv", "CSV file", FileText]]} />
        </div>
        <div>
          <span className="mb-1.5 block text-[12.5px] font-medium text-zinc-300">How often?</span>
          <Chips value={f.frequency} onChange={set("frequency")} options={[["once", "Once"], ["daily", "Daily"], ["weekly", "Weekly"]]} />
        </div>
      </div>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <label className="block sm:w-56">
          <span className="mb-1.5 block text-[12.5px] font-medium text-zinc-300">Budget <span className="font-normal text-zinc-500">(optional)</span></span>
          <div className="relative">
            <input type="number" min="0" step="0.5" inputMode="decimal" value={f.budget} onChange={set("budget")} className={field + " pr-20"} placeholder="0" />
            <span className="pointer-events-none absolute right-3.5 top-1/2 -translate-y-1/2 text-[12.5px] text-zinc-500">EUDemo</span>
          </div>
        </label>
        <motion.button type="submit" disabled={sending} whileHover={{ y: -1 }} whileTap={{ scale: 0.985 }}
          className="inline-flex items-center justify-center gap-2 rounded-xl bg-white px-5 py-3 text-[14px] font-semibold text-ink-950 shadow-lg shadow-black/30 transition hover:bg-zinc-200 disabled:opacity-60">
          {sending ? <Spin c="h-4 w-4" /> : <Sparkles className="h-4 w-4" />} Get a draft plan
        </motion.button>
      </div>
      {err && <div className="flex items-start gap-2 rounded-xl bg-amber-400/10 px-3.5 py-2.5 text-[13px] text-amber-200 ring-1 ring-amber-400/25"><ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />{err}</div>}
      <p className="text-[12px] leading-relaxed text-zinc-500">Nothing runs yet. You get a draft plan to review, and ClientScope confirms a fixed price before any work or payment.</p>
    </form>
  );
}

function DraftPlan({ rec, onEdit, onNew }) {
  const p = rec.plan;
  const freq = { once: "One-off job", daily: "Runs daily", weekly: "Runs weekly" }[p.frequency];
  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.45, ease: EASE }} className="space-y-4 px-5 pb-5 sm:px-6 sm:pb-6" data-custom="plan">
      <div className="flex flex-wrap items-center gap-2">
        <Pill tone="violet"><Sparkles className="h-3 w-3" /> Draft plan</Pill>
        <Pill tone="amber" dot pulse>Waiting for ClientScope to confirm</Pill>
        <span className="ml-auto font-mono text-[11px] text-zinc-600">Request {rec.id}</span>
      </div>
      <blockquote className="rounded-2xl bg-black/20 px-4 py-3 text-[13.5px] leading-relaxed text-zinc-300 ring-1 ring-white/[.06]">“{p.summary}”</blockquote>
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
        <div className="rounded-2xl bg-black/20 p-4 ring-1 ring-white/[.06]">
          <div className="mb-3 text-[11px] font-semibold uppercase tracking-[.14em] text-zinc-500">Steps</div>
          <ol className="space-y-2.5">
            {p.steps.map((s, i) => (
              <motion.li key={i} initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.05 * i }} className="flex gap-3">
                <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-white/[.06] text-[11px] font-semibold text-zinc-300 ring-1 ring-white/10">{i + 1}</span>
                <div><div className="text-[13px] font-medium text-zinc-100">{s.title}</div><div className="text-[12px] leading-relaxed text-zinc-400">{s.text}</div></div>
              </motion.li>
            ))}
          </ol>
        </div>
        <div className="space-y-3">
          <div className="rounded-2xl bg-black/20 p-4 ring-1 ring-white/[.06]">
            <div className="mb-2.5 text-[11px] font-semibold uppercase tracking-[.14em] text-zinc-500">What “done” means</div>
            <ul className="space-y-2">
              {p.done_rules.map((r, i) => <li key={i} className="flex items-start gap-2 text-[12.5px] leading-snug text-zinc-300"><CircleCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-400" />{r}</li>)}
            </ul>
          </div>
          <div className="rounded-2xl bg-gradient-to-br from-violet-500/15 to-sky-500/5 p-4 ring-1 ring-violet-400/20">
            <div className="text-[11px] font-semibold uppercase tracking-[.14em] text-violet-200/80">Estimated price</div>
            <div className="mt-1 text-[24px] font-semibold tracking-tight text-white">{p.estimate.amount} <span className="text-[14px] font-medium text-zinc-400">EUDemo per {p.estimate.per}</span></div>
            <div className="mt-1 text-[12px] leading-relaxed text-zinc-400">{p.estimate.note}</div>
            {p.budget_note && <div className="mt-2 text-[12px] leading-relaxed text-amber-200">{p.budget_note}</div>}
          </div>
        </div>
      </div>
      <div className="flex flex-wrap gap-x-6 gap-y-2 text-[12.5px] text-zinc-400">
        <span className="inline-flex items-center gap-1.5"><FileSpreadsheet className="h-3.5 w-3.5 text-zinc-500" />{p.deliverable}</span>
        <span className="inline-flex items-center gap-1.5"><CalendarClock className="h-3.5 w-3.5 text-zinc-500" />{freq}</span>
        {p.sources.length > 0 && <span className="inline-flex items-center gap-1.5"><Link2 className="h-3.5 w-3.5 text-zinc-500" />{p.sources.length} source{p.sources.length > 1 ? "s" : ""}: {[...new Set(p.sources.map((s) => s.kind))].join(", ")}</span>}
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t border-white/[.06] pt-4">
        <button onClick={onEdit} className="rounded-xl bg-white/[.06] px-3.5 py-2 text-[13px] font-medium text-zinc-200 ring-1 ring-white/10 transition hover:bg-white/10">Edit request</button>
        <button onClick={onNew} className="rounded-xl px-3.5 py-2 text-[13px] font-medium text-zinc-400 transition hover:text-zinc-200">Start a new request</button>
        <span className="ml-auto text-[12px] text-zinc-500">Nothing has run and nothing has been charged.</span>
      </div>
    </motion.div>
  );
}

function JobRow({ open, onToggle, icon: Icon, tone, title, text, badge, children, id }) {
  return (
    <motion.div layout="position" transition={{ duration: 0.4, ease: EASE }} data-job={id}
      className={`overflow-hidden rounded-2xl ring-1 transition-colors ${open ? "bg-white/[.035] ring-violet-400/30 shadow-[0_0_0_1px_rgba(139,124,255,.08),0_20px_60px_-30px_rgba(124,108,255,.6)]" : "bg-white/[.015] ring-white/[.07] hover:bg-white/[.03] hover:ring-white/15"}`}>
      <button type="button" onClick={onToggle} className="flex w-full items-center gap-3.5 px-5 py-4 text-left sm:px-6">
        <div className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-gradient-to-br to-transparent ring-1 ring-white/10 ${tone}`}><Icon className="h-[18px] w-[18px]" strokeWidth={1.8} /></div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2"><span className="text-[15px] font-semibold tracking-tight text-white">{title}</span>{badge}</div>
          <p className="mt-0.5 text-[12.5px] leading-relaxed text-zinc-400">{text}</p>
        </div>
        <ChevronDown className={`h-4 w-4 shrink-0 text-zinc-500 transition-transform duration-300 ${open ? "rotate-180" : ""}`} />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.35, ease: EASE }}>
            {children}
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

function JobsPanel({ selected, setSelected, ...p }) {
  const toggle = (k) => setSelected(selected === k ? null : k);
  return (
    <motion.section layout="position" transition={{ duration: 0.5, ease: EASE }} className="card card-hero overflow-hidden rounded-3xl">
      <div className="px-5 pb-4 pt-5 sm:px-7 sm:pt-6">
        <div className="text-[11px] font-semibold uppercase tracking-[.16em] text-violet-300/80">New job</div>
        <h2 className="mt-1 text-[20px] font-semibold tracking-tight text-white sm:text-[22px]">Choose a job</h2>
        <p className="mt-1 text-[14px] text-zinc-400">Hire ClientScope for a ready-made job, or describe your own.</p>
      </div>
      <div className="space-y-3 px-3 pb-3 sm:px-4 sm:pb-4">
        <div className="px-2 pt-1 text-[11px] font-semibold uppercase tracking-[.14em] text-zinc-500">Available now</div>
        <JobRow id="supplier" open={selected === "supplier"} onToggle={() => toggle("supplier")} icon={FileSpreadsheet} tone="from-emerald-400/25 text-emerald-300"
          title="Supplier price list to Google Sheet" text="Reads a supplier's live prices and stock into a new Google Sheet, with a full log of every step."
          badge={<><Pill tone="green" dot pulse>Live</Pill><span className="text-[12px] font-medium text-zinc-400">1 EUDemo</span></>}>
          <SupplierJob {...p} />
        </JobRow>
        <JobRow id="domain" open={selected === "domain"} onToggle={() => toggle("domain")} icon={Globe} tone="from-sky-400/25 text-sky-300"
          title="Domain proof: real supplier vs lookalike" text="Before it reads a supplier's site, ClientScope checks that the website, its Concordium account and its badge all point to each other."
          badge={<Pill tone="green" dot pulse>Live</Pill>}>
          <DomainScene />
        </JobRow>
        <JobRow id="custom" open={selected === "custom"} onToggle={() => toggle("custom")} icon={PenLine} tone="from-violet-400/25 text-violet-300"
          title="Custom job" text="Describe your own task. ClientScope drafts a plan, clear rules for “done” and a price estimate for you to review."
          badge={<Pill tone="violet">Your own task</Pill>}>
          <CustomJob />
        </JobRow>
        <div className="px-2 pt-2 text-[11px] font-semibold uppercase tracking-[.14em] text-zinc-500">Coming soon</div>
        <div className="grid gap-3 sm:grid-cols-2">
          {[[LineChart, "Competitor price watch", "Track rivals' prices and get told when they change."],
            [PackageSearch, "Stock and reorder alerts", "Get told when stock runs low, with a suggested reorder."]].map(([Icon, t, d]) => (
            <div key={t} className="flex items-start gap-3 rounded-2xl bg-white/[.01] px-4 py-3.5 border border-dashed border-white/[.08]">
              <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-white/[.04] text-zinc-500 ring-1 ring-white/[.06]"><Icon className="h-4 w-4" strokeWidth={1.8} /></div>
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-[13.5px] font-medium text-zinc-300">{t}<span className="rounded-full bg-white/[.05] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Soon</span></div>
                <div className="mt-0.5 text-[12px] leading-relaxed text-zinc-500">{d}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="flex items-start gap-2 border-t border-white/[.06] bg-black/20 px-5 py-3 text-[12px] leading-relaxed text-zinc-500 sm:px-7">
        <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>Everything runs on the Concordium test network, so no real money moves. With your wallet, you sign the order first and approve the payment only after the work passes its checks.</span>
      </div>
    </motion.section>
  );
}


/* ------------------------------------------------------------------ DOMAIN PROOF scene */
const DOMAIN_STEPS = [
  ["proof_published", "Site publishes its proof file"],
  ["proof_names_this_site", "Proof is for this exact site"],
  ["proof_signature_valid", "Signed by the account's on-chain key"],
  ["badge_owned_by_account", "Badge is owned by that account"],
  ["badge_valid", "Badge Active, card hash matches chain"],
  ["card_names_this_site", "Badge's card names this site"],
  ["claimed_site_points_back", "The site it claims points back to it"],
];
function DomainColumn({ side, info, state, tamper }) {
  const t = info?.targets?.[side];
  const res = state?.res; const shown = state?.shown ?? 0;
  const steps = res ? res.steps : [];
  const byId = Object.fromEntries(steps.map((x) => [x.id, x]));
  const rows = res ? steps : DOMAIN_STEPS.map(([id, label]) => ({ id, label }));
  const revealed = res && shown >= steps.length;
  const verdict = revealed ? res.verdict : null;
  const tone = verdict === "verified" ? "emerald" : verdict ? "rose" : "zinc";
  const agent = side === "real" ? info?.real_agent : info?.lookalike_agent;
  return (
    <div data-domain-side={side} data-verdict={verdict || (state?.busy ? "checking" : "idle")}
      className={`rounded-2xl p-4 ring-1 transition-colors duration-500 ${verdict === "verified" ? "bg-emerald-500/[.06] ring-emerald-400/30" : verdict ? "bg-rose-500/[.06] ring-rose-400/30" : "bg-black/20 ring-white/[.06]"}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[11px] font-semibold uppercase tracking-[.14em] text-zinc-500">{side === "real" ? "Real supplier" : "Lookalike"}</div>
          <div className="mt-0.5 text-[14px] font-semibold text-white">{side === "real" ? "Northgate Supplies" : "\u201cNorthgate Supplies\u201d"}</div>
          {t && <a href={t.url} target="_blank" rel="noreferrer" className="mt-0.5 block truncate font-mono text-[11px] text-violet-300 hover:text-violet-200">{t.url.replace("https://", "")}</a>}
          {agent?.token_id && <div className="mt-0.5 text-[11.5px] text-zinc-500">Badge #{agent.token_id} · real, Active on Concordium</div>}
        </div>
        {verdict ? <Pill tone={verdict === "verified" ? "green" : verdict === "unproven" ? "amber" : "red"} dot>{verdict === "verified" ? "Verified" : verdict === "unproven" ? "No proof" : "Refused"}</Pill>
          : state?.busy ? <Pill tone="violet" dot pulse>Checking</Pill> : <Pill>Not checked</Pill>}
      </div>
      {side === "real" && tamper && <div className="mt-2 rounded-lg bg-amber-400/10 px-2.5 py-1.5 text-[11.5px] text-amber-200 ring-1 ring-amber-400/25">Tampered: the downloaded proof is changed to point at another badge before it is checked.</div>}
      <div className="mt-3 space-y-1.5">
        {rows.map((x, i) => {
          const r = byId[x.id]; const show = res && i < shown;
          const icon = show ? (r.pass ? <CircleCheck className="h-4 w-4 text-emerald-400" /> : <X className="h-4 w-4 text-rose-400" strokeWidth={3} />)
            : state?.busy ? <Spin c="h-4 w-4 text-zinc-500" /> : <Minus className="h-4 w-4 text-zinc-600" />;
          return (
            <motion.div key={x.id} data-check={x.id} data-pass={show ? String(r.pass) : "pending"} initial={false} animate={{ opacity: show || !res ? 1 : 0.5 }}
              className="flex items-start gap-2 text-[12.5px]">
              <span className="mt-0.5 shrink-0">{icon}</span>
              <span className="min-w-0"><span className={show ? "text-zinc-200" : "text-zinc-500"}>{x.label}</span>
                {show && <span className="block break-words text-[11px] leading-snug text-zinc-500">{r.detail}</span>}</span>
            </motion.div>
          );
        })}
        {res && res.steps.length === 1 && res.verdict !== "verified" && revealed && (
          <div className="text-[11.5px] text-zinc-500">Other checks skipped: there is no proof to check.</div>
        )}
      </div>
      {revealed && (
        <div className="mt-3">
          {state?.anchoring ? <div className="flex items-center gap-2 text-[12px] text-zinc-400"><Spin c="h-3.5 w-3.5" /> Anchoring this verdict on Concordium…</div>
            : res.anchor?.explorer ? <LinkTile icon={Receipt} label={verdict === "verified" ? "Pass anchored on Concordium" : "Refusal anchored on Concordium"} value={short(res.anchor.tx_hash, 10, 8)} href={res.anchor.explorer} mono />
            : state?.anchorErr ? <div className="text-[12px] text-amber-300">Could not anchor this verdict right now.</div> : null}
        </div>
      )}
    </div>
  );
}
function DomainScene() {
  const [info, setInfo] = useState(null);
  const [tamper, setTamper] = useState(false);
  const [st, setSt] = useState({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  useEffect(() => { fetch(`${API}/api/domain/info`).then((r) => (r.ok ? r.json() : null)).then(setInfo).catch(() => {}); }, []);
  const set = (side, patch) => setSt((o) => ({ ...o, [side]: { ...(o[side] || {}), ...patch } }));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const check = async (side, tam) => {
    set(side, { busy: true, res: null, shown: 0, anchoring: false, anchorErr: false });
    const post = (anchor) => fetch(`${API}/api/domain/check`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ target: side, tamper: tam, anchor }) })
      .then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.json(); });
    const t0 = Date.now();
    const res = await post(false);
    set(side, { res, busy: false, ms: Date.now() - t0 });
    for (let i = 1; i <= res.steps.length; i++) { await sleep(420); set(side, { shown: i }); }
    set(side, { anchoring: true });
    try { const a = await post(true); set(side, { res: { ...res, anchor: a.anchor }, anchoring: false, anchorErr: !a.anchor }); }
    catch { set(side, { anchoring: false, anchorErr: true }); }
  };
  const runBoth = async (tam = tamper) => {
    setBusy(true); setErr(null);
    try { await Promise.all([check("real", tam), (async () => { await sleep(150); await check("lookalike", tam); })()]); }
    catch { setErr("The check could not reach the job server. Try again in a moment."); }
    setBusy(false);
  };
  const toggleTamper = async (v) => { setTamper(v); setErr(null); setBusy(true); try { await check("real", v); } catch { setErr("The check could not reach the job server."); } setBusy(false); };
  return (
    <div className="space-y-4 px-5 pb-5 sm:px-6 sm:pb-6" data-domain-scene>
      <p className="text-[12.5px] leading-relaxed text-zinc-400">
        Both sites carry the name Northgate Supplies, and both have a real badge on Concordium's Agent Registry. Only the real one can make its website, its Concordium account and its badge all point to each other.
        ClientScope runs these checks before it reads a supplier page, so a lookalike is refused before anyone pays.
      </p>
      <div className="flex flex-wrap gap-2">
        <button onClick={() => runBoth()} disabled={busy} data-domain-run
          className="flex items-center gap-2 rounded-xl bg-gradient-to-r from-sky-500 to-violet-500 px-4 py-2.5 text-[13.5px] font-semibold text-white shadow-[0_10px_30px_-10px_rgba(56,189,248,.8)] transition hover:brightness-110 disabled:opacity-50">
          {busy ? <Spin c="h-4 w-4" /> : <ShieldCheck className="h-4 w-4" />} Check both sites now
        </button>
        {!tamper ? (
          <button onClick={() => toggleTamper(true)} disabled={busy} data-domain-tamper
            className="flex items-center gap-2 rounded-xl bg-amber-400/10 px-3.5 py-2.5 text-[13px] font-medium text-amber-200 ring-1 ring-amber-400/30 transition hover:bg-amber-400/15 disabled:opacity-50">
            <ShieldAlert className="h-4 w-4" /> Tamper with the real proof
          </button>
        ) : (
          <button onClick={() => toggleTamper(false)} disabled={busy} data-domain-restore
            className="flex items-center gap-2 rounded-xl bg-emerald-400/10 px-3.5 py-2.5 text-[13px] font-medium text-emerald-200 ring-1 ring-emerald-400/30 transition hover:bg-emerald-400/15 disabled:opacity-50">
            <Undo2 className="h-4 w-4" /> Restore the real proof
          </button>
        )}
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <DomainColumn side="real" info={info} state={st.real} tamper={tamper} />
        <DomainColumn side="lookalike" info={info} state={st.lookalike} />
      </div>
      {err && <div className="flex items-start gap-2 rounded-xl bg-amber-400/10 px-3.5 py-2.5 text-[13px] text-amber-200 ring-1 ring-amber-400/25"><ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />{err}</div>}
      <p className="flex items-start gap-1.5 text-[11.5px] leading-relaxed text-zinc-500"><Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        Every check is live: the proof file is downloaded now, its signature is checked against keys read from Concordium, and the badge and its card are read from the registry. Tamper changes the downloaded copy before checking, as an attacker on the wire or a hacked web host would. Each verdict is anchored on Concordium.</p>
    </div>
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

function StepTracker({ steps, copy = STEP_COPY }) {
  return (
    <ol className="relative">
      {steps.map((s, i) => {
        const last = i === steps.length - 1;
        const items = (s.items || []).filter((x) => typeof x === "object");
        const active = s.status !== "pending";
        const [title, hint] = copy[s.key] || [s.title, s.hint];
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


/* ------------------------------------------------------------------ agent identity */
function AgentCard({ agent, error, onRefresh, loading }) {
  const ok = agent?.verified;
  const rows = [
    ["Registry checks", agent ? `${agent.checks_passed} of ${agent.checks_total} passed` : "…", agent?.badge_valid],
    ["Agent Card hash", agent ? (agent.hash_match ? `Matches chain · ${agent.card_hash.slice(0, 8)}` : "Does not match") : "…", agent?.hash_match],
    ["On-chain status", agent?.status || "…", agent?.status === "Active"],
  ];
  return (
    <section data-agent="card" className="card overflow-hidden rounded-3xl">
      <div className={`relative px-5 pb-4 pt-5 ${ok ? "bg-gradient-to-br from-emerald-500/15 via-transparent to-transparent" : agent ? "bg-gradient-to-br from-rose-500/15 via-transparent to-transparent" : ""}`}>
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3 min-w-0">
            <div className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl ring-1 ${ok ? "bg-emerald-500 text-white ring-emerald-400/40 shadow-[0_0_24px_-4px_rgba(16,185,129,.8)]" : "bg-white/[.06] text-zinc-300 ring-white/10"}`}>
              <Bot className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <div className="text-[11px] font-semibold uppercase tracking-[.14em] text-zinc-500">Agent</div>
              <h2 className="mt-0.5 text-[15.5px] font-semibold tracking-tight text-white">{agent?.name || "ClientScope Work Agent"}</h2>
              <div className="mt-0.5 text-[12.5px] text-zinc-400">Agent #{agent?.token_id || "1010"} · v{agent?.version || "1.0.0"} · CIS-8004</div>
            </div>
          </div>
          <button type="button" onClick={onRefresh} title="Check again now" className="rounded-lg p-1.5 text-zinc-500 transition hover:bg-white/5 hover:text-zinc-300">
            {loading ? <Spin c="h-4 w-4" /> : <RotateCw className="h-4 w-4" />}
          </button>
        </div>
        <div className={`mt-4 flex items-center gap-3 rounded-2xl px-3.5 py-3 ring-1 ${ok ? "bg-emerald-500/15 text-emerald-100 ring-emerald-400/25" : agent ? "bg-rose-500/15 text-rose-100 ring-rose-400/25" : "bg-white/[.04] text-zinc-400 ring-white/10"}`}>
          {agent ? (ok ? <ShieldCheck className="h-6 w-6 shrink-0 text-emerald-300" /> : <ShieldX className="h-6 w-6 shrink-0 text-rose-300" />) : <Spin c="h-5 w-5" />}
          <div className="min-w-0">
            <div className="text-[13.5px] font-semibold text-white">{agent ? (ok ? "Verified by Concordium" : "Badge not valid") : error ? "Registry unreachable" : "Checking badge…"}</div>
            <div className="text-[11.5px] text-zinc-400">
              {agent ? `Live check ${fmtTime(agent.checked_at)} UK · ${agent.checks_passed}/${agent.checks_total} registry checks` : "Concordium Agent Registry, testnet"}
            </div>
          </div>
        </div>
      </div>
      <dl className="divide-y divide-white/[.06] border-t border-white/[.06] text-[13px]">
        {rows.map(([k, v, good]) => (
          <div key={k} className="flex items-center justify-between gap-3 px-5 py-2.5">
            <dt className="whitespace-nowrap text-zinc-500">{k}</dt>
            <dd className="flex items-center gap-1.5 text-right font-medium text-zinc-200">
              {agent && (good ? <Check className="h-3.5 w-3.5 text-emerald-400" strokeWidth={2.5} /> : <X className="h-3.5 w-3.5 text-rose-400" strokeWidth={2.5} />)}
              <span>{v}</span>
            </dd>
          </div>
        ))}
        <div className="flex items-center justify-between gap-3 px-5 py-2.5">
          <dt className="text-zinc-500">Owner</dt>
          <dd>{agent?.owner ? <a href={agent.owner_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-mono text-[12px] text-violet-300 hover:text-violet-200">{short(agent.owner, 8, 6)}<ArrowUpRight className="h-3 w-3" /></a> : "…"}</dd>
        </div>
      </dl>
      <div className="border-t border-white/[.06] px-5 py-4">
        <div className="flex flex-wrap gap-1.5">
          {(agent?.skills || [{ id: "scrape-to-sheet", name: "Scrape to Sheet" }]).map((s) => (
            <span key={s.id} className="rounded-md bg-violet-400/10 px-2 py-1 text-[11.5px] font-medium text-violet-200 ring-1 ring-violet-400/20">{s.name}</span>
          ))}
          <span className="rounded-md bg-white/[.04] px-2 py-1 text-[11.5px] font-medium text-zinc-400 ring-1 ring-white/10">Pay on delivery</span>
          <span className="rounded-md bg-white/[.04] px-2 py-1 text-[11.5px] font-medium text-zinc-400 ring-1 ring-white/10">Fees sponsored</span>
        </div>
        {agent?.card_url && (
          <a href={agent.card_url} target="_blank" rel="noreferrer" className="mt-3 inline-flex items-center gap-1 text-[12px] font-medium text-zinc-500 hover:text-violet-300">View Agent Card <ArrowUpRight className="h-3 w-3" /></a>
        )}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ progress sidebar */
const OUTCOME_TITLE = {
  delivered_paid: "Delivered, then paid",
  delivery_failed: "Delivery failed, so you weren't charged",
  buyer_rejected: "Buyer not verified, so the job was refused",
  agent_refused: "Agent badge not valid, so the buyer walked away",
  error: "Something went wrong, and nothing was charged",
  payment_declined: "Delivered, but the payment was not approved",
  cancelled: "Hire cancelled, so nothing was charged",
  halted_revoked: "Kill switch pressed: the job stopped and nothing was charged",
  domain_refused: "Lookalike supplier refused before any payment",
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
          Job <span className="font-mono text-zinc-400">{run.job_id || "…"}</span> · {run.mode === "wallet" ? <>Your wallet <span className="font-mono">{short(run.account, 4, 4)}</span></> : run.mode === "normal" ? "Demo buyer" : MODE_COPY[run.mode] || run.mode_label} · started {fmtTime(run.started)} UK
        </p>
        <div className="mt-3 flex items-center gap-2.5">
          <div className="h-1 flex-1 overflow-hidden rounded-full bg-white/[.06]">
            <motion.div className={`h-full rounded-full ${run.status === "failed" ? "bg-gradient-to-r from-amber-400 to-amber-300" : "bg-gradient-to-r from-violet-400 via-sky-400 to-emerald-400"}`}
              initial={{ width: 0 }} animate={{ width: `${(doneCount / steps.length) * 100}%` }} transition={{ duration: 0.8, ease: EASE }} />
          </div>
          <span className="font-mono text-[10.5px] text-zinc-500">{doneCount}/{steps.length}</span>
        </div>
      </header>
      <div className="px-5 pt-4"><StepTracker steps={steps} copy={run.mode === "wallet" ? WALLET_STEP_COPY : STEP_COPY} /></div>
    </section>
  );
}

function ApproveCard({ run, wallet, onApprove, onDecline, state }) {
  const req = run.result?.payment_request;
  if (!req || run.status !== "running") return null;
  const sameAccount = wallet.status === "connected" && wallet.account === run.account;
  return (
    <motion.section initial={{ opacity: 0, y: 12, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ duration: 0.45, ease: EASE }}
      className="card overflow-hidden rounded-3xl !border-violet-400/40" data-approve="pending">
      <div className="bg-gradient-to-br from-violet-500/20 via-transparent to-transparent px-5 py-5">
        <div className="flex items-start gap-3">
          <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-violet-500 text-white shadow-[0_0_24px_-4px_rgba(139,124,255,.9)]"><Wallet className="h-5 w-5" /></div>
          <div>
            <h3 className="text-[15.5px] font-semibold tracking-tight text-white">Delivery passed. Approve the payment</h3>
            <p className="mt-1 text-[12.5px] leading-relaxed text-zinc-400">Your Sheet passed every check. Approve 1 EUDemo in your wallet to pay ClientScope. ClientScope pays the network fee.</p>
          </div>
        </div>
        <dl className="mt-4 space-y-1.5 rounded-xl bg-black/25 p-3 text-[12.5px] ring-1 ring-white/[.06]">
          <div className="flex justify-between gap-3"><dt className="text-zinc-500">Amount</dt><dd className="font-medium text-zinc-100">1 EUDemo</dd></div>
          <div className="flex justify-between gap-3"><dt className="text-zinc-500">To</dt><dd className="font-mono text-[11.5px] text-zinc-300">ClientScope · {short("3qYSik7b8w9NsgeAk91Mrpapq9T5S7EGvmsa3Ecf4449xiJ8cX", 4, 4)}</dd></div>
          <div className="flex justify-between gap-3"><dt className="text-zinc-500">Reference</dt><dd className="font-mono text-[11.5px] text-zinc-300">{run.job_id}</dd></div>
          {run.result.payment_request_expires && <div className="flex justify-between gap-3"><dt className="text-zinc-500">Request valid until</dt><dd className="text-zinc-300">{fmtTime(run.result.payment_request_expires)} UK</dd></div>}
        </dl>
        {!sameAccount && <p className="mt-3 text-[12px] text-amber-200">Connect the wallet account {short(run.account, 6, 6)} to approve this payment.</p>}
        <div className="mt-4 flex gap-2">
          <button onClick={onApprove} disabled={!sameAccount || state === "busy"} className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-white px-4 py-2.5 text-[13.5px] font-semibold text-ink-950 transition hover:bg-zinc-200 disabled:opacity-50">
            {state === "busy" ? <><Spin c="h-4 w-4" /> Check your wallet…</> : <><Wallet className="h-4 w-4" /> Approve in wallet</>}
          </button>
          <button onClick={onDecline} disabled={state === "busy"} className="rounded-xl px-3.5 py-2.5 text-[13px] font-medium text-zinc-400 ring-1 ring-white/10 transition hover:text-zinc-200 disabled:opacity-50">Decline</button>
        </div>
        {state === "error" && <p className="mt-2 text-[12px] text-amber-200">The wallet did not send the payment. You can try again or decline.</p>}
      </div>
    </motion.section>
  );
}

function KillSwitchIntro() {
  const [pool, setPool] = useState(null);
  useEffect(() => { fetch(`${API}/api/killswitch`).then((r) => (r.ok ? r.json() : null)).then(setPool).catch(() => {}); }, []);
  return (
    <div className="mt-3 rounded-xl bg-rose-500/[.07] p-3 text-[12.5px] leading-relaxed text-zinc-300 ring-1 ring-rose-400/20">
      <div className="flex items-start gap-2"><Siren className="mt-0.5 h-4 w-4 shrink-0 text-rose-300" />
        <span>The buyer hires ClientScope with a throwaway agent that is really registered on Concordium. While the job runs, its owner revokes the agent on chain, with your button or a timer. ClientScope must notice within seconds, stop, take no money and anchor a halt receipt.
          {pool && <span className="text-zinc-500"> {pool.active} demo agents left.</span>}</span>
      </div>
    </div>
  );
}

/* LIVE KILL SWITCH: the buyer agent's owner revokes its on-chain badge while the job runs. */
function KillSwitchCard({ run }) {
  const r = run.result || {};
  const [now, setNow] = useState(Date.now());
  const [pressing, setPressing] = useState(false);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 250); return () => clearInterval(t); }, []);
  if (run.mode !== "kill_switch") return null;
  const running = run.status === "running";
  const st = r.kill_state || "waiting";
  const left = st === "ready" && r.kill_ready_at && r.kill_auto_s ? Math.max(0, Math.ceil(r.kill_auto_s - (now - new Date(r.kill_ready_at)) / 1000)) : null;
  const press = async () => { setPressing(true); try { await fetch(`${API}/api/runs/${run.id}/kill`, { method: "POST" }); } catch {} };
  const halted = run.outcome === "halted_revoked" || r.kill_detected;
  const Row = ({ ok, active, children }) => (
    <div className={`flex items-start gap-2 text-[12.5px] ${ok ? "text-zinc-200" : active ? "text-zinc-300" : "text-zinc-600"}`}>
      {ok ? <CircleCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" /> : active ? <Spin c="mt-0.5 h-4 w-4 shrink-0 text-rose-300" /> : <Minus className="mt-0.5 h-4 w-4 shrink-0" />}
      <span>{children}</span>
    </div>
  );
  return (
    <motion.section initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} data-killswitch={st}
      className={`card overflow-hidden rounded-3xl ${halted ? "!border-emerald-400/30" : "!border-rose-400/40"}`}>
      <div className="bg-gradient-to-br from-rose-500/20 via-transparent to-transparent px-5 py-5">
        <div className="flex items-start gap-3">
          <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-rose-500 text-white shadow-[0_0_24px_-4px_rgba(244,63,94,.9)]"><Power className="h-5 w-5" /></div>
          <div className="min-w-0">
            <h3 className="text-[15.5px] font-semibold tracking-tight text-white">Owner's kill switch</h3>
            <p className="mt-1 text-[12.5px] leading-relaxed text-zinc-400">
              This hire uses a throwaway demo agent{r.kill_agent ? <> <span className="font-mono text-zinc-300">#{r.kill_agent.token_id}</span></> : ""}, a real agent on Concordium's registry. Its owner can revoke it at any moment. ClientScope watches the badge every second.
            </p>
          </div>
        </div>
        {running && st === "ready" && (
          <button onClick={press} disabled={pressing} data-kill-button
            className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-rose-500 px-4 py-3 text-[14px] font-semibold text-white shadow-[0_0_30px_-6px_rgba(244,63,94,.9)] transition hover:bg-rose-400 disabled:opacity-60">
            {pressing ? <><Spin c="h-4 w-4" /> Sending the revoke…</> : <><OctagonX className="h-4 w-4" /> Revoke the agent's badge now{left !== null ? ` · auto in ${left}s` : ""}</>}
          </button>
        )}
        <div className="mt-4 space-y-2 rounded-xl bg-black/25 p-3 ring-1 ring-white/[.06]">
          <Row ok={["ready", "sent", "revoked"].includes(st) || halted} active={st === "waiting" && running}>Job running, kill switch armed</Row>
          <Row ok={st === "revoked" || halted} active={st === "sent"}>
            {r.revoke_tx ? <>Owner revoked the badge on chain{r.revoke_finalized_s ? ` (final in ${r.revoke_finalized_s} s)` : ""}{r.kill_by ? `, by ${r.kill_by === "button" ? "your button" : "the auto timer"}` : ""}</> : "Owner sends the CIS-8004 revoke"}
          </Row>
          <Row ok={halted} active={st === "revoked" && !halted}>{halted ? `ClientScope saw it ${r.detection_seconds || "?"} s after the revoke's block and halted the job` : "ClientScope detects the revoke and halts"}</Row>
          <Row ok={run.outcome === "halted_revoked"} active={halted && running}>{run.outcome === "halted_revoked" ? "Payment never sent, halt receipt anchored on chain" : "Payment discarded, halt receipt anchored"}</Row>
        </div>
        {r.revoke_tx_url && <div className="mt-3"><LinkTile icon={ShieldOff} label="Revoke transaction on Concordium" value={short(r.revoke_tx, 10, 8)} href={r.revoke_tx_url} mono /></div>}
      </div>
    </motion.section>
  );
}

function Side({ run, elapsed, approve }) {
  const done = run.status !== "running";
  return (
    <div className="flex flex-col gap-5">
      <KillSwitchCard run={run} />
      {approve && <ApproveCard run={run} {...approve} />}
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
    ? (run.mode === "wallet" ? "The Sheet passed the delivery check, then you approved the 1 EUDemo payment in your wallet. ClientScope checked it on chain and stored the log's fingerprint on Concordium."
      : "The Sheet passed the delivery check, so the 1 EUDemo payment was released. The log's fingerprint is now stored on Concordium.")
    : run.outcome === "delivery_failed"
      ? "The signed payment was thrown away and never sent. The failure is still logged and its fingerprint stored on chain."
      : run.outcome === "halted_revoked"
      ? `The owner revoked the buyer agent's badge mid-job. ClientScope saw it on chain ${r.detection_seconds || "?"} s after the revoke's block, stopped the job, threw the signed payment away and anchored a halt receipt that names the revoke transaction.`
      : run.outcome === "domain_refused"
      ? `The supplier site ${r.domain?.site || ""} has a real Concordium badge, but its website, account and badge do not all point to each other (${(r.domain?.failed || []).map((f) => f.replace(/_/g, " ")).join(", ") || "domain proof failed"}). ClientScope refused before any 402, so nothing was signed. The refusal is anchored on Concordium.`
      : run.outcome === "payment_declined"
      ? "The work passed its checks, but the payment was not approved in your wallet, so nothing was sent. This is recorded in the Audit Log and anchored on chain."
      : run.outcome === "cancelled"
      ? "The signature request was not completed in your wallet, so no work ran and nothing was paid."
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
            : run.outcome === "halted_revoked" ? <Pill tone="amber">Charged 0 EUDemo · owner paid {r.revoke_fee_ccd ? Number(r.revoke_fee_ccd).toFixed(2) : "?"} CCD to revoke</Pill>
            : <Pill tone="amber">{bal || run.outcome !== "error" ? "Charged 0 EUDemo · 0 CCD" : "Nothing sent"}</Pill>}
          {r.receipt_verified && <Pill tone="violet"><BadgeCheck className="h-3 w-3" /> Receipt checked: valid</Pill>}
        </div>
      </div>
      {(r.sheet_url || r.payment_tx || r.anchor_tx || r.revoke_tx || r.domain_anchor_tx) && (
        <div className="space-y-2 border-t border-white/[.06] px-5 py-4">
          {r.sheet_url && <LinkTile icon={FileSpreadsheet} label={ok ? "Your finished Google Sheet" : "Sheet with the failure log"} value="Open in Google Sheets" href={r.sheet_url} />}
          {r.payment_tx && <LinkTile icon={HandCoins} label="Payment on Concordium" value={short(r.payment_tx, 10, 8)} href={r.payment_tx_url} mono />}
          {r.domain_anchor_tx && <LinkTile icon={Globe} label="Domain refusal stored on Concordium" value={short(r.domain_anchor_tx, 10, 8)} href={r.domain_anchor_tx_url} mono />}
          {r.revoke_tx && <LinkTile icon={ShieldOff} label="Owner's revoke on Concordium" value={short(r.revoke_tx, 10, 8)} href={r.revoke_tx_url} mono />}
          {r.anchor_tx && <LinkTile icon={Receipt} label={run.outcome === "halted_revoked" ? "Halt receipt stored on Concordium" : "Receipt stored on Concordium"} value={short(r.anchor_tx, 10, 8)} href={r.anchor_tx_url} mono />}
        </div>
      )}
      {bal && (
        <div className="border-t border-white/[.06] px-5 py-3">
          <div className="text-[10.5px] font-semibold uppercase tracking-[.14em] text-zinc-500">Balances read back from the chain</div>
          <div className="divide-y divide-white/[.05]">
            <BalanceRow name={run.mode === "kill_switch" ? "Buyer (also the agent's owner, paid the revoke fee)" : "Buyer"} b={bal.before.client} a={bal.after.client} />
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
  const [selected, setSelected] = useState("supplier");
  const [payWith, setPayWith] = useState("wallet");
  const [connecting, setConnecting] = useState(false);
  const [prompt, setPrompt] = useState(null);
  const [approveState, setApproveState] = useState(null);
  const sideRef = useRef(null);
  const autoPay = useRef(new Set());   // runs started in this tab: open the wallet automatically when delivery passes
  const wallet = useWallet();

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

  const post = (path, body) => fetch(`${API}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const errText = (status, detail) => status === 409 ? "Another hire is already running. Please try again in a moment."
    : detail ? `Couldn't start the job: ${detail}.` : "Couldn't start the job. Please try again.";

  const connect = async () => {
    setErr(null); setConnecting(true);
    try { await wallet.connect(); }
    catch { setErr("The wallet did not connect. Open the Concordium Wallet, unlock it and try again."); }
    finally { setConnecting(false); }
  };

  const hireWallet = async () => {
    setErr(null); setStarting(true);
    let runId = null;
    try {
      const r = await post("/api/wallet/start", { account: wallet.account });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setErr(errText(r.status, d.detail)); return; }
      runId = d.run_id;
      history.replaceState(null, "", `?run=${runId}`);
      setRun({ id: runId, mode: "wallet", account: wallet.account, status: "running", steps: IDLE_STEPS, audit: [], console: [], result: {}, started: new Date().toISOString() });
      follow(runId);
      if (d.refused) return;
      autoPay.current.add(runId);
      if (window.innerWidth < 1024) setTimeout(() => sideRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 350);
      setPrompt("Check your wallet: sign ClientScope's one-time challenge to confirm the order. Nothing is paid yet.");
      let signature;
      try { signature = await wallet.signMessage(wallet.account, d.message); }
      catch { await post("/api/wallet/stop", { run_id: runId }).catch(() => {}); setErr("You closed the signature request, so the hire was cancelled. Nothing was paid."); return; }
      setPrompt("Checking your signature and account on Concordium…");
      const v = await post("/api/wallet/verify", { run_id: runId, signature });
      if (!v.ok) setErr("ClientScope could not check your signature. Please try again.");
    } catch { setErr("Couldn't reach the server. Check your connection and try again."); }
    finally { setStarting(false); setPrompt(null); }
  };

  const approve = async () => {
    if (!run?.result?.payment_request) return;
    setApproveState("busy");
    try {
      const hash = await wallet.approvePayment(wallet.account, run.result.payment_request);
      const r = await post("/api/wallet/pay", { run_id: run.id, tx_hash: hash });
      setApproveState(r.ok ? null : "error");
    } catch { setApproveState("error"); }
  };
  const decline = async () => { setApproveState(null); await post("/api/wallet/stop", { run_id: run.id }).catch(() => {}); };
  useEffect(() => {
    if (run?.mode === "wallet" && run.status === "running" && run.result?.payment_request && autoPay.current.has(run.id) && wallet.account === run.account) {
      autoPay.current.delete(run.id); approve();
    }
  }, [run?.result?.payment_request]);

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
            className="mx-auto grid max-w-[1240px] items-start gap-5 px-5 pb-20 sm:px-6 lg:grid-cols-[minmax(0,1fr)_400px]">
            <div className="flex min-w-0 flex-col gap-5">
              <JobsPanel selected={selected} setSelected={setSelected} agent={agent} agentErr={agentErr} agentLoading={agentLoading} onRefresh={loadAgent}
                modes={modes} mode={mode} setMode={setMode} payWith={payWith} setPayWith={setPayWith} wallet={wallet} onConnect={connect} connecting={connecting}
                onHire={hire} onHireWallet={hireWallet} busy={busy} starting={starting} serverReady={health.x402_server} err={err} prompt={prompt} />
              {/* on narrow screens the progress sits right under New Job */}
              {hasRun && <div ref={sideRef} className="scroll-mt-4 lg:hidden"><Side run={run} elapsed={elapsed} approve={{ wallet, onApprove: approve, onDecline: decline, state: approveState }} /></div>}
              {run?.result?.products && <Products rows={run.result.products} />}
              <AuditLog rows={run?.audit || []} source={run?.audit_source} running={run?.status === "running"} outcome={run?.outcome} hasRun={hasRun} />
              {run && <Console lines={run.console || []} />}
              <div className="lg:hidden"><AgentCard agent={agent} error={agentErr} loading={agentLoading} onRefresh={loadAgent} /></div>
            </div>

            <aside className="hidden min-w-0 lg:block">
              <div className="flex flex-col gap-5">
                <AnimatePresence>
                  {hasRun && (
                    <motion.div key="side" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 16 }} transition={{ duration: 0.55, ease: EASE }}>
                      <Side run={run} elapsed={elapsed} approve={{ wallet, onApprove: approve, onDecline: decline, state: approveState }} />
                    </motion.div>
                  )}
                </AnimatePresence>
                <AgentCard agent={agent} error={agentErr} loading={agentLoading} onRefresh={loadAgent} />
              </div>
            </aside>
          </main>
        </LayoutGroup>

        <footer className="border-t border-white/[.06] py-6 text-center text-[12px] text-zinc-600">
          ClientScope runs on the Concordium test network.
        </footer>
      </div>
    </div>
  );
}
