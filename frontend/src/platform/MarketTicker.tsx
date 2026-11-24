import { Sparkline } from "../charts";
import { Coin, money } from "../ui";
import { workspaceHref } from "./navigation";
import { useMarkets } from "./useMarkets";

export function MarketTicker({ detailed = false }: { detailed?: boolean }) {
  const markets = useMarkets();
  return (
    <div
      className={detailed ? "kx-ticker kx-ticker-detailed" : "kx-ticker"}
      role={detailed ? "region" : undefined}
      aria-label="Live prices"
      tabIndex={detailed ? 0 : undefined}
    >
      {(markets ?? [null, null, null]).map((item, index) => {
        const symbol = (
          <span className="kx-ticker-symbol">{item?.asset ?? "···"}</span>
        );
        const price = (
          <span className="kx-num kx-ticker-price" key={item?.price}>
            {money(item?.price)}
          </span>
        );
        const change = item?.change24h != null && (
          <span
            className="kx-num kx-change"
            data-direction={item.change24h >= 0 ? "up" : "down"}
            title="24-hour change"
          >
            {item.change24h >= 0 ? "+" : ""}
            {(item.change24h * 100).toFixed(2)}%
            {detailed && <small className="kx-ticker-period">24h</small>}
          </span>
        );
        const history = item?.history ?? [];
        const movement = (history.at(-1) ?? 0) - (history[0] ?? 0);
        return (
          <a
            key={item?.asset ?? index}
            className="kx-ticker-item"
            href={
              item
                ? workspaceHref("markets", `?asset=${item.asset}`)
                : undefined
            }
            data-loading={!item?.live || undefined}
            data-tick={item?.direction ?? undefined}
            title={item?.live ? `${item.asset}/USDT on Binance` : undefined}
          >
            {item && <Coin symbol={item.asset} />}
            {detailed ? (
              <>
                <span className="kx-ticker-quote">
                  <span className="kx-ticker-heading">
                    {symbol}
                    {change}
                  </span>
                  {price}
                </span>
                {history.length > 1 && (
                  <span
                    className="kx-ticker-history"
                    title="Hourly prices over the past 24 hours"
                  >
                    <Sparkline
                      values={history}
                      positive={movement >= 0}
                      neutral={movement === 0}
                      shaded
                    />
                  </span>
                )}
              </>
            ) : (
              <>
                {symbol}
                {price}
                {change}
              </>
            )}
          </a>
        );
      })}
    </div>
  );
}
