#!/usr/bin/env python3
"""Reproduce the nocturnal 0dv asset using only Python's standard library.

Native UDV suffixes encode gamma*10, so gamma 1 is .10g.
No source asset or app code is read or written here.
"""
import argparse
import hashlib
import json
import math
from pathlib import Path

FPS = 30
SECONDS = 60
FRAMES = FPS * SECONDS
GAMMA = 1.0
NAME = "nocturnal-drift.30fps.10g.0dv"
# RGB control points, artist-selected rather than a sweep around the hue wheel.
PALETTE = (
    (78, 24, 150),   # velvet violet
    (32, 42, 112),   # indigo dusk
    (12, 108, 112),  # muted lagoon teal
    (22, 58, 76),    # blue-green shadow
    (190, 91, 23),   # low amber lantern
    (91, 32, 104),   # plum returning to violet
)


def rgb_at(phase):
    """Periodic C2 palette morph and gentle twice-per-loop breathing.

    Sample [0, 1), not both endpoints: no duplicate end-frame pause.
    Each 10-second transition has zero first/second palette derivatives at
    its stops. The breathing envelope and its derivatives are periodic too.
    """
    phase %= 1.0
    position = phase * len(PALETTE)
    index = int(position)
    fraction = position - index
    blend = fraction**3 * (fraction * (6 * fraction - 15) + 10)
    a = PALETTE[index]
    b = PALETTE[(index + 1) % len(PALETTE)]
    brightness = 0.86 + 0.10 * math.cos(math.tau * 2 * phase + 0.4)
    return tuple((x + (y - x) * blend) * brightness for x, y in zip(a, b))


def encoded_rgb(phase):
    return tuple(max(0, min(255, round(255 * (v / 255)**GAMMA)))
                 for v in rgb_at(phase))


def generate():
    output = bytearray()
    for frame in range(FRAMES):
        red, green, blue = encoded_rgb(frame / FRAMES)
        output.extend((green, red, blue))
    return bytes(output)


def verify(data):
    assert len(data) == FRAMES * 3
    samples = [tuple(data[i:i + 3]) for i in range(0, len(data), 3)]
    deltas = [max(abs(a - b) for a, b in zip(samples[i], samples[(i + 1) % FRAMES]))
              for i in range(FRAMES)]
    assert rgb_at(0) == rgb_at(1)
    assert encoded_rgb(0) == encoded_rgb(1)
    assert max(deltas) <= 2, "Unexpected abrupt adjacent-frame change"
    assert deltas[-1] <= 1, "Unexpected loop seam"
    return {
        "asset": NAME, "bytes": len(data), "frames": len(samples),
        "fps": FPS, "duration_seconds": len(samples) / FPS,
        "order": "GRB", "gamma": GAMMA,
        "sha256": hashlib.sha256(data).hexdigest(),
        "first_grb": samples[0], "last_grb": samples[-1],
        "wrap_max_channel_step": deltas[-1],
        "all_adjacent_max_channel_step_including_wrap": max(deltas),
        "channel_min_grb": [min(s[c] for s in samples) for c in range(3)],
        "channel_max_grb": [max(s[c] for s in samples) for c in range(3)],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true",
                        help="verify existing generated file without writing")
    args = parser.parse_args()
    path = Path(__file__).resolve().parent / NAME
    data = generate()
    if args.check:
        assert path.read_bytes() == data, "Existing asset is not reproducible"
    else:
        path.write_bytes(data)
        assert path.read_bytes() == data
    print(json.dumps(verify(data), indent=2))


if __name__ == "__main__":
    main()
