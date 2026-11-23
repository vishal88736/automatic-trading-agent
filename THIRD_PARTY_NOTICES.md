# Third-party notices

This repository preserves and extends [vishal88736/alpaca-trading-agent](https://github.com/vishal88736/alpaca-trading-agent) at revision `2495276210d977dd09a5190def02755f5b96bea8`. That project is an independent Alpaca-oriented derivative of the [TauricResearch TradingAgents framework](https://github.com/TauricResearch/TradingAgents). The original work is **TradingAgents: Multi-Agents LLM Financial Trading Framework**, by Yijia Xiao, Edward Sun, Di Luo and Wei Wang (2025), [arXiv:2412.20138](https://arxiv.org/abs/2412.20138).

The original Apache License 2.0 is retained in [LICENSE](LICENSE). The inherited CLI, prompts, numerical utilities and applicable tests are retained. Research telemetry is grouped under `tradingagents/telemetry/`, and its optional dependencies are listed in [config/legacy-requirements.txt](config/legacy-requirements.txt). See the [application architecture](docs/ARCHITECTURE.md).

React, TypeScript, Vite, Tailwind CSS, Lucide, FastAPI, Pydantic, LangGraph, pandas, Backtrader and other installed dependencies retain their respective licenses; their source is not vendored into the public repository's runtime cache.

Krono bundles Plus Jakarta Sans and JetBrains Mono through Fontsource. Both fonts are licensed under the SIL Open Font License 1.1, included in their installed packages.

cryptocurrency.cv is used through its hosted API. Its service source was not copied, redistributed or deployed. News records retain publisher attribution and original links. Synthetic fixture stories were authored for this demo and explicitly use non-real publisher URLs.
