"""Async API boundary around one thread-affine SQLite/RPC runtime."""

from __future__ import annotations

import asyncio
import copy
import threading
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import TimeoutError as FutureTimeout
from pathlib import Path

from aegis.nl.agent import ControlAgent
from aegis.nl.tools import ToolCall, execute_tool
from aegis.runtime import PaperRuntime
from aegis.strategy.library import LibrarySnapshot

# How long a request waits for a market check. The check itself keeps running on its worker.
CHECK_DEADLINE_SECONDS = 45


class AegisService:
    def __init__(
        self,
        path: Path,
        *,
        factory=None,
        enabled=True,
        reference_source=None,
        terminal_tool=None,
        monitor=False,
    ):
        self.path, self.factory, self.enabled = path, factory, enabled
        # Keep market data live while the agent is stopped. Isolated test apps leave this off.
        self.monitor = monitor
        self.monitor_ready = False
        self.reference_source = reference_source
        # Async callable(name, args) on the API loop for library/selector chat tools.
        self.terminal_tool = terminal_tool
        self.loop = None
        self.library_revision = 0
        self.pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="aegis-paper")
        self.halted, self.emergency = threading.Event(), threading.Event()
        self.halted.set()
        self.runtime = None
        self.agent = None
        self.task = None
        self.closing = False
        self.inflight = False
        self.state = {
            "available": False,
            "mode": "paper",
            "paused": True,
            "live_enabled": False,
            "reason": "AEGIS is disabled in this isolated test application",
        }

    async def start(self):
        if not self.enabled:
            return

        def initialize():
            self.agent = ControlAgent.from_environment()
            self.runtime = (
                self.factory(self.path, self.halted, self.emergency)
                if self.factory
                else PaperRuntime(self.path, halted=self.halted, emergency=self.emergency)
            )
            self.runtime.library_revision = lambda: self.library_revision
            self.runtime.terminal_bridge = self._terminal_bridge if self.terminal_tool else None

        self.loop = asyncio.get_running_loop()
        try:
            await self.loop.run_in_executor(self.pool, initialize)
            await self.call("view")
            self.task = asyncio.create_task(self._loop())
        except Exception:
            self.state["reason"] = (
                "AEGIS storage or configuration could not initialize; existing terminal remains available"
            )

    def _terminal_bridge(self, name: str, args: dict) -> dict:
        """Run a research-store tool on the API event loop from the runtime thread. The loop is
        free while it awaits this executor call, so the coroutine can run; SQLite stays on it."""
        future = asyncio.run_coroutine_threadsafe(self.terminal_tool(name, args), self.loop)
        try:
            return future.result(timeout=15)
        except FutureTimeout:
            future.cancel()
            raise ValueError(
                "Strategy library update timed out; check Strategies before retrying"
            ) from None

    async def call(self, operation: str, *args, **kwargs):
        if self.runtime is None:
            raise ValueError(self.state["reason"])
        if operation == "control":
            action = args[0]
            if action in {"pause", "panic"}:
                self.halted.set()  # Visible to an in-flight gateway before its atomic fill.
            if action == "panic":
                self.emergency.set()

        def invoke():
            if operation == "chat":
                result = self.agent.respond(self.runtime, *args)
            elif operation == "tool":
                result = execute_tool(self.runtime, ToolCall.model_validate(args[0]))
            else:
                result = getattr(self.runtime, operation)(*args, **kwargs)
            self.state = {
                "available": True,
                **self.runtime.view(),
                "ai_engine": self.agent.status(),
            }
            return result

        return await asyncio.get_running_loop().run_in_executor(self.pool, invoke)

    def view(self):
        result = copy.deepcopy(self.state)
        if self.runtime is not None:
            result.update(
                paused=self.halted.is_set(),
                emergency=self.emergency.is_set(),
                refresh_in_progress=self.inflight,
                library_revision=self.library_revision,
                monitoring=self.monitor,
            )
            import time

            fresh = (
                result.get("block_timestamp") and int(time.time()) - result["block_timestamp"] <= 90
            )
            if not fresh:
                result.update(valuation_fresh=False, pnl=None)
                if result.get("block_timestamp"):
                    result["data_status"] = "STALE"
        return result

    def invalidate_library(self):
        # Event-loop writers invalidate a worker's captured strategy policy without sharing SQLite.
        self.library_revision += 1

    async def check(self):
        if self.inflight:
            raise ValueError("A market check is already running; wait for its recorded result")
        self.inflight = True
        work = asyncio.ensure_future(self._check())

        def finished(task):
            self.inflight = False
            if not task.cancelled():
                task.exception()  # Consumed even if the waiting request has already moved on.

        work.add_done_callback(finished)
        try:
            # A thread cannot be cancelled mid-read: stop waiting, keep the "running" guard.
            return await asyncio.wait_for(asyncio.shield(work), CHECK_DEADLINE_SECONDS)
        except asyncio.TimeoutError:
            raise ValueError(
                "The market check is taking longer than expected. It is still running; "
                "the page updates when it finishes."
            ) from None

    async def _check(self):
        library = None
        if self.reference_source is not None:
            revision = self.library_revision
            try:
                library = await asyncio.wait_for(self.reference_source(self.view()), timeout=15)
                library = library.model_copy(update={"revision": revision})
            except Exception:
                import time

                library = LibrarySnapshot(
                    captured_at=int(time.time()),
                    signals=[],
                    catalog=[],
                    error="Reference-strategy data could not refresh; library entries are blocked",
                )
        return await self.call("tick", library=library)

    async def observe(self):
        if self.inflight:
            return
        self.inflight = True
        try:
            return await self.call("observe")
        finally:
            self.inflight = False

    async def _loop(self):
        while not self.closing:
            await asyncio.sleep(1)
            if not self.runtime or self.inflight:
                continue
            running = self.state.get("running")
            if not running and not self.monitor:
                continue
            import time

            last = self.state.get("last_tick_at") or 0
            interval = self.state.get("params", {}).get("tick_seconds", 30)
            # A stopped agent still needs one full check after startup: it fills the strategy
            # catalog and signals. It cannot trade (entries stay paused until an explicit start).
            first_check = self.monitor and not self.monitor_ready
            if time.time() - last < interval and not first_check:
                continue
            try:
                if running or first_check:
                    await self.check()
                    self.monitor_ready = True
                else:
                    await self.observe()
            except Exception:
                self.halted.set()
                self.state.update(last_error="Unexpected runtime failure; entries paused")
                await asyncio.sleep(5)

    async def close(self):
        self.closing = True
        self.halted.set()
        if self.agent:
            self.agent.cancel_pending()
        if self.runtime:
            rpc = getattr(getattr(self.runtime.live, "reader", None), "rpc", None)
            if hasattr(rpc, "cancel_pending"):
                rpc.cancel_pending()
        if self.task:
            # Do not cancel a thread running a fill. Drain its work before closing its ledger.
            self.task.cancel()
            try:
                await self.task
            except asyncio.CancelledError:
                pass
        if self.runtime:
            await asyncio.get_running_loop().run_in_executor(self.pool, self.runtime.close)
        if self.agent:
            await asyncio.get_running_loop().run_in_executor(self.pool, self.agent.close)
        self.pool.shutdown(wait=True)
