export interface Rule {
  indicator: string;
  operator: string;
  threshold: string | number;
}

export interface RuleGroup {
  combine?: "all" | "any";
  conditions: Rule[];
}

export interface StrategyDocument {
  name: string;
  description?: string;
  definition: {
    asset: string;
    timeframe?: string;
    entry: RuleGroup;
    exit: RuleGroup;
    cash_fraction: string | number;
    stop_loss: string | number;
    take_profit?: string | number | null;
    trailing_stop?: string | number | null;
    max_position_usdt?: string | number | null;
  };
}

export interface StrategyRevision {
  id: string;
  version: number;
  document: StrategyDocument;
  created_at: string;
}
