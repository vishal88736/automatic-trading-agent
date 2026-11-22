"""Minimal signed Binance Spot client for linked user accounts.

Only the calls Krono needs: account balances, key permissions, market orders sized in USDT,
order lookup by client ID, and cancelling open orders. Requests are HMAC-SHA256 signed per
https://developers.binance.com/docs/binance-spot-api-docs/rest-api/request-security
"""

from __future__ import annotations

import hashlib
import hmac
import time
from decimal import Decimal
from typing import Literal
from urllib.parse import urlencode

import httpx

Environment = Literal["testnet", "live"]
BASE_URLS: dict[str, str] = {
    "live": "https://api.binance.com",
    "testnet": "https://testnet.binance.vision",
}


class BinanceError(Exception):
    def __init__(self, status: int, code: int | None, message: str):
        super().__init__(message)
        self.status, self.code, self.message = status, code, message

    @property
    def unknown_outcome(self) -> bool:
        """True when Binance may have accepted the order despite the error."""
        return self.status >= 500 or self.code == -1007


def sign(secret: str, query: str) -> str:
    return hmac.new(secret.encode(), query.encode(), hashlib.sha256).hexdigest()


class BinanceClient:
    def __init__(
        self,
        api_key: str,
        api_secret: str,
        environment: Environment,
        *,
        transport: httpx.BaseTransport | None = None,
        clock=time.time,
    ):
        self.environment = environment
        self.secret = api_secret
        self.clock = clock
        self.client = httpx.Client(
            base_url=BASE_URLS[environment],
            timeout=httpx.Timeout(10, connect=5),
            transport=transport,
            headers={"X-MBX-APIKEY": api_key, "User-Agent": "Krono/0.1"},
        )

    def close(self):
        self.client.close()

    def _request(self, method: str, path: str, params: dict | None = None, signed=True):
        params = {k: v for k, v in (params or {}).items() if v is not None}
        if signed:
            params["recvWindow"] = 5000
            params["timestamp"] = int(self.clock() * 1000)
            query = urlencode(params)
            query += "&signature=" + sign(self.secret, query)
        else:
            query = urlencode(params)
        try:
            response = self.client.request(method, path + ("?" + query if query else ""))
        except httpx.TimeoutException as exc:
            raise BinanceError(504, None, "Binance did not respond in time") from exc
        except httpx.HTTPError as exc:
            raise BinanceError(503, None, "Binance is unreachable") from exc
        try:
            body = response.json()
        except ValueError:
            body = {}
        if response.status_code >= 400:
            message = body.get("msg") if isinstance(body, dict) else None
            raise BinanceError(
                response.status_code,
                body.get("code") if isinstance(body, dict) else None,
                message or f"Binance request failed ({response.status_code})",
            )
        return body

    def account(self) -> dict:
        return self._request("GET", "/api/v3/account", {"omitZeroBalances": "true"})

    def api_restrictions(self) -> dict:
        """Key permissions. Only the live API has this endpoint; testnet keys hold test funds."""
        return self._request("GET", "/sapi/v1/account/apiRestrictions")

    def market_order(
        self, symbol: str, side: Literal["BUY", "SELL"], quote_amount: Decimal, client_id: str
    ) -> dict:
        return self._request(
            "POST",
            "/api/v3/order",
            {
                "symbol": symbol,
                "side": side,
                "type": "MARKET",
                "quoteOrderQty": format(quote_amount.normalize(), "f"),
                "newClientOrderId": client_id,
                "newOrderRespType": "FULL",
            },
        )

    def order(self, symbol: str, client_id: str) -> dict:
        return self._request(
            "GET", "/api/v3/order", {"symbol": symbol, "origClientOrderId": client_id}
        )

    def open_orders(self, symbol: str) -> list[dict]:
        return self._request("GET", "/api/v3/openOrders", {"symbol": symbol})

    def cancel_open_orders(self, symbol: str) -> list[dict]:
        try:
            return self._request("DELETE", "/api/v3/openOrders", {"symbol": symbol})
        except BinanceError as exc:
            if exc.code == -2011:  # No open orders for this symbol.
                return []
            raise


def fill_summary(order: dict) -> dict:
    """Executed quantity, quote spent or received, average price and fees from a response."""
    executed = Decimal(str(order.get("executedQty") or "0"))
    quote = Decimal(str(order.get("cummulativeQuoteQty") or "0"))
    fees: dict[str, Decimal] = {}
    for fill in order.get("fills") or []:
        asset = fill.get("commissionAsset")
        if asset:
            fees[asset] = fees.get(asset, Decimal(0)) + Decimal(str(fill.get("commission", "0")))
    return {
        "executed_qty": executed,
        "quote_filled": quote,
        "average_price": (quote / executed).quantize(Decimal("0.00000001")) if executed else None,
        "fees": {asset: format(amount, "f") for asset, amount in fees.items()},
    }
