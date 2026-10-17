"""Budget of a Docker fixture call, stretched by the release gate's CAUCE_PLAZOS_FACTOR (tests/helpers/plazos.ts)."""
from __future__ import annotations

import math
import os


def factor() -> float:
    raw = os.environ.get('CAUCE_PLAZOS_FACTOR', '')
    if raw == '':
        return 1.0
    value = float(raw)
    if not math.isfinite(value) or value < 1 or value > 20:
        raise ValueError(f'CAUCE_PLAZOS_FACTOR inválido: {raw}')
    return value


def plazo(seconds: float) -> float:
    return seconds * factor()
