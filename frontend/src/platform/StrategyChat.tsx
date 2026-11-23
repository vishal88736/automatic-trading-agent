import { Bot, Send, Sparkles, UserRound } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { percent } from "../ui";
import { platform, PlatformRequestError } from "./client";
import { workspaceHref } from "./navigation";
import { PaperAgentFields, paperAgentSettings } from "./PaperAgentFields";
import type {
  RuleGroup,
  StrategyDocument,
  StrategyRevision,
} from "./strategy-types";

interface Message {
  id: string;
  role: "user" | "assistant";
  text: string;
  model?: string;
}

interface DraftReply {
  document: StrategyDocument | null;
  notes: string;
  model: string;
}

interface Proposal {
  document: StrategyDocument;
  saved?: StrategyRevision;
  agentId?: string;
}

const suggestions = [
  "Buy ETH when RSI drops below 30 and sell above 70. Use 5% per trade with a 3% stop loss.",
  "MACD crossover on BTC with a 6% take profit and 2% trailing stop.",
  "Aggressive SOL breakout strategy.",
  "Conservative BTC trend following with a 2% stop loss.",
];

const comparisons: Record<string, string> = {
  lt: "below",
  lte: "at or below",
  gt: "above",
  gte: "at or above",
  crosses_above: "crosses above",
  crosses_below: "crosses below",
};

function describeRules(group: RuleGroup) {
  return group.conditions
    .map(({ indicator, operator, threshold }) =>
      [
        indicator.toUpperCase().replaceAll("_", " "),
        comparisons[operator] ?? operator,
        String(threshold).replaceAll("_", " "),
      ].join(" "),
    )
    .join(group.combine === "any" ? " or " : " and ");
}

export function StrategyChat({
  disabled = false,
  onEdit,
  onSave,
  onStarted,
}: {
  disabled?: boolean;
  onEdit?: (document: StrategyDocument, saved?: StrategyRevision) => void;
  onSave: (document: StrategyDocument) => Promise<StrategyRevision>;
  onStarted?: (strategy: StrategyRevision) => void;
}) {
  const [prompt, setPrompt] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [proposal, setProposal] = useState<Proposal>();
  const [showSettings, setShowSettings] = useState(false);
  const [pending, setPending] = useState("");
  const [error, setError] = useState("");
  const conversation = useRef<HTMLDivElement>(null);
  const previousDraft = useRef<StrategyDocument | null>(null);
  const retry = useRef<{ input: string; key: string; epoch?: number } | null>(
    null,
  );
  const busy = disabled || Boolean(pending);

  useEffect(() => {
    if (conversation.current)
      conversation.current.scrollTop = conversation.current.scrollHeight;
  }, [messages, pending]);

  function addMessage(role: Message["role"], text: string, model?: string) {
    const message = { id: crypto.randomUUID(), role, text, model };
    setMessages((items) => [...items.slice(-15), message]);
  }

  async function run(label: string, action: () => Promise<void>) {
    setError("");
    setPending(label);
    try {
      await action();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPending("");
    }
  }

  function send(event?: FormEvent<HTMLFormElement>, text?: string) {
    event?.preventDefault();
    const objective = (text ?? prompt).trim();
    if (busy || !objective) return;
    setShowSettings(false);
    setProposal(undefined);
    addMessage("user", objective);
    void run("Interpreting prompt…", async () => {
      const { document, notes, model } = await platform<DraftReply>(
        "/strategy-authoring/generate",
        "POST",
        {
          objective,
          current_document: previousDraft.current
            ? JSON.stringify(previousDraft.current)
            : undefined,
        },
      );
      addMessage(
        "assistant",
        notes ||
          (document
            ? "Your strategy draft is ready to review."
            : "Add an asset and entry and exit rules to continue."),
        model,
      );
      setPrompt("");
      if (document) {
        previousDraft.current = document;
        setProposal({ document });
      }
    });
  }

  function start(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !proposal || proposal.agentId) return;
    const { document, saved } = proposal;
    const settings = paperAgentSettings(new FormData(event.currentTarget));
    const source = saved
      ? { strategy_id: saved.id, strategy_version: saved.version }
      : { document };
    const input = JSON.stringify({ ...settings, ...source });
    if (retry.current?.input !== input)
      retry.current = { input, key: crypto.randomUUID() };
    const attempt = retry.current;
    void run("Queueing paper agent…", async () => {
      if (attempt.epoch === undefined) {
        const { account } = await platform<{
          account: { epoch: number } | null;
        }>("/paper-account");
        if (!account)
          throw Error("Open a paper account before starting an agent.");
        attempt.epoch = account.epoch;
      }
      try {
        const result = await platform<{
          id: string;
          strategy?: StrategyRevision;
        }>(
          saved ? "/paper-agents" : "/strategy-authoring/start-agent",
          "POST",
          {
            ...settings,
            ...source,
            epoch: attempt.epoch,
            request_key: attempt.key,
          },
        );
        if (result.strategy) onStarted?.(result.strategy);
        setProposal({
          document,
          saved: result.strategy ?? saved,
          agentId: result.id,
        });
        setShowSettings(false);
        retry.current = null;
      } catch (err) {
        if (err instanceof PlatformRequestError && err.status === 409)
          retry.current = null;
        throw err;
      }
    });
  }

  const definition = proposal?.document.definition;
  return (
    <section className="strategy-chat kx-chat" aria-label="Strategy chat">
      <div
        ref={conversation}
        className="strategy-chat-messages kx-chat-log"
        role="log"
        aria-label="Conversation"
      >
        {messages.length === 0 && (
          <div className="kx-chat-welcome">
            <span className="kx-chat-orb">
              <Sparkles size={22} aria-hidden />
            </span>
            <h3>What should your agent trade?</h3>
            <p>
              Describe the market, when to buy, when to sell and how much to
              risk. You can refine the draft in follow-up messages.
            </p>
            <div className="kx-chips">
              {suggestions.map((text) => (
                <button
                  key={text}
                  type="button"
                  disabled={busy}
                  onClick={() => send(undefined, text)}
                >
                  {text}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((message) => (
          <div
            key={message.id}
            className="strategy-chat-message kx-bubble"
            data-role={message.role}
          >
            <span className="kx-bubble-avatar" aria-hidden>
              {message.role === "user" ? (
                <UserRound size={15} />
              ) : (
                <Bot size={15} />
              )}
            </span>
            <div>
              <strong className="visually-hidden">
                {message.role === "user" ? "You" : "Strategy assistant"}
              </strong>
              <p>{message.text}</p>
              {message.model && <small>{message.model}</small>}
            </div>
          </div>
        ))}
        {pending && (
          <div className="kx-bubble" data-role="assistant" role="status">
            <span className="kx-bubble-avatar" aria-hidden>
              <Bot size={15} />
            </span>
            <div className="kx-typing">
              <span />
              <span />
              <span />
              <small>{pending}</small>
            </div>
          </div>
        )}
      </div>
      {error && (
        <p role="alert" className="platform-error">
          {error}
        </p>
      )}
      {proposal && definition && (
        <section
          className="strategy-chat-preview kx-strategy-card"
          aria-label="Validated strategy draft"
        >
          <h4>{proposal.document.name}</h4>
          <p>
            {definition.asset}/USD · {definition.timeframe ?? "1h"} · Long only
          </p>
          <dl>
            <div>
              <dt>Entry</dt>
              <dd>{describeRules(definition.entry)}</dd>
            </div>
            <div>
              <dt>Exit</dt>
              <dd>{describeRules(definition.exit)}</dd>
            </div>
            <div>
              <dt>Position size</dt>
              <dd>{percent(definition.cash_fraction)} of cash</dd>
            </div>
            <div>
              <dt>Stop loss</dt>
              <dd>{percent(definition.stop_loss)}</dd>
            </div>
            {definition.take_profit && (
              <div>
                <dt>Take profit</dt>
                <dd>{percent(definition.take_profit)}</dd>
              </div>
            )}
            {definition.trailing_stop && (
              <div>
                <dt>Trailing stop</dt>
                <dd>{percent(definition.trailing_stop)}</dd>
              </div>
            )}
          </dl>
          <div className="platform-product-actions">
            {onEdit && (
              <button
                type="button"
                disabled={busy}
                onClick={() => onEdit(proposal.document, proposal.saved)}
              >
                Edit strategy
              </button>
            )}
            <button
              type="button"
              disabled={busy || Boolean(proposal.saved)}
              onClick={() =>
                void run("Saving strategy…", async () => {
                  const saved = await onSave(proposal.document);
                  setProposal({ ...proposal, saved });
                })
              }
            >
              {proposal.saved
                ? `Saved v${proposal.saved.version}`
                : "Save strategy"}
            </button>
            {!proposal.agentId && (
              <button
                type="button"
                disabled={busy}
                aria-expanded={showSettings}
                onClick={() => setShowSettings(!showSettings)}
              >
                Run as paper agent
              </button>
            )}
          </div>
          {showSettings && (
            <form onSubmit={start} className="strategy-chat-start">
              <p>
                The worker runs a backtest and applies risk checks before
                placing simulated orders.
              </p>
              <fieldset className="platform-backtest-fields" disabled={busy}>
                <legend>Paper agent settings</legend>
                <PaperAgentFields name={proposal.document.name} />
              </fieldset>
              <button className="primary" disabled={busy}>
                Start paper agent
              </button>
            </form>
          )}
          {proposal.agentId && (
            <p role="status">
              Paper agent queued for validation.{" "}
              <a href={workspaceHref("agents", `?agent=${proposal.agentId}`)}>
                View paper agent
              </a>
            </p>
          )}
        </section>
      )}
      <form onSubmit={send} className="strategy-chat-compose kx-composer">
        <label htmlFor="strategy-prompt" className="visually-hidden">
          Trading prompt
        </label>
        <textarea
          id="strategy-prompt"
          rows={2}
          maxLength={2000}
          value={prompt}
          placeholder={
            proposal
              ? "Refine it: “use 3% per trade”, “switch to SOL”, “add a 5% take profit”…"
              : "Describe your strategy…"
          }
          disabled={busy}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              send();
            }
          }}
        />
        <button
          className="primary"
          aria-label="Send prompt"
          disabled={busy || !prompt.trim()}
        >
          <Send size={16} aria-hidden />
        </button>
      </form>
    </section>
  );
}
