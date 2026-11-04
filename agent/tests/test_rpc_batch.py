"""Pinned batches retain the read-only, chain and reorg boundaries."""

import json
import threading
import time

import httpx
import pytest
from eth_abi import encode
from web3 import Web3

from aegis.connectors.rpc import BlockRef, DiscoveryError, ReadOnlyRpc, RpcResponseError, call_read

ADDRESS = "0x" + "1" * 40


@pytest.mark.parametrize("corruption", [None, "duplicate", "missing", "wrong_chain", "error"])
def test_batch_accepts_out_of_order_complete_responses_only(corruption):
    requests = []

    def handler(request):
        batch = json.loads(request.content)
        requests.append(batch)
        assert isinstance(batch, list)
        result = [
            {
                "id": p["id"],
                "result": "0x85"
                if p["method"] == "eth_chainId"
                else "0x" + encode(["uint8"], [18]).hex(),
            }
            for p in batch
        ]
        if corruption == "duplicate":
            result[1] = result[0]
        elif corruption == "missing":
            result.pop()
        elif corruption == "wrong_chain":
            result[0]["result"] = "0xb1"
        elif corruption == "error":
            result[1] = {"id": batch[1]["id"], "error": {"code": -32000}}
        return httpx.Response(200, json=list(reversed(result)))

    rpc = ReadOnlyRpc(133, ["https://rpc.test"], attempts=1, transport=httpx.MockTransport(handler))
    block = BlockRef(100, "0x" + "1" * 64, int(time.time()))
    read = call_read(ADDRESS, "decimals()", block)
    try:
        if corruption:
            with pytest.raises(RpcResponseError if corruption == "error" else DiscoveryError):
                rpc.prefetch(block, [read])
            assert not rpc._prefetched
        else:
            rpc.prefetch(block, [read, read])
            assert rpc.call(ADDRESS, "decimals()", ["uint8"], block) == (18,)
            rpc.prefetch(block, [read])
            assert len(requests) == 1 and len(requests[0]) == 2
    finally:
        rpc.close()


@pytest.mark.parametrize(
    "method,params",
    [
        ("eth_sendRawTransaction", ["0x"]),
        ("eth_getTransactionReceipt", ["0x64"]),
        ("eth_getCode", [ADDRESS, "latest"]),
        ("eth_call", [{"to": ADDRESS}, "0x63"]),
    ],
)
def test_batch_rejects_writes_unpinned_reads_and_receipt_caching(method, params):
    rpc = ReadOnlyRpc(
        133,
        ["https://rpc.test"],
        attempts=1,
        transport=httpx.MockTransport(lambda r: pytest.fail("No request allowed")),
    )
    try:
        with pytest.raises(DiscoveryError, match="block-pinned"):
            rpc.prefetch(BlockRef(100, "hash", int(time.time())), [(method, params)])
    finally:
        rpc.close()


def test_replacement_block_hash_does_not_reuse_prefetched_data():
    methods = []

    def handler(request):
        data = json.loads(request.content)
        if isinstance(data, list):
            return httpx.Response(
                200,
                json=[
                    {
                        "id": p["id"],
                        "result": "0x85"
                        if p["method"] == "eth_chainId"
                        else "0x" + encode(["uint8"], [18]).hex(),
                    }
                    for p in data
                ],
            )
        methods.append(data["method"])
        return httpx.Response(
            200,
            json={
                "id": data["id"],
                "result": "0x85"
                if data["method"] == "eth_chainId"
                else "0x" + encode(["uint8"], [6]).hex(),
            },
        )

    rpc = ReadOnlyRpc(133, ["https://rpc.test"], transport=httpx.MockTransport(handler))
    first = BlockRef(100, "first", int(time.time()))
    replacement = BlockRef(100, "replacement", first.timestamp)
    try:
        rpc.prefetch(first, [call_read(ADDRESS, "decimals()", first)])
        assert rpc.call(ADDRESS, "decimals()", ["uint8"], first) == (18,)
        assert rpc.call(ADDRESS, "decimals()", ["uint8"], replacement) == (6,)
        assert methods == ["eth_chainId", "eth_call"]
    finally:
        rpc.close()


def test_mainnet_retains_serial_reads_without_batch_support():
    methods = []

    def handler(request):
        data = json.loads(request.content)
        assert isinstance(data, dict), "Mainnet must not require RPC batches"
        methods.append(data["method"])
        return httpx.Response(
            200,
            json={
                "id": data["id"],
                "result": "0xb1"
                if data["method"] == "eth_chainId"
                else "0x" + encode(["uint8"], [18]).hex(),
            },
        )

    rpc = ReadOnlyRpc(177, ["https://rpc.test"], transport=httpx.MockTransport(handler))
    block = BlockRef(100, "hash", int(time.time()))
    try:
        rpc.prefetch(block, [call_read(ADDRESS, "decimals()", block)])
        assert rpc.call(ADDRESS, "decimals()", ["uint8"], block) == (18,)
        assert methods == ["eth_chainId", "eth_call"]
    finally:
        rpc.close()


def parallel_rpc(handler, urls=("https://rpc.test",)):
    return ReadOnlyRpc(
        177, list(urls), attempts=1, retry_delay=0, transport=httpx.MockTransport(handler)
    )


def test_mainnet_prefetch_reads_concurrently_with_chain_checks_around_the_set():
    calls = []
    lock = threading.Lock()

    def handler(request):
        data = json.loads(request.content)
        assert isinstance(data, dict), "Mainnet must not require RPC batches"
        with lock:
            calls.append(data["method"])
        result = "0xb1" if data["method"] == "eth_chainId" else "0x" + encode(["uint8"], [18]).hex()
        return httpx.Response(200, json={"id": data["id"], "result": result})

    rpc = parallel_rpc(handler)
    block = BlockRef(100, "hash", int(time.time()))
    reads = [call_read(ADDRESS, "decimals()", block), call_read(ADDRESS, "symbol()", block)]
    try:
        rpc.prefetch(block, reads)
        assert calls[0] == calls[-1] == "eth_chainId"
        assert calls.count("eth_call") == 2 and calls.count("eth_chainId") == 2
        count = len(calls)
        # Decoding is served from the published set, with no further network reads.
        assert rpc.call(ADDRESS, "decimals()", ["uint8"], block) == (18,)
        assert len(calls) == count
    finally:
        rpc.close()


@pytest.mark.parametrize("failure", ["revert", "wrong_chain_after", "http_429", "bad_id"])
def test_failed_parallel_read_publishes_nothing_and_falls_back_to_serial(failure):
    block = BlockRef(100, "hash", int(time.time()))
    good, failing = call_read(ADDRESS, "decimals()", block), call_read(ADDRESS, "symbol()", block)
    state = {"parallel_round": True, "chain_checks": 0}
    lock = threading.Lock()
    served = "0x" + encode(["uint8"], [18]).hex()

    def handler(request):
        data = json.loads(request.content)
        reply = {"id": data["id"], "result": served}
        if data["method"] == "eth_chainId":
            with lock:
                state["chain_checks"] += 1
                changed = failure == "wrong_chain_after" and state["chain_checks"] == 2
            return httpx.Response(200, json={**reply, "result": "0x1" if changed else "0xb1"})
        if state["parallel_round"] and data["params"][0]["data"] == failing[1][0]["data"]:
            if failure == "revert":
                return httpx.Response(
                    200, json={"id": data["id"], "error": {"code": 3, "message": "reverted"}}
                )
            if failure == "http_429":
                return httpx.Response(429, json={})
            if failure == "bad_id":
                return httpx.Response(200, json={"id": 999999, "result": served})
        return httpx.Response(200, json=reply)

    rpc = parallel_rpc(handler)
    try:
        rpc.prefetch(block, [good, failing])
        assert rpc._prefetched == {}, "A partial set must never be published"
        state["parallel_round"] = False
        assert rpc.call(ADDRESS, "decimals()", ["uint8"], block) == (18,)
    finally:
        rpc.close()


def test_read_many_rejects_writes_and_unknown_methods():
    rpc = parallel_rpc(lambda request: pytest.fail("no request may be sent"))
    try:
        with pytest.raises(DiscoveryError, match="contract state reads"):
            rpc.read_many([("eth_sendRawTransaction", ["0x00"])])
    finally:
        rpc.close()


def test_throttled_reads_retry_at_lower_concurrency_without_restarting_the_set():
    block = BlockRef(100, "hash", int(time.time()))
    reads = [
        call_read(ADDRESS, "decimals()", block),
        call_read(ADDRESS, "symbol()", block),
        call_read(ADDRESS, "name()", block),
    ]
    refused = set()
    served = []
    lock = threading.Lock()

    def handler(request):
        data = json.loads(request.content)
        if data["method"] == "eth_chainId":
            return httpx.Response(200, json={"id": data["id"], "result": "0xb1"})
        selector = data["params"][0]["data"]
        with lock:
            first_time = selector not in refused
            refused.add(selector)
            if not first_time:
                served.append(selector)
        if first_time:
            return httpx.Response(429, headers={"retry-after": "0"}, json={})
        return httpx.Response(
            200, json={"id": data["id"], "result": "0x" + encode(["uint8"], [18]).hex()}
        )

    rpc = parallel_rpc(handler)
    try:
        rpc.prefetch(block, reads)
        assert len(rpc._prefetched) == 3, "Throttling must not fall back to slow serial reads"
        assert sorted(served) == sorted(r[1][0]["data"] for r in reads), "Each read served once"
        assert rpc._parallel < 8
    finally:
        rpc.close()


def test_time_budget_stops_new_reads_with_a_clear_error():
    rpc = parallel_rpc(lambda request: pytest.fail("no read may start past the budget"))
    try:
        with pytest.raises(DiscoveryError, match="taking too long"):
            with rpc.time_budget(-1):
                rpc.request("eth_blockNumber", [])
        assert rpc._deadline is None
    finally:
        rpc.close()


def test_identity_is_verified_first_then_only_changing_state_is_read(monkeypatch):
    from aegis.connectors import hskswap_v3  # noqa: F401 - import order
    from aegis.data import HSKSwapData, load_network

    network = load_network("mainnet")
    reader = HSKSwapData(network, rpc=object())
    sent = []
    reader.rpc = type(
        "Rpc",
        (ReadOnlyRpc,),
        {"prefetch": lambda self, block, reads: sent.append(reads), "__init__": lambda self: None},
    )()
    block = BlockRef(100, "hash", int(time.time()))
    reader.prefetch_snapshot(block)
    first = sent[-1]
    reader._identity_verified_at = time.monotonic()
    reader.prefetch_snapshot(block)
    routine = sent[-1]
    assert len(routine) * 2 < len(first), (len(first), len(routine))
    selectors = {r[1][0]["data"][:10] for r in routine if r[0] == "eth_call"}
    assert Web3.keccak(text="slot0()").hex()[:8] in {s[2:] for s in selectors}
    # A proxy's implementation can change at any time, so it stays in every read.
    assert any(r[0] == "eth_getStorageAt" for r in routine)
    reader._identity_verified_at = time.monotonic() - 301
    reader.prefetch_snapshot(block)
    assert len(sent[-1]) == len(first), "Identity is re-verified periodically"
