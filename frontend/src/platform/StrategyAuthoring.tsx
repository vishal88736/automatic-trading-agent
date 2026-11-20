import { useEffect, useState } from "react";
import { platform } from "./client";

interface Rule {
  indicator: string;
  operator: string;
  threshold: string | number;
}
interface Group {
  combine?: "all" | "any";
  conditions: Rule[];
}
interface Strategy {
  name: string;
  description?: string;
  definition: {
    asset: string;
    timeframe?: string;
    entry: Group;
    exit: Group;
    cash_fraction: string | number;
    stop_loss: string | number;
    take_profit?: string | number | null;
    trailing_stop?: string | number | null;
  };
}
interface Options {
  assets: string[];
  timeframes: string[];
  indicators: string[];
  operators: string[];
  templates: Strategy[];
}
const defaultRule = { indicator: "rsi", operator: "lt", threshold: "30" };
function readVisual(text: string): Strategy | null {
  try {
    const value: Strategy = JSON.parse(text);
    for (const key of ["entry", "exit"] as const) {
      const rules = value.definition[key].conditions;
      if (
        !Array.isArray(rules) ||
        !rules.length ||
        rules.some((rule) => !rule || typeof rule.indicator !== "string")
      )
        return null;
    }
    return value;
  } catch {
    return null;
  }
}

function Choices({ items }: { items: string[] }) {
  return (
    <>
      {items.map((item) => (
        <option value={item} key={item}>
          {item.replaceAll("_", " ")}
        </option>
      ))}
    </>
  );
}

export function StrategyAuthoring({
  draft,
  disabled,
  onChange,
  onTemplate,
}: {
  draft: string;
  disabled: boolean;
  onChange: (draft: string) => void;
  onTemplate: (draft: string) => void;
}) {
  const [mode, setMode] = useState<"json" | "visual" | "natural">("json");
  const [options, setOptions] = useState<Options>();
  const [objective, setObjective] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [generating, setGenerating] = useState(false);
  useEffect(() => {
    let active = true;
    platform<Options>("/strategy-authoring")
      .then((value) => {
        if (active) setOptions(value);
      })
      .catch((err: Error) => {
        if (active) setError(err.message);
      });
    return () => {
      active = false;
    };
  }, []);

  const visual = readVisual(draft);
  function patch(definition: Partial<Strategy["definition"]>) {
    if (visual)
      onChange(
        JSON.stringify(
          { ...visual, definition: { ...visual.definition, ...definition } },
          null,
          2,
        ),
      );
  }
  async function generate() {
    setGenerating(true);
    setError("");
    setNotice("");
    try {
      const result = await platform<{
        document: Strategy | null;
        notes: string;
        model: string;
      }>("/strategy-authoring/generate", "POST", { objective });
      setNotice(`${result.model} · ${result.notes}`);
      if (result.document) {
        onTemplate(JSON.stringify(result.document, null, 2));
        setMode("json");
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setGenerating(false);
    }
  }

  return (
    <>
      <div
        className="platform-product-actions"
        aria-label="Strategy authoring method"
      >
        {(
          [
            ["json", "Structured JSON"],
            ["visual", "Visual builder"],
            ["natural", "Natural language"],
          ] as const
        ).map(([key, label]) => (
          <button
            type="button"
            key={key}
            aria-pressed={mode === key}
            disabled={disabled || generating}
            onClick={() => setMode(key)}
          >
            {label}
          </button>
        ))}
      </div>
      {options && (
        <label>
          Strategy template
          <select
            value=""
            disabled={disabled || generating}
            onChange={(event) => {
              const template = options.templates.find(
                (item) => item.name === event.target.value,
              );
              if (template) {
                onTemplate(JSON.stringify(template, null, 2));
                setMode("visual");
              }
            }}
          >
            <option value="">Choose a template to edit</option>
            <Choices items={options.templates.map((item) => item.name)} />
          </select>
        </label>
      )}
      {mode === "json" && (
        <>
          <label htmlFor="strategy-document">Strategy JSON</label>
          <textarea
            id="strategy-document"
            spellCheck={false}
            value={draft}
            disabled={disabled}
            rows={18}
            onChange={(event) => onChange(event.target.value)}
          />
        </>
      )}
      {mode === "natural" && (
        <>
          <label htmlFor="strategy-objective">Trading objective</label>
          <textarea
            id="strategy-objective"
            maxLength={2000}
            value={objective}
            rows={5}
            onChange={(event) => setObjective(event.target.value)}
          />
          <button
            type="button"
            disabled={disabled || generating || objective.trim().length < 10}
            onClick={() => void generate()}
          >
            {generating ? "Generating draft…" : "Generate strategy draft"}
          </button>
          <p>Generated rules stay in the editor for review and saving.</p>
        </>
      )}
      {mode === "visual" &&
        (!visual || !options ? (
          <p>
            Load a template or correct the strategy document to use the visual
            builder.
          </p>
        ) : (
          <fieldset disabled={disabled}>
            <legend>Hourly spot rules</legend>
            <div className="platform-backtest-fields">
              <label>
                Strategy name
                <input
                  value={visual.name}
                  onChange={(event) =>
                    onChange(
                      JSON.stringify(
                        { ...visual, name: event.target.value },
                        null,
                        2,
                      ),
                    )
                  }
                />
              </label>
              <label>
                Asset
                <select
                  value={visual.definition.asset}
                  onChange={(event) => patch({ asset: event.target.value })}
                >
                  <Choices items={options.assets} />
                </select>
              </label>
              <label>
                Timeframe
                <select
                  value={visual.definition.timeframe ?? "1h"}
                  onChange={(event) => patch({ timeframe: event.target.value })}
                >
                  <Choices items={options.timeframes} />
                </select>
              </label>
              {(
                [
                  ["cash_fraction", "Position sizing (fraction)"],
                  ["stop_loss", "Stop loss (fraction)"],
                  ["take_profit", "Take profit (fraction)"],
                  ["trailing_stop", "Trailing stop (fraction)"],
                ] as const
              ).map(([key, label]) => (
                <label key={key}>
                  {label}
                  <input
                    type="number"
                    min="0"
                    max="1"
                    step="0.000001"
                    value={visual.definition[key] ?? ""}
                    onChange={(event) =>
                      patch({ [key]: event.target.value || null })
                    }
                  />
                </label>
              ))}
            </div>
            <datalist id="strategy-indicator-options">
              <Choices items={options.indicators} />
            </datalist>
            {(["entry", "exit"] as const).map((key) => {
              const group = visual.definition[key];
              return (
                <fieldset key={key}>
                  <legend>
                    {key === "entry" ? "Entry conditions" : "Exit conditions"}
                  </legend>
                  <label>
                    Match
                    <select
                      value={group.combine ?? "all"}
                      onChange={(event) =>
                        patch({
                          [key]: { ...group, combine: event.target.value },
                        })
                      }
                    >
                      <option value="all">All (AND)</option>
                      <option value="any">Any (OR)</option>
                    </select>
                  </label>
                  {group.conditions.map((rule, index) => {
                    const change = (update: Partial<Rule>) =>
                      patch({
                        [key]: {
                          ...group,
                          conditions: group.conditions.map((current, n) =>
                            n === index ? { ...current, ...update } : current,
                          ),
                        },
                      });
                    return (
                      <div className="platform-backtest-fields" key={index}>
                        <label>
                          Indicator
                          <select
                            value={rule.indicator}
                            onChange={(event) =>
                              change({ indicator: event.target.value })
                            }
                          >
                            <Choices items={options.indicators} />
                          </select>
                        </label>
                        <label>
                          Comparison
                          <select
                            value={rule.operator}
                            onChange={(event) =>
                              change({ operator: event.target.value })
                            }
                          >
                            <Choices items={options.operators} />
                          </select>
                        </label>
                        <label>
                          Value or indicator
                          <input
                            list="strategy-indicator-options"
                            value={rule.threshold}
                            onChange={(event) =>
                              change({ threshold: event.target.value })
                            }
                          />
                        </label>
                        <button
                          type="button"
                          disabled={group.conditions.length <= 1}
                          onClick={() =>
                            patch({
                              [key]: {
                                ...group,
                                conditions: group.conditions.filter(
                                  (_, n) => n !== index,
                                ),
                              },
                            })
                          }
                        >
                          Remove rule
                        </button>
                      </div>
                    );
                  })}
                  <button
                    type="button"
                    disabled={group.conditions.length >= 12}
                    onClick={() =>
                      patch({
                        [key]: {
                          ...group,
                          conditions: [...group.conditions, defaultRule],
                        },
                      })
                    }
                  >
                    Add {key} rule
                  </button>
                </fieldset>
              );
            })}
          </fieldset>
        ))}
      {error && (
        <p className="platform-error" role="alert">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
    </>
  );
}
