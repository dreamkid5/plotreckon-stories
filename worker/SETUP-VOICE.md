# Ava female narration — free and locked

PlotReckon Stories narrates every production video with
`en-US-AvaMultilingualNeural`. This matches the supplied Ava reference sample and
uses the free Microsoft Edge neural speech service.

The production lock lives in `worker/voice.mjs`. CSV voice fields, provider
environment variables, and workflow settings cannot replace Ava.

## Install locally

```sh
python3 -m pip install edge-tts
```

GitHub Actions installs `edge-tts` automatically.

## Run

```sh
cd worker
npm run once
```

Each narrated segment also produces word-boundary timing data. The renderer uses
those timings for highlighted captions and verifies that both the audio and timing
files are valid. Transient narration failures are retried up to eight times.

The female presenter is a separate generated image. She appears on the left side
of the video, and the exact same image is reused on the right side of the thumbnail.
