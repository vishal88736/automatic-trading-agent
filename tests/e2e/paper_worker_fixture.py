"""Drive the real worker process with an accelerated closed-candle clock."""

import os
import signal
import time
from datetime import datetime, timedelta, timezone
from threading import Event

from backend.product.database import DSN_ENV
from backend.product.worker import PaperWorker, service
from tests.e2e.product_api import history, quotes


def main():
    if os.environ.get("TERMINAL_TEST_RUN") != "1":
        raise RuntimeError("Use the isolated e2e configuration")
    origin = float(os.environ["KRONO_TEST_MARKET_ORIGIN"])

    def market_clock():
        # Advance one closed historical hour every five wall-clock seconds across restarts.
        return datetime(2026, 1, 20, tzinfo=timezone.utc) + timedelta(
            hours=int((time.time() - origin) / 5)
        )

    stop = Event()
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    service(
        os.environ[DSN_ENV],
        stop,
        PaperWorker(history, quotes, allow_fixture=True, market_clock=market_clock),
    )


if __name__ == "__main__":
    main()
