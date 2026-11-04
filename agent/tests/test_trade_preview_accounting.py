"""The person's reviewed costs and rules must agree with the authoritative fill ledger."""

from decimal import Decimal

import pytest

from aegis.connectors.paper import PaperTerms
from agent.tests.test_runtime import runtime as runtime
from agent.tests.test_testnet_runtime import FakeSigner, make


@pytest.mark.parametrize("asset", ["WHSK", "WETH", "WBTC"])
@pytest.mark.parametrize("fraction", [Decimal(1), Decimal("0.5")])
def test_paper_preview_matches_debits_risk_levels_and_realized_result(runtime, asset, fraction):
    runtime.observe()
    # Exercise base-unit rounding too: the gateway rounds the network model upward.
    runtime.gateway.connector.terms = PaperTerms(network_fee_usdt=Decimal("0.0100001"))
    preview = runtime.trade_preview("buy", asset, amount_usdt=Decimal("1.0000009"))
    assert preview["trade_input_usdt"] == "1"
    assert preview["spend_usdt"] == "1.010001"
    assert preview["network_fee_usdt"] == "0.010001"
    assert preview["params_version"] == runtime.version
    runtime.control("trade_confirm", confirmation=preview["confirmation"])
    bought = runtime.view()
    [position] = bought["positions"]
    assert position["stop_price"] == preview["stop_loss_price"]
    assert position["take_profit_price"] == preview["take_profit_price"]
    assert Decimal(
        runtime.ledger.balances()[runtime.ledger.stable.address.lower()]["amount_raw"]
    ) / 10**runtime.ledger.stable.decimals == Decimal(100) - Decimal(preview["spend_usdt"])
    before_sell_cash = runtime.ledger.balances()[runtime.ledger.stable.address.lower()][
        "amount_raw"
    ]
    sale = runtime.trade_preview("sell", asset, fraction=fraction)
    runtime.control("trade_confirm", confirmation=sale["confirmation"])
    fill = runtime.ledger.fills()[-1]
    assert sale["estimated_result_usdt"] == fill["realized_pnl_usdt"]
    after_sell_cash = runtime.ledger.balances()[runtime.ledger.stable.address.lower()]["amount_raw"]
    assert (
        Decimal(sale["receive_estimate"])
        == Decimal(after_sell_cash - before_sell_cash) / 10**runtime.ledger.stable.decimals
    )
    assert bool(runtime.view()["positions"]) == (fraction < 1)


@pytest.mark.parametrize(
    "patch", [{"stop_loss_pct": "1.5"}, {"take_profit_pct": "12"}, {"position_size_pct": "4"}]
)
def test_saved_preference_change_requires_a_fresh_trade_preview(runtime, patch):
    runtime.observe()
    old = runtime.trade_preview("buy", "WHSK", amount_usdt=Decimal(1))
    runtime.set_params(patch, runtime.version)
    with pytest.raises(ValueError, match="settings changed"):
        runtime.control("trade_confirm", confirmation=old["confirmation"])
    assert not runtime.ledger.fills()
    fresh = runtime.trade_preview("buy", "WHSK", amount_usdt=Decimal(1))
    runtime.control("trade_confirm", confirmation=fresh["confirmation"])
    assert len(runtime.ledger.fills()) == 1


def test_testnet_preview_does_not_deduct_a_paper_network_expense(tmp_path):
    signer = FakeSigner()
    runtime, _ = make(tmp_path, signer)
    try:
        runtime.observe()
        preview = runtime.trade_preview("buy", "WHSK", amount_usdt=Decimal(1))
        assert preview["spend_usdt"] == "1" and preview["network_fee_usdt"] == "0"
        assert "outside vault NAV" in preview["network_fee_note"]
        runtime.control("trade_confirm", confirmation=preview["confirmation"])
        assert runtime.ledger.fills()[0]["modeled_network_fee_usdt"] == "0"
    finally:
        runtime.close()


def test_trade_amount_remains_user_configurable_without_a_ten_usdt_floor(runtime):
    runtime.observe()
    preview = runtime.trade_preview("buy", "WHSK", amount_usdt=Decimal("0.5"))
    assert preview["trade_input_usdt"] == "0.5"
    assert runtime.params.position_size_pct == 5
    assert runtime.params.position_size_usdt is None
