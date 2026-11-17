// Concordium Browser Wallet helpers. The wallet extension injects window.concordium; nothing here touches keys.
import { detectConcordiumProvider } from "@concordium/browser-wallet-api-helpers";
import { useEffect, useRef, useState } from "react";

export const INSTALL_URL = "https://chromewebstore.google.com/detail/concordium-wallet/mnnkpffndmickbiakofclnpoiajlegmg";
const TESTNET_GENESIS = "4221332d34e1694168c2a0c0b3fd0f27"; // first 32 hex of the testnet genesis hash (same as the CAIP-2 id)
const isTestnet = (g) => !g || String(g).toLowerCase().startsWith(TESTNET_GENESIS);  // undefined = locked wallet, checked again on use

export function useWallet() {
  const [state, setState] = useState({ status: "checking", account: null, testnet: true });
  const prov = useRef(null);
  useEffect(() => {
    let alive = true;
    (async () => {
      let p = null;
      try { p = await detectConcordiumProvider(2500); } catch { p = null; }
      if (!alive) return;
      if (!p) { setState({ status: "missing", account: null, testnet: true }); return; }
      prov.current = p;
      let account = null, chain = null;
      try { account = await p.getMostRecentlySelectedAccount(); } catch {}
      try { chain = await p.getSelectedChain(); } catch {}
      setState({ status: account ? "connected" : "disconnected", account: account || null, testnet: isTestnet(chain) });
      p.on?.("accountChanged", (a) => setState((s) => ({ ...s, status: "connected", account: a })));
      p.on?.("accountDisconnected", () => setState((s) => ({ ...s, status: "disconnected", account: null })));
      p.on?.("chainChanged", (g) => setState((s) => ({ ...s, testnet: isTestnet(g) })));
    })();
    return () => { alive = false; };
  }, []);

  const connect = async () => {
    const p = prov.current; if (!p) throw new Error("missing");
    const accounts = await p.requestAccounts();
    let chain = null; try { chain = await p.getSelectedChain(); } catch {}
    const account = accounts?.[0] || null;
    setState({ status: account ? "connected" : "disconnected", account, testnet: isTestnet(chain) });
    if (!account) throw new Error("no_account");
    return account;
  };
  const signMessage = (account, message) => prov.current.signMessage(account, message);
  // The payment the sponsor already signed: the wallet shows it, adds the buyer's signature and submits it.
  const approvePayment = async (account, json) => {
    const { Transaction, AccountAddress } = await import("@concordium/web-sdk");
    const tx = Transaction.signableFromJSON(json);
    const hash = await prov.current.sendSponsoredTransaction(AccountAddress.fromBase58(account), tx);
    return String(hash?.toString?.() ?? hash);
  };
  return { ...state, connect, signMessage, approvePayment };
}
