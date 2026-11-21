import {
  ArrowRight,
  BadgeCheck,
  KeyRound,
  Lock,
  OctagonX,
  Rocket,
  ShieldCheck,
  Wallet,
} from "lucide-react";
import { workspaceHref } from "./navigation";

const exchanges = [
  {
    name: "Binance",
    method: "API key",
    note: "Spot, trade-only key, IP allow-list",
  },
  {
    name: "Coinbase Advanced",
    method: "OAuth",
    note: "Sign in with Coinbase, no key copy-paste",
  },
  {
    name: "Kraken",
    method: "API key",
    note: "Query + create/cancel orders only",
  },
  {
    name: "Bybit",
    method: "API key",
    note: "Spot, read + trade, no withdrawals",
  },
  { name: "OKX", method: "API key", note: "Trade permission with passphrase" },
];

const steps = [
  {
    icon: BadgeCheck,
    title: "Prove it on paper",
    text: "An agent must run on paper for at least 7 days and stay inside its risk limits before it can be promoted.",
  },
  {
    icon: KeyRound,
    title: "Link your exchange",
    text: "Connect with OAuth, or paste an API key that has trading enabled and withdrawals disabled. Keys are encrypted at rest and never shown again.",
  },
  {
    icon: Wallet,
    title: "Set a live budget",
    text: "Choose how much of your exchange balance the agent may use, plus per-trade, daily-loss and drawdown caps.",
  },
  {
    icon: Rocket,
    title: "Promote the agent",
    text: "The same strategy version that ran on paper starts placing real orders. Every order is logged against your account.",
  },
];

export default function LiveTrading() {
  return (
    <div className="kx-stack">
      <section className="kx-card kx-hero-card">
        <div>
          <span className="kx-badge" data-tone="warning">
            <span className="kx-dot" aria-hidden /> Not yet enabled on this
            server
          </span>
          <h2>Trade real funds with the agents you've proven on paper</h2>
          <p>
            Live trading connects one of your exchange accounts to Krono. Your
            funds stay on the exchange, and Krono only gets permission to place
            and cancel orders. It can never withdraw.
          </p>
          <div className="kx-actions">
            <a className="button primary" href={workspaceHref("agents")}>
              Prepare an agent on paper <ArrowRight size={15} />
            </a>
            <a className="button secondary" href={workspaceHref("leaderboard")}>
              See top paper agents
            </a>
          </div>
        </div>
        <ul className="kx-guarantees">
          <li>
            <Lock size={16} aria-hidden /> Withdrawal permission is rejected
            when a key is linked
          </li>
          <li>
            <ShieldCheck size={16} aria-hidden /> Server-side risk limits on
            every order
          </li>
          <li>
            <OctagonX size={16} aria-hidden /> One-click kill switch cancels
            open orders and pauses all agents
          </li>
        </ul>
      </section>

      <section className="kx-steps">
        {steps.map(({ icon: Icon, title, text }, index) => (
          <article key={title} className="kx-card kx-step">
            <span className="kx-step-index">{index + 1}</span>
            <Icon size={20} aria-hidden />
            <h3>{title}</h3>
            <p>{text}</p>
          </article>
        ))}
      </section>

      <section className="kx-card">
        <h2 className="kx-card-title">Supported exchanges (planned)</h2>
        <ul className="kx-exchange-list">
          {exchanges.map((exchange) => (
            <li key={exchange.name}>
              <span className="kx-exchange-logo" aria-hidden>
                {exchange.name[0]}
              </span>
              <div>
                <strong>{exchange.name}</strong>
                <small>{exchange.note}</small>
              </div>
              <span className="kx-pill">{exchange.method}</span>
              <button type="button" className="secondary" disabled>
                Connect
              </button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
