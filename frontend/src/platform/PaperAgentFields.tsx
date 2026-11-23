export function paperAgentSettings(form: FormData) {
  return {
    name: String(form.get("name")).trim(),
    capital: form.get("capital"),
    interval_seconds: Number(form.get("interval")),
    max_drawdown: (Number(form.get("drawdown")) / 100).toFixed(3),
    max_daily_loss: (Number(form.get("loss")) / 100).toFixed(3),
  };
}

export function PaperAgentFields({ name = "" }: { name?: string }) {
  return (
    <>
      <label>
        Agent name
        <input name="name" defaultValue={name} maxLength={120} required />
      </label>
      <label>
        Allocated virtual USDT
        <input
          name="capital"
          type="number"
          min="0.01"
          max="100000"
          step="0.01"
          placeholder="Enter an amount"
          required
        />
      </label>
      <details
        className="paper-agent-advanced"
        onInvalidCapture={(event) => {
          event.currentTarget.open = true;
        }}
      >
        <summary>Advanced agent settings</summary>
        <div className="platform-backtest-fields">
          <label>
            Evaluation interval (seconds)
            <input
              name="interval"
              type="number"
              min="10"
              max="3600"
              defaultValue="60"
              required
            />
          </label>
          <label>
            Maximum drawdown (%)
            <input
              name="drawdown"
              type="number"
              min="0.1"
              max="10"
              step="0.1"
              defaultValue="10"
              required
            />
          </label>
          <label>
            Maximum daily loss (%)
            <input
              name="loss"
              type="number"
              min="0.1"
              max="3"
              step="0.1"
              defaultValue="3"
              required
            />
          </label>
        </div>
      </details>
    </>
  );
}
