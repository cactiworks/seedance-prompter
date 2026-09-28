# Routing: which model for which task

Source: research 003 (27.09.2026) — Higgsfield's own model routing in its official agent skill
(github.com/higgsfield-ai/skills, 26.09.2026) plus LMArena / Artificial Analysis rankings (24–27.09.2026).

| The idea mostly needs | First choice | Why | Second choice |
|---|---|---|---|
| Readable text in the frame: poster, sign, packaging, UI, infographic | GPT Image 2.5 (sunburst for dense text) | #1 in text rendering on both arenas [arena]; Higgsfield routes text to it [official] | Seedream 5 Pro — Russian is an officially supported text language [official] |
| The owner's own character (Soul ID), fashion / editorial mood, close or medium shot | Soul 2 | trained identity, editorial look, curated moodboards [vendor] | GPT Image 2.5 with reference photos when text or a wide shot is required |
| A character sheet (front / side / three-quarter / full body), face-preserving edit | Seedream 5 Pro | Higgsfield routes character sheets and face edits to it [official]; multi-image edit #4 [arena] | GPT Image 2.5 sunburst — #1 in identity-preserving edits [arena] |
| Product / object shots, several angles, clean background | GPT Image 2.5 | #1 in Product/Branding/Commercial [arena] | Seedream 5 Pro |
| Several references combined into one scene | GPT Image 2.5 sunburst or Seedream 5 Pro | multi-image edit #1 and #4 [arena] | — |
| Complex composition, exact number of objects, physics, hands | GPT Image 2.5 | #1 in complex compositions, anatomy, physics [arena] | Seedream 5 Pro |
| Documentary / handheld realism for video, dialogue, long shot | Seedance 2.5 | 4–30 s, audio, up to 30 references; the owner's shot constructor («Кадры») is built for it | Kling 3.0 for short clips from a start frame |
| Short clip that animates a given still (start frame, optional end frame) | Kling 3.0 | start / end frames, 3–15 s, cheaper per second [official KIE schema] | Seedance 2.5 with first / last frame |

Known weak spots to route around:
- Soul 2 renders text badly [vendor] → keep text out; if needed, fix afterwards with a GPT Image 2.5 edit.
- Soul ID loses likeness when the face is under ~20% of the frame [vendor] → keep the character close or medium.
- Soul ID face can be cloned onto background people [vendor] → avoid crowds with Soul ID.
- Pixel-identical areas cannot be guaranteed by any edit [official, OpenAI] → composite instead.
