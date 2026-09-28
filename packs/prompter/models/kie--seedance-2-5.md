# Seedance 2.5 (ByteDance, via KIE) — card

Status: parameters from the official KIE schema; reference syntax @ImageN from KIE / fal examples. The owner's
guide-based shot constructor (the «Кадры» tab) encodes a proven documentary-realism method for this model —
for a serious shot, recommend it in `alternativesRu`.

## What it is good at
- 4–30 s clips with native audio; dialogue; up to 30 reference images; first / last frame mode [official schema].
- Handheld / documentary realism when the prompt is written by time segments (the owner's guide).

## Where it fails
- Frames (first / last) and references cannot be combined in one task [official].
- Expensive at higher resolution: 480p 28, 720p 63, 1080p 158 credits per second [official price].

## How to write the prompt
- Paragraphs by time segments: what happens in each segment, where the camera is and how it moves.
- Describe the camera as a physical operator (handheld, distance, height), light and weather as physics
  (wet asphalt, wind in hair) — the owner's guide style.
- Dialogue: the spoken line in quotes with its language ("says in clear, native Russian: «…»").
- References: call them @Image1, @Image2 … in the order they are attached. With no references attached, do
  not mention any.

## Parameters
- resolution: 480p, 720p, 1080p (default 720p). durationSec: 4–30. aspectRatio: 9:16, 3:4, 1:1, 4:3, 16:9, 21:9.
  audio: on by default.
