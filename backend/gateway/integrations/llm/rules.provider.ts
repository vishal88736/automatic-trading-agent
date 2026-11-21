import type { LLMProvider, LLMRequest, LLMResponse } from "./llm.interface.js";

/**
 * A deterministic stand-in for a model, so strategy chat works without any provider key.
 * It understands common phrasing for the supported hourly indicators and risk settings,
 * revises a current draft in place, and says plainly what it could not interpret.
 */

type Condition = {
  indicator: string;
  operator: string;
  threshold: string;
};
type Strategy = {
  name: string;
  description: string;
  definition: {
    schema_version?: number;
    asset: "BTC" | "ETH" | "SOL";
    timeframe?: string;
    entry: { combine?: string; conditions: Condition[] };
    exit: { combine?: string; conditions: Condition[] };
    cash_fraction: string;
    stop_loss: string;
    take_profit?: string | null;
    trailing_stop?: string | null;
  };
};

const ASSETS: Array<[Strategy["definition"]["asset"], RegExp]> = [
  ["BTC", /\b(btc|bitcoin|xbt)\b/i],
  ["ETH", /\b(eth|ether|ethereum)\b/i],
  ["SOL", /\b(sol|solana)\b/i],
];

const fraction = (value: number) =>
  String(Math.round(Math.min(Math.max(value, 0.001), 0.99) * 10000) / 10000);

function percentAfter(
  text: string,
  ...patterns: RegExp[]
): number | undefined {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const value = match ? Number(match[1]) : NaN;
    if (Number.isFinite(value) && value > 0) return value / 100;
  }
  return undefined;
}

function number(text: string, pattern: RegExp): string | undefined {
  const match = text.match(pattern);
  return match ? String(Number(match[1])) : undefined;
}

function single(indicator: string, operator: string, threshold: string) {
  return { conditions: [{ indicator, operator, threshold }] };
}

interface Template {
  label: string;
  test: RegExp;
  build(text: string): Pick<Strategy["definition"], "entry" | "exit">;
}

const templates: Template[] = [
  {
    label: "RSI mean reversion",
    test: /\brsi\b|oversold|overbought|buy (the )?dips?|mean.?reversion/i,
    build(text) {
      const low =
        number(
          text,
          /rsi[^.\d]{0,30}(?:below|under|<|less than|drops? to)\s*(\d{1,2})/i,
        ) ??
        number(text, /oversold[^.\d]{0,20}(\d{1,2})/i) ??
        "30";
      const high =
        number(
          text,
          /rsi[^.\d]{0,40}(?:above|over|>|greater than|reaches|hits)\s*(\d{1,2})/i,
        ) ??
        number(text, /overbought[^.\d]{0,20}(\d{1,2})/i) ??
        "70";
      return {
        entry: single("rsi", "lt", low),
        exit: single("rsi", "gt", high),
      };
    },
  },
  {
    label: "MACD crossover",
    test: /\bmacd\b/i,
    build: () => ({
      entry: single("macd", "crosses_above", "macd_signal"),
      exit: single("macd", "crosses_below", "macd_signal"),
    }),
  },
  {
    label: "Bollinger band reversion",
    test: /bollinger|\bbands?\b/i,
    build: () => ({
      entry: single("price", "lt", "bb_lower"),
      exit: single("price", "gte", "bb_mid"),
    }),
  },
  {
    label: "20-hour breakout",
    test: /breakout|break out|new high|range high/i,
    build: () => ({
      entry: single("price", "gt", "prior_high_20"),
      exit: single("price", "lt", "prior_low_20"),
    }),
  },
  {
    label: "Trend following",
    test: /\b(sma|50.?(hour|period|bar))\b|trend/i,
    build: () => ({
      entry: {
        combine: "all",
        conditions: [
          { indicator: "price", operator: "gt", threshold: "sma50" },
          { indicator: "ema_fast", operator: "gt", threshold: "ema_slow" },
        ],
      },
      exit: single("price", "lt", "sma50"),
    }),
  },
  {
    label: "EMA crossover",
    test: /\bema\b|moving average|golden cross|crossover|momentum/i,
    build: () => ({
      entry: single("ema_fast", "crosses_above", "ema_slow"),
      exit: single("ema_fast", "crosses_below", "ema_slow"),
    }),
  },
];

export function draftStrategy(objective: string, current?: Strategy) {
  const text = objective.replace(/\s+/g, " ").trim();
  const understood: string[] = [];
  const asset =
    ASSETS.find(([, pattern]) => pattern.test(text))?.[0] ??
    current?.definition.asset ??
    "BTC";
  if (!current || asset !== current.definition.asset)
    understood.push(`asset ${asset}`);

  const template = templates.find((item) => item.test.test(text));
  let rules = current
    ? { entry: current.definition.entry, exit: current.definition.exit }
    : undefined;
  if (template) {
    rules = template.build(text);
    understood.push(`${template.label} rules`);
  }

  const risk = /conservative|safe|low risk/i.test(text)
    ? "conservative"
    : /aggressive|high risk|degen/i.test(text)
      ? "aggressive"
      : undefined;
  const preset = {
    conservative: { cash: 0.02, stop: 0.02 },
    aggressive: { cash: 0.1, stop: 0.06 },
  };
  let cash = current ? Number(current.definition.cash_fraction) : 0.05;
  let stop = current ? Number(current.definition.stop_loss) : 0.04;
  if (risk) {
    cash = preset[risk].cash;
    stop = preset[risk].stop;
    understood.push(`${risk} sizing`);
  }
  const size = percentAfter(
    text,
    /(?:use|risk|allocate|position(?: size)?|size|invest)\s*(?:of\s*)?(\d+(?:\.\d+)?)\s*%/i,
    /(\d+(?:\.\d+)?)\s*%\s*(?:per trade|of (?:my )?(?:cash|capital|balance)|position)/i,
  );
  if (size) {
    cash = size;
    understood.push(`${(size * 100).toFixed(1)}% of cash per entry`);
  }
  const stopLoss = percentAfter(
    text,
    /stop(?:[- ]?loss)?\s*(?:at|of|to)?\s*(\d+(?:\.\d+)?)\s*%/i,
    /(\d+(?:\.\d+)?)\s*%\s*stop/i,
  );
  if (stopLoss) {
    stop = stopLoss;
    understood.push(`${(stopLoss * 100).toFixed(1)}% stop loss`);
  }
  const takeProfit = percentAfter(
    text,
    /(?:take[- ]?profit|target|tp)\s*(?:at|of|to)?\s*(\d+(?:\.\d+)?)\s*%/i,
    /(\d+(?:\.\d+)?)\s*%\s*(?:take[- ]?profit|target|profit target)/i,
  );
  const trailing = percentAfter(
    text,
    /trailing(?: stop)?\s*(?:at|of|to)?\s*(\d+(?:\.\d+)?)\s*%/i,
    /(\d+(?:\.\d+)?)\s*%\s*trailing/i,
  );
  if (takeProfit)
    understood.push(`${(takeProfit * 100).toFixed(1)}% take profit`);
  if (trailing)
    understood.push(`${(trailing * 100).toFixed(1)}% trailing stop`);

  if (!rules) return { strategy: null, understood };

  const named = text.match(
    /(?:call it|named?|title)\s+["']?([^"'.,]{2,60})/i,
  )?.[1];
  const name =
    named?.trim() ??
    (template
      ? `${asset} ${template.label}`
      : (current?.name ?? `${asset} strategy`));
  const strategy: Strategy = {
    name,
    description: (current && !template
      ? current.description
      : `Drafted from: ${text}`
    ).slice(0, 2000),
    definition: {
      asset,
      entry: rules.entry,
      exit: rules.exit,
      cash_fraction: fraction(cash),
      stop_loss: fraction(Math.min(stop, 0.5)),
      take_profit: takeProfit
        ? fraction(takeProfit)
        : (current?.definition.take_profit ?? null),
      trailing_stop: trailing
        ? fraction(trailing)
        : (current?.definition.trailing_stop ?? null),
    },
  };
  return { strategy, understood };
}

const HELP =
  "I could not find trading rules in that message. Try something like: " +
  '"Buy ETH when RSI drops below 30 and sell above 70, 5% per trade, 3% stop loss", ' +
  '"MACD crossover on BTC with a 6% take profit", or "aggressive SOL breakout".';

function reply(request: LLMRequest, payload: unknown): LLMResponse {
  void request;
  return {
    message: {
      role: "assistant",
      content: [{ text: JSON.stringify(payload) }],
    },
    stopReason: "end_turn",
    modelId: "krono-rules",
    usage: { inputTokens: null, outputTokens: null },
    durationMs: 0,
  };
}

export class RulesProvider implements LLMProvider {
  async converse(request: LLMRequest): Promise<LLMResponse> {
    const input = request.messages.at(-1)?.content.find((b) => "text" in b);
    const raw = input && "text" in input ? input.text : "";
    if (request.outputSchema?.name === "paper_market_insight") {
      return reply(request, insight(raw));
    }
    let objective = raw;
    let current: Strategy | undefined;
    try {
      const parsed = JSON.parse(raw) as {
        objective?: string;
        current_document?: string;
      };
      if (typeof parsed.objective === "string") {
        objective = parsed.objective;
        current = parsed.current_document
          ? (JSON.parse(parsed.current_document) as Strategy)
          : undefined;
      }
    } catch {
      // A first message is plain text.
    }
    const { strategy, understood } = draftStrategy(objective, current);
    if (!strategy) return reply(request, { strategy_json: "", notes: HELP });
    const notes = understood.length
      ? `Understood: ${understood.join(", ")}. Hourly candles, long only. Review the rules, then backtest or start a paper agent.`
      : "No changes detected; the current draft is unchanged.";
    return reply(request, {
      strategy_json: JSON.stringify(strategy),
      notes: notes.slice(0, 1200),
    });
  }
}

function insight(raw: string) {
  try {
    const data = JSON.parse(raw) as {
      asset: string;
      indicators?: {
        rsi?: string | number | null;
        macd?: string | number | null;
        regime?: string | null;
      } | null;
    };
    const rsi = Number(data.indicators?.rsi);
    const macd = Number(data.indicators?.macd);
    const parts: string[] = [];
    if (Number.isFinite(rsi))
      parts.push(
        `RSI is ${rsi.toFixed(1)}${rsi < 30 ? ", in the oversold zone" : rsi > 70 ? ", in the overbought zone" : ", in a neutral range"}.`,
      );
    if (Number.isFinite(macd))
      parts.push(
        `MACD is ${macd >= 0 ? "positive, showing upward" : "negative, showing downward"} short-term momentum.`,
      );
    if (data.indicators?.regime)
      parts.push(`The regime classifier reads ${data.indicators.regime}.`);
    return {
      observations: (
        parts.join(" ") || `No indicators were available for ${data.asset}.`
      ).slice(0, 1000),
      uncertainty:
        "Indicators describe recent hourly candles only. They cannot establish future direction, and regimes can change abruptly.",
    };
  } catch {
    return {
      observations: "Market evidence could not be read.",
      uncertainty: "No interpretation is possible without indicators.",
    };
  }
}
