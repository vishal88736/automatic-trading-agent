import { useEffect, useRef, useState } from "react";
import { Bot, Send, X } from "lucide-react";
import { api } from "../api";
import { Modal, number } from "../ui";
import { useAegis } from "./context";
import { ParamsConfirmation } from "./LiveControls";
import { utcTime, type AegisState } from "./types";

/** A size shortcut the risk policy will accept for this account, never a fixed amount. */
export function sizeSuggestion(state: AegisState | null | undefined) {
  const nav = Number(state?.pnl?.nav_usdt);
  const capPct = Number(state?.caps?.max_position_size_pct);
  if (!state?.valuation_fresh || !(nav > 0) || !(capPct > 0))
    return "Set position size to 5% and frequency to 30s";
  // 80% of the USDT ceiling, rounded down to two significant digits.
  const budget = (nav * capPct * 0.8) / 100;
  const step = 10 ** (Math.floor(Math.log10(budget)) - 1);
  const rounded = Number((Math.floor(budget / step) * step).toPrecision(2));
  return `Set position size to ${rounded} USDT and frequency to 30s`;
}

export function AegisChat() {
  const { messages, busy, send, setChatOpen, state } = useAegis();
  const [message, setMessage] = useState("");
  const bottom = useRef<HTMLDivElement>(null),
    input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    input.current?.focus();
  }, []);
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "nearest" });
  }, [messages.length]);
  const submit = (text: string) => {
    if (!text.trim() || busy) return;
    setMessage("");
    void send(text);
  };
  return (
    <aside
      className="chat-panel aegis-assistant"
      role="dialog"
      aria-label="AEGIS trading assistant"
    >
      <div className="chat-head">
        <span className="chat-avatar">
          <Bot size={20} />
        </span>
        <div>
          <strong>AEGIS assistant</strong>
          <small>
            {state?.ai_engine?.label ?? "AI Engine: Deterministic Fallback"} ·{" "}
            {state?.mode === "testnet" ? "TESTNET" : "PAPER"}
          </small>
        </div>
        <button
          className="icon-button right"
          aria-label="Close AEGIS assistant"
          onClick={() => setChatOpen(false)}
        >
          <X size={18} />
        </button>
      </div>
      <div className="chat-messages" aria-live="polite">
        {!messages.length && (
          <div className="chat-message assistant">
            <p>
              Ask about positions, P&L or a trading decision. Adjust sizing,
              frequency, risk appetite and target assets through the same
              controls used by the strategy screen.
            </p>
          </div>
        )}
        {messages.length === 0 && (
          <div className="chat-welcome">
            <strong>New to trading? Start here.</strong>
            <p>
              I can see your account and every past session. Ask me anything in
              your own words: what to do next, what a term means, why nothing is
              trading, or how a session went. I can also prepare a trade; you
              always review it before it runs.
            </p>
          </div>
        )}
        {messages.map((m) => (
          <div
            key={m.id}
            className={`chat-message ${m.who === "you" ? "user" : "assistant"}`}
          >
            <span className="eyebrow">{m.who === "you" ? "YOU" : "AEGIS"}</span>
            <p>{m.text}</p>
            {m.tool && <span className="tool-chip">{m.tool}</span>}
            {m.engine && (
              <small className="aegis-chat-engine">{m.engine}</small>
            )}
          </div>
        ))}
        <div ref={bottom} />
      </div>
      <div className="aegis-chips">
        {[
          "What should I do next?",
          "What can you control?",
          "How does this work?",
          "Why is it not trading?",
          "Analyze my past sessions",
          "Show my open positions and real-time P&L",
          sizeSuggestion(state),
          "Switch risk appetite to conservative with a 1.5% stop-loss",
          `Focus target assets on ${(state?.supported_assets ?? ["WHSK", "WETH"]).slice(0, 2).join(" and ")}`,
        ].map((text) => (
          <button disabled={busy} key={text} onClick={() => submit(text)}>
            {text}
          </button>
        ))}
      </div>
      <form
        className="aegis-composer"
        onSubmit={(e) => {
          e.preventDefault();
          submit(message);
        }}
      >
        <textarea
          ref={input}
          id="aegis-chat-input"
          aria-label="Message AEGIS"
          maxLength={1000}
          rows={2}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit(message);
            }
          }}
          placeholder="Cut position size to 3%…"
        />
        <button
          className="button primary"
          type="submit"
          aria-label="Send to AEGIS"
          disabled={busy || !message.trim()}
        >
          <Send size={16} />
        </button>
      </form>
      <small className="chat-policy">
        Conversation stays in this tab. Typed actions are audited. Closing
        positions requires confirmation.
      </small>
    </aside>
  );
}

export function AegisConfirmations() {
  const { preview, setPreview, busy, act, state, error } = useAegis();
  if (!preview) return null;
  const signed = state?.mode === "testnet";
  const mode = signed ? "testnet" : "paper";
  if (preview.kind === "emergency_clear")
    return (
      <Modal
        title="Review emergency-stop clearance"
        close={() => setPreview(null)}
      >
        <p>{preview.summary}</p>
        <p>
          Review the latest decisions and balances. Clearing the stop leaves
          entries paused.
        </p>
        <div className="inline gap">
          <button
            className="button secondary"
            disabled={busy}
            onClick={() => setPreview(null)}
          >
            Cancel
          </button>
          <button
            className="button primary"
            disabled={
              busy || !state?.valuation_fresh || !!state.positions.length
            }
            onClick={() =>
              void act(async () => {
                await api("/aegis/control", "POST", {
                  action: "clear_emergency",
                  acknowledgement: "REVIEW_AND_CLEAR_PAPER_STOP",
                });
                setPreview(null);
              }, "Emergency stop cleared after review. Entries remain paused.")
            }
          >
            Confirm emergency-stop clearance
          </button>
        </div>
      </Modal>
    );
  if (preview.kind === "trade_preview") {
    const trade = preview;
    const settingsChanged =
      state?.params_version !== undefined &&
      trade.params_version !== state.params_version;
    const expired = Date.now() / 1000 > trade.expires_at;
    const facts: [string, string | null | undefined][] =
      trade.side === "buy"
        ? [
            ["Trade input", `${number(trade.trade_input_usdt, 6)} USDT`],
            ["You spend", `${number(trade.spend_usdt, 6)} USDT`],
            [
              "You receive about",
              `${number(trade.receive_estimate, 8)} ${trade.asset}`,
            ],
            ["Trade allocation", `${number(trade.percent_of_portfolio, 2)}%`],
            [
              "Estimated stop-loss trigger",
              `${number(trade.stop_loss_price, 6)} USDT`,
            ],
            [
              "Estimated take-profit trigger",
              `${number(trade.take_profit_price, 6)} USDT`,
            ],
          ]
        : [
            ["You sell", `${number(trade.sell_quantity, 8)} ${trade.asset}`],
            [
              "Gross USDT proceeds",
              `${number(trade.gross_receive_estimate, 6)} USDT`,
            ],
            [
              "Net USDT cash change",
              `${number(trade.receive_estimate, 6)} USDT`,
            ],
            [
              "Estimated result",
              `${number(trade.estimated_result_usdt, 6)} USDT`,
            ],
            ["Still held after", `${number(trade.remaining_after, 8)}`],
          ];
    return (
      <Modal
        title={`Review ${mode} ${trade.side} of ${trade.asset}`}
        close={() => setPreview(null)}
      >
        <p>{trade.summary}</p>
        {(settingsChanged || expired) && (
          <p role="alert">
            {settingsChanged
              ? "Trading settings changed after this preview."
              : "This trade preview expired."}{" "}
            Cancel and ask for a new preview.
          </p>
        )}
        {error && <p role="alert">{error}</p>}
        <dl className="trade-facts">
          {facts.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
          <div>
            <dt>Costs included</dt>
            <dd>
              {number(trade.lp_fee_pct, 3)}% pool fee ·{" "}
              {number(trade.price_impact_bps, 2)} bps price impact
              {" · "}
              {number(trade.modeled_slippage_bps, 2)} bps slippage allowance
            </dd>
          </div>
          <div>
            <dt>USDT network expense</dt>
            <dd>{number(trade.network_fee_usdt, 6)} USDT</dd>
          </div>
        </dl>
        <p className="muted">{trade.network_fee_note}</p>
        {trade.warnings.map((warning) => (
          <p key={warning} role="alert" className="trade-warning">
            {warning}
          </p>
        ))}
        <p className="muted">
          {signed
            ? "This signs a real transaction with test tokens."
            : "Virtual funds; no real money moves."}{" "}
          Prices can move: the trade is refused if the result is more than 0.5%
          worse. Preview expires at {utcTime(trade.expires_at)}.
        </p>
        <div className="inline gap">
          <button
            className="button secondary"
            disabled={busy}
            onClick={() => setPreview(null)}
          >
            Cancel
          </button>
          <button
            className="button primary"
            disabled={busy || settingsChanged || expired}
            onClick={() =>
              void act(
                async () => {
                  await api("/aegis/control", "POST", {
                    action: "trade_confirm",
                    confirmation: trade.confirmation,
                  });
                  setPreview(null);
                  await api("/aegis/check", "POST");
                },
                `${trade.side === "buy" ? "Bought" : "Sold"} ${trade.asset}. It is recorded in Sessions.`,
              )
            }
          >
            Confirm {trade.side}
          </button>
        </div>
      </Modal>
    );
  }
  if (preview.kind === "params_change")
    return (
      <Modal title="Confirm settings change" close={() => setPreview(null)}>
        <ParamsConfirmation key={preview.confirmation} preview={preview} />
      </Modal>
    );
  return (
    <Modal
      title={`Confirm ${mode} position unwind`}
      close={() => setPreview(null)}
    >
      <p>
        {signed
          ? `Close ${preview.positions.length} testnet position(s) into testnet USDT. Each exit signs a real Guard Vault swap on chain 133.`
          : `Close ${preview.positions.length} paper position(s) into virtual USDT.`}{" "}
        Entries will pause. Fresh quotes and risk limits apply to each exit.
      </p>
      <p>
        Preview expires at {utcTime(preview.expires_at)}. Changed holdings
        require another preview.
      </p>
      <div className="inline gap">
        <button
          className="button secondary"
          disabled={busy}
          onClick={() => setPreview(null)}
        >
          Cancel
        </button>
        <button
          className="button primary"
          disabled={busy}
          onClick={() =>
            void act(async () => {
              await api("/aegis/control", "POST", {
                action: "close_all_confirm",
                confirmation: preview.confirmation,
              });
              setPreview(null);
              await api("/aegis/check", "POST");
            }, `Confirmed ${mode} unwind requested; entries paused.`)
          }
        >
          Confirm {mode} unwind
        </button>
      </div>
    </Modal>
  );
}
