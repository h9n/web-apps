# Scratch colour assets

Headerless unsigned 8-bit **G, R, B** triples, one colour/frame (0dv), 30 fps.
No dimensions, timestamps, padding, or embedded metadata. Frame `i` starts at
byte `3*i`; duration is `byteLength / 3 / fps`.

| File | Frames | Bytes | Seconds | Decode gamma |
| --- | ---: | ---: | ---: | ---: |
| `blockiness.30fps.n3.70g.0dv` | 1201 | 3603 | 40.033333… | 7 |
| `nocturnal-drift.30fps.10g.0dv` | 1800 | 5400 | 60 | 1 |

## Source and native convention

`blockiness.30fps.n3.70g.0dv` is an unchanged copy of
`/Users/hamish/Desktop/hole_fairylight_mesh/blockiness.30fps.n3.70g.0dv`.
Original and copy SHA-256:
`c54bd441500f899650bfe07fd6f733ab67800c408406e6992bbdac8d27e4842c`.
The original was checked unchanged after copying. Its bytes are preserved,
including leading/trailing black frames; no de-gamma or remapping was applied.

Inspected local implementation:
- `/Users/hamish/art/tools/undimensionaliser/undimensionaliser.lisp:58–59`:
  `*udv-pxformat*` is `(g r b)`.
- Same file, `frame-width-from-udv-file` and `num-frames-from-udv-file`
  (lines 926–938): 0dv width is 1, three bytes/frame.
- Same file, `gamma-from-udv-file` (lines 965–972): integer `Ng` means
  gamma `N/10`; therefore `70g` means **7.0**, not 0.70.
- `/Users/hamish/art/sl/vidadlib.lisp:455–465` (the imported gamma helper):
  encoding is `round(255 * (inputByte / 255)^gamma)`.
- `temporal-interpolation.lisp:122–135` writes suffix `round(10*gamma)g`.

The generated asset uses `.10g` for gamma 1, consistent with native playback.
Scratch uses an explicit, fixed metadata table for its two bundled assets.

## Recommended browser decode

Unpack each triple as `[g, r, b]`, then compute display RGB bytes:

```text
R = round(255 * (r / 255)^(1/gamma))
G = round(255 * (g / 255)^(1/gamma))
B = round(255 * (b / 255)^(1/gamma))
```

Use gamma **7** for blockiness and **1** for nocturnal-drift. The inverse is an
artistic reconstruction of the pre-UDV values, not physical calibration or an
extra sRGB conversion; gamma encoding's 8-bit quantization is irreversible.
For direct native LED playback use stored GRB bytes without inverse gamma.
Loop index: `floor(elapsedSeconds * 30) % frameCount`.

Scratch applies a visibility floor after decoding: when the highest channel
is below 96, all channels are scaled together to a peak of 96; pure black
becomes neutral `[96,96,96]`. This is a deliberate UI-only adaptation so
black stretches cannot hide the writing or colour button. Source bytes stay
unchanged. This is not a WCAG contrast guarantee for every hue.

The app precaches both assets in its service-worker shell, remembers its
fixed mode locally, pauses animation while hidden, and holds a static frame
when reduced motion is requested. There is no upload/custom-file chooser.

## Reproduce and verify nocturnal-drift

From the repository root, with Python 3 (standard library only):

```sh
python3 scratch/colours/generate.py
python3 scratch/colours/generate.py --check
```

The script writes only its named generated asset, never the copied source.
No randomness or external dependencies. It morphs artist-selected violet,
indigo, teal, blue-green shadow, amber, and plum control points over six
10-second smootherstep transitions, with gentle periodic brightness breathing.
It is not a hue-wheel sweep. The continuous curve is periodic with matched
first/second derivatives; samples cover `[0,60)` at 30 fps (no duplicated
terminal time). Gamma 1 leaves the chosen colour bytes unwarped.

Verified output SHA-256:
`7225ef3083553b29250f4d97c68fbf2d81c5cd1b244fcb027e7ff857fe2985c4`.
All adjacent frames, including wrap, change by at most **1 byte/channel**.
First and last stored GRB are both `[23, 74, 143]`, so the wrap step is **0**.
The generator checks size, reproducibility, periodic endpoint and seam limits,
and prints metadata. Visual character is designed, not hardware-calibrated.
