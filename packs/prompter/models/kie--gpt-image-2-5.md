# GPT Image 2.5 (OpenAI, via KIE) — card

Status: official prompting guide exists (developers.openai.com/api/docs/guides/image-prompting, written for
2.5); #1 on LMArena and Artificial Analysis in almost every category (Sept 2026).

## What it is good at
- Text rendering, photorealism, portraits, anatomy, physics, complex compositions, product / branding,
  precise edits and multi-reference scenes — #1 (sunburst) / #2 (flare) [arena].
- Edits change only what was asked and keep the subject better than GPT Image 2 [official].
- Russian text: not claimed by OpenAI; the owner's test (28.09.2026) rendered a short Russian handwritten
  note correctly [owner]. Long or small Russian text is untested.

## Where it fails
- Precise text placement and clarity in dense layouts; consistency of a recurring character across
  generations; layout-sensitive compositions [official limitations].
- Repeated edits can still change what should stay [official].

## How to write the prompt
- Structure: scene → subject → details → constraints. State the intended use (poster, ad, product shot,
  UI) and the framing. Any format works — a clear paragraph is fine [official].
- Text: put the exact wording in double quotes and describe its position and typography; spell unusual
  words letter by letter; tell how many times it appears; add "No extra text, no watermarks, no unrelated
  logos." [official].
- Photorealism: say "photorealistic" or "real photograph"; ask for real texture (pores, wrinkles, fabric
  wear, imperfections); "No glamorization, no heavy retouching."; avoid studio-polish words; camera
  specifications are cues for appearance, not physics [official].
- Framing: be explicit ("full body visible, feet included", "close-up, face fills the upper half") [official].
- References: identify each input by number and purpose — subject, style, clothing, background — as
  "image 1", "image 2" [official].

## Parameters
- variant: flare (default, faster) or sunburst (most precise — use for dense text, demanding edits,
  identity preservation) [official].
- resolution: 1K, 2K, 4K (small text or print → 2K+). aspectRatio: 9:16, 3:4, 2:3, 1:1, 4:3, 3:2, 16:9, 21:9.
- background: auto, opaque, transparent (transparent for cut-out product shots / stickers).
