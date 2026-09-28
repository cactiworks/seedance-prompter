# Soul 2 (Higgsfield, official API) — card

Status: [provisional] — Higgsfield publishes no prompting guide for Soul and the model is absent from the
independent arenas. Rules below come from vendor statements and single reviews; the owner's own test runs
will refine them.

## What it is good at
- Realistic people, skin and fabric texture, natural light, spontaneous poses, an "expensive" editorial /
  fashion look [vendor].
- Understands camera and culture cues as looks: "phone flash", "disposable camera", subculture names — name
  the look instead of describing it technically [vendor].
- Light and poses read better than Nano Banana 2 [single, sponsored review].

## Where it fails
- Text in the frame is "not a core strength" [vendor]; reviews show garbled text on bottles and clothing
  [single]. Keep text out of the prompt; if the idea needs text, write the scene without it and put
  "add the text with a GPT Image 2.5 edit" into weak spots.
- Object-level editing is limited; illustration and heavy stylisation are weaker [vendor].
- Prompt adherence is looser than Nano Banana: "full body" was cropped at the knees, a backhand became a
  forehand [single]. Put critical framing first and state it plainly.

## Soul ID (the owner's trained character)
- Identity comes from the Soul ID parameter, not from words: describe styling, setting, action and light,
  not the face [vendor: "leave the identity to Soul ID"]. One user got a better body shape by stating the
  build explicitly [single] — body type is allowed, facial features are not.
- Likeness holds on close-up and medium shots and breaks first on wide shots (face under ~20% of the
  frame), profile, extreme low or high angles [vendor]. For a wide scene with the character: warn, and
  suggest a close-up generation plus a separate wide plate.
- The trained face may be cloned onto background people [vendor] — avoid crowds while Soul ID is on.
- The owner's Soul ID «matthew» is NOT available in the API account (checked 28.09.2026) — do not assume a
  character is set; the owner enters a Soul ID himself when he has one.

## How to write the prompt
- Lead with the aesthetic direction and the mood / setting; then subject, action, styling, light,
  framing [vendor: prompt is "for mood and setting", "leading with aesthetic direction"].
- Positive phrasing only — there is no negative prompt [official, general Higgsfield advice].
- Keep it short: about 40–120 words; Higgsfield's general ceiling is ~200 tokens [official, general] —
  long prompts distort.
- No real public people or trademarks (the API flags them) [official].

## Moodboards (curated styles)
- 33 curated moodboards; pick one by exact name when it matches the look (see `styleOptions`). A moodboard
  sets palette, grain and look — do not restate it in words [vendor: "presets beat freehand prompting"].
- Custom moodboards made on the Higgsfield website are not available through the API.

## Parameters
- aspectRatio: 9:16, 3:4, 2:3, 1:1, 4:3, 3:2, 16:9. resolution: 720p, 1080p (default 1080p).
- No reference images via the API. Seed is handled by the studio — do not mention it.
