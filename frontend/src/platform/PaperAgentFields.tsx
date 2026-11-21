export function paperAgentSettings(form: FormData) {
  return {
    name: form.get("name"),
    capital: form.get("capital"),
    interval_seconds: Number(form.get("interval")),
    max_drawdown: form.get("drawdown"),
    max_daily_loss: form.get("loss"),
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
          defaultValue="1000"
          required
        />
      </label>
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
        Drawdown cap (fraction)
        <input
          name="drawdown"
          type="number"
          min="0.001"
          max="0.10"
          step="0.001"
          defaultValue="0.10"
          required
        />
      </label>
      <label>
        Daily loss cap (fraction)
        <input
          name="loss"
          type="number"
          min="0.001"
          max="0.03"
          step="0.001"
          defaultValue="0.03"
          required
        />
      </label>
    </>
  );
}
