import type { LLMProvider, LLMRequest, LLMResponse } from "./llm.interface.js";

import {
  interpretStrategy,
  type StrategyDocument,
  type StrategyTurn,
} from "../../product/strategy-intent.js";

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
    if (request.outputSchema?.name !== "paper_strategy_draft") {
      return reply(request, {
        notes: "Strategy authoring requires a trading prompt.",
      });
    }
    const data = JSON.parse(raw) as {
      user_turns: StrategyTurn[];
      current_document?: StrategyDocument;
      assets: string[];
    };
    const decision = interpretStrategy(
      data.user_turns,
      data.current_document,
      data.assets,
    );
    return reply(request, {
      status: decision.status,
      strategy_json:
        decision.status === "READY" ? JSON.stringify(decision.document) : "",
      notes: decision.status === "UNSUPPORTED" ? decision.notes : "",
      missing_fields:
        decision.status === "NEEDS_CLARIFICATION"
          ? decision.missing_fields
          : [],
      questions:
        decision.status === "NEEDS_CLARIFICATION" ? decision.questions : [],
    });
  }
}

function insight(raw: string) {
  try {
    const data = JSON.parse(raw) as {
      asset: string;
      market?: { candles: { close: string | number }[] };
      headlines?: { title: string; scope: string }[];
      news_status?: string;
      indicators?: {
        rsi?: string | number | null;
        macd?: string | number | null;
        regime?: string | null;
      } | null;
    };
    const rsi = Number(data.indicators?.rsi ?? NaN);
    const macd = Number(data.indicators?.macd ?? NaN);
    const parts: string[] = [];
    const closes = data.market?.candles ?? [];
    const start = Number(closes[0]?.close);
    const end = Number(closes.at(-1)?.close);
    if (closes.length > 1 && start > 0 && Number.isFinite(end)) {
      const change = (end / start - 1) * 100;
      parts.push(
        `${data.asset} changed ${change.toFixed(2)}% from the first to the last of ${closes.length} hourly closes.`,
      );
    }
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
    const assetNews =
      data.headlines?.filter((item) => item.scope === "asset") ?? [];
    const broader = data.headlines?.find((item) => item.scope !== "asset");
    const news = assetNews.length
      ? assetNews
          .slice(0, 2)
          .map((item) => `Reported: ${item.title}`.slice(0, 260))
      : [
          data.news_status === "unavailable"
            ? `News coverage for ${data.asset} was unavailable.`
            : `No matching ${data.asset} headlines were found in the past 48 hours.`,
        ];
    if (broader) news.push(`Broader market: ${broader.title}`.slice(0, 260));
    return {
      summary: closes.length
        ? `Hourly chart and recent news for ${data.asset}.`
        : `Recent news for ${data.asset}. Hourly candles were unavailable.`,
      observations: parts.length
        ? parts
        : [`No chart observations were available for ${data.asset}.`],
      news_analysis: news,
      uncertainty:
        "The hourly chart and headlines cannot establish what drove price changes or what will happen next.",
    };
  } catch {
    return {
      summary: "Market evidence could not be read.",
      observations: ["Chart evidence unavailable."],
      news_analysis: ["News evidence unavailable."],
      uncertainty: "No interpretation is possible without indicators.",
    };
  }
}
