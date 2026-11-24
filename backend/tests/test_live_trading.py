import asyncio
import json
import time
from decimal import Decimal
from urllib.parse import parse_qs, urlsplit
from uuid import uuid4

import httpx
import pytest

from backend.product.binance import BinanceClient, BinanceError, fill_summary, sign
from backend.product.credentials import CredentialVault
from backend.product.live import safe_message
from backend.product.price_hub import PriceHub


def test_signature_matches_binance_documented_example():
    secret = "NhqPtmdSJYdKjVHjA7PZj4Mge3R5YNiP1e3UZjInClVN65XAbvqqM6A7H5fATj0j"
    query = (
        "symbol=LTCBTC&side=BUY&type=LIMIT&timeInForce=GTC&quantity=1&price=0.1"
        "&recvWindow=5000&timestamp=1499827319559"
    )
    assert sign(secret, query) == (
        "c8db56825ae71d6d79447849e617115f4a920fa2acdcab2b053c4b2838bd6b71"
    )


def test_market_orders_are_signed_sized_in_usdt_and_errors_are_typed():
    seen = []

    def handler(request: httpx.Request):
        seen.append(request)
        if request.url.path == "/api/v3/order" and "side=BUY" in str(request.url):
            return httpx.Response(
                200,
                json={
                    "orderId": 7,
                    "status": "FILLED",
                    "executedQty": "0.002",
                    "cummulativeQuoteQty": "120.00",
                    "fills": [
                        {"commission": "0.000001", "commissionAsset": "BTC"},
                        {"commission": "0.000001", "commissionAsset": "BTC"},
                    ],
                },
            )
        return httpx.Response(400, json={"code": -2010, "msg": "Account has insufficient balance"})

    client = BinanceClient(
        "key", "secret", "testnet", transport=httpx.MockTransport(handler), clock=lambda: 1000
    )
    order = client.market_order("BTCUSDT", "BUY", Decimal("120.00"), "kr-abc")
    request = seen[0]
    assert request.url.host == "testnet.binance.vision"
    assert request.headers["X-MBX-APIKEY"] == "key"
    params = parse_qs(urlsplit(str(request.url)).query)
    assert params["quoteOrderQty"] == ["120"]
    assert params["type"] == ["MARKET"] and params["newClientOrderId"] == ["kr-abc"]
    unsigned = str(request.url).split("?", 1)[1].rsplit("&signature=", 1)[0]
    assert params["signature"] == [sign("secret", unsigned)]
    assert fill_summary(order) == {
        "executed_qty": Decimal("0.002"),
        "quote_filled": Decimal("120.00"),
        "average_price": Decimal("60000.00000000"),
        "fees": {"BTC": "0.000002"},
    }
    with pytest.raises(BinanceError) as error:
        client.market_order("BTCUSDT", "SELL", Decimal("5"), "kr-def")
    assert error.value.code == -2010 and not error.value.unknown_outcome
    client.close()


def test_credentials_are_bound_to_their_owner_and_connection():
    vault = CredentialVault(bytes(range(32)))
    owner, connection = uuid4(), uuid4()
    nonce, sealed = vault.seal(owner, connection, {"api_key": "k", "api_secret": "s"})
    assert b"api_secret" not in sealed
    assert vault.open(owner, connection, nonce, sealed) == {"api_key": "k", "api_secret": "s"}
    with pytest.raises(ValueError):
        vault.open(uuid4(), connection, nonce, sealed)
    with pytest.raises(ValueError):
        CredentialVault(bytes(32 * [1])).open(owner, connection, nonce, sealed)


def test_sell_lot_rejects_dust_and_minimum_notional_before_submission():
    from backend.product.exchanges import ExchangeError, SellLot, checked_sell_size

    lot = SellLot(Decimal("0.001"), Decimal("0.002"), Decimal("5"))
    with pytest.raises(ExchangeError, match="minimum quantity"):
        checked_sell_size(Decimal("0.0019"), lambda: lot, lambda: pytest.fail("priced dust"))
    with pytest.raises(ExchangeError, match="minimum notional"):
        checked_sell_size(Decimal("0.0209"), lambda: lot, lambda: "100")
    assert checked_sell_size(Decimal("0.0509"), lambda: lot, lambda: "100") == "0.050"


def test_exchange_messages_never_echo_key_shaped_values():
    assert safe_message("Invalid key " + "A" * 64) == "Invalid key [redacted]"


async def test_price_hub_reads_the_stream_and_rest_and_drops_stale_quotes():
    def handler(request):
        assert json.loads(request.url.params["symbols"]) == ["BTCUSDT", "ETHUSDT", "SOLUSDT"]
        return httpx.Response(
            200,
            json=[
                {
                    "symbol": "ETHUSDT",
                    "lastPrice": "2000",
                    "openPrice": "1900",
                    "highPrice": "2100",
                    "lowPrice": "1850",
                    "quoteVolume": "5",
                    "closeTime": int(time.time() * 1000),
                }
            ],
        )

    hub = PriceHub(transport=httpx.MockTransport(handler), stream=False)
    queue = hub.subscribe()
    await hub.refresh()
    assert hub.price("ETH") == Decimal("2000")
    assert queue.get_nowait()["change_24h"] == round(Decimal(100) / Decimal(1900), 6)

    now_ms = int(time.time() * 1000)
    hub.handle_message(
        json.dumps(
            {
                "stream": "btcusdt@miniTicker",
                "data": {
                    "e": "24hrMiniTicker",
                    "E": now_ms,
                    "s": "BTCUSDT",
                    "c": "60000",
                    "o": "59000",
                    "h": "61000",
                    "l": "58000",
                    "q": "1",
                },
            }
        )
    )
    assert hub.connected and hub.price("BTC") == Decimal("60000")
    hub.prices["BTC"]["at"] = hub.prices["BTC"]["at"].replace(year=2020)
    assert hub.price("BTC") is None
    for _ in range(150):  # A slow subscriber keeps only the most recent quotes.
        hub.update(hub.prices["ETH"])
    assert queue.qsize() == 100
    await hub.stop()
    await asyncio.sleep(0)


def test_bybit_adapter_signs_requests_checks_permissions_and_reads_fills():
    import hashlib
    import hmac as hmac_module

    from backend.product.exchanges import BybitAdapter, ExchangeError

    calls = []
    permissions = {"Spot": ["SpotTrade"], "Wallet": ["AccountTransfer"]}

    def handler(request: httpx.Request):
        calls.append(request)
        path = request.url.path
        if "X-BAPI-SIGN" in request.headers:
            payload = (
                request.url.query.decode() if request.method == "GET" else request.content.decode()
            )
            expected = hmac_module.new(
                b"secret",
                (request.headers["X-BAPI-TIMESTAMP"] + "key" + "5000" + payload).encode(),
                hashlib.sha256,
            ).hexdigest()
            assert request.headers["X-BAPI-SIGN"] == expected
        if path == "/v5/user/query-api":
            return httpx.Response(
                200,
                json={
                    "retCode": 0,
                    "result": {"readOnly": 0, "permissions": permissions, "ips": ["1.2.3.4"]},
                },
            )
        if path == "/v5/market/instruments-info":
            return httpx.Response(
                200,
                json={
                    "retCode": 0,
                    "result": {"list": [{"lotSizeFilter": {"basePrecision": "0.000001"}}]},
                },
            )
        if path == "/v5/order/create":
            body = json.loads(request.content)
            assert body["marketUnit"] == "baseCoin" and body["qty"] == "0.001234"
            return httpx.Response(200, json={"retCode": 0, "result": {"orderId": "1"}})
        if path == "/v5/order/realtime":
            return httpx.Response(
                200,
                json={
                    "retCode": 0,
                    "result": {
                        "list": [
                            {
                                "symbol": "BTCUSDT",
                                "side": "Sell",
                                "orderId": "1",
                                "orderStatus": "Filled",
                                "cumExecQty": "0.001234",
                                "cumExecValue": "74.04",
                                "cumExecFee": "0.07",
                            }
                        ]
                    },
                },
            )
        return httpx.Response(200, json={"retCode": 10001, "retMsg": "params error"})

    bybit = BybitAdapter(
        "live",
        {"api_key": "key", "api_secret": "secret"},
        transport=httpx.MockTransport(handler),
        sleep=lambda _: None,
    )
    assert bybit.verify() == {"can_trade": True, "withdrawals": False, "ip_restricted": True}
    permissions["Wallet"].append("Withdraw")
    with pytest.raises(ValueError, match="withdraw"):
        bybit.verify()
    order = bybit.market_order("BTC", "SELL", "kr-1", quantity=Decimal("0.0012349"))
    assert order["status"] == "FILLED" and order["average_price"] == Decimal("60000.00000000")
    assert order["fees"] == {"USDT": "0.07"}
    with pytest.raises(ExchangeError, match="params error"):
        bybit.cancel_open_orders("BTC")
    bybit.close()


def test_okx_adapter_uses_demo_mode_passphrase_and_rejects_withdraw_keys():
    import base64
    import hashlib
    import hmac as hmac_module
    from datetime import datetime, timezone

    from backend.product.exchanges import ExchangeError, OkxAdapter, client_order_id

    perm = {"value": "read_only,trade"}

    def handler(request: httpx.Request):
        assert request.headers["x-simulated-trading"] == "1"
        assert request.headers["OK-ACCESS-PASSPHRASE"] == "phrase"
        timestamp = request.headers["OK-ACCESS-TIMESTAMP"]
        assert timestamp == "2026-01-02T03:04:05.006Z"
        prehash = timestamp + request.method + request.url.raw_path.decode()
        prehash += request.content.decode() if request.method == "POST" else ""
        expected = base64.b64encode(
            hmac_module.new(b"secret", prehash.encode(), hashlib.sha256).digest()
        ).decode()
        assert request.headers["OK-ACCESS-SIGN"] == expected
        path = request.url.path
        if path == "/api/v5/account/config":
            return httpx.Response(
                200, json={"code": "0", "data": [{"perm": perm["value"], "ip": ""}]}
            )
        if path == "/api/v5/trade/order" and request.method == "POST":
            body = json.loads(request.content)
            assert body["tgtCcy"] == "quote_ccy" and body["sz"] == "25"
            return httpx.Response(200, json={"code": "0", "data": [{"sCode": "0"}]})
        if path == "/api/v5/trade/order":
            if request.url.params["clOrdId"] == "missing":
                return httpx.Response(
                    200, json={"code": "51603", "msg": "Order does not exist", "data": []}
                )
            return httpx.Response(
                200,
                json={
                    "code": "0",
                    "data": [
                        {
                            "state": "filled",
                            "ordId": "99",
                            "accFillSz": "0.0005",
                            "avgPx": "50000",
                            "fee": "-0.0000005",
                            "feeCcy": "BTC",
                        }
                    ],
                },
            )
        return httpx.Response(404)

    clock = lambda: datetime(2026, 1, 2, 3, 4, 5, 6000, tzinfo=timezone.utc)  # noqa: E731
    okx = OkxAdapter(
        "testnet",
        {"api_key": "key", "api_secret": "secret", "api_passphrase": "phrase"},
        transport=httpx.MockTransport(handler),
        clock=clock,
        sleep=lambda _: None,
    )
    assert okx.verify()["ip_restricted"] is False
    order = okx.market_order("BTC", "BUY", "kr123", quote_amount=Decimal("25"))
    assert order["status"] == "FILLED" and order["quote_filled"] == Decimal("25.0000")
    assert order["fees"] == {"BTC": "0.0000005"}
    with pytest.raises(ExchangeError) as missing:
        okx.order("BTC", "missing")
    assert missing.value.not_found
    live = OkxAdapter(
        "live",
        {"api_key": "key", "api_secret": "secret", "api_passphrase": "phrase"},
        transport=httpx.MockTransport(
            lambda r: httpx.Response(
                200, json={"code": "0", "data": [{"perm": "read_only,trade,withdraw"}]}
            )
        ),
    )
    with pytest.raises(ValueError, match="withdraw"):
        live.verify()
    assert len(client_order_id("okx", uuid4())) == 32
    assert client_order_id("okx", uuid4()).isalnum()
