# Seedance 2.5 (ByteDance, via Higgsfield API) — card

Status: parameters from the official Higgsfield model schema; reference syntax @ImageN from Higgsfield examples. The owner's
guide-based shot constructor (the «Кадры» tab) encodes a proven documentary-realism method for this model —
for a serious shot, recommend it in `alternativesRu`.

## What it is good at
- 4–30 s clips with native audio; dialogue; up to 30 reference images; first / last frame mode [official schema].
- Handheld / documentary realism when the prompt is written by time segments (the owner's guide).

## Where it fails
- Frames (first / last) and references cannot be combined in one task [official].
- Expensive at higher resolution: account-specific cost; obtain /estimate for the exact request before submission.

## How to write the prompt
- Paragraphs by time segments: what happens in each segment, where the camera is and how it moves.
- Describe the camera as a physical operator (handheld, distance, height), light and weather as physics
  (wet asphalt, wind in hair) — the owner's guide style.
- Dialogue: the spoken line in quotes with its language ("says in clear, native Russian: «…»").
- References: call them @Image1, @Image2 … in the order they are attached. With no references attached, do
  not mention any.

## Parameters
- resolution: 480p, 720p, 1080p (default 480p — the owner drafts Seedance in 480p; 720p / 1080p only when the idea
  says it is a final). durationSec: 4–30. aspectRatio: 9:16, 3:4, 1:1, 4:3, 16:9, 21:9.
  audio: on by default.
