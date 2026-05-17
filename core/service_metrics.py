from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class ServiceMetrics:
    service: str
    values: dict[str, Any] = field(default_factory=dict)
    counters: dict[str, int] = field(default_factory=dict)

    def set(self, key: str, value: Any) -> None:
        self.values[key] = value

    def add_counter(self, key: str, value: int = 1) -> None:
        self.counters[key] = self.counters.get(key, 0) + value

    def to_log_dict(self) -> dict[str, Any]:
        payload = {"service": self.service}
        payload.update(self.values)
        payload.update(self.counters)
        return payload

    def to_log_string(self) -> str:
        payload = self.to_log_dict()
        return " ".join(f"{key}={value}" for key, value in payload.items())
