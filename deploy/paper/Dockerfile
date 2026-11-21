FROM ghcr.io/astral-sh/uv:0.13.0 AS uv
FROM python:3.12-slim-bookworm
COPY --from=uv /uv /bin/uv
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 PATH=/app/.venv/bin:$PATH
WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --extra platform --no-dev --no-cache
COPY backend backend
COPY tradingagents tradingagents
COPY config config
COPY scripts/platform_database.py scripts/platform_database.py
USER 10001:10001
CMD ["python", "-m", "uvicorn", "backend.product.api:app_from_environment", "--factory", "--host", "0.0.0.0", "--port", "8794"]
