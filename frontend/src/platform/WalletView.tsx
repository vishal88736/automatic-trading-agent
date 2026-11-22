import { useEffect, useState } from "react";
import { Eye, Unplug, Wallet } from "lucide-react";
import { money, number } from "../ui";
import { useMarkets } from "./useMarkets";

/**
 * View-only wallet connection through the browser wallet itself (EIP-1193: MetaMask, Rabby,
 * Coinbase Wallet, Trust and others). Krono only reads balances; it never requests a
 * signature or a transaction, so a connected wallet cannot be moved by Krono.
 */
interface Eip1193 {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on?(event: string, handler: (...args: unknown[]) => void): void;
  removeListener?(event: string, handler: (...args: unknown[]) => void): void;
}

declare global {
  interface Window {
    ethereum?: Eip1193;
  }
}

const CHAINS: Record<string, { name: string; symbol: string; price?: "ETH" }> =
  {
    "0x1": { name: "Ethereum", symbol: "ETH", price: "ETH" },
    "0xa": { name: "Optimism", symbol: "ETH", price: "ETH" },
    "0xa4b1": { name: "Arbitrum One", symbol: "ETH", price: "ETH" },
    "0x2105": { name: "Base", symbol: "ETH", price: "ETH" },
    "0x38": { name: "BNB Smart Chain", symbol: "BNB" },
    "0x89": { name: "Polygon", symbol: "POL" },
  };
// Ethereum mainnet stablecoins (6 decimals). Read with a plain balanceOf call.
const TOKENS = [
  { symbol: "USDT", address: "0xdAC17F958D2ee523a2206206994597C13D831ec7" },
  { symbol: "USDC", address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" },
];

const toUnits = (hex: string, decimals: number) => {
  const value = BigInt(hex || "0x0");
  const scale = 10n ** BigInt(decimals);
  return Number(value / scale) + Number(value % scale) / Number(scale);
};

interface Holding {
  symbol: string;
  amount: number;
  usd: number | null;
}

export function WalletView() {
  const provider = typeof window === "undefined" ? undefined : window.ethereum;
  const markets = useMarkets();
  const [address, setAddress] = useState<string>();
  const [chain, setChain] = useState<string>();
  const [holdings, setHoldings] = useState<Holding[]>();
  const [error, setError] = useState("");
  const ethPrice = markets?.find((m) => m.asset === "ETH")?.price ?? null;

  async function read(account: string) {
    if (!provider) return;
    const chainId = (await provider.request({
      method: "eth_chainId",
    })) as string;
    setChain(chainId);
    const info = CHAINS[chainId];
    const native = toUnits(
      (await provider.request({
        method: "eth_getBalance",
        params: [account, "latest"],
      })) as string,
      18,
    );
    const next: Holding[] = [
      {
        symbol: info?.symbol ?? "Native",
        amount: native,
        usd: info?.price === "ETH" && ethPrice ? native * ethPrice : null,
      },
    ];
    if (chainId === "0x1")
      for (const token of TOKENS) {
        const data =
          "0x70a08231" + account.slice(2).toLowerCase().padStart(64, "0");
        const raw = (await provider.request({
          method: "eth_call",
          params: [{ to: token.address, data }, "latest"],
        })) as string;
        const amount = toUnits(raw, 6);
        if (amount > 0)
          next.push({ symbol: token.symbol, amount, usd: amount });
      }
    setHoldings(next);
  }

  useEffect(() => {
    if (!provider) return;
    // Silently restore a wallet the user already connected; never prompts.
    provider
      .request({ method: "eth_accounts" })
      .then((accounts) => {
        const [first] = accounts as string[];
        if (first) {
          setAddress(first);
          void read(first).catch(() => undefined);
        }
      })
      .catch(() => undefined);
    const changed = (...args: unknown[]) => {
      const [first] = args[0] as string[];
      setAddress(first);
      setHoldings(undefined);
      if (first) void read(first).catch(() => undefined);
    };
    const chainChanged = () =>
      address && void read(address).catch(() => undefined);
    provider.on?.("accountsChanged", changed);
    provider.on?.("chainChanged", chainChanged);
    return () => {
      provider.removeListener?.("accountsChanged", changed);
      provider.removeListener?.("chainChanged", chainChanged);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider]);

  useEffect(() => {
    if (address && ethPrice && holdings?.some((h) => h.usd === null)) {
      void read(address).catch(() => undefined);
    }
    // Re-value once the live ETH price arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ethPrice]);

  async function connect() {
    setError("");
    try {
      const [first] = (await provider!.request({
        method: "eth_requestAccounts",
      })) as string[];
      setAddress(first);
      await read(first);
    } catch (err) {
      setError((err as Error).message || "The wallet did not connect");
    }
  }

  const total = holdings?.reduce((sum, h) => sum + (h.usd ?? 0), 0);
  return (
    <section className="kx-card kx-wallet">
      <div className="kx-toolbar">
        <h2 className="kx-card-title">
          <Wallet size={17} aria-hidden /> Wallet{" "}
          <span className="kx-badge">
            <Eye size={12} aria-hidden /> View only
          </span>
        </h2>
        {address && (
          <button
            className="kx-icon-button"
            aria-label="Hide wallet"
            title="Hide wallet (disconnect it in your wallet app)"
            onClick={() => {
              setAddress(undefined);
              setHoldings(undefined);
            }}
          >
            <Unplug size={15} />
          </button>
        )}
      </div>
      {!provider && (
        <p className="muted">
          Install a browser wallet such as MetaMask to see its balances here.
          Krono only reads balances; it cannot move funds from a wallet.
        </p>
      )}
      {provider && !address && (
        <>
          <p className="muted">
            Connect a browser wallet to see its holdings next to your exchange
            accounts. Krono never asks you to sign anything.
          </p>
          <button className="secondary" onClick={() => void connect()}>
            <Wallet size={15} /> Connect wallet
          </button>
        </>
      )}
      {error && (
        <p className="platform-error" role="alert">
          {error}
        </p>
      )}
      {address && (
        <>
          <p className="muted kx-mono">
            {address.slice(0, 6)}…{address.slice(-4)} ·{" "}
            {CHAINS[chain ?? ""]?.name ?? `Chain ${chain ?? "…"}`}
          </p>
          <p className="kx-big kx-num">
            {total !== undefined ? money(total) : "—"}
          </p>
          <ul className="kx-wallet-list">
            {holdings?.map((holding) => (
              <li key={holding.symbol}>
                <strong>{holding.symbol}</strong>
                <span className="kx-num">{number(holding.amount, 6)}</span>
                <span className="kx-num muted">{money(holding.usd)}</span>
              </li>
            ))}
          </ul>
          <p className="kx-footnote">
            Agents trade through linked exchange accounts. A wallet would need
            you to approve every transaction, so it is shown for reference only.
          </p>
        </>
      )}
    </section>
  );
}
