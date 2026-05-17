from __future__ import annotations

import heapq
import itertools
import time
from collections import OrderedDict
from typing import Callable, Generic, TypeVar

T = TypeVar("T")


class TTLCache(Generic[T]):
    def __init__(
        self,
        *,
        maxsize: int,
        clock: Callable[[], float] | None = None,
    ) -> None:
        self._maxsize = max(1, int(maxsize))
        self._clock = clock or time.time
        self._store: OrderedDict[str, tuple[float, int, T]] = OrderedDict()
        self._expiry_heap: list[tuple[float, int, str]] = []
        self._version_counter = itertools.count(1)

    def _prune_expired(self, now: float | None = None) -> None:
        current = self._clock() if now is None else now
        while self._expiry_heap and self._expiry_heap[0][0] <= current:
            expires_at, version, key = heapq.heappop(self._expiry_heap)
            item = self._store.get(key)
            if item is None:
                continue
            stored_expires_at, stored_version, _ = item
            if stored_version != version or stored_expires_at != expires_at:
                continue
            self._store.pop(key, None)

    def get(self, key: str) -> T | None:
        now = self._clock()
        self._prune_expired(now)
        item = self._store.get(key)
        if item is None:
            return None
        expires_at, _, value = item
        if expires_at <= now:
            self._store.pop(key, None)
            return None
        self._store.move_to_end(key)
        return value

    def set(self, key: str, value: T, ttl: float) -> None:
        ttl_value = float(ttl)
        if ttl_value <= 0:
            self._store.pop(key, None)
            return

        now = self._clock()
        self._prune_expired(now)
        expires_at = now + ttl_value
        version = next(self._version_counter)
        self._store.pop(key, None)
        self._store[key] = (expires_at, version, value)
        heapq.heappush(self._expiry_heap, (expires_at, version, key))

        while len(self._store) > self._maxsize:
            self._store.popitem(last=False)

    def delete(self, key: str) -> None:
        self._store.pop(key, None)

    def clear(self) -> None:
        self._store.clear()
        self._expiry_heap.clear()

    def stats(self) -> dict[str, int]:
        self._prune_expired()
        return {
            "entries": len(self._store),
            "maxsize": self._maxsize,
        }

    def __len__(self) -> int:
        self._prune_expired()
        return len(self._store)
