# Seedance 2.5 и Higgsfield — факты для лимитов и валидаторов

Собрано веб-ресёрчем 20.09.2026. Уровень: **П** — подтверждено первоисточником, **В** — вторичный
источник, **С** — слух, **Н** — не найдено. Перед тем как полагаться на пункт уровня В/С — перепроверить.

## Модель

| факт | уровень | источник |
|---|---|---|
| Seedance 2.5 вышел 31.07.2026; до 30 с за генерацию с multi-round extensions; до 30 изображений + 10 видео + 10 аудио; мультишот внутри одного дубля; timestamp-level редактирование | П | https://seed.bytedance.com/en/blog/one-take-creation-flexible-referencing-introducing-seedance-2-5 |
| Seedance 2.0 (10.02.2026): 15 с, до 9 изображений / 3 видео / 3 аудио, нативный липсинк | П | https://seed.bytedance.com/en/blog/official-launch-of-seedance-2-0 |
| Референсов всего ≤50; изображения JPG/PNG/WebP/BMP/TIFF/GIF/HEIC/HEIF ≤30 MB | П | https://fal.ai/models/bytedance/seedance-2.5/reference-to-video/api |
| Длительность: `auto` или целое 4–30 с | П | fal API |
| Aspect ratios: auto, 21:9, 16:9, 4:3, 1:1, 3:4, 9:16 | П | fal API |
| Разрешение в API — 480p / 720p; «native 4K» на лендингах — маркетинг; 1080p на Pro+ по help-центру Higgsfield | П / В | fal API, Higgsfield help |
| 24 fps | В | mindstudio, segmind |
| **Максимальная длина промпта** | **Н** | нигде: ByteDance, BytePlus, fal, Higgsfield, CLI |
| Озвучка: «more than ten languages», нативный липсинк | П | BytePlus / Runware |
| **Русская озвучка** в официальных списках не названа; утверждают только агрегаторы | В / С | seedance.tv |

## Синтаксис и структура промпта

| факт | уровень | источник |
|---|---|---|
| Ссылки на референсы официально — `@Image 1` / `@Video 1` / `@Audio 1` (кит. `@图片1`) | П | https://higgsfield.ai/creator-hub/help-center/ai-models/how-do-i-use-seedance · https://higgsfield.ai/blog/seedance-2-5-on-higgsfield-2026 · fal |
| `<<<image_N>>>` (синтаксис гайда) не подтверждён ни одним источником — вероятно, сериализация чипа-упоминания в веб-UI Higgsfield при копировании | Н | — |
| Официальная формула: subject + action/event + scene & environment + visual style + camera work/cutting + sound (обязательны первые две) | П | https://docs.byteplus.com/en/docs/ModelArk/2607689 (JS-рендер) · перевод https://dev.to/super_lewis/the-seedance-25-prompting-guide-in-english-4hen |
| Разметка: музыка `( )`, SFX `< >`, **реплики `{ }`**, субтитры `【 】`; язык словами перед репликой: `Dialogue language: American English. The girl says naturally: {…}` | П | там же |
| «Ёлочки» гайда — не документированный синтаксис (но у автора гайда работают) | — | гайд vs документация |
| Референс + исключение одним предложением: «@image1 supplies <subject>'s <appearance…>. **Do not take the background.**» | П | там же |
| Таймкоды — бюджеты темпа, не точки монтажа; формат `0-8s:` отдельной строкой; сегменты без перекрытий | П | там же |
| Negative prompt как поля нет; «no X» в описании действия может усиливать X | П / В | там же |
| «the more assets, the more easily stability drops»; рекомендуют 1–8 субъектов | П | там же |
| «Use the shortest prompt that fully specifies the production»; типично 150–300 знаков на сцену | П / В | https://dreamina.capcut.com/seedance/seedance-2-5-prompt · https://best.xiaohu.ai/article/seedance-25-prompt-guide/ |

## Слабые места (практика)

- Морфинг и декогеренция в быстром движении (В) — https://www.mindstudio.ai/blog/seedance-2-5-review-guide
- Масштаб пропсов плавает: книга размером с чемодан (В).
- Непредсказуемый кастинг голоса: британский акцент без запроса; «American» сработало, «American English» — нет (В).
- Промпты эпохи 2.0 в 2.5 дают «visibly broken, glitchy results» (В).
- Character sheet затаскивает серый студийный задник в кадр (В).
- Дрейф лица усиливается, когда руки пересекают лицо, и при быстрых поворотах головы (В).
- Модерация: реальные публичные лица, загруженные фото реальных людей, бренд-марки, франшизные персонажи (В).
- Двери/крышки, руки, текст в кадре, слипание однотипных объектов — специфично для 2.5 не найдено (Н);
  в гайде Cinema Ai Tech подтверждены практикой: борт пикапа, три кейса слиплись в один.

## API и площадки

- Higgsfield: docs.higgsfield.ai, консоль open.higgsfield.ai, npm `@higgsfield/cli`
  (https://github.com/higgsfield-ai/cli). Эндпойнты `text-to-video` / `image-to-video` /
  `reference-to-video`; text-to-video референсы не принимает (П).
- fal.ai — полная схема reference-to-video (П). BytePlus ModelArk — https://docs.byteplus.com/en/docs/ModelArk/2607688 (П).
- Replicate — подтверждён только Seedance 2.0 (П).
- Операционное (из журнала решений владельца): в Higgsfield отключать Enhance Prompt.

## Что из этого следует для инструмента

1. Диалект вывода — настройка проекта: `refSyntax` (`<<<image_N>>>` | `@Image N`), `dialogueWrap`
   («ёлочки» + языковая фраза | `{}` + `Dialogue language:`). Дефолт — по итогам проверки M0-c.
2. Лимиты-валидаторы: рефов ≤30 изображений (мягко >8), длительность целое 4–30, 9:16 допустим.
3. Клауза-исключение у character sheet со студийным задником; риск-флаги: рука у лица, текст в кадре,
   реальные лица, быстрые движения, масштаб пропсов.
4. Счётчик длины промпта виден всегда; жёсткого лимита нет — порог только информационный.
