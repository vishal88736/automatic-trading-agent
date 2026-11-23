import { Decimal } from "decimal.js";
import { z } from "zod";

const fields = [
  "asset",
  "entry",
  "exit",
  "cash_fraction",
  "stop_loss",
  "take_profit",
  "trailing_stop",
  "max_position_usdt",
] as const;
const required = fields.slice(0, 5);
export const questionField = z.enum([...fields, "strategy"]);
export type QuestionField = z.infer<typeof questionField>;
type StrategyField = (typeof fields)[number];

export interface StrategyTurn {
  text: string;
  answer_to?: QuestionField;
}

export interface StrategyQuestion {
  field: QuestionField;
  question: string;
  options: string[];
}

export type StrategyDocument = z.infer<typeof strategyDocumentSchema>;
type Definition = StrategyDocument["definition"];
type Condition = z.infer<typeof conditionSchema>;

export type StrategyDecision =
  | { status: "READY"; document: StrategyDocument }
  | {
      status: "NEEDS_CLARIFICATION";
      missing_fields: QuestionField[];
      questions: StrategyQuestion[];
    }
  | { status: "UNSUPPORTED"; notes: string };

const aliases: Readonly<Record<string, string>> = {
  bitcoin: "BTC",
  xbt: "BTC",
  ethereum: "ETH",
  ether: "ETH",
  solana: "SOL",
  cardano: "ADA",
  avalanche: "AVAX",
  pepe: "PEPE",
  dogecoin: "DOGE",
  shiba: "SHIB",
  "shiba inu": "SHIB",
  ripple: "XRP",
  chainlink: "LINK",
  polkadot: "DOT",
  litecoin: "LTC",
  "bitcoin cash": "BCH",
  "near protocol": "NEAR",
};

const categories = [
  [/\bmemes?\b|\bmemecoins?\b/i, ["DOGE", "SHIB", "PEPE", "BONK", "WIF"]],
  [
    /\b(?:ai\s+(?:tokens?|coins?)|artificial intelligence)\b/i,
    ["FET", "RENDER", "TAO", "NEAR", "AKT"],
  ],
  [/\bdefi\b/i, ["UNI", "AAVE", "LINK", "MKR", "COMP"]],
  [/\blayer\s*2\b/i, ["ARB", "OP", "STRK", "ZK", "POL"]],
] as const;

const messages: Record<QuestionField, string> = {
  asset: "Which cryptocurrency should the strategy trade?",
  entry:
    "What exact condition should open a position? You can specify an indicator, comparison, and threshold.",
  exit: "What exact condition should close the position?",
  cash_fraction:
    "What percentage of available cash should the agent use per entry?",
  stop_loss:
    "What percentage below the entry price should trigger the stop loss?",
  take_profit:
    "What percentage gain should trigger take profit, or should take profit be turned off?",
  trailing_stop:
    "What trailing-stop percentage should the strategy use, or should it be turned off?",
  max_position_usdt:
    "What maximum position amount in USD or USDT should apply, or should the cap be removed?",
  strategy:
    "Which trading rule do you want to add or change? Please include the condition and its threshold.",
};

export function questionFor(
  field: QuestionField,
  options: string[] = [],
): StrategyQuestion {
  return { field, question: messages[field], options };
}

export function clarification(
  missing_fields: QuestionField[],
  options: string[] = [],
): Extract<StrategyDecision, { status: "NEEDS_CLARIFICATION" }> {
  const field = missing_fields[0] ?? "strategy";
  return {
    status: "NEEDS_CLARIFICATION",
    missing_fields: missing_fields.length ? missing_fields : [field],
    questions: [questionFor(field, options)],
  };
}

const quoteSuffix =
  /(?:\s*[/:\-]\s*(?:USDT|USDC|USD|EUR|BTC|ETH|PERP|SWAP))(?=$|\b)/gi;
const actions =
  /\b(?:(enter and exit)|(buy|enter|(?<!per )entry(?! price))|(sell|exit|close (?:the )?position))\b/gi;
const contextualWords = new Set([
  "WHEN",
  "IF",
  "ON",
  "THE",
  "A",
  "AN",
  "AT",
  "ABOVE",
  "BELOW",
  "USING",
  "WITH",
  "PRICE",
  "RSI",
  "MACD",
  "ATR",
  "ADX",
  "EMA",
  "SMA",
  "SIGNAL",
  "CASH",
  "AND",
  "OR",
  "TOP",
  "MEME",
  "MEMECOINS",
  "AI",
  "COINS",
  "TOKENS",
  "CRYPTO",
  "THIS",
  "THAT",
  "IT",
  "ONLY",
  "AS",
  "PER",
  "RULE",
  "ENTRY",
  "EXIT",
  "TRADE",
  "LONG",
  "WHENEVER",
  "AFTER",
  "BEFORE",
  "OVER",
  "UNDER",
  "STOP",
  "MARKET",
]);

function normalizeAsset(value: string) {
  const raw = value.trim().replace(/^\$/, "").replace(quoteSuffix, "");
  const name = raw.toLowerCase();
  return Object.hasOwn(aliases, name) ? aliases[name] : raw.toUpperCase();
}

function mentionedAssets(turn: StrategyTurn, allowed: Set<string>) {
  const text = turn.text
    .replace(quoteSuffix, "")
    .replace(/\$\d[\d,.]*(?!\w)|(?<=\d)\s+(?:USDT|USD)\b/gi, " ");
  const candidates = new Set<string>();
  const standalone = normalizeAsset(text.replace(/[.!?]$/, ""));
  if (allowed.has(standalone)) candidates.add(standalone);
  for (const pair of turn.text.matchAll(
    /\b([a-z0-9]{2,20})[/-](?:USDT|USDC|USD|PERP|SWAP)\b/gi,
  ))
    candidates.add(normalizeAsset(pair[1]));
  // Longest names first so "Bitcoin Cash" is one asset.
  const names = Object.keys(aliases).sort((a, b) => b.length - a.length);
  const scanned = text.replace(
    new RegExp(`\\b(?:${names.join("|")})\\b`, "gi"),
    (name) => {
      candidates.add(normalizeAsset(name));
      return " ";
    },
  );
  for (const match of scanned.matchAll(
    /\$[a-z0-9]{2,20}\b|\b[A-Z][A-Z0-9]{1,19}\b/g,
  )) {
    const symbol = normalizeAsset(match[0]);
    if (
      !contextualWords.has(symbol) &&
      (allowed.has(symbol) || match[0].startsWith("$"))
    )
      candidates.add(symbol);
  }
  for (const match of text.matchAll(
    /\b(?:trade|buy|sell|switch to|asset\s*[:=]|market\s*[:=])\s+\$?([a-z0-9]{2,20})\b/gi,
  )) {
    const symbol = normalizeAsset(match[1]);
    if (
      !contextualWords.has(symbol) &&
      (allowed.has(symbol) || match[1] === symbol)
    )
      candidates.add(symbol);
  }
  if (turn.answer_to === "asset") {
    const symbol = normalizeAsset(turn.text.replace(/[.!?]$/, ""));
    if (/^[A-Z0-9]{2,20}$/.test(symbol) && !contextualWords.has(symbol))
      candidates.add(symbol);
  }
  return [...candidates];
}

const indicators = {
  price: "price",
  "close price": "price",
  "closing price": "price",
  close: "price",
  rsi: "rsi",
  "rsi 14": "rsi",
  macd: "macd",
  "macd line": "macd",
  "macd signal": "macd_signal",
  "macd signal line": "macd_signal",
  atr: "atr",
  "atr 14": "atr",
  "fast ema": "ema_fast",
  "ema fast": "ema_fast",
  "ema 12": "ema_fast",
  "12 period ema": "ema_fast",
  "slow ema": "ema_slow",
  "ema slow": "ema_slow",
  "ema 26": "ema_slow",
  "26 period ema": "ema_slow",
  sma50: "sma50",
  "sma 50": "sma50",
  "50 period sma": "sma50",
  "50 hour sma": "sma50",
  "bb lower": "bb_lower",
  "lower bollinger band": "bb_lower",
  "bb middle": "bb_mid",
  "bb mid": "bb_mid",
  "middle bollinger band": "bb_mid",
  "bb upper": "bb_upper",
  "upper bollinger band": "bb_upper",
  "volume ratio": "volume_ratio",
  "prior high 20": "prior_high_20",
  "prior low 20": "prior_low_20",
  "prior 20 bar high": "prior_high_20",
  "prior 20 bar low": "prior_low_20",
} as const;

const operators = {
  "<": "lt",
  ">": "gt",
  "<=": "lte",
  ">=": "gte",
  "≤": "lte",
  "≥": "gte",
  below: "lt",
  under: "lt",
  "less than": "lt",
  "at or below": "lte",
  "at most": "lte",
  above: "gt",
  over: "gt",
  "greater than": "gt",
  "at or above": "gte",
  "at least": "gte",
  "crosses above": "crosses_above",
  "crosses below": "crosses_below",
} as const;

const indicatorName = z.enum([...new Set(Object.values(indicators))]);
const operatorName = z.enum([...new Set(Object.values(operators))]);
const amountSchema = z.union([z.string(), z.number()]);
const conditionSchema = z.strictObject({
  indicator: indicatorName,
  operator: operatorName,
  threshold: amountSchema,
});
const combineSchema = z.enum(["all", "any"]);
const groupSchema = z.strictObject({
  combine: combineSchema,
  conditions: z.array(conditionSchema).min(1).max(12),
});

// Required keys and nullable optional values give structured-output providers
// the same trade fields as the saved definition, in a closed JSON object.
export const generatedDefinitionSchema = z.strictObject({
  schema_version: z.literal(1),
  asset: z.string(),
  timeframe: z.literal("1h"),
  entry: groupSchema,
  exit: groupSchema,
  cash_fraction: amountSchema,
  stop_loss: amountSchema,
  take_profit: amountSchema.nullable(),
  trailing_stop: amountSchema.nullable(),
  max_position_usdt: amountSchema.nullable(),
});

const savedGroupSchema = groupSchema.partial({ combine: true });
export const strategyDocumentSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  definition: generatedDefinitionSchema
    .partial({
      schema_version: true,
      timeframe: true,
      take_profit: true,
      trailing_stop: true,
      max_position_usdt: true,
    })
    .extend({ entry: savedGroupSchema, exit: savedGroupSchema }),
});

function indicator(value: string) {
  const key = value
    .toLowerCase()
    .replace(/^the\s+/, "")
    .replace(/[()_-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return Object.hasOwn(indicators, key)
    ? indicators[key as keyof typeof indicators]
    : undefined;
}

function removeLeadingAsset(text: string, asset?: string) {
  return text
    .replace(/^(\$?[a-z0-9]+(?:\s+[a-z]+)?)(?=\s)/i, (value) => {
      if (normalizeAsset(value) === asset) return "";
      const [first] = value.split(/\s/);
      return normalizeAsset(first) === asset
        ? value.slice(first.length)
        : value;
    })
    .trim();
}

function readCondition(text: string, asset?: string): Condition | undefined {
  const comparison = text.match(
    /^(.+?)\s*(crosses[\s_]+(?:above|below)|at\s+or\s+(?:above|below)|at least|at most|less than|greater than|<=|>=|≤|≥|<|>|\bbelow\b|\bunder\b|\babove\b|\bover\b)\s*(.+)$/i,
  );
  if (!comparison) return;
  const [, rawLeft, rawOperator, rawRight] = comparison;
  const left = indicator(
    removeLeadingAsset(
      rawLeft.replace(/\s+(?:is|goes|drops|falls|rises|moves)\s*$/i, "").trim(),
      asset,
    ),
  );
  if (!left) return;
  const operator =
    operators[
      rawOperator.toLowerCase().replace(/[\s_]+/g, " ") as keyof typeof operators
    ];
  const right = rawRight.trim();
  const reference =
    left === "macd" && /^(?:(?:its|the) )?signal(?: line)?$/i.test(right)
      ? "macd_signal"
      : indicator(right);
  if (reference) return { indicator: left, operator, threshold: reference };
  const numeric =
    right.match(/^(-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|-?\.\d+)$/)?.[1] ??
    (left === "price" || left === "atr"
      ? right.match(
          /^\$?((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|\.\d+)\s*(?:USD)?$/i,
        )?.[1]
      : undefined);
  if (numeric === undefined) return;
  const value = new Decimal(numeric.replaceAll(",", ""));
  if (left === "rsi" && (value.lt(0) || value.gt(100))) return;
  if (["price", "atr"].includes(left) && value.lt(0)) return;
  return { indicator: left, operator, threshold: value.toFixed() };
}

function readGroup(
  text: string,
  asset?: string,
): Definition["entry"] | undefined {
  const normalized = text
    .replace(quoteSuffix, "")
    .replace(/\bat or (above|below)\b/gi, "at_or_$1")
    .replace(/^(?:[:=,]\s*|(?:when|if|once|rule)\s+)+/i, "")
    .replace(/\s+(?:when|if|once)\s+/i, (cue, index: number, source: string) =>
      normalizeAsset(source.slice(0, index)) === asset ? " " : cue,
    )
    .trim();
  const joins = [...normalized.matchAll(/\s+(and|or)\s+/gi)].map((match) =>
    match[1].toLowerCase(),
  );
  if (new Set(joins).size > 1) return;
  const conditions = normalized
    .split(/\s+(?:and|or)\s+/i)
    .map((clause) =>
      readCondition(clause.replace(/at_or_/gi, "at or "), asset),
    );
  if (!conditions.every((item) => item !== undefined) || conditions.length > 12)
    return;
  return { combine: joins[0] === "or" ? "any" : "all", conditions };
}

const percent =
  "(?<![+\\d.-])(-?(?:\\d+(?:\\.\\d+)?|\\.\\d+))\\s*(?:%|percent\\b)";
const budgetNumber = "-?(?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d+)?";
const positionCap = "(?:max(?:imum)? position(?: size)?|position cap)";
const positionCapLabel = new RegExp(`\\b${positionCap}\\b`, "i");
const positionCapAmount = new RegExp(
  `\\b${positionCap}\\s*(?:[:=]|at|of|to|is)?\\s*(?:\\$(${budgetNumber})(?![\\w,]|\\.\\d)|(${budgetNumber})\\s*(?:USDT|USD)\\b)`,
  "gi",
);
const removePositionCap = new RegExp(
  `\\b(?:remove|disable|no|turn off)\\s+(?:the\\s+)?${positionCap}\\b`,
  "i",
);
const riskRules = {
  cash_fraction: [
    `${percent}\\s*(?:per (?:trade|entry)|of (?:available |my |the )?(?:cash|capital|balance))`,
    `(?:position size|entry size|allocation)\\s*(?:[:=]|at|is|of|to)?\\s*${percent}`,
    `(?:allocate|size (?:each|the) trade at)\\s*${percent}`,
  ],
  stop_loss: [
    `\\bstop[ -]loss\\s*(?:[:=]|at|is|of|to)?\\s*${percent}`,
    `${percent}\\s+stop[ -]loss\\b`,
  ],
  take_profit: [
    `\\btake[ -]profit\\s*(?:[:=]|at|is|of|to)?\\s*${percent}`,
    `${percent}\\s+take[ -]profit\\b`,
  ],
  trailing_stop: [
    `\\btrailing[ -]stop\\s*(?:[:=]|at|is|of|to)?\\s*${percent}`,
    `${percent}\\s+trailing[ -]stop\\b`,
  ],
} as const;

function endOfRule(value: string) {
  return value
    .split(
      /;|[.!?](?=\s|$)|[, ]+(?:(?:with|using|and)\s+)?(?=(?:use\s+|risk\s+|allocate\s+|max(?:imum)? position|position cap|position size|entry size|allocation|stop[ -]loss|take[ -]profit|trailing[ -]stop|\d+(?:\.\d+)?\s*(?:%|percent)))/i,
    )[0]
    .replace(
      /\s+(?:on|using)\s+(?:the\s+)?(?:1\s*h(?:our)?|hourly)(?:\s+candles?)?\s*$/i,
      "",
    )
    .replace(/[,\s]+(?:and|then)\s*$/i, "")
    .replace(/[,.:!?\s]+$/, "")
    .trim();
}

function unsupported(text: string) {
  if (
    /\b(?:nifty(?:\s*50)?|aapl|tsla|msft|nasdaq|s&p\s*500|forex|equities|(?:eur|gbp)\s*[\/-]\s*(?:usd|jpy))\b/i.test(
      text,
    )
  )
    return "Choose a supported cryptocurrency. This builder supports spot crypto markets.";
  const instrumentText = text.replace(quoteSuffix, "");
  if (
    /\b(?:short(?:ing)?\s+(?:\$?[a-z0-9]+|positions?)|perpetuals?|futures|leverag(?:e|ed)|margin trading)\b/i.test(
      instrumentText,
    )
  )
    return "This builder supports long-only spot rules. Rephrase the request as a spot strategy.";
  if (
    /\b(?:weekends?|weekdays?|mondays?|tuesdays?|wednesdays?|thursdays?|fridays?|saturdays?|sundays?|(?:at|after|before)\s+\d{1,2}(?::\d{2})?\s*(?:am|pm|UTC))\b/i.test(
      text,
    )
  )
    return "The strategy engine does not support trading schedules. Specify rules that apply on every eligible hourly close.";
  if (
    /\badx\b|\b(?:ema|sma|rsi|atr)\s*[-_(]?\s*\d+\b/i.test(
      text.replace(
        /\b(?:ema\s*[-_(]?\s*(?:12|26)|sma\s*[-_(]?\s*50|rsi\s*[-_(]?\s*14|atr\s*[-_(]?\s*14)\b/gi,
        "",
      ),
    )
  )
    return "Choose a supported indicator with its built-in period. ADX and custom indicator periods are unavailable.";
}

function timeframeRequest(text: string) {
  if (/\b(?:daily|weekly)\s+(?:candles?|chart|timeframe)\b/i.test(text))
    return "unsupported";
  const intervals = [
    ...text.matchAll(
      /\b(\d+(?:\.\d+)?)\s*(m|min(?:ute)?s?|h(?:ours?)?|d(?:ays?)?|w(?:eeks?)?)\b/gi,
    ),
  ];
  if (
    intervals.some(
      ([, amount, unit]) =>
        !(Number(amount) === 1 && unit.toLowerCase().startsWith("h")),
    )
  )
    return "unsupported";
  return intervals.length || /\bhourly\b/i.test(text) ? "hourly" : undefined;
}

export function interpretStrategy(
  turns: StrategyTurn[],
  current: StrategyDocument | undefined,
  assets: readonly string[],
): StrategyDecision {
  const allowed = new Set(assets);
  const draft: Partial<Definition> = { ...current?.definition };
  const unresolved = new Set<StrategyField>();
  let categoryOptions: string[] = [];
  let incompatible: string | undefined;
  let timeframe: ReturnType<typeof timeframeRequest>;
  let changed = false;
  let name = current?.name;

  for (const turn of turns) {
    const text = turn.text.trim().replace(/\s+/g, " ");
    timeframe = timeframeRequest(text) ?? timeframe;
    const conflict = unsupported(text);
    if (conflict) {
      incompatible = conflict;
      continue;
    }
    if (
      /\b(?:spot only|use spot|long only)\b/i.test(text) &&
      incompatible?.includes("long-only spot")
    )
      incompatible = undefined;

    const requested = mentionedAssets(turn, allowed);
    if (requested.length === 1 && !allowed.has(requested[0])) {
      incompatible = `${requested[0]} is unavailable in the paper market catalog. Choose a supported ticker.`;
      continue;
    }
    if (requested.length === 1) {
      if (
        incompatible?.includes("paper market catalog") ||
        incompatible?.includes("spot crypto markets")
      )
        incompatible = undefined;
      draft.asset = requested[0];
      unresolved.delete("asset");
      changed = true;
    } else {
      const category = categories.find(([pattern]) => pattern.test(text));
      if (
        category ||
        requested.length > 1 ||
        turn.answer_to === "asset" ||
        /\b(?:switch to|change (?:the )?(?:asset|coin) to)\b/i.test(text)
      ) {
        unresolved.add("asset");
        categoryOptions = (category ? category[1] : requested)
          .filter((symbol) => allowed.has(symbol))
          .slice(0, 4);
      }
    }

    const cues = [...text.matchAll(actions)];
    const ruleText: Partial<Record<"entry" | "exit", string[]>> = {};
    for (const [index, cue] of cues.entries()) {
      const rule = endOfRule(
        text.slice(cue.index + cue[0].length, cues[index + 1]?.index),
      );
      // A buy/sell mention alone can name a market or a position size.
      if (
        !rule ||
        normalizeAsset(rule) === draft.asset ||
        /^\d+(?:\.\d+)?\s*(?:%|percent)/i.test(rule)
      )
        continue;
      if (cue[1] || cue[2]) (ruleText.entry ??= []).push(rule);
      if (cue[1] || cue[3]) (ruleText.exit ??= []).push(rule);
    }
    for (const field of ["entry", "exit"] as const) {
      const clauses = ruleText[field];
      const answer = !cues.length && turn.answer_to === field;
      if (!clauses && !answer) continue;
      const rule =
        !clauses || clauses.length === 1
          ? readGroup(clauses?.[0] ?? endOfRule(text), draft.asset)
          : undefined;
      if (rule) {
        draft[field] = rule;
        unresolved.delete(field);
        changed = true;
      } else {
        unresolved.add(field);
      }
    }

    for (const field of [
      "cash_fraction",
      "stop_loss",
      "take_profit",
      "trailing_stop",
    ] as const) {
      const values = new Set(
        riskRules[field].flatMap((pattern) =>
          [...text.matchAll(new RegExp(pattern, "gi"))].map((match) =>
            new Decimal(match[1]).div(100).toFixed(),
          ),
        ),
      );
      if (turn.answer_to === field) {
        const bare =
          text.match(new RegExp(`^${percent}[.!]?$`, "i")) ??
          text.match(/^(-?(?:\d+(?:\.\d+)?|\.\d+))[.!]?$/);
        if (bare) values.add(new Decimal(bare[1]).div(100).toFixed());
      }
      const [value] = values;
      const label = field.replace("_", "[ -]");
      const remove =
        (field === "take_profit" || field === "trailing_stop") &&
        (new RegExp(
          `\\b(?:no|remove|disable|turn off)\\s+(?:the\\s+)?${label}\\b`,
          "i",
        ).test(text) ||
          (turn.answer_to === field && /^(?:off|none|no)[.!]?$/i.test(text)));
      if (remove && !values.size) {
        draft[field] = null;
        unresolved.delete(field);
        changed = true;
      } else if (
        values.size === 1 &&
        !remove &&
        Number(value) > 0 &&
        (field === "cash_fraction" ? Number(value) <= 1 : Number(value) < 1) &&
        new Decimal(value).decimalPlaces() <= 6
      ) {
        draft[field] = value;
        unresolved.delete(field);
        changed = true;
      } else if (
        values.size ||
        turn.answer_to === field ||
        new RegExp(`\\b${label}\\b`, "i").test(text)
      ) {
        unresolved.add(field);
      }
    }

    if (positionCapLabel.test(text) || turn.answer_to === "max_position_usdt") {
      const values = new Set(
        [...text.matchAll(positionCapAmount)].map((match) =>
          new Decimal((match[1] ?? match[2]).replaceAll(",", "")).toFixed(),
        ),
      );
      const answer =
        turn.answer_to === "max_position_usdt"
          ? text.match(new RegExp(`^\\$?(${budgetNumber})\\s*(?:USDT|USD)?[.!]?$`, "i"))
          : null;
      if (answer) values.add(new Decimal(answer[1].replaceAll(",", "")).toFixed());
      const [amount] = values;
      const remove =
        removePositionCap.test(text) ||
        (turn.answer_to === "max_position_usdt" &&
          /^(?:off|none|no)[.!]?$/i.test(text));
      if (remove && !values.size) {
        draft.max_position_usdt = null;
        unresolved.delete("max_position_usdt");
        changed = true;
      } else if (
        values.size === 1 &&
        !remove &&
        new Decimal(amount).gt(0) &&
        new Decimal(amount).lte(100000) &&
        new Decimal(amount).decimalPlaces() <= 6
      ) {
        draft.max_position_usdt = amount;
        unresolved.delete("max_position_usdt");
        changed = true;
      } else {
        unresolved.add("max_position_usdt");
      }
    }

    const title = text
      .match(/\b(?:call it|name it|named)\s+["']?([^"'.,;]{2,120})/i)?.[1]
      ?.trim();
    if (title) {
      name = title;
      changed = true;
    }
  }
  if (incompatible) return { status: "UNSUPPORTED", notes: incompatible };
  if (timeframe === "unsupported")
    return {
      status: "UNSUPPORTED",
      notes: "Krono evaluates closed 1-hour candles. Specify 1h to continue.",
    };
  const missing = fields.filter(
    (field) =>
      unresolved.has(field) ||
      (required.includes(field) && draft[field] == null),
  );
  if (missing.length)
    return clarification(
      missing,
      missing[0] === "asset" ? categoryOptions : [],
    );
  if (!changed || !draft.asset || !allowed.has(draft.asset)) {
    const result = clarification(["strategy"]);
    if (new RegExp(percent, "i").test(turns.at(-1)?.text ?? ""))
      result.questions[0].question =
        "Which setting should that percentage change? Please give the setting and its value.";
    return result;
  }
  return {
    status: "READY",
    document: {
      name: name ?? `${draft.asset} strategy`,
      description: current?.description ?? "",
      definition: { ...draft, timeframe: "1h" } as Definition,
    },
  };
}

function comparable(value: Definition[StrategyField]): string | number | null {
  if (value == null) return null;
  if (typeof value === "object") {
    const conditions = value.conditions.map(
      ({ indicator, operator, threshold }) => [
        indicator,
        operator,
        comparable(threshold),
      ],
    );
    return JSON.stringify([
      conditions.length > 1 ? (value.combine ?? "all") : "all",
      conditions.map((item) => JSON.stringify(item)).sort(),
    ]);
  }
  if (/^-?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?$/i.test(String(value)))
    return new Decimal(value).toFixed();
  return value;
}

export function changedStrategyFields(
  author: Definition,
  proposed: Definition,
) {
  return fields.filter(
    (field) => comparable(author[field]) !== comparable(proposed[field]),
  );
}
