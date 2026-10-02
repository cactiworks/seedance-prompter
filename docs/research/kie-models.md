# Модели KIE и Higgsfield API: входные схемы для каталога генерации

**Дата сверки: 2026-09-27.** Только чтение: docs.kie.ai (`.md`-версии страниц + OpenAPI-блоки внутри них),
публичные страницы kie.ai, docs.higgsfield.ai. Ни одного `createTask`, `POST` на генерацию или `estimate` не делалось.

## Легенда уверенности

| метка | что значит |
|---|---|
| **[док]** | подтверждено документацией (OpenAPI-схема или текст страницы доков) |
| **[прайс]** | только из прайса KIE (`kie_prices.json`, 503 позиции, снят 27.09.2026) |
| **[нет]** | в документации не найдено; не додумывать |
| **[стр]** | *расширение легенды:* публичная страница модели (kie.ai/… — конфиг Playground и `pricingDesc`; console.higgsfield.ai). Это UI, а не контракт API, поэтому слабее [док] |
| **[конфликт]** | источники расходятся; передавать значение явно, закладываться на худший вариант |

**Scope.** После сужения задачи детально разобраны: GPT Image 2.5 (и GPT Image 2 для сравнения),
Seedream 5.0 Pro, Kling 3.0 (turbo и motion control — одной строкой), Seedance 2.5 (только роли медиа),
Soul 2 через официальный Higgsfield API. Что успел собрать до сужения — в приложении A: только id и URL, без сверки.

---

## 0. KIE Market API: общее для всех моделей ниже

| что | значение | ур. |
|---|---|---|
| Base URL | `https://api.kie.ai` | [док] |
| Auth | `Authorization: Bearer <KEY>` + `Content-Type: application/json` | [док] |
| Создать задачу | `POST /api/v1/jobs/createTask`, тело `{"model": "...", "callBackUrl": "...", "input": {...}}` → `data.taskId` | [док] |
| Статус | `GET /api/v1/jobs/recordInfo?taskId=...` → `data.state` ∈ `waiting / queuing / generating / success / fail` | [док] |
| Результат | `data.resultJson` — это **строка** с JSON внутри: `{"resultUrls":[...]}`, её нужно парсить ещё раз; плюс `failCode`, `failMsg`, `costTime`, `creditsConsumed` | [док] |
| Ошибки | код приходит в теле ответа, поле `code`: 401, 402 (нет кредитов), 422 (валидация), 429, 433, 455, 500, 501 (генерация упала), 505. Проверять `code`, а не только HTTP-статус | [док] |
| Rate limit | 20 новых задач за 10 с на аккаунт. Лишние получают 429 и в очередь не попадают | [док] |
| Webhook | `callBackUrl`: POST приходит при любом исходе, успехе или провале. Подпись — Webhook Verification Guide | [док] |
| Жизнь результатов | recordInfo: URL «typically expire after 24 hours». Getting Started: медиа хранятся 14 дней | [конфликт] скачивать сразу |
| Загрузка файлов | отдельный хост `https://kieai.redpandaai.co` (upload по URL, base64 или stream), бесплатно. В одном месте доков «удаляются через 24 ч», в другом «через 3 дня, URL живёт 24 ч» | [док] [конфликт] |
| Кредит | 1 кредит = $0.005: у всех строк прайса 6 кр = $0.03 | [прайс] |
| `nsfw_checker` | есть во `input` у многих моделей (bool). В API default `false`, то есть фильтр KIE выключен. В Playground default `true` | [док] / [стр] |
| Доплата | «High-tier top-ups +10% bonus», эффективно примерно на 10% дешевле прайса | [стр] |

Все модели из разделов 1–4 используют этот общий Market API. Отдельных эндпоинтов у них нет.

---

## 1. GPT Image 2.5: Flare и Sunburst

### Что такое Flare и Sunburst

- Это **два разных model id** одного семейства GPT Image 2.5. На kie.ai сказано: OpenAI, релиз 08.09.2026. [стр]
- **Схемы входа идентичны.** Сделал diff OpenAPI обеих пар: отличаются только имена моделей и примеры. **Цены тоже одинаковые.** [док] [прайс]
- Разница только в описании на https://kie.ai/gpt-image-2-5 [стр]:
  - **Flare** — «the default choice for most applications… with lower latency». Для креатор-контента, соцсетей, прототипов, high-volume.
  - **Sunburst** — «built for more premium visual workflows that benefit from tighter control and more polished outputs». Для кампейн-ассетов, брендовых визуалов, продуктовых фото, «stronger precision across edits».
  - На практике: Flare быстрее, Sunburst тщательнее. **Параметра `quality` нет**: качество выбирается выбором модели.
- На той же странице есть Arena-рейтинг: у GPT Image 2.5 две позиции (T2I 1421 и 1399; edit 1520 и 1491; multi-image edit 1535 и 1501). Какая цифра к какому варианту — **не указано**. [стр] [нет]
- Внутренний канал KIE у обеих — `"channel":"fal_request"`, то есть модель проксируется через fal. [стр]

### model id (Market API, статус через recordInfo)

| режим | Flare | Sunburst |
|---|---|---|
| text-to-image | `gpt-image-2-5-flare-text-to-image` | `gpt-image-2-5-sunburst-text-to-image` |
| image-to-image | `gpt-image-2-5-flare-image-to-image` | `gpt-image-2-5-sunburst-image-to-image` |

У этих id нет префикса со слешем, в отличие от `seedream/...` и `kling-3.0/...`. [док]

### input

| поле | тип | значения / диапазон | default | обяз. | ур. |
|---|---|---|---|---|---|
| `prompt` | string | 1–20 000 символов | — | да | [док] |
| `input_urls` | string[] (uri) | до 16 картинок; **только в i2i** | — | да в i2i | [док]. Форматы в доках не указаны [нет]; Playground: jpeg/png/webp, ≤30 MB, до 16 [стр] |
| `aspect_ratio` | string | `auto`, `1:1`, `3:2`, `2:3`, `4:3`, `3:4`, `16:9`, `9:16`, `21:9`, `27:16`, `16:27`, `9:8`, `8:9` | `auto` (так сказано в описании поля) | нет | [док]. `27:16`, `16:27`, `9:8`, `8:9` работают только на 1K |
| `resolution` | string | `1K`, `2K`, `4K` | в доке [нет]; Playground `1K` [стр] | нет | [док] |
| `background` | string | `transparent`, `opaque`, `auto` | в доке [нет]; Playground `auto` [стр] | нет | [док] |

- Полей **нет** [нет]: `quality`, `n` / число картинок, `seed`, `output_format`, `negative_prompt`, `mask`.
- **Роли входных картинок.** Все лежат в `input_urls` без ролей. Маски нет. Механизма ссылок на картинки в промпте (`@Image1`, «image 1») нет [нет].
- Для GPT Image 2 есть ограничения: 1:1 не бывает 4K, `auto` даёт только 1K, `background` работает только на 1K. Для 2.5 в доках они **не повторены** [нет]. Пока не проверено, считать, что они могут действовать.

### Цена [прайс] [стр], за картинку

| модель | 1K | 2K | 4K |
|---|---|---|---|
| Flare и Sunburst, t2i и i2i | 6 кр ($0.03) | 10 кр ($0.05) | 16 кр ($0.08) |

Цена зависит только от `resolution`. Отдельной строки за входные картинки в прайсе нет.

Доки: https://docs.kie.ai/market/gpt/gpt-image-2-5-flare-text-to-image · …/gpt-image-2-5-flare-image-to-image ·
…/gpt-image-2-5-sunburst-text-to-image · …/gpt-image-2-5-sunburst-image-to-image

### Для сравнения: GPT Image 2 [док]

- id: `gpt-image-2-text-to-image` и `gpt-image-2-image-to-image`. Цена та же: 6 / 10 / 16 кр [прайс].
- `prompt` до 20 000 символов, `input_urls` до 16, `resolution` 1K / 2K / 4K, `background` transparent / opaque / auto.
- `aspect_ratio`: auto, 1:1, 3:2, 2:3, 4:3, 3:4, 5:4, 4:5, 16:9, 9:16, 2:1, 1:2, 3:1, 1:3, 21:9, 9:21.
  На 2K нельзя 5:4, 4:5, 3:1, 1:3, 9:21. На 4K нельзя 3:1, 1:3, 9:21. **1:1 не бывает 4K.**
  **`auto` или отсутствие aspect_ratio дают только 1K**, иначе задача не создастся. **`background` работает только на 1K.**
- Доки: https://docs.kie.ai/market/gpt/gpt-image-2-text-to-image · https://docs.kie.ai/market/gpt/gpt-image-2-image-to-image

---

## 2. Seedream 5.0 Pro

model id: `seedream/5-pro-text-to-image` и `seedream/5-pro-image-to-image`. Market API, статус через recordInfo. [док]

| поле | тип | значения / диапазон | default | обяз. | ур. |
|---|---|---|---|---|---|
| `prompt` | string | 3–5000 символов | — | да | [док] |
| `image_urls` | string[] (uri) | до 10; jpeg/png/webp; ≤30 MB каждая; **только в i2i** | — | да в i2i | [док] |
| `aspect_ratio` | string | `1:1`, `4:3`, `3:4`, `16:9`, `9:16`, `2:3`, `3:2`, `21:9` | `1:1` | помечено required | [док] |
| `quality` | string | `basic` = 1K, `high` = 2K | `basic` | помечено required | [док] |
| `output_format` | string | `png`, `jpeg` | `png` | нет | [док] |
| `nsfw_checker` | bool | | `false` | нет | [док] |

- Отдельного поля `resolution` нет, разрешением управляет `quality`. 4K нет. `auto` / adaptive для aspect_ratio нет.
  `seed` и числа выходных картинок нет. [нет]
- **Роли.** Все `image_urls` — равноправные референсы, ролей нет [док]. Синтаксиса ссылок на картинки в промпте нет [нет].
  Страница kie.ai пишет только общее: «subject image, background image, style reference, product material, composition guide» [стр].
- Есть ещё Layer Decomposition (страница `market/seedream/5-pro-layer-decomposition`). Его id и схему не сверял [нет].
  Цена по прайсу: 7 кр за 1K / 1.5K, 14 кр за 2K, за каждый слой, включая базовый [прайс].

### Цена [прайс] [стр], за картинку

| quality | цена |
|---|---|
| `basic` (1K) | 7 кр ($0.035) |
| `high` (2K) | 14 кр ($0.07) |
| входные картинки (i2i) | **0.5 кр за каждую, первая бесплатно** |

Пример: i2i с 10 рефами на 2K стоит 14 + 9 × 0.5 = **18.5 кр**.

Доки: https://docs.kie.ai/market/seedream/5-pro-text-to-image · https://docs.kie.ai/market/seedream/5-pro-image-to-image

---

## 3. Kling 3.0: `kling-3.0/video`

Market API, статус через recordInfo. Доки: https://docs.kie.ai/market/kling/kling-3-0

### Режимы: std, pro, 4K

Задаются полем `mode`. Разрешение считается из `mode` и `aspect_ratio` [док]:

| `mode` | 16:9 | 9:16 | 1:1 |
|---|---|---|---|
| `std` | 1280×720 | 720×1280 | 720×720 |
| `pro` | 1920×1080 | 1080×1920 | 1080×1080 |
| `4K` | 3840×2160 | 2160×3840 | 2160×2160 |

### input

В схеме обязательным помечен только `model`, но `input` по смыслу тоже нужен.

| поле | тип | значения / диапазон | default | обяз. | ур. |
|---|---|---|---|---|---|
| `prompt` | string | работает только при `multi_shots=false`. Лимит в доке не указан [нет]; Playground: 2500 [стр] | — | в схеме required | [док] |
| `image_urls` | string[] (uri) | 0–2. `[0]` — первый кадр, `[1]` — последний. При multi-shot — только первый кадр. **«Required when elements are referenced in the prompt»** | — | условно | [док]. Форматы в доке не указаны [нет]; Playground: jpg/png ≤10 MB [стр] |
| `sound` | bool | звук / SFX | `false`; при `multi_shots=true` default `true` | required | [док]. Playground default `true` [конфликт] |
| `duration` | **string** | `"3"` … `"15"` | `"5"` | required | [док] |
| `aspect_ratio` | string | `16:9`, `9:16`, `1:1` | `16:9` (Playground `1:1`) | required | [док]. Если есть `image_urls`, параметр необязателен: аспект берётся с картинки. Playground: «invalid if first or last frames are provided» |
| `mode` | string | `std`, `pro`, `4K` | док `pro`, Playground `std` | required | [конфликт] передавать явно |
| `multi_shots` | bool | | `false` | required | [док] |
| `multi_prompt` | object[] | до 5 шотов: `{prompt: string ≤500, duration: int 1–12}` | — | при multi_shots | [док] |
| `kling_elements` | object[] | до 3 элементов, структура ниже | — | нет | [док] |

**Элемент в `kling_elements`** [док]:

| поле | что |
|---|---|
| `name` (req.) | имя. В промпте пишется как `@name`, в массиве — без `@` |
| `description` (req.) | описание |
| `element_input_urls` (req.) | **2–4 картинки** JPG/PNG, ≤10 MB каждая. Текст доки и пример допускают вместо них **1 видео** MP4/MOV (≥3 с, рабочий отрезок 3–8 с), но описание поля говорит только о картинках [конфликт] |
| `element_input_audio_urls` | опционально, аудио 5–30 с («audio material for characters», голос персонажа) |
| `start_time`, `end_time` | мс; только для видео-элемента; `end − start` от 3000 до 8000 |

### Как ссылаться в промпте [док]

- Синтаксис `@element_name`; имя совпадает с `name` в `kling_elements`.
- В примерах доков встречается и `window@element_dog` (слитно), и `window @element_dog` (с пробелом).
- **Каждый `@element` съедает 37 символов лимита.** Это критично для multi-shot, где на шот 500 символов.
- На задачу не больше 3 элементов.

### Роли медиа и запреты

- **Single-shot:** `image_urls[0]` — стартовый кадр, `[1]` — конечный. Один элемент в массиве = только первый кадр.
  Передать только конечный кадр нельзя: такого способа в схеме нет. [док]
- **Multi-shot:** поддерживается только первый кадр. [док]
- **Элементы требуют `image_urls`** («required when elements are referenced»). По доке получается, что элементы работают только вместе со стартовым кадром. На живом API не проверено. [док]
- **Сумма длительностей шотов.** Playground: сумма ≤15 с [стр]. Дока: «plan your shot durations to match the total video duration», но в её примере шоты 3+3 при `duration: "5"` [конфликт]. Ставить `duration` равной сумме шотов.
- `negative_prompt`, `cfg_scale`, seed — [нет].

### Цена [прайс] [стр], кредитов за секунду

| `mode` | без звука | со звуком |
|---|---|---|
| `std` (720p) | 14 ($0.07) | 20 ($0.10) |
| `pro` (1080p) | 18 ($0.09) | 27 ($0.135) |
| `4K` | 67 ($0.335) | 67 ($0.335) |

Цена = ставка(mode, sound) × duration. Меняют ли цену элементы (видео или аудио) — [нет].
При multi-shot звук по умолчанию включён, то есть дефолт дороже.

### Остальное семейство Kling 3.0, одной строкой

- **Kling 3.0 Turbo — есть.** `kling/v3-turbo-text-to-video` и `kling/v3-turbo-image-to-video`.
  `prompt` ≤2500, `duration` 3–15 с, `resolution` `720p` / `1080p`, `aspect_ratio` 1:1 / 9:16 / 16:9 (только в t2v).
  В i2v одна картинка в `image_urls`, jpeg/png ≤10 MB. Полей sound, elements, multi-shot нет.
  Цена 18 кр/с (720p), 22.5 кр/с (1080p). [док] [прайс]
- **Kling 3.0 Motion Control — есть.** `kling-3.0/motion-control`.
  `input_urls` — 1 картинка персонажа, `video_urls` — 1 видео движения, `prompt` опционально 0–2500.
  `mode` `std` (720p) / `pro` (1080p), `character_orientation` `video` | `image`, `background_source` `input_video` | `input_image`.
  Цена 20 кр/с (720p), 27 кр/с (1080p). [док] [прайс]
- **Kling 3.0 Omni** — отдельное семейство, не разбирал: `kling-3.0-omni/text-to-video`, `/image-to-video`, `/reference-to-video`, `/transformation`. В прайсе строк нет. [док] [нет]

---

## 4. Seedance 2.5: сверка ролей медиа

model `bytedance/seedance-2-5`, Market API. Доки: https://docs.kie.ai/market/bytedance/seedance-2-5

### Роли

| роль | поле | лимиты | ур. |
|---|---|---|---|
| первый кадр | `first_frame_url` (string: URL или `asset://{assetId}`) | 1 | [док] |
| последний кадр | `last_frame_url` | 1. **Отдельно не передаётся, только вместе с `first_frame_url`** | [док] |
| референс-картинки | `reference_image_urls[]` | до 30; jpeg/png/webp/bmp/tiff/gif; соотношение сторон (0.4, 2.5); стороны 300–6000 px; <30 MB | [док]. Playground принимает jpeg/png/webp [стр] |
| референс-видео | `reference_video_urls[]` | до 10; mp4/mov; 480p/720p; соотношение [0.4, 2.5]; w×h от 409 600 до 927 408 px; ≤200 MB; 24–60 fps; каждое 2–30 с; **суммарно ≤30 с** | [док] |
| референс-аудио | `reference_audio_urls[]` | до 10; wav/mp3; ≤15 MB; каждое 2–30 с | [док]. Сумма ≤30 с сказана только в Playground [стр] |

### Взаимоисключение [док]

Три сценария **не смешиваются**:

1. I2V по первому кадру: `first_frame_url`.
2. I2V по первому и последнему кадру: `first_frame_url` + `last_frame_url`.
3. Multimodal R2V: любые `reference_*`.

Без медиа получается T2V. `first_frame_url` нельзя сочетать ни с одним `reference_image_urls` / `reference_video_urls` / `reference_audio_urls`.
Совет из доки: чтобы получить «кадры + референсы», положить картинку в `reference_image_urls` и в промпте назвать её первым или последним кадром.
Если кадры должны совпасть строго — сценарий 2.

### Ссылки в промпте

- В доках не описаны [нет].
- В примере на https://kie.ai/seedance-2-5 (и в Playground, и в cURL) используется `Reference @Image1 @Image2 for the …, @Image3 @Image4 for the scene`, то есть `@ImageN` слитно, нумерация с 1 [стр].
- Для видео и аудио синтаксис на KIE не найден [нет]. В `seedance-2.5-facts.md` есть `@Video 1` / `@Audio 1`, но это источники Higgsfield и fal, не KIE.

### Остальные поля, коротко [док]

| поле | значения |
|---|---|
| `prompt` | ≤30 000 символов |
| `duration` | int 4–30 или `-1` (авто; для video-edit равна длине входного видео); default 5 |
| `resolution` | `480p` / `720p` / `1080p`, default `720p`. **На KIE есть 1080p**, в fal API и в `seedance-2.5-facts.md` — только 480p / 720p |
| `aspect_ratio` | `1:1`, `4:3`, `3:4`, `16:9`, `9:16`, `21:9`, `adaptive`; default `adaptive` |
| `generate_audio` | default `true` |
| `return_last_frame` | default `false`. Со слов доки несовместим с `draft=true`, но поля `draft` в схеме нет [нет] |
| `output_format` | `mp4` / `mov` |
| `web_search` | bool |
| `nsfw_checker` | подключён в схему через `$ref`, в Playground виден [док] [стр] |

`lastFrameUrl` в `resultJson` при `return_last_frame` recordInfo описывает только для Seedance 2 / 2 Fast. Для 2.5 — [нет].

### Цена [прайс] [стр], кредитов за секунду

| разрешение | без видео-входа | с видео-входом |
|---|---|---|
| 480p | 28 ($0.14) | 17 ($0.085) |
| 720p | 63 ($0.315) | 38 ($0.19) |
| 1080p | 158 ($0.79) | 95 ($0.475) |

Формула со страницы: без видео-входа = ставка × длительность выхода; **с видео-входом = ставка × (длительность входного видео + выхода)**.
`generate_audio` в прайсе на цену не влияет (отдельных строк нет), хотя дока пишет «Enabling audio will increase the generation cost» [конфликт].

---

## 5. Higgsfield API: Soul 2 (Soul V2)

Источники: https://docs.higgsfield.ai/docs/models/soul-2/generate.md (перечитан вживую 27.09), `…/models/soul-id/create-character.md`,
`…/concepts/*.md`; страница модели https://console.higgsfield.ai/models/higgsfield-ai/soul/v2/standard и её
`https://dash.higgsfield.ai/models/higgsfield-ai/soul/v2/standard/llms.txt`.

### Эндпоинт и авторизация [док]

- `POST https://api.higgsfield.ai/higgsfield-ai/soul/v2/standard` (endpoint ID `higgsfield-ai/soul/v2/standard`). Тело — **плоский JSON**, без обёртки `input`.
- `Authorization: Key KEY_ID:KEY_SECRET`. Ключи берутся в console.higgsfield.ai. Legacy-заголовки `hf-api-key` + `hf-secret` тоже принимаются. Вызывать только с сервера.
- Webhook: query-параметр `?hf_webhook=<urlencoded https URL>`. Payload: `{request_id, status, error, payload: {images: [{url, content_type}]}}`. Отвечать нужно за 10 с.

### Поля запроса

| поле | тип | значения / диапазон | default | ур. |
|---|---|---|---|---|
| `prompt` (req.) | string | лимит длины не указан [нет] | — | [док] |
| `aspect_ratio` | string | `9:16`, `16:9`, `4:3`, `3:4`, `1:1`, `2:3`, `3:2` | docs `1:1` / console и dash-llms `4:3` | [конфликт] передавать явно |
| `resolution` | string | `720p`, `1080p` | `720p` | [док] |
| `enhance_prompt` | bool | | docs `false` / console `true` | [конфликт]. Док: короткие промпты в general-стиле могут усиливаться даже при `false` |
| `custom_reference_id` | uuid \| null | Soul ID: `completed` и принадлежит аккаунту вызывающего | `null` | [док]. **В схеме console/dash этого поля нет** [конфликт] |
| `custom_reference_strength` | number 0–1 | с `custom_reference_id` ставить **>0**: схема принимает 0, но runtime на нём падает | `1.0` | [док] |
| `style_id` | uuid | список через API, см. ниже | `3db34ab5-3439-4317-9e03-08dc30852e69` | [док] |
| `style_strength` | number 0–1 | **принимается, но сейчас ни на что не влияет** | `1.0` | [док] |
| `seed` | int 1–1 000 000 | | случайный; **явный `null` невалиден** (docs), при этом пример в console шлёт `"seed": null` | [конфликт] не передавать поле вовсе |
| `batch_size` | int | **только `1` или `4`** | `1` | [док] |

- Референс-картинки и мудборда в API-схеме нет [нет]. В ui_schema console упомянут виджет `image_reference`, но в `input_schema` такого поля нет [стр].

### Статус и формат ответа [док]

- Ответ на сабмит: `{"status":"queued","request_id":"…","status_url":"https://api.higgsfield.ai/requests/{id}/status","cancel_url":"…/cancel"}`.
  Брать URL из ответа, а не собирать вручную.
- `GET /requests/{request_id}/status` → `status` ∈ `queued`, `in_progress`, `completed`, `failed`, `nsfw`, `canceled`.
  **На `completed` картинки лежат в `images: [{url}]`** (у видео-моделей — `video.url`). На `failed` приходит `error`.
- Отмена: `POST /requests/{id}/cancel` работает только пока `queued`, ответ 202. Если уже `in_progress` — 400.
- Поллинг: 2 с, дальше ×1.5 до 10 с, плюс jitter. Выход хранится минимум 7 дней.
- Ключа идемпотентности нет. **POST после неясного таймаута не повторять**, иначе будет двойная генерация.
- Лимит — конкурентность: `400 "Maximum number of concurrent requests (4) has been reached"` (пример из доки).
  Коды: `403` — нет кредитов, `423` — модель временно заблокирована, `503` — модель выключена.

### Estimate [док]

`POST https://api.higgsfield.ai/estimate/higgsfield-ai/soul/v2/standard` с тем же телом, что у генерации → `{"credits": "1.500", "usd": "0.094"}`.
Цифры в доке иллюстративные: авторитетен ответ для конкретного аккаунта.

### Soul ID (custom references) и стили [док]

- **Создать:** `POST /v1/custom-references`, тело `{name ≤100, model_version: "v1"|"v2"|"cinema", input_images: [{type: "image_url", image_url}] × 1–100}`.
  **Default `model_version` — `v1`**, поэтому для Soul 2 нужно явно передать `"v2"`.
  Ответ: `{id, name, model_version, status, thumbnail_url, created_at, in_progress_at, fail_reason}`.
- **Статус тренировки:** `GET /v1/custom-references/{id}` → `not_ready`, `queued`, `in_progress`, `completed`, `failed`.
  После `completed` этот `id` передаётся как `custom_reference_id`.
- **Списка всех Soul ID в доках нет** [нет]: описан только GET по конкретному id. Каталогу придётся хранить UUID у себя или просить владельца вставить его.
- **Список стилей:** `GET /v1/text2image/soul-styles/v2` → `[{id, name, description, preview_url}]`. Для Soul v1 — `/v1/text2image/soul-styles`.
- **Загрузка файлов:** `POST /files/generate-upload-url {"content_type": "image/jpeg"}` → `{public_url, upload_url, upload_headers}`.
  Дальше PUT файла на `upload_url` со всеми `upload_headers`. Upload URL живёт 1 ч.
  Типы: image/jpeg, jpg, png, webp, gif; audio/wav; video/mp4.
  Для самого Soul 2 t2i загрузка не нужна; публичные URL нужны для тренировки Soul ID.

### Цена

- **$0.0032 за картинку на 720p, $0.0057 на 1080p** — страница модели в console [стр].
  Что `batch_size: 4` стоит ×4 — вероятно, но нигде не сказано [нет]. Отдельной таблицы цен в доках нет [нет]; точное значение даёт `estimate`.
- Тренировка Soul ID — «from $2.5 per request» (блок related models в console) [стр].
- Запросы с исходом `failed` и `nsfw` не списываются; отменённые в `queued` возвращаются. Кредиты сгорают через год. [док]
- Из журнала владельца, не из доков: бесплатный пул генераций Soul есть только в веб-интерфейсе, developer-линия всегда платная.
  Работает ли «matthew», натренированный через веб / CLI (бэкенд fnf), как `custom_reference_id` в `api.higgsfield.ai` — **не проверено**.
  Дока требует только, чтобы reference принадлежал тому же аккаунту, что и API-ключ.

---

## Приложение A. Собрано до сужения задачи, без сверки

Здесь только model id и путь к доке (`https://docs.kie.ai/<путь>`). Схемы скачаны, но не разбирались. Все — Market API (`createTask` + `recordInfo`).

| модель | model id | дока |
|---|---|---|
| Nano Banana 2 / 2 Lite / Pro | `nano-banana-2`, `nano-banana-2-lite`, `nano-banana-pro` | `market/google/nanobanana2`, `…/nano-banana-2-lite`, `…/pro-image-to-image` |
| Nano Banana (+ edit) | `google/nano-banana`, `google/nano-banana-edit` | `market/google/nano-banana`, `…/nano-banana-edit` |
| Seedream 4.5 | `seedream/4.5-text-to-image`, `seedream/4.5-edit` | `market/seedream/4-5-text-to-image`, `…/4-5-edit` |
| Flux 2 Pro | `flux-2/pro-text-to-image`, `flux-2/pro-image-to-image` | `market/flux2/pro-*` |
| Qwen 2.1 | `qwen2-1/text-to-image`, `qwen2-1/image-to-image` | `market/qwen2-1/*` |
| Grok Imagine image | `grok-imagine/text-to-image`, `grok-imagine/image-to-image`; 2.0: `grok-imagine-image-2-0/text-to-image`, `…/image-edit`, `…/segment-edit`, `…/segment-map` | `market/grok-imagine*/…` |
| Seedance 2 / Fast / Mini | `bytedance/seedance-2`, `bytedance/seedance-2-fast`, `bytedance/seedance-2-mini` | `market/bytedance/seedance-2*` |
| Kling 2.6 | `kling-2.6/text-to-video`, `kling-2.6/image-to-video`, `kling-2.6/motion-control` | `market/kling/text-to-video`, `…/image-to-video`, `…/motion-control` |
| Wan 2.7 | `wan/2-7-text-to-video`, `wan/2-7-image-to-video`, `wan/2-7-r2v`, `wan/2-7-videoedit` | `market/wan/2-7-*` |
| Wan 3.0 | `wan/3-0-video`, `wan/3-0-video-prime` | `market/wan/3-0-video*` |
| Hailuo 2.3 | `hailuo/2-3-image-to-video-pro`, `hailuo/2-3-image-to-video-standard` (t2v у 2.3 на KIE нет) | `market/hailuo/2-3-*` |
| MiniMax H3 | `minimax-h3/text-to-video`, `…/image-to-video`, `…/reference-to-video` | `market/minimax-h3/*` |
| PixVerse V6 | `pixverse-v6/text-to-video`, `…/image-to-video`, `…/transition`, `…/extend`, `…/reference-to-video` | `market/pixverse/*` |
| Grok Imagine video | `grok-imagine/text-to-video`, `…/image-to-video`, `…/extend`, `…/upscale`, `grok-imagine-video-1-5-preview` | `market/grok-imagine/*` |
| Upscale | `topaz/image-upscale`, `topaz/video-upscale`, `recraft/crisp-upscale` | `market/topaz/*`, `market/recraft/crisp-upscale` |

**Veo 3.1 (не разбирал).** Новая версия доков описывает Veo через общий `POST /api/v1/jobs/createTask`: `model: "veo-3-1"`,
`generation_type` ∈ `TEXT_2_VIDEO` / `FIRST_AND_LAST_FRAMES_2_VIDEO` / `REFERENCE_2_VIDEO`, `resolution` 720p / 1080p / 4k,
`duration` 4 / 6 / 8 [док]. Страница Extend при этом ещё ссылается на старый «Get Video Details API»
(`veo3-api/get-veo-3-video-details`), а старая версия доков лежит в `docs.kie.ai/old-model/veo3-api/…`.
Как выбирается Lite / Fast / Quality в новой схеме и одинаков ли формат статуса со старым — **не выяснено** (после сужения задачи не копал).

## 6. Topaz Video Upscale: `topaz/video-upscale` (сверено 02.10.2026, решение 39)

| поле | значение | источник |
|---|---|---|
| `model` | `topaz/video-upscale`, общий `POST /api/v1/jobs/createTask` | [док] docs.kie.ai/market/topaz/video-upscale |
| `input.video_url` | обязательное; mp4 / quicktime / matroska; до 50 МБ | [док] |
| `input.upscale_factor` | строка `'1'` / `'2'` / `'4'`, по умолчанию `'2'` | [док] |
| результат | `resultJson`: `resultUrls`, `firstFrameUrl`, `lastFrameUrl` | [док] |
| предел длительности и выходного разрешения | **[нет]** — не додумывать; 480p × 4 = 1920×3416, проходит ли — проверить первым прогоном | — |

### Цена [прайс], кредитов за секунду (публичный JSON прайса, снят 02.10.2026)

| увеличение | кр/с | $/с |
|---|---|---|
| 1× и 2× | 8 | 0.04 |
| 4× | 14 | 0.07 |

За какую длительность берут деньги — входа или выхода, и как округляют — **[нет]**. В системе: секунды исходника по ffprobe,
вверх с допуском 0.1 с (`billedSeconds`). Первое списание сверить с оценкой.
