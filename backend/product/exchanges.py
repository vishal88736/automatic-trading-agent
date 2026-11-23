"""One interface over the exchanges users can link: Binance, Bybit and OKX.

Each adapter verifies a key's permissions, reads balances, places spot market orders sized in
USDT or in the base asset, looks orders up by Krono's client ID, and cancels open orders.
All three offer free test environments: Binance Spot Testnet, Bybit Testnet and OKX demo
trading.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import re
import time
from datetime import datetime, timezone
from decimal import ROUND_DOWN, Decimal
from typing import Literal, Protocol
from urllib.parse import urlencode
from uuid import UUID

import httpx

from backend.product.errors import LiveRejected
from backend.product.binance import BinanceClient, BinanceError, fill_summary

Exchange = Literal["binance", "bybit", "okx"]
Environment = Literal["testnet", "live"]
Side = Literal["BUY", "SELL"]


def spot_symbols(rows, base_key, quote_key, eligible) -> list[str]:
    return sorted(
        {
            row[base_key]
            for row in rows
            if isinstance(row, dict)
            and isinstance(row.get(base_key), str)
            and re.fullmatch(r"[A-Z0-9]{2,20}", row[base_key])
            and row.get(quote_key) == "USDT"
            and eligible(row)
        }
    )


class ExchangeError(Exception):
    def __init__(self, message: str, *, unknown_outcome=False, not_found=False):
        super().__init__(message)
        self.message = message
        self.unknown_outcome = unknown_outcome
        self.not_found = not_found


def result(status, order_id, executed, quote, fees=None) -> dict:
    executed, quote = Decimal(str(executed or 0)), Decimal(str(quote or 0))
    return {
        "status": status,
        "order_id": str(order_id) if order_id is not None else None,
        "executed_qty": executed,
        "quote_filled": quote,
        "average_price": (quote / executed).quantize(Decimal("0.00000001")) if executed else None,
        "fees": fees or {},
    }


def floor_to_step(quantity: Decimal, step: Decimal) -> Decimal:
    return (quantity / step).to_integral_value(rounding=ROUND_DOWN) * step


class ExchangeClient(Protocol):
    exchange: Exchange
    environment: Environment

    def verify(self) -> dict: ...
    def balances(self) -> list[dict]: ...
    def spot_assets(self, asset: str | None = None) -> list[str]: ...
    def market_order(
        self,
        asset: str,
        side: Side,
        client_id: str,
        *,
        quote_amount: Decimal | None = None,
        quantity: Decimal | None = None,
    ) -> dict: ...
    def order(self, asset: str, client_id: str) -> dict: ...
    def cancel_open_orders(self, asset: str) -> int: ...
    def close(self) -> None: ...


def client_order_id(exchange: Exchange, request_key: UUID) -> str:
    # OKX accepts only letters and digits, up to 32 characters.
    return "kr" + request_key.hex[:30] if exchange == "okx" else "kr-" + request_key.hex


# ---------------------------------------------------------------- Binance
class BinanceAdapter:
    exchange: Exchange = "binance"

    def __init__(self, environment: Environment, credentials: dict, *, transport=None):
        self.environment = environment
        self.raw = BinanceClient(
            credentials["api_key"], credentials["api_secret"], environment, transport=transport
        )
        self._steps: dict[str, Decimal] = {}

    def _call(self, action):
        try:
            return action()
        except BinanceError as exc:
            raise ExchangeError(
                exc.message, unknown_outcome=exc.unknown_outcome, not_found=exc.code == -2013
            ) from None

    def verify(self) -> dict:
        account = self._call(self.raw.account)
        if not account.get("canTrade"):
            raise LiveRejected("This key cannot trade. Enable Spot trading for the key and retry.")
        if self.environment == "testnet":
            return {"can_trade": True, "withdrawals": "testnet funds only", "ip_restricted": None}
        restrictions = self._call(self.raw.api_restrictions)
        if restrictions.get("enableWithdrawals"):
            raise LiveRejected("This key can withdraw funds. Create a key with withdrawals disabled.")
        if not restrictions.get("enableSpotAndMarginTrading"):
            raise LiveRejected("Enable Spot & Margin trading for this key and retry.")
        return {
            "can_trade": True,
            "withdrawals": False,
            "ip_restricted": bool(restrictions.get("ipRestrict")),
        }

    def balances(self) -> list[dict]:
        return [
            {"asset": b["asset"], "free": Decimal(b["free"]), "locked": Decimal(b["locked"])}
            for b in self._call(self.raw.account).get("balances", [])
        ]

    def spot_assets(self, asset=None):
        params = {"symbol": f"{asset}USDT"} if asset else {"symbolStatus": "TRADING"}
        data = self._call(
            lambda: self.raw._request("GET", "/api/v3/exchangeInfo", params, signed=False)
        )
        return spot_symbols(
            data.get("symbols", []),
            "baseAsset",
            "quoteAsset",
            lambda row: (
                row.get("status") == "TRADING"
                and row.get("isSpotTradingAllowed") is True
                and row.get("quoteOrderQtyMarketAllowed") is True
                and "MARKET" in row.get("orderTypes", [])
            ),
        )

    def _step(self, symbol: str) -> Decimal:
        if symbol not in self._steps:
            info = self._call(
                lambda: self.raw._request(
                    "GET", "/api/v3/exchangeInfo", {"symbol": symbol}, signed=False
                )
            )
            lot = next(f for f in info["symbols"][0]["filters"] if f["filterType"] == "LOT_SIZE")
            self._steps[symbol] = Decimal(lot["stepSize"]).normalize()
        return self._steps[symbol]

    @staticmethod
    def _normalize(order: dict) -> dict:
        summary = fill_summary(order)
        return result(
            order.get("status", "UNKNOWN"),
            order.get("orderId"),
            summary["executed_qty"],
            summary["quote_filled"],
            summary["fees"],
        )

    def market_order(self, asset, side, client_id, *, quote_amount=None, quantity=None):
        symbol = asset + "USDT"
        params = {
            "symbol": symbol,
            "side": side,
            "type": "MARKET",
            "newClientOrderId": client_id,
            "newOrderRespType": "FULL",
        }
        if quantity is not None:
            params["quantity"] = format(floor_to_step(quantity, self._step(symbol)), "f")
        else:
            params["quoteOrderQty"] = format(quote_amount.normalize(), "f")
        return self._normalize(
            self._call(lambda: self.raw._request("POST", "/api/v3/order", params))
        )

    def order(self, asset, client_id):
        return self._normalize(self._call(lambda: self.raw.order(asset + "USDT", client_id)))

    def cancel_open_orders(self, asset) -> int:
        return len(self._call(lambda: self.raw.cancel_open_orders(asset + "USDT")))

    def close(self):
        self.raw.close()


# ---------------------------------------------------------------- Bybit (v5 unified account)
class BybitAdapter:
    exchange: Exchange = "bybit"
    BASE = {"live": "https://api.bybit.com", "testnet": "https://api-testnet.bybit.com"}
    STATUS = {
        "Filled": "FILLED",
        "PartiallyFilledCanceled": "PARTIALLY_FILLED",
        "PartiallyFilled": "PARTIALLY_FILLED",
        "New": "NEW",
        "Cancelled": "CANCELED",
        "Rejected": "REJECTED",
    }

    def __init__(self, environment, credentials, *, transport=None, clock=time.time, sleep=None):
        self.environment = environment
        self.key, self.secret = credentials["api_key"], credentials["api_secret"]
        self.clock = clock
        self.sleep = sleep or time.sleep
        self.client = httpx.Client(
            base_url=self.BASE[environment],
            timeout=httpx.Timeout(10, connect=5),
            transport=transport,
        )
        self._steps: dict[str, Decimal] = {}

    def _request(self, method: str, path: str, params: dict | None = None, signed=True):
        params = params or {}
        timestamp, window = str(int(self.clock() * 1000)), "5000"
        if method == "GET":
            payload, content = urlencode(params), None
        else:
            payload = content = json.dumps(params, separators=(",", ":"))
        headers = {"Content-Type": "application/json"}
        if signed:
            signature = hmac.new(
                self.secret.encode(),
                (timestamp + self.key + window + payload).encode(),
                hashlib.sha256,
            ).hexdigest()
            headers |= {
                "X-BAPI-API-KEY": self.key,
                "X-BAPI-SIGN": signature,
                "X-BAPI-SIGN-TYPE": "2",
                "X-BAPI-TIMESTAMP": timestamp,
                "X-BAPI-RECV-WINDOW": window,
            }
        url = path + ("?" + payload if method == "GET" and payload else "")
        try:
            response = self.client.request(method, url, content=content, headers=headers)
        except httpx.TimeoutException:
            raise ExchangeError("Bybit did not respond in time", unknown_outcome=True) from None
        except httpx.HTTPError:
            raise ExchangeError("Bybit is unreachable", unknown_outcome=True) from None
        if response.status_code >= 500:
            raise ExchangeError(f"Bybit error ({response.status_code})", unknown_outcome=True)
        try:
            body = response.json()
        except ValueError:
            raise ExchangeError(f"Bybit error ({response.status_code})") from None
        if body.get("retCode") != 0:
            raise ExchangeError(str(body.get("retMsg") or "Bybit rejected the request"))
        return body.get("result") or {}

    def verify(self) -> dict:
        info = self._request("GET", "/v5/user/query-api")
        permissions = info.get("permissions") or {}
        if info.get("readOnly") or "SpotTrade" not in (permissions.get("Spot") or []):
            raise LiveRejected("This key cannot trade spot. Enable Spot trading for the key.")
        if self.environment == "live" and "Withdraw" in (permissions.get("Wallet") or []):
            raise LiveRejected("This key can withdraw funds. Create a key without Withdraw.")
        ips = info.get("ips") or ["*"]
        return {
            "can_trade": True,
            "withdrawals": False if self.environment == "live" else "testnet funds only",
            "ip_restricted": ips != ["*"],
        }

    def balances(self) -> list[dict]:
        data = self._request("GET", "/v5/account/wallet-balance", {"accountType": "UNIFIED"})
        coins = (data.get("list") or [{}])[0].get("coin") or []
        out = []
        for coin in coins:
            total = Decimal(coin.get("walletBalance") or "0")
            locked = Decimal(coin.get("locked") or "0")
            out.append({"asset": coin["coin"], "free": total - locked, "locked": locked})
        return out

    def spot_assets(self, asset=None):
        params = {"category": "spot"}
        if asset:
            params["symbol"] = f"{asset}USDT"
        data = self._request("GET", "/v5/market/instruments-info", params, signed=False)
        return spot_symbols(
            data.get("list", []),
            "baseCoin",
            "quoteCoin",
            lambda row: row.get("status") == "Trading",
        )

    def _step(self, symbol: str) -> Decimal:
        if symbol not in self._steps:
            data = self._request(
                "GET",
                "/v5/market/instruments-info",
                {"category": "spot", "symbol": symbol},
                signed=False,
            )
            self._steps[symbol] = Decimal(data["list"][0]["lotSizeFilter"]["basePrecision"])
        return self._steps[symbol]

    def _lookup(self, asset: str, client_id: str) -> dict | None:
        for path in ("/v5/order/realtime", "/v5/order/history"):
            rows = self._request(
                "GET",
                path,
                {"category": "spot", "symbol": asset + "USDT", "orderLinkId": client_id},
            ).get("list")
            if rows:
                return rows[0]
        return None

    def _normalize(self, row: dict, side: str) -> dict:
        fee = Decimal(row.get("cumExecFee") or "0")
        # Bybit spot charges buys in the base coin and sells in USDT.
        fee_asset = row["symbol"].removesuffix("USDT") if side == "Buy" else "USDT"
        return result(
            self.STATUS.get(row.get("orderStatus"), "UNKNOWN"),
            row.get("orderId"),
            row.get("cumExecQty"),
            row.get("cumExecValue"),
            {fee_asset: format(fee, "f")} if fee else {},
        )

    def market_order(self, asset, side, client_id, *, quote_amount=None, quantity=None):
        symbol = asset + "USDT"
        body = {
            "category": "spot",
            "symbol": symbol,
            "side": side.title(),
            "orderType": "Market",
            "orderLinkId": client_id,
        }
        if quantity is not None:
            body |= {
                "qty": format(floor_to_step(quantity, self._step(symbol)), "f"),
                "marketUnit": "baseCoin",
            }
        else:
            body |= {"qty": format(quote_amount.normalize(), "f"), "marketUnit": "quoteCoin"}
        self._request("POST", "/v5/order/create", body)
        # Market orders fill almost instantly; read the final state back.
        for _ in range(6):
            row = self._lookup(asset, client_id)
            if row and row.get("orderStatus") not in {"New", "PartiallyFilled", "Created"}:
                return self._normalize(row, body["side"])
            self.sleep(0.25)
        return self._normalize(row, body["side"]) if row else result("NEW", None, 0, 0)

    def order(self, asset, client_id):
        row = self._lookup(asset, client_id)
        if row is None:
            raise ExchangeError("Order does not exist", not_found=True)
        return self._normalize(row, row.get("side", "Buy"))

    def cancel_open_orders(self, asset) -> int:
        data = self._request(
            "POST", "/v5/order/cancel-all", {"category": "spot", "symbol": asset + "USDT"}
        )
        return len(data.get("list") or [])

    def close(self):
        self.client.close()


# ---------------------------------------------------------------- OKX (v5)
class OkxAdapter:
    exchange: Exchange = "okx"
    STATUS = {
        "filled": "FILLED",
        "partially_filled": "PARTIALLY_FILLED",
        "live": "NEW",
        "canceled": "CANCELED",
        "mmp_canceled": "CANCELED",
    }

    def __init__(self, environment, credentials, *, transport=None, clock=None, sleep=None):
        self.environment = environment
        self.key, self.secret = credentials["api_key"], credentials["api_secret"]
        self.passphrase = credentials.get("api_passphrase") or ""
        self.clock = clock or (lambda: datetime.now(timezone.utc))
        self.sleep = sleep or time.sleep
        headers = {"Content-Type": "application/json"}
        if environment == "testnet":
            headers["x-simulated-trading"] = "1"  # OKX demo trading
        self.client = httpx.Client(
            base_url="https://www.okx.com",
            timeout=httpx.Timeout(10, connect=5),
            transport=transport,
            headers=headers,
        )
        self._steps: dict[str, Decimal] = {}

    def _request(self, method: str, path: str, params=None, signed=True):
        if method == "GET":
            path = path + ("?" + urlencode(params) if params else "")
            body = ""
        else:
            body = json.dumps(params or {}, separators=(",", ":"))
        headers = {}
        if signed:
            now = self.clock()
            timestamp = now.strftime("%Y-%m-%dT%H:%M:%S.") + f"{now.microsecond // 1000:03d}Z"
            signature = base64.b64encode(
                hmac.new(
                    self.secret.encode(),
                    (timestamp + method + path + body).encode(),
                    hashlib.sha256,
                ).digest()
            ).decode()
            headers = {
                "OK-ACCESS-KEY": self.key,
                "OK-ACCESS-SIGN": signature,
                "OK-ACCESS-TIMESTAMP": timestamp,
                "OK-ACCESS-PASSPHRASE": self.passphrase,
            }
        try:
            response = self.client.request(method, path, content=body or None, headers=headers)
        except httpx.TimeoutException:
            raise ExchangeError("OKX did not respond in time", unknown_outcome=True) from None
        except httpx.HTTPError:
            raise ExchangeError("OKX is unreachable", unknown_outcome=True) from None
        if response.status_code >= 500:
            raise ExchangeError(f"OKX error ({response.status_code})", unknown_outcome=True)
        try:
            payload = response.json()
        except ValueError:
            raise ExchangeError(f"OKX error ({response.status_code})") from None
        if payload.get("code") != "0":
            detail = (payload.get("data") or [{}])[0] if payload.get("data") else {}
            message = detail.get("sMsg") or payload.get("msg") or "OKX rejected the request"
            raise ExchangeError(
                message, not_found=payload.get("code") in {"51603", "51001"} and "order" in path
            )
        return payload.get("data") or []

    def verify(self) -> dict:
        if not self.passphrase:
            raise LiveRejected("OKX keys need the passphrase you set when creating them.")
        config = self._request("GET", "/api/v5/account/config")[0]
        permissions = {p.strip() for p in str(config.get("perm", "")).split(",")}
        if "trade" not in permissions:
            raise LiveRejected("This key cannot trade. Enable the Trade permission.")
        if self.environment == "live" and "withdraw" in permissions:
            raise LiveRejected("This key can withdraw funds. Create a key without Withdraw.")
        return {
            "can_trade": True,
            "withdrawals": False if self.environment == "live" else "demo funds only",
            "ip_restricted": bool(config.get("ip")),
        }

    def balances(self) -> list[dict]:
        details = (self._request("GET", "/api/v5/account/balance") or [{}])[0].get("details", [])
        return [
            {
                "asset": d["ccy"],
                "free": Decimal(d.get("availBal") or "0"),
                "locked": Decimal(d.get("frozenBal") or "0"),
            }
            for d in details
        ]

    def spot_assets(self, asset=None):
        params = {"instType": "SPOT"}
        if asset:
            params["instId"] = f"{asset}-USDT"
        data = self._request("GET", "/api/v5/public/instruments", params, signed=False)
        return spot_symbols(data, "baseCcy", "quoteCcy", lambda row: row.get("state") == "live")

    def _step(self, inst: str) -> Decimal:
        if inst not in self._steps:
            data = self._request(
                "GET", "/api/v5/public/instruments", {"instType": "SPOT", "instId": inst}, False
            )
            self._steps[inst] = Decimal(data[0]["lotSz"])
        return self._steps[inst]

    def _normalize(self, row: dict) -> dict:
        executed = Decimal(row.get("accFillSz") or "0")
        average = Decimal(row.get("avgPx") or "0")
        fee = abs(Decimal(row.get("fee") or "0"))
        return result(
            self.STATUS.get(row.get("state"), "UNKNOWN"),
            row.get("ordId"),
            executed,
            executed * average,
            {row["feeCcy"]: format(fee, "f")} if fee and row.get("feeCcy") else {},
        )

    def order(self, asset, client_id):
        rows = self._request(
            "GET", "/api/v5/trade/order", {"instId": f"{asset}-USDT", "clOrdId": client_id}
        )
        if not rows:
            raise ExchangeError("Order does not exist", not_found=True)
        return self._normalize(rows[0])

    def market_order(self, asset, side, client_id, *, quote_amount=None, quantity=None):
        inst = f"{asset}-USDT"
        body = {
            "instId": inst,
            "tdMode": "cash",
            "side": side.lower(),
            "ordType": "market",
            "clOrdId": client_id,
        }
        if quantity is not None:
            body |= {
                "sz": format(floor_to_step(quantity, self._step(inst)), "f"),
                "tgtCcy": "base_ccy",
            }
        else:
            body |= {"sz": format(quote_amount.normalize(), "f"), "tgtCcy": "quote_ccy"}
        self._request("POST", "/api/v5/trade/order", body)
        for _ in range(6):
            final = self.order(asset, client_id)
            if final["status"] not in {"NEW", "PARTIALLY_FILLED"}:
                return final
            self.sleep(0.25)
        return final

    def cancel_open_orders(self, asset) -> int:
        inst = f"{asset}-USDT"
        pending = self._request(
            "GET", "/api/v5/trade/orders-pending", {"instType": "SPOT", "instId": inst}
        )
        if not pending:
            return 0
        self._request(
            "POST",
            "/api/v5/trade/cancel-batch-orders",
            [{"instId": inst, "ordId": row["ordId"]} for row in pending[:20]],
        )
        return len(pending[:20])

    def close(self):
        self.client.close()


ADAPTERS = {"binance": BinanceAdapter, "bybit": BybitAdapter, "okx": OkxAdapter}


def create_client(exchange: Exchange, environment: Environment, credentials: dict):
    return ADAPTERS[exchange](environment, credentials)
