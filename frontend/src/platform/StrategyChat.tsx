import { Bot, Send } from "lucide-react";
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
  disabled,
  onEdit,
  onSave,
  onStarted,
}: {
  disabled: boolean;
  onEdit: (document: StrategyDocument, saved?: StrategyRevision) => void;
  onSave: (document: StrategyDocument) => Promise<StrategyRevision>;
  onStarted: (strategy: StrategyRevision) => void;
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

  function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const objective = prompt.trim();
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
        if (result.strategy) onStarted(result.strategy);
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
    <section className="strategy-chat" aria-label="Strategy chat">
      <div
        ref={conversation}
        className="strategy-chat-messages"
        role="log"
        aria-label="Conversation"
      >
        {messages.length === 0 && (
          <p className="strategy-chat-welcome">
            <Bot size={20} aria-hidden />
            Describe a strategy to save its rules or start a paper agent.
          </p>
        )}
        {messages.map((message) => (
          <div
            key={message.id}
            className="strategy-chat-message"
            data-role={message.role}
          >
            <strong>
              {message.role === "user" ? "You" : "Strategy assistant"}
            </strong>
            {message.model && <small>{message.model}</small>}
            <p>{message.text}</p>
          </div>
        ))}
      </div>
      <form onSubmit={send} className="strategy-chat-compose">
        <label htmlFor="strategy-prompt">Trading prompt</label>
        <textarea
          id="strategy-prompt"
          rows={3}
          maxLength={2000}
          value={prompt}
          placeholder="Buy BTC below RSI 30 and exit above 65. Use 2% of cash with a 4% stop loss."
          disabled={busy}
          onChange={(event) => setPrompt(event.target.value)}
        />
        <button className="primary" disabled={busy || !prompt.trim()}>
          <Send size={15} aria-hidden /> Send prompt
        </button>
      </form>
      {pending && <p role="status">{pending}</p>}
      {error && (
        <p role="alert" className="platform-error">
          {error}
        </p>
      )}
      {proposal && definition && (
        <section
          className="strategy-chat-preview"
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
            <button
              type="button"
              disabled={busy}
              onClick={() => onEdit(proposal.document, proposal.saved)}
            >
              Edit strategy
            </button>
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
    </section>
  );
}
