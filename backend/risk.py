from __future__ import annotations

from datetime import datetime
from decimal import ROUND_DOWN, Decimal

from backend.data import USD
from backend.models import Check, Mode, Proposal, Quote, RiskConfig, RiskDecision, now

D = Decimal


def assess(
    proposal: Proposal,
    portfolio: dict,
    config: RiskConfig,
    version: int,
    *,
    stopped=False,
    pending=False,
    recent_failures=0,
    last_trade: datetime | None = None,
    clock=None,
) -> RiskDecision:
    clock = clock or now()
    checks = []

    def check(code, passed, actual, limit, reason):
        checks.append(
            Check(
                code=code, passed=bool(passed), actual=str(actual), limit=str(limit), reason=reason
            )
        )

    equity, cash = (
        D(
            str(
                portfolio.get("equity")
                if portfolio.get("equity") is not None
                else portfolio.get("known_equity", "0")
            )
        ),
        D(str(portfolio["cash"])),
    )
    exposure = D(
        str(
            portfolio["exposure"]
            if portfolio.get("exposure") is not None
            else portfolio.get("known_exposure", "0")
        )
    )
    asset_value = D(str(portfolio.get("asset_values", {}).get(proposal.asset.asset_id, "0")))
    check(
        "EMERGENCY_OR_PAUSE",
        not stopped,
        stopped,
        False,
        "New execution is disabled while paused or stopped.",
    )
    check(
        "SUPPORTED_MODE",
        proposal.mode == Mode.SIMULATION,
        proposal.mode,
        "SIMULATION",
        "HSKSwap live and paper execution are not validated.",
    )
    check(
        "TOKEN_IDENTITY",
        proposal.mode == Mode.SIMULATION or proposal.asset.verified,
        proposal.asset.verified,
        True,
        "Live trades require verified on-chain identity.",
    )
    check(
        "DUPLICATE_INTENT",
        not pending,
        pending,
        False,
        "An execution for this proposal already exists.",
    )
    check(
        "FRESH_PROPOSAL",
        proposal.expires_at > clock and proposal.signal_at <= clock,
        proposal.expires_at,
        clock,
        "Proposal has expired or has a future signal time.",
    )
    fixture_clock = (
        proposal.mode == Mode.SIMULATION and proposal.market_source == "synthetic_fixture_v1"
    )
    age = (clock - proposal.market_as_of).total_seconds()
    check(
        "MARKET_FRESHNESS",
        fixture_clock or 0 <= age <= config.max_market_age_seconds,
        "fixture clock" if fixture_clock else age,
        config.max_market_age_seconds,
        "Market evidence is stale or future-dated.",
    )
    check(
        "HISTORY",
        proposal.candle_count >= 80,
        proposal.candle_count,
        80,
        "Insufficient candle history.",
    )
    check(
        "EXIT_POLICY",
        bool(proposal.exit_policy)
        and (proposal.side != "BUY" or proposal.stop_price < proposal.reference_price),
        proposal.stop_price,
        proposal.reference_price,
        "A valid downside stop and exit policy are mandatory.",
    )
    check("EQUITY", equity > 0, equity, "> 0", "Portfolio equity must be positive.")
    check(
        "VALUATION",
        portfolio.get("valuation_complete", True),
        portfolio.get("valuation_complete", True),
        True,
        "Positions require available fresh marks for risk accounting.",
    )
    check(
        "DAILY_LOSS",
        portfolio.get("daily_return") is not None
        and D(str(portfolio["daily_return"])) > -config.max_daily_loss,
        portfolio.get("daily_return")
        if portfolio.get("daily_return") is not None
        else "UNAVAILABLE",
        -config.max_daily_loss,
        "Daily realized plus unrealized loss is unavailable or exceeds its limit. Hold and review.",
    )
    check(
        "DRAWDOWN",
        portfolio.get("drawdown") is not None
        and D(str(portfolio["drawdown"])) < config.max_drawdown,
        portfolio.get("drawdown") if portfolio.get("drawdown") is not None else "UNAVAILABLE",
        config.max_drawdown,
        "Portfolio drawdown is unavailable or exceeds its limit. Hold and review.",
    )
    check(
        "FAILURE_COOLDOWN",
        recent_failures < config.max_recent_failures,
        recent_failures,
        config.max_recent_failures,
        "Repeated execution failures require a cooldown and review.",
    )
    elapsed = (clock - last_trade).total_seconds() if last_trade else None
    check(
        "ENTRY_COOLDOWN",
        proposal.side == "SELL" or elapsed is None or elapsed >= config.cooldown_seconds,
        elapsed,
        config.cooldown_seconds,
        "Asset entry cooldown is active.",
    )
    capacity = min(
        proposal.notional,
        config.max_trade_notional,
        max(D(0), equity * config.max_equity_per_trade),
    )
    if proposal.side == "BUY":
        capacity = min(
            capacity,
            max(D(0), equity * config.max_asset_exposure - asset_value),
            max(D(0), equity * config.max_aggregate_exposure - exposure),
            max(D(0), cash - config.max_network_fee),
        )
        check(
            "POSITION_COUNT",
            asset_value > 0 or len(portfolio["positions"]) < config.max_positions,
            len(portfolio["positions"]),
            config.max_positions,
            "Maximum concurrent positions reached.",
        )
    else:
        # Cash-only spot exits cannot create a short position.
        capacity = min(proposal.notional, config.max_trade_notional, asset_value)
        check(
            "OWNED_INVENTORY",
            asset_value > 0,
            asset_value,
            "> 0",
            "No owned inventory is available to sell.",
        )
    capacity = max(D(0), capacity.quantize(D("0.00000001"), rounding=ROUND_DOWN))
    check(
        "MAX_TRADE_NOTIONAL",
        capacity <= config.max_trade_notional,
        capacity,
        config.max_trade_notional,
        "Final size must respect the absolute notional ceiling.",
    )
    if proposal.side == "BUY":
        check(
            "EQUITY_ALLOCATION",
            capacity <= equity * config.max_equity_per_trade,
            capacity,
            equity * config.max_equity_per_trade,
            "Final size must respect the equity allocation ceiling.",
        )
        check(
            "ASSET_CONCENTRATION",
            asset_value + capacity <= equity * config.max_asset_exposure,
            asset_value + capacity,
            equity * config.max_asset_exposure,
            "Final exposure must respect per-asset concentration.",
        )
        check(
            "AGGREGATE_EXPOSURE",
            exposure + capacity <= equity * config.max_aggregate_exposure,
            exposure + capacity,
            equity * config.max_aggregate_exposure,
            "Final exposure must respect the aggregate ceiling.",
        )
    check(
        "SIZING_CAPACITY",
        capacity >= D("1"),
        capacity,
        ">= 1 USD",
        "Balance or exposure capacity is too small.",
    )
    failed = [c for c in checks if not c.passed]
    verdict = "REJECTED" if failed else "REDUCED" if capacity < proposal.notional else "APPROVED"
    reasons = [c.reason for c in failed] or (
        ["Size reduced to satisfy notional, cash, equity and concentration caps."]
        if verdict == "REDUCED"
        else ["All deterministic pre-trade checks passed."]
    )
    return RiskDecision(
        proposal_id=proposal.id,
        verdict=verdict,
        requested_notional=proposal.notional,
        approved_notional=D(0) if failed else capacity,
        checks=checks,
        reasons=reasons,
        version=version,
    )


def validate_quote(
    quote: Quote,
    proposal: Proposal,
    decision: RiskDecision,
    config: RiskConfig,
    clock=None,
    wallet=None,
) -> list[str]:
    clock = clock or now()
    errors = []
    if decision.verdict == "REJECTED" or decision.proposal_id != proposal.id:
        errors.append("Risk approval is missing")
    if quote.proposal_id != proposal.id or quote.mode != proposal.mode:
        errors.append("Quote intent or mode mismatch")
    expected_input = proposal.asset if proposal.side == "SELL" else None
    expected_output = proposal.asset if proposal.side == "BUY" else None
    if quote.chain_id != proposal.asset.chain_id:
        errors.append("Chain mismatch")
    if (
        expected_input
        and quote.input_token != expected_input
        or expected_output
        and quote.output_token != expected_output
    ):
        errors.append("Token identity mismatch")
    if (
        proposal.side == "BUY"
        and quote.input_token != USD
        or proposal.side == "SELL"
        and quote.output_token != USD
    ):
        errors.append("Settlement asset mismatch")
    if quote.notional != decision.approved_notional:
        errors.append("Quote amount differs from approved size")
    expected_amount = (
        quote.notional if proposal.side == "BUY" else quote.notional / proposal.reference_price
    )
    if abs(quote.input_amount - expected_amount) > D("0.000000000000000001"):
        errors.append("Unexpected input amount")
    if not 0 <= (
        clock - quote.created_at
    ).total_seconds() <= config.max_quote_age_seconds or clock >= min(
        quote.expires_at, quote.deadline
    ):
        errors.append("Quote expired, future-dated or stale")
    if quote.slippage_bps > config.max_slippage_bps:
        errors.append("Slippage ceiling exceeded")
    if quote.price_impact > config.max_price_impact:
        errors.append("Price impact ceiling exceeded")
    if quote.network_fee_usd > config.max_network_fee:
        errors.append("Network fee ceiling exceeded")
    if quote.trading_fee_usd > quote.notional * D(config.max_trading_fee_bps) / 10000:
        errors.append("Trading fee ceiling exceeded")
    allowed_price_move = D(quote.slippage_bps) / 10000 + quote.price_impact
    if abs(quote.price / proposal.reference_price - 1) > allowed_price_move + D("0.000000000001"):
        errors.append("Quoted price move exceeds declared slippage and impact")
    expected_output = (
        (quote.notional - quote.trading_fee_usd) / quote.price
        if proposal.side == "BUY"
        else quote.input_amount * quote.price - quote.trading_fee_usd
    )
    if abs(quote.output_amount - expected_output) > D("0.000000000000000002"):
        errors.append("Quote output, price and fee are inconsistent")
    if not 0 < (quote.deadline - quote.created_at).total_seconds() <= 120:
        errors.append("Transaction deadline exceeds the bounded authorization window")
    if quote.liquidity_usd is None or quote.liquidity_usd < config.min_liquidity_usd:
        errors.append("Liquidity missing or below minimum")
    floor = quote.output_amount * (D(1) - D(config.max_slippage_bps) / 10000)
    if not floor <= quote.minimum_output <= quote.output_amount:
        errors.append("Minimum output does not protect the slippage ceiling")
    if quote.mode != Mode.SIMULATION and (
        not wallet
        or quote.wallet != wallet
        or not quote.input_token.verified
        or not quote.output_token.verified
    ):
        errors.append("Verified wallet and token permissions required")
    return errors
