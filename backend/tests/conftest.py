import pytest


@pytest.fixture(autouse=True)
def isolate_runtime(monkeypatch):
    monkeypatch.setenv("TERMINAL_MODE", "SIMULATION")
    monkeypatch.setenv("RESEARCH_ENABLED", "false")
    monkeypatch.setenv("MARKET_PROVIDER", "fixture")
    monkeypatch.setenv("NEWS_PROVIDER", "fixture")
    monkeypatch.delenv("NEWS_API_KEY", raising=False)
