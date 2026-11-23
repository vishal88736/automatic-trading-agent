import { Bot, Send, Sparkles, UserRound } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { money, percent } from "../ui";
import { platform, PlatformRequestError } from "./client";
import { workspaceHref } from "./navigation";
import { PaperAgentFields, paperAgentSettings } from "./PaperAgentFields";
import type {
  RuleGroup,
  StrategyDocument,
  StrategyRevision,
} from "./strategy-types";

type QuestionField =
  | "asset"
  | "entry"
  | "exit"
  | "cash_fraction"
  | "stop_loss"
  | "take_profit"
  | "trailing_stop"
  | "max_position_usdt"
  | "strategy";

interface Question {
  field: QuestionField;
  question: string;
  options: string[];
}

interface Turn {
  text: string;
  answer_to?: QuestionField;
}

interface Message {
  id: string;
  role: "user" | "assistant";
  text: string;
  model?: string;
  question?: Question;
}

interface DraftReply {
  status: "READY" | "NEEDS_CLARIFICATION" | "UNSUPPORTED";
  document: StrategyDocument | null;
  notes: string;
  questions: Question[];
  model?: string;
}

interface Proposal {
  document: StrategyDocument;
  saved?: StrategyRevision;
  agentId?: string;
}

const example =
  "Buy ETH when RSI is below 30 and sell when RSI is above 70. Use 5% of available cash per entry and a 3% stop loss.";

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
  initialDocument,
  onEdit,
  onSave,
  onStarted,
}: {
  disabled?: boolean;
  initialDocument?: StrategyDocument;
  onEdit?: (document: StrategyDocument, saved?: StrategyRevision) => void;
  onSave: (document: StrategyDocument) => Promise<StrategyRevision>;
  onStarted?: (strategy: StrategyRevision) => void;
}) {
  const [prompt, setPrompt] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [pendingTurn, setPendingTurn] = useState<Message>();
  const [question, setQuestion] = useState<{ id: string; value: Question }>();
  const history = useRef<Turn[]>([]);
  const inFlight = useRef(false);
  const composer = useRef<HTMLTextAreaElement>(null);
  const focusComposer = useRef(false);
  const [proposal, setProposal] = useState<Proposal>();
  const [showSettings, setShowSettings] = useState(false);
  const [pending, setPending] = useState("");
  const [error, setError] = useState("");
  const conversation = useRef<HTMLDivElement>(null);
  const previousDraft = useRef<StrategyDocument | null>(
    initialDocument ?? null,
  );
  const retry = useRef<{ input: string; key: string; epoch?: number } | null>(
    null,
  );
  const busy = disabled || Boolean(pending);

  useEffect(() => {
    if (conversation.current)
      conversation.current.scrollTop = conversation.current.scrollHeight;
  }, [messages, pending]);

  useEffect(() => {
    if (!busy && focusComposer.current) {
      focusComposer.current = false;
      composer.current?.focus({ preventScroll: true });
    }
  }, [busy]);

  async function run(label: string, action: () => Promise<void>) {
    if (disabled || inFlight.current) return;
    inFlight.current = true;
    setError("");
    setPending(label);
    try {
      await action();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      inFlight.current = false;
      setPending("");
    }
  }

  function send(event?: FormEvent<HTMLFormElement>, text?: string) {
    event?.preventDefault();
    const objective = (text ?? prompt).trim();
    if (busy || inFlight.current || !objective) return;
    const turn = { text: objective, answer_to: question?.value.field };
    const user: Message = {
      id: crypto.randomUUID(),
      role: "user",
      text: objective,
    };
    focusComposer.current = true;
    setShowSettings(false);
    setProposal(undefined);
    // A failed request leaves the reply in the composer for a retry.
    setPrompt(objective);
    void run("Reading your instructions…", async () => {
      setPendingTurn(user);
      try {
        const reply = await platform<DraftReply>(
          "/strategy-authoring/generate",
          "POST",
          {
            objective,
            answer_to: turn.answer_to,
            history: history.current.slice(-16),
            current_document: previousDraft.current
              ? JSON.stringify(previousDraft.current)
              : undefined,
          },
        );
        const ready = reply.status === "READY" && reply.document;
        const followUp =
          reply.status === "NEEDS_CLARIFICATION"
            ? reply.questions[0]
            : undefined;
        const assistant: Message = {
          id: crypto.randomUUID(),
          role: "assistant",
          text: followUp ? "" : reply.notes,
          question: followUp,
          model: reply.model,
        };
        setMessages((items) => [...items.slice(-30), user, assistant]);
        setQuestion(
          followUp ? { id: assistant.id, value: followUp } : undefined,
        );
        setPrompt("");
        if (ready) {
          previousDraft.current = ready;
          history.current = [];
          setProposal({ document: ready });
        } else {
          history.current = [...history.current.slice(-16), turn];
        }
      } finally {
        setPendingTurn(undefined);
      }
    });
  }

  function reset() {
    previousDraft.current = initialDocument ?? null;
    history.current = [];
    retry.current = null;
    setQuestion(undefined);
    setMessages([]);
    setProposal(undefined);
    setShowSettings(false);
    setPrompt("");
    setError("");
    composer.current?.focus();
  }

  function start(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || inFlight.current || !proposal || proposal.agentId) return;
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
      {messages.length > 0 && (
        <div className="strategy-chat-toolbar">
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={reset}
          >
            New conversation
          </button>
        </div>
      )}
      <div
        ref={conversation}
        className="strategy-chat-messages kx-chat-log"
        role="log"
        aria-label="Conversation"
      >
        {messages.length === 0 && !pendingTurn && (
          <div className="kx-chat-welcome">
            <span className="kx-chat-orb">
              <Sparkles size={22} aria-hidden />
            </span>
            <h3>
              {initialDocument
                ? "How should this strategy change?"
                : "What should your agent trade?"}
            </h3>
            <p>
              {initialDocument
                ? `Editing from ${initialDocument.name}. Describe the rules you want to change.`
                : "Describe what to trade, when to enter and exit, how much cash to use, and your stop loss. The builder asks about missing details before you can run the strategy on hourly paper markets."}
            </p>
            {!initialDocument && (
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => {
                  setPrompt(example);
                  composer.current?.focus();
                }}
              >
                Fill in an example prompt
              </button>
            )}
          </div>
        )}
        {(pendingTurn ? [...messages, pendingTurn] : messages).map(
          (message) => (
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
                {message.text && <p>{message.text}</p>}
                {message.question && (
                  <div className="strategy-chat-question">
                    <p id={`strategy-question-${message.id}`}>
                      {message.question.question}
                    </p>
                    {question?.id === message.id &&
                      message.question.options.length > 0 && (
                        <div className="platform-product-actions">
                          {message.question.options.map((option) => (
                            <button
                              key={option}
                              type="button"
                              disabled={busy}
                              onClick={() => send(undefined, option)}
                            >
                              {option}
                            </button>
                          ))}
                        </div>
                      )}
                  </div>
                )}
                {message.model && (
                  <small>
                    {message.model === "krono-rules"
                      ? "Rules-based interpreter"
                      : message.model}
                  </small>
                )}
              </div>
            </div>
          ),
        )}
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
            {definition.max_position_usdt != null && (
              <div>
                <dt>Maximum entry budget</dt>
                <dd>{money(definition.max_position_usdt)}</dd>
              </div>
            )}
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
          ref={composer}
          id="strategy-prompt"
          aria-describedby={
            question ? `strategy-question-${question.id}` : undefined
          }
          rows={2}
          maxLength={2000}
          value={prompt}
          placeholder={
            question
              ? "Answer the follow-up question…"
              : proposal
                ? "Describe a change to these rules…"
                : "Describe your strategy…"
          }
          disabled={busy}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing
            ) {
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
