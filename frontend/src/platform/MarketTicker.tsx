import { Coin, money } from "../ui";
import { workspaceHref } from "./navigation";
import { useMarkets } from "./useMarkets";

export function MarketTicker() {
  const markets = useMarkets();
  return (
    <div className="kx-ticker" aria-label="Live prices">
      {(markets ?? [null, null, null]).map((item, index) => (
        <a
          key={item?.asset ?? index}
          className="kx-ticker-item"
          href={
            item ? workspaceHref("markets", `?asset=${item.asset}`) : undefined
          }
          data-loading={!item || undefined}
        >
          {item && <Coin symbol={item.asset} />}
          <span className="kx-ticker-symbol">{item?.asset ?? "···"}</span>
          <span className="kx-num">
            {item?.price != null ? money(item.price) : "—"}
          </span>
          {item?.change24h != null && (
            <span
              className="kx-num kx-change"
              data-direction={item.change24h >= 0 ? "up" : "down"}
            >
              {item.change24h >= 0 ? "+" : ""}
              {(item.change24h * 100).toFixed(2)}%
            </span>
          )}
        </a>
      ))}
    </div>
  );
}
