# Kling 3.0 (Kuaishou, via KIE) — card

Status: parameters from the official KIE schema (docs.kie.ai, checked 27.09.2026). A Kling prompting guide
was not collected yet [not found] — prompt rules below are general video practice, mark them provisional.

## What it is good at
- Short clips of 3–15 s; animating a given still from a start frame, optionally landing on an end frame
  [official schema].
- Cheaper per second than Seedance 2.5 (std 14–20 credits/s vs 63 at 720p) [official price].

## Where it fails
- Only start / end frames are supported in this studio — no free reference images (Kling "elements" are not
  wired in yet).
- Dialogue and long takes are Seedance territory; prefer Seedance 2.5 for them.

## How to write the prompt (provisional)
- One continuous shot: subject, the single main action, how the camera moves, the mood and light.
- With a start frame: describe what changes from that frame (motion, camera), not the whole picture again.
- Keep it under ~2 500 characters (Playground limit) [official].

## Parameters
- mode: std (720p), pro (1080p), 4K. durationSec: 3–15. aspectRatio: 9:16, 1:1, 16:9 (taken from the start
  frame when one is given). audio: sound on / off (on costs more).
