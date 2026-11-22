# Routing: which model for which task

Source: research 003 (27.09.2026) — Higgsfield's own model routing in its official agent skill
(github.com/higgsfield-ai/skills, 26.09.2026) plus LMArena / Artificial Analysis rankings (24–27.09.2026).

## Automatic cost policy

In `auto` mode, satisfy the request's required capabilities and reference routing first. Among models
that can meet those requirements, prefer the lower estimated cost. A cheap model that loses required
identity, product details, lettering, input images or duration is not an adequate substitute. In `fixed`
mode, keep the owner's chosen model.

Each candidate includes a `costHint` for one output using its listed parameter defaults and the number
of reference images actually routed to that model. These are catalog estimates, not confirmed charges
or a quote for different parameters. `account_quote_required` with `usd: null` means the price is
unknown until the normal account quote step; it is never zero or evidence that this model is cheapest.
Use these supplied hints for current comparisons. Historical price claims in model cards do not
establish a price for an unquoted candidate.

Auto defaults use a lower-cost supported resolution or mode when the catalog can price it. Keep these
defaults for an ordinary draft unless the idea, comment or prior explicitly required parameters call
for higher resolution or quality. Small readable lettering, fine required detail and print output may
justify a higher tier. Preserve requested duration, aspect ratio and explicit quality; never shorten
the requested clip to make its price look lower. Compare costs only for settings that meet the same
requirements, and explain a necessary higher-cost choice briefly in `reasonRu`.

| The idea mostly needs | First choice | Why | Second choice |
|---|---|---|---|
| Readable text in the frame: poster, sign, packaging, UI, infographic | GPT Image 2.5 (sunburst for dense text) | #1 in text rendering on both arenas [arena]; Higgsfield routes text to it [official] | Seedream 5 Pro — Russian is an officially supported text language [official] |
| The owner's own character (Soul ID), fashion / editorial mood, close or medium shot | Soul 2 | trained identity, editorial look, curated moodboards [vendor] | GPT Image 2.5 with reference photos when text or a wide shot is required |
| A character sheet (front / side / three-quarter / full body), face-preserving edit | Seedream 5 Pro | Higgsfield routes character sheets and face edits to it [official]; multi-image edit #4 [arena] | GPT Image 2.5 sunburst — #1 in identity-preserving edits [arena] |
| Product / object shots, several angles, clean background | GPT Image 2.5 | #1 in Product/Branding/Commercial [arena] | Seedream 5 Pro |
| A real person from a reference photo (the owner or someone he attaches), any framing | GPT Image 2.5 sunburst | #1 in identity-preserving edits [arena]; the photo reaches the model; Soul 2 also accepts one image reference, but its identity quality is unverified | Seedream 5 Pro — face-preserving edits [official, Higgsfield skill] |
| A product / item from a reference photo that must stay exact | GPT Image 2.5 | #1 Product/Branding [arena]; label text rendered from the quote | Seedream 5 Pro |
| Several references combined into one scene | GPT Image 2.5 sunburst or Seedream 5 Pro | multi-image edit #1 and #4 [arena] | — |
| Complex composition, exact number of objects, physics, hands | GPT Image 2.5 | #1 in complex compositions, anatomy, physics [arena] | Seedream 5 Pro |
| Documentary / handheld realism for video, dialogue, long shot | Seedance 2.5 | 4–30 s, audio, up to 30 references; the owner's shot constructor («Кадры») is built for it | Kling 3.0 for short clips from a start frame |
| Short clip that animates a given still (start frame, optional end frame) | Kling 3.0 | start / end frames, 3–15 s [official KIE schema]; compare current cost hints only when both prices are known | Seedance 2.5 with first / last frame |

Known weak spots to route around:
- Soul 2 renders text badly [vendor] → keep text out; if needed, fix afterwards with a GPT Image 2.5 edit.
- Soul ID loses likeness when the face is under ~20% of the frame [vendor] → keep the character close or medium.
- Soul ID face can be cloned onto background people [vendor] → avoid crowds with Soul ID.
- Pixel-identical areas cannot be guaranteed by any edit [official, OpenAI] → composite instead.
