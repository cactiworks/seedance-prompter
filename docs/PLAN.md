# Seedance Prompter — локальный конструктор промптов для Seedance 2.5

## Context

Владелец генерирует видео в Higgsfield на Seedance 2.5 и хочет свой инструмент сборки промптов: сайт,
где заполняешь параметры → получаешь промпт, с опциональной загрузкой референсов. Источник правил —
гайд школы Cinema Ai Tech (`https://splendid-starlight-7a4c1c.netlify.app/`): 12 слоёв промпта,
11 правил механики, 12 приёмов, таблица «симптом → причина → починка», чек-лист, 6 полных промптов
(7,4–9,6 тыс. знаков) с разбором по абзацам. Дополнение — корпус Карлова в волте. Интерфейс — на
дизайн-системе **Lab UI v2.1** (Figma Community, lab.pics, CC BY 4.0), требование — «очень качественно».

Встроенный в гайд конструктор — подстановка ~20 полей в строку. Самое трудное он оставляет человеку:
сценарные абзацы на английском (≈70 % текста), где и живут все ошибки из таблицы гайда — оператор как
действующее лицо, 15 микродействий подряд, блик на реквизите, синяк не с той стороны, сдвиг номеров
ссылок между кадрами, пропавшие теги после «from», опечатки в репликах. Цель — инструмент, который
закрывает эти классы ошибок конструкцией, а не памятью пользователя.

## Решения владельца (20.09.2026)

| вопрос | решение |
|---|---|
| где живёт | только он, локально на Mac (localhost), с нуля, старые проекты не переиспользуем |
| роль LLM | гибрид: детерминированное ядро работает без LLM; LLM — писатель сценарных абзацев |
| доступ к LLM | только подписка Claude Code (Max) → локальный сервер зовёт `claude -p`; провайдер за абстракцией |
| единица работы | проект из кадров: общий мир + непрерывность между кадрами |
| режимы | v1 — только «документалка ручной камерой» из гайда; режимы = packs, добавляются данными |
| объём v1 | ядро + LLM-писатель + **петля попыток** + **vision-анализ рефов** |
| отложено | LLM-критик, профили full/lean, таймкоды, новые packs, раннер генерации |
| `<<<image_N>>>` | не проверял → оба синтаксиса с первого дня + проверка «день 0» |
| дизайн | Lab UI v2.1; Figma Starter; доступ: REST API по токену в Keychain + экспорт переменных плагином |
| тема / материалы | светлая по умолчанию (тёмная поддержана); liquid glass только на плавающем хроме |

## Факты, на которые опирается дизайн

- **Seedance 2.5** (релиз 31.07.2026, блог ByteDance Seed): до 30 с одним дублем, до 30 img + 10 video +
  10 audio (≤50), 9:16 есть, API отдаёт 480p/720p. Жёсткий лимит длины промпта не найден нигде.
- **Гайд расходится с официальной документацией** в трёх местах: ссылки (`<<<image_N>>>` vs `@Image N`),
  реплики («ёлочки» + языковая фраза vs `{…}` + `Dialogue language:`), длина (7–9,6 тыс. знаков vs
  «shortest prompt», типично 150–300). Инструмент по умолчанию следует гайду (подтверждён готовым
  роликом), но синтаксис вывода — **настройка проекта**, а не константа.
- **Практика 2.5:** character sheet затаскивает серый студийный задник; лицо плывёт, когда рука
  пересекает лицо; масштаб пропсов плавает; морфинг в быстром движении; «no X» в описании действия может
  усиливать X (совпадает с правилом гайда «запрет работает, когда текст с ним не спорит»).
- **Карлов:** отдельная карта персонажа под каждый образ/одежду; рефы только на основе реальных фото;
  «немой вход» — движение в первом кадре, событие ко 2-й секунде; темп речи ≈2,6–3,1 слова/с (К1 — 64
  слова, К2 — 77, К3 — 57–59); в Higgsfield отключать Enhance Prompt.
- **`guide.html` — размеченный датасет:** спаны 7 категорий подсветки (`hl-ref`, `hl-cam`, `hl-imp`,
  `hl-look`, `hl-world`, `hl-say`, `hl-neg`) и `look-data`. Pack извлекается скриптом, не перепечаткой.
- **claude CLI 2.1.278** (`claude auth status`: claude.ai, max): `--safe-mode` отключает CLAUDE.md, хуки,
  плагины, MCP, skills, auto-memory, auth при этом работает; `--bare` не годится (только API key);
  `ANTHROPIC_API_KEY` в env молча уводит биллинг на API; structured output сделан внутренним tool
  `StructuredOutput` (поэтому `--max-turns 1` и `--disallowedTools "*"` его ломают).
- **Lab UI:** кода/npm нет — только Figma-файл. Primitive + semantic токены (v2.1.1: производный токен =
  цвет × непрозрачность), материалы liquid glass / ambient / solid, прогрессивные тени и блюры, light/dark
  + повышенный контраст, масштаб 75–133 %, 30+ компонентов, 400+ иконок. Язык Apple-подобный: пилюли,
  крупные радиусы, segmented control со стеклянным бегунком, input с label на рамке, акцент `#007AFF`,
  Inter. Figma отдаёт 403 ботам; Variables REST API — только Enterprise; MCP на Starter ≈ 6 вызовов/мес.
- Mac: node 26 (исполняет TS нативно), npm 11, bun 1.3; `~/Documents` не в iCloud.

## Инварианты (то, что физически не даёт ошибиться)

1. **Номера ссылок руками не пишет никто.** В тексте живут плейсхолдеры; компилятор разворачивает их в
   диалект по порядку панели *этого* кадра. Перетащил картинку — номера сменились везде. Исчезают: сдвиг
   нумерации между кадрами, висящий «from», `@image7` вперемешку. Неразрешённый плейсхолдер блокирует
   экспорт; токен неизвестной ссылки никогда не удаляется молча.
2. **LLM не пишет ни реплик, ни языковой фразы, ни травм.** Закрытая грамматика `{{type:id}}`:
   `{{intro:key}}` — первое упоминание с привязкой к рефу («Alexander, matching <<<image_6>>>»; при
   флаге студийного задника детерминированно добавляется клауза-исключение); `{{ref:key}}` — повторная
   ссылка; `{{line:L3}}` — вся конструкция реплики по диалекту (языковая фраза + обёртка + русский текст
   буква в букву); `{{state:S1}}` — каноническое предложение последствия со стороной, степенью и
   ограничителем («right side only… no blood, no cut»). LLM только выбирает, где их поставить.
3. **Проверенные формулировки гайда — дословно, из pack**; `verbatim.lock.json` хранит sha256 каждой —
   защита от «улучшений» агентом. Побайтный golden-тест: из структурных фикстур компилятор выдаёт
   промпты гайда байт в байт.
4. **Комплект «камера + объектив» — одна переменная.** Объектив живёт в 6+ местах промпта; характер,
   абзац оптики, поведение блика в световых событиях берутся из `kits`; смена комплекта открывает
   чек-лист шести мест (детерминированное обновлено, LLM-абзацы stale, реплики на пересмотр, реф).
5. **Абзац = отрезок времени = сегмент.** Связь 1:1; маркеры попыток по таймкоду автоматически
   указывают «виновный абзац». Перегенерация, блокировка, правка, diff — по сегментам.
6. **Любой слот, попадающий в промпт, двуязычен:** `ru` вводит владелец, `en` пишет LLM или он сам;
   ручная правка блокирует юнит; при изменении входов юнит помечается stale, текст не теряется.
7. **Наружу уходит только то, что нажато кнопкой:** LLM-вызовы текста и vision-анализ конкретного рефа.
   Сервер слушает 127.0.0.1, проверяет `Host`/`Origin` и заголовок клиента на мутациях (иначе любая
   веб-страница сможет тратить квоту и читать рефы). `data/` в `.gitignore`; репозиторий не публикуется:
   внутри чужой гайд и авторизация по подписке.
8. **Гейт перед копированием.** «Копировать для генерации» открывает чек-лист: проверяемое закрывает
   линтер; человеческое («реплики вычитаны» — галочка на каждой реплике, сбрасывается при правке;
   «панель в Higgsfield в том же порядке»; «Enhance Prompt выключен») остаётся ручным.
9. **UI только на токенах Lab UI.** stylelint запрещает сырые цвета, радиусы и тени в CSS приложения —
   допустимы только `var(--lab-*)`. Это момент срабатывания дизайн-системы, а не договорённость.

## Стек и процессная модель

Каталог: `~/Documents/вайбк/seedance-prompter/`. TypeScript везде, один npm-пакет, без нативных зависимостей.

- **Один процесс, один порт, один режим:** `node src/server/index.ts` (нативный TS Node 26:
  `erasableSyntaxOnly`, импорты с `.ts`, без enum/namespace; откат — `tsx`) поднимает http-сервер:
  `/api/*` → Hono, остальное → Vite в middleware mode. Нет `dist`, нет расхождения dev/prod.
- **core** (`src/core`) — чистый TS без DOM и Node API (ESLint `no-restricted-imports` + архитектурный
  тест): работает в браузере (живой предпросмотр и линт на каждое нажатие) и в Vitest.
- **web** — React 19 + Zustand (+immer, zundo для undo) + Zod 4 + dnd-kit + CodeMirror 6 (правка
  EN-абзацев: плейсхолдеры — атомарные чипы, находки линтера — диагностики с quick-fix) +
  **Radix primitives** (поведение и доступность) + **свой UI-kit на токенах Lab UI** (CSS Modules).
  Tailwind и shadcn не используем: дизайн-система задаёт собственную шкалу.
- **server** — Hono: хранение, отдача картинок, LLM-мост; типобезопасный клиент `hc<AppType>` — дрейф
  API ловится на `tsc`; `app.request()` — тесты без портов.
- **Команды:** `npm start` / двойной клик `Запустить.command` (сам открывает браузер на
  `127.0.0.1:4317`; повторный запуск видит живой `/api/health` и просто открывает вкладку) ·
  `npm run dev` (watch) · `npm run check` = `tsc --noEmit && eslint && stylelint && vitest run && vite build`
  — единственный критерий «готово» каждой сессии · `npm run doctor` — проверки «дня 0», перезапускаемые.
- **Хранение** — файлы: `data/projects/<slug>/project.json` (PUT целиком с `If-Match: rev`, 409 →
  перезагрузка; атомарная запись tmp + rename; кольцевые бэкапы; `schemaVersion` + миграции),
  `refs/<id>/{original.*, vision.jpg ≤1568px, thumb.webp}` (ресайз в браузере через canvas),
  `attempts/<shotId>/<n>.json` + `<n>.prompt.txt`, `llm-results/`, `data/user-pack/`, `data/logs/llm/`.
- Версии пинятся, lockfile в git (в registry уже TS 7 — брать ту, что совместима с typescript-eslint).

```
seedance-prompter/
  CLAUDE.md  README.md  Запустить.command  package.json  tsconfig.json  vite.config.ts  eslint/stylelint
  docs/      PLAN.md  DECISIONS.md  source/guide.{html,txt}  research/seedance-2.5-facts.md  day0/*.ndjson
  design/lab-ui/  variables.json  raw/file.json  renders/*.png  compare/*.png  ATTRIBUTION.md
  packs/cinema-doc/
    pack.json layers.json block-plan.json verbatim.json verbatim.lock.json kits/*.json defects.json
    techniques.json symptoms.json checklist.json lexicon.json lint.json highlight.json dialects.json
    prompts/{writer,translator,fixer,vision}.system.md  prompts/fewshot/{k1a3,k2,k3a2}.json
  src/core/   model/ pack/ compile/ lint/{engine,rules/*} llm/{contracts,build*,validate,repair}
              attempts/{diff,summary,symptoms,promote} continuity/ import/parsePrompt.ts
  src/server/ index.ts app.ts routes/ storage/ doctor.ts
              llm/{provider,queue}.ts llm/claudeCli/{provider,args,env,ndjson,tripwire,classifyError}.ts
              llm/mock/provider.ts llm/tasks/{write,rewriteBlock,translate,fix,vision}.ts
  src/web/    ui/{tokens,materials,icons,components}/  features/{projects,world,refs,shot,preview,lint,
              llm,attempts,check}/  store/  api/  routes/ui-gallery
  scripts/    extract-guide.ts  lint-text.ts  day0/*.sh  design/{figma-pull,build-tokens,compare}.ts
  tests/      fixtures/guide/{k1a1..k3a2}.json  fixtures/projects/*.project.json  fixtures/llm/*.ndjson
  data/       # .gitignore
```

## Pack «cinema-doc»: знания как данные

Код не знает правил гайда — он исполняет pack. В pack: все английские формулировки, русские «зачем»,
словари, пороги, комплекты, порядок и условия блоков, system prompts, few-shot, рецепты симптомов,
чек-лист. В коде: схемы, template engine, разрешение плейсхолдеров и диалектов, механика правил,
оркестрация LLM, хранилище, UI. `scripts/extract-guide.ts` извлекает фикстуры, словари подсветки и
look-строки из `guide.html`. Новый режим позже = новый каталог в `packs/`.

- **12 слоёв → план блоков** (6–7 блоков, как в удачных промптах): ① стиль-блок [verbatim + kit];
  ①ʹ разделение ролей + абзац оптики [автоматически, если реквизит того же типа, что снимающая техника];
  ② правило про оператора + локация/погода/базовый свет [verbatim + мир.en]; ③ герои, предметы, входящие
  последствия, первая реплика; ④ главное действие и реплики; ⑤ поведение камеры + фон и звук;
  ⑥ световые события + финал + мостик [LLM + дословный хвост].
- **kits:** якорная строка, характер (long/short), абзац оптики, спецификация блика (форма, отрицание,
  поведение, место «on the image itself»), политика блика для световых событий, слова-маркеры комплекта.
- **symptoms:** 10 строк таблицы гайда + найденное ресёрчем и в разборах (общий план вместо среднего,
  фон не исполнен, обрыв посреди движения, серый задник, дрейф лица, не тот акцент, смена света посреди
  дубля, непрошеные объекты, «дрон»-камера, потерянные слова реплики).
- **fewshot:** К1·попытка 3, К2, К3·попытка 2 в плейсхолдерной форме + русские биты к ним.
  `fixtures/projects/*.project.json` — три кадра гайда структурно: тест-данные и учебный пример в UI.

## Модель данных (Zod, `src/core/model/`)

```
TextUnit       { id, ru, en (с плейсхолдерами), source: llm|manual, locked, inputsHash, inputsProjection,
                 generator{model, promptVersion}, history[≤5] }          # единица «текст с происхождением»
Project        { schemaVersion, rev, title, format{9:16, 30 с, singleTake}, dialogueLanguage,
                 dialect{ refSyntax: higgsfield-chip | at-image, dialogueWrap: guillemets | braces },
                 world{location, weatherPhysics, lightBaseline, ambientSound, exclusions : TextUnit},
                 refs[], characters[], props[], extras[], shots[], continuity[] }
Ref            { id, key, file, kind: location|character|prop|vehicle|gear|other, label,
                 role{preset по kind + свободный хвост}, flags{hasPeople, hasText, studioBackdrop, realPerson}, vision? }
Character      { key (неизменяемый slug), name (латиницей), looks[{id, title, refId}], movement: TextUnit }
Prop           { key, name, refId?, isKey, wear: TextUnit, kitLinked }
Shot           { id, order, kitId | customKit, vantage: TextUnit, operatorRule: long|short|off,
                 panel: RefId[]  # порядок = нумерация
                 cast[{characterKey, lookId, holds{left,right}, stateIds[]}], props[], segments[],
                 finale: TextUnit, bridge, outcomes: ContinuityState[], overrides{blockKind→text}, attempts[] }
Segment        { id, titleRu, approxStart/End, shotSize, beats[], text: TextUnit }     # 1:1 с абзацем
Beat           { id, kind: action|dialogue|camera|light|background|sound, weight: major|minor, ru, lineId? }
Line           { id 'L3' (не переиспользуется), speakerKey, ru, proofread, delivery[stumble|pause|breath|through-action] }
ContinuityState{ id 'S1', subject, kind, bodyPart, side, degree, cause, looksLike: TextUnit, limiter, originShotId }
Attempt        { n, promptText, panelSnapshot, blocksSnapshot, compiledWith{packVersion, dialect}, verdict,
                 markers[{t, note, segmentId}], worked[], failed[], symptomIds[], fixesApplied[], changesSummary[],
                 generation{status: manual|…} }        # контракт AttemptExport готов для будущего раннера
CompiledBlock  # производный, не хранится: { kind, layerIds, spans[{text, origin: verbatim|template|textUnit|ref|line|state}] }
```

## Конвейер

1. **Plan + Compile** (детерминированно, в браузере): входы кадра → блоки по `block-plan`; у каждого
   фрагмента provenance-спан (клик в превью ведёт в поле-источник). Ручная правка детерминированного
   блока — через `overrides` («отвязан от шаблона», есть возврат).
2. **Staleness:** `inputsHash` по проекции входов сегмента (биты, shotSize, время, задействованные
   сущности, vantage, правило оператора, состояния; kit — только для kit-чувствительных сегментов).
   Не входят порядок панели, диалект и текст реплик. UI объясняет причину: «устарел: изменился бит B3».
3. **Write** (LLM, только по клику): один вызов на кадр ради связной причинно-следственной цепочки;
   пишутся лишь юниты «пустые или llm» ∧ «stale или пустые» ∧ «не заблокированные». `rewriteBlock` —
   один сегмент с соседями как read-only контекстом. Любая замена непустого текста — через review-diff.
4. **Validate** (детерминированно): схема → покрытие сегментов → грамматика плейсхолдеров → починка
   неизвестного id (регистр, алиасы, Левенштейн ≤2 внутри типа) → обязательность и порядок (`{{line}}`
   ровно раз и в порядке битов; `{{state}}` раз; один `{{intro}}` на сущность с рефом) → запрещённое
   (кириллица, «», сырые `<<<image`/`@Image`) → линтер. Провал → **один repair-вызов** только по
   упавшим блокам со списком нарушений → иначе блок `invalid`: прежний текст сохранён, нарушения показаны.
5. **Resolve:** плейсхолдеры → диалект. **Lint** — мгновенно, находка привязана к блоку и диапазону.
6. **Export:** весь промпт / по блокам; манифест панели + **выгрузка панели пронумерованными файлами**
   `01-…`, `02-…` и «Показать в Finder» (порядок загрузки нельзя перепутать); чек-лист-гейт;
   **paste-back verifier** (вставил то, что показывает Higgsfield → сравнение с экспортом: рецепт гайда
   против пропавших тегов); «Сохранить как попытку N».

## LLM-мост (`src/server/llm/`)

`LLMProvider { health(); run(req): AsyncIterable<LLMEvent> }` — события `init | progress | retry |
result | error`. В v1 адаптер `claude-cli` + `mock` (проигрывает NDJSON, записанные в «день 0»).
План Б за тем же интерфейсом — Agent SDK (`settingSources: []` **явно**, у SDK дефолт не пуст); позже —
API-ключ/OpenRouter. Subprocess выбран, потому что это документированный личный сценарий, команду можно
скопировать в Терминал для отладки, а `--safe-mode` доступен напрямую.

```bash
claude -p --safe-mode --strict-mcp-config --tools "" --disallowedTools "mcp__*" --disable-slash-commands \
  --no-session-persistence --permission-mode dontAsk --system-prompt-file <abs> \
  --model <cfg> --effort medium --fallback-model sonnet --max-turns 5 \
  --input-format stream-json --output-format stream-json --verbose --include-partial-messages \
  --json-schema '<draft-07>'        # z.toJSONSchema(schema, {target: "draft-7"})
```

- stdin — одна NDJSON-строка user-сообщения (текст и, для vision, image-блок base64); один путь кода.
- `spawn` без shell; `cwd` — пустой каталог вне репозитория; **env по allowlist** (`HOME USER PATH LANG
  TMPDIR…` + `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 ENABLE_CLAUDEAI_MCP_SERVERS=false DISABLE_AUTOUPDATER=1`);
  никогда не наследовать `ANTHROPIC_*`, `CLAUDECODE`, `CLAUDE_CODE_SESSION_ID`.
- **Tripwire на каждом вызове** по событию `system/init`: `tools ⊆ {StructuredOutput}`, `mcp_servers`,
  `plugins`, `slash_commands` пусты, `apiKeySource == "none"`. Нарушение → убить процесс,
  `ISOLATION_VIOLATION`, вывод не используется. Это закрывает смешение контуров: без хуков claude-mem и
  личного CLAUDE.md в вызовах инструмента.
- Профиль B (герметичный fallback): `CLAUDE_CONFIG_DIR=<пустой>` + `CLAUDE_CODE_OAUTH_TOKEN` из
  `claude setup-token`, токен — в Keychain. Нужен, если `-p` когда-нибудь станет `--bare` по умолчанию.
- Успех — только `subtype == success` с непустым `structured_output`. Ошибки классифицируются таблицей
  и показываются по-русски с действием: не залогинен · лимит сессии/недели (когда сброс) · модель
  недоступна → переключить на Sonnet · таймаут · исчерпаны ретраи схемы · «продолжить без LLM».
- Таймауты: write 240 с, rewriteBlock 120 с, vision 90 с, translate 60 с; idle 60 с; SIGINT → SIGTERM →
  SIGKILL; очередь concurrency 1; дочерние процессы гасятся при остановке сервера (в т.ч. SIGHUP).
- `POST /api/llm/run` → SSE; отмена через `AbortController`. Результат **до отправки** пишется в
  `llm-results/<runId>.json`: упавшая вкладка не теряет минуту генерации.
- System prompt побайтно стабилен (правила + few-shot ≈10–12 тыс. токенов, без дат) → prompt cache;
  всё динамическое — в user message. Личные правила владельца — отдельным стабильным хвостом.

**Задачи v1:** `translate` (мир и дескрипторы ru → en, один раз на проект — абзац локации един для всех
кадров, как в гайде) · `write` / `rewriteBlock` · `fix` (петля попыток) · `vision`. Ответ писателя:
`{ blocks[{segmentId, en, usedPlaceholders, mainAction, notesRu}], warningsRu[] }` — `notesRu`
показывает, что писатель решил сам («добавил medium shot на выходе героя»).

## Линтер (`src/core/lint/`)

Правило `{ id, family, needs: text|structure|both, defaultSeverity, run(ctx) → Finding[] }`; параметры и
словари — из pack. `Finding { ruleId, severity, messageRu, blockId, range, origin, evidence, fixes[],
fingerprint }`; quick-fix = патчи (`setField | replaceInTextUnit | addRefToPanel | insertVerbatim`).
**Suppress по fingerprint с обязательной причиной** («осознанное исключение» — как отражение оператора
в К2). Две точки входа: `lintShot(project, shotId)` и `lintText(raw, {panelSize, dialect})` — для
вставленных промптов и golden-тестов. **error — только гигиена, рефы, роли, непрерывность**; остальное
warn/info: правила выведены из одного ролика, источник истины — журнал попыток.

| семейство | ключевые правила |
|---|---|
| **стиль** | STYLE_FIRST · REAL_GEAR · LOOK_NEAR_GEAR · HANDHELD_SWITCH · DEFECT_STACK · ORDER (как снято → что снято) · LANG_TAIL · FORMAT_REPEAT (30 с и 9:16 совпадают с полями) · ONE_TAKE_CONTRADICTION («cut to», «later») |
| **оператор** | OP_VANTAGE_VIA_PERSON («The operator rides in…», error) · OP_ACTOR_VERB (без правила — error, с правилом — info) · OP_BODY_NOUN (hands, strap; белый список «as if the arms holding it are tired») · OP_PORTRAIT_IN_STYLE · OP_RULE_MISSING · OP_BAN_CONTRADICTED |
| **рефы** | REF_SYNTAX_FOREIGN · REF_DANGLING_PREP («from with», «as in and») · REF_OUT_OF_RANGE · REF_UNUSED · REF_NO_ROLE · REF_LOCATION_IGNORE_PEOPLE · REF_PEOPLE_ON_OBJECT_REF («только машина») · REF_TEXT_ON_REF · REF_STUDIO_BACKDROP · REF_KEY_OBJECT_NO_REF · REF_ON_EXTRA · REF_LOOK_MISMATCH · REF_PANEL_LIMIT (>8 мягко, >30 жёстко) |
| **бюджет** | EVENT_BUDGET (4–6 major, масштаб по длительности) · MICRO_ACTION_OVERLOAD · ONE_MAIN_ACTION · BG_BUDGET (≤3–4) · BG_NO_REACT · EXTRA_LONG_ROLE · SHOT_SIZE_KEY_MOMENTS · ENTRY_DRAMATURGY (событие ко 2-й секунде, первый бит не реплика; info) |
| **реплики** | SPEECH_BUDGET: ёмкость = (длительность − немой вход − финальная пауза) × 2,8 слова/с; info >85 %, warn >100 %, никогда не error · LINE_TOO_LONG · LINE_HOMOGLYPH (кириллица + латиница в слове, error) · LINE_DIGITS («f/0.95» → словами) · LINE_PUNCT · LINE_NOT_PROOFREAD · LINE_LIVE_ERRORS · LINE_KIT_MISMATCH · LINE_LANG_PHRASE (для ручного/импортированного текста) |
| **гигиена** | HYG_CYRILLIC_OUTSIDE_QUOTES (error) · HYG_PUNCT («,.», абзац без точки) · HYG_PLACEHOLDER_LEFT (error) |
| **показуемость** | UNSHOWABLE_SENSE (smell, «as if remembering») · UNSHOWABLE_SILENT_SPEECH («mutters… no sound») |
| **свет и мир** | LIGHT_EVENT (с длительностью) · LIGHT_MIDSHOT_DRIFT (overcast vs golden sunset в одном дубле) · LIGHT_KIT_CONSISTENT · WEATHER_PHYSICS · NEGATION_AMPLIFY («no X» в абзацах действия) |
| **финал** | FINALE_PRESENT (≥2 из 4: покой, тишина, звук за кадром, камера оседает) · FINALE_COMMAND («The scene ends.») · BRIDGE_PRESENT |
| **непрерывность** | CONT_STATE_PRESENT (error) · CONT_STATE_COMPLETE (сторона, степень, ограничитель) · CONT_SIDE_CONFLICT · CONT_HANDS_PHYSICS (лёд в левой руке у правой щеки) · HAND_OVER_FACE (дрейф лица) · CONT_WORLD_MEMORY |
| **роли** | ROLE_SPLIT_REQUIRED (error) · ROLE_FX_ON_PROP (flare/streak/bokeh рядом с реквизитом без «on the image / shooting lens») |
| **механика и риски** | MECH_RISK (door, tailgate, lid, case opens → «спрячем в монтаже») · SAME_OBJECTS_MERGE · FAST_MOTION_MORPH · PROP_SCALE · TEXT_IN_FRAME · REAL_FACE_MODERATION |
| **комплект и платформа** | KIT_RESIDUE · KIT_REF_MISMATCH · KIT_SIX_PLACES · LEN_RANGE · PLATFORM_DURATION (целое 4–30) · DIALECT_UNVERIFIED |

## Петля попыток (v1)

1. «Сохранить как попытку N» замораживает развёрнутый промпт, снимок панели, диалект, блоки.
2. Разбор после генерации: вердикт (в монтаже / частично / не вошла), необязательный mp4 с маркерами по
   клавише M (атрибутируются сегменту), «получилось / не получилось», симптомы из словаря + свой текст.
3. «Предложить правки»: симптом → рецепт. Детерминированная часть — сразу (длинное правило оператора,
   клауза-исключение рефу, требование рефа предмету). Прозу правит **Fixer**: вход — целевые юниты в
   плейсхолдерной форме, симптом, рецепт, сниппет приёма; тот же конвейер Validate; применение через
   review-diff поблочно.
4. Diff попыток: выравнивание по сегментам, внутри word-level, плюс diff панели; авто-сводка «Что поменяли».
5. `data/user-pack/`: счётчик симптомов; встреченный ≥3 раз предлагается повысить до **личного правила**
   (строка в хвост system prompt писателя + пункт чек-листа-гейта, либо regex-правило линтера). Момент
   срабатывания есть: каждый вызов писателя и каждое копирование промпта.

## Vision-анализ рефов (v1)

Кнопка на конкретном рефе, с подтверждением при первом использовании (на рефе может быть лицо владельца;
картинка уходит в Anthropic — тот же получатель, что у сессий Claude Code). Отправляется заранее
уменьшенная `vision.jpg` base64-блоком, инструменты выключены, tripwire тот же; в логах base64 заменён
на `{refId, bytes}`. Ответ по схеме: люди, читаемый текст, задник (студийный/реальный), одежда,
посторонние объекты → предложения роли и флаги (кормят REF_LOCATION_IGNORE_PEOPLE, REF_TEXT_ON_REF,
REF_STUDIO_BACKDROP, REF_LOOK_MISMATCH). Ничего не применяется молча. Подсказка в загрузчике: «реф —
реальное фото или кадр, не генерация с нуля; под каждый образ своя карта персонажа».

## Дизайн-система Lab UI (`design/lab-ui/`, `src/web/ui/`)

У Lab UI нет кода — переносим её из Figma-файла точно, а не «на глаз». **Эталон качества — сайт
lab.pics** (решение владельца 20.09): как система ведёт себя в собранном продукте. Разбор, измерения с
живого сайта, принципы и список запрещённого — `design/lab-ui/REFERENCE.md`; сайт отдаёт палитру Lab UI
CSS-переменными, поэтому foundations можно начинать до получения файла и уточнять по нему.

**Доступ (M0-d).** Владелец: «Open in Figma» → копия в своих черновиках → присылает URL (ключ файла);
создаёт personal access token (только `File content: read`) и кладёт в Keychain
(`security add-generic-password -s figma-pat-lab-ui -a "$USER" -w` — ввод скрыт, в чат значение не
попадает; скрипты читают его через `security find-generic-password … -w` и никогда не печатают);
выгружает переменные бесплатным плагином (TokensBrücke или аналог: DTCG/JSON **с модами и алиасами**) в
`design/lab-ui/variables.json`. `scripts/design/figma-pull.ts` спроектирован экономно (лимиты Starter не
проверены, худший случай — единицы запросов в месяц): **1 запрос** на весь файл → `raw/file.json` (кэш
навсегда), **2–3** пакетных запроса PNG-рендеров компонентных наборов и страниц гайдлайнов ×2,
**1** запрос SVG нужного подмножества иконок; backoff на 429. Запасной путь — ручной экспорт PNG/SVG.

**Токены.** `scripts/design/build-tokens.ts`: `variables.json` + стили текста и эффектов из `file.json` →
генерируемый `src/web/ui/tokens/tokens.css` («generated — do not edit»): primitives на `:root`,
semantic под `[data-theme="light"|"dark"]` (+ `[data-contrast="more"]`, если мода есть в файле), масштаб
75–133 % модой или корневым множителем, типографика, прогрессивные тени (стеки), блюры, motion.
Производные «цвет × непрозрачность» — `color-mix()` из двух токенов, чтобы бренд-цвет менялся в одном
месте, как в v2.1.1. Тест соответствия: каждый semantic-токен экспорта есть в CSS для обеих тем.

**Материалы.** `materials.css`: glass / ambient / solid собираются из токенов по слоям узла-материала в
Figma (заливки, background blur, блик по кромке, внутренние и внешние тени). Стекло — только плавающий
хром: полоса панели рефов, верхний тулбар, липкая строка метров, поповеры и меню, модалки и шиты, тосты,
бегунок segmented control. Формы и превью промпта — solid. `@supports not (backdrop-filter)` и
`prefers-reduced-transparency` → solid-вариация Lab UI; `prefers-reduced-motion` уважается.

**UI-kit** (Radix для поведения, CSS Modules + токены для вида; состав уточняется по файлу):
foundations — ThemeProvider (тема, контраст, масштаб), Surface, Material, Text, Icon (типизированный
`name` + outline/filled, только нужное подмножество SVG), Divider, ScrollArea, Stack/Row/Grid ·
ввод — Button, IconButton, TextField (label на рамке, helper/error), TextArea (авторост), Select,
Checkbox, Radio, Switch, SegmentedControl, Slider, Chip/Tag, FileDropzone · навигация — Sidebar/TreeList,
Tabs, Toolbar · обратная связь — Tooltip, Popover, DropdownMenu, Dialog, Sheet, Toast, InlineAlert,
Badge, Progress (линейный и круговой), Spinner, Skeleton, EmptyState · данные — Card, Accordion,
ListItem, Kbd. **Производные** (в Lab UI их нет, собираются из её токенов и примитивов по её гайдлайнам
и помечены в галерее): Meter (бюджеты), RefThumb с номером, BeatCard/SegmentCard, PromptBlock с
подсветкой 7 категорий, DiffView, тема CodeMirror, чип плейсхолдера.
Шрифт — Inter Variable самохостом (`@fontsource-variable/inter`); семейство сверяется по стилям файла.

**Качество.** Маршрут `/ui` — галерея: каждый компонент × варианты × состояния (hover, pressed,
focus-visible, disabled, error, loading) × light/dark × масштаб 75/100/133. `scripts/design/compare.ts`
кладёт рядом PNG-рендер из Figma и скриншот секции галереи (headless browse) в `design/lab-ui/compare/`;
правки до совпадения геометрии, типографики, цветов и теней. **Готовность компонента:** только токены
(stylelint) · все варианты и состояния из файла · сверка принята · клавиатура и фокус-кольцо по
спецификации · обе темы · нет сдвигов на 75/133 % · axe-core без нарушений контраста.
Светлая тема полируется первой. Атрибуция CC BY 4.0 (lab.pics, lemone и Meowdes, «ported to React/CSS»)
— в `README`, `design/lab-ui/ATTRIBUTION.md` и в поповере «О программе».

## UI приложения

- **Верх (glass):** проект · вкладки кадров со статус-точками (ошибки, stale) · бейдж LLM («подписка
  OK» / «лимит до 18:20» / «идёт 0:42 [отмена]») · чип диалекта · undo/redo · «сохранено 12:03».
- **Слева:** Мир · Герои (образы) · Предметы · Референсы · Кадры (drag-and-drop, стрелки
  непрерывности) · Попытки · Личные правила · «Проверить готовый промпт».
- **Кадр, центр** — шесть групп по слоям: ① Как снято (карточки комплектов, стек дефектов, vantage с
  пикером приёма «точка съёмки вне тела», правило оператора, авто-разделение ролей с объяснением) ·
  ② Панель референсов (glass-полоса: миниатюры с крупными номерами, роль, флаги, счётчик использований —
  ноль красным, drag-and-drop мгновенно перенумеровывает превью) · ③ Локация и погода (ru → en, чипы
  погоды несут физику дословными фрагментами pack) · ④ Герои и предметы (образ → «реф в панели ✓/✗»,
  редактор состояний «сторона / степень / ограничитель» с превью канонической фразы, виджет рук) ·
  ⑤ Сценарий (линейка 0–30 с, карточки сегментов: биты по-русски с ★ major, реплики со spellcheck и
  чипами подачи, под ними EN-абзац в CodeMirror со статусом «пусто / LLM / вручную / устарел /
  невалиден»; липкие метры: события ★ 5/4–6, фон 3/≤4, речь 62/ёмкость, тишина 27 %, длина) ·
  ⑥ Финал и мост (элементы финала, мост, исходящие последствия → следующий кадр).
- **Справа, вкладки:** Промпт (блоки с подсветкой 7 категорий и легендой-переключателями, клик → поле-
  источник, «плейсхолдеры / итог», копирование по блокам) · Линтер (по severity и семейству, клик →
  прокрутка и вспышка, quick-fix, suppress с причиной, чек-лист гайда с автозаполнением) · Экспорт
  (гейт, манифест, нумерованные файлы панели, paste-back) · Попытки (разбор, починки, diff).
- **«Проверить готовый промпт»** — вставил текст → `lintText`; «Начать с эталона К2» — импорт фикстуры.

## Этапы — каждый оставляет работающий срез

**M0 · День 0 (до кода приложения).** Итоги — в `docs/DECISIONS.md`, сырые выводы — в `docs/day0/`.
- a. `git init`; **первым действием** скопировать `guide.html`/`guide.txt` из временного scratchpad
  (или перекачать с сайта) в `docs/source/`; этот план → `docs/PLAN.md`; `CLAUDE.md` проекта (первый
  пункт: репозиторий не публиковать); дымовой тест тулчейна в кириллическом пути.
- b. `scripts/day0/*` + `npm run doctor` — LLM-мост: tripwire по `system/init`; поведенческий зонд
  (три редких токена из `~/.claude/CLAUDE.md` отсутствуют в выводе; mtime БД claude-mem не изменился;
  нового каталога в `~/.claude/projects/` нет; контрольный прогон без флагов обязан *провалить* зонд);
  `--json-schema` вместе с `--tools ""`, минимальный `--max-turns`, наличие `--system-prompt-file`;
  латентность (opus/sonnet × effort, system ≈10 тыс. токенов, ответ ≈900 слов, холодный и прогретый
  кэш); vision на нейтральной картинке; бесплатные образцы ошибок → фикстуры NDJSON для mock.
- c. Владелец в Higgsfield, без генерации и кредитов: при загруженной картинке вставить `<<<image_1>>>`,
  `@Image 1`, `@image1` — что становится чипом и что возвращается при копировании обратно; принимает ли
  поле 9 557 знаков (К2); где Enhance Prompt и его дефолт. Итог задаёт диалект по умолчанию.
  **Это главный продуктовый риск — проверяется до работ над UI.**
- d. Доступ к Lab UI: копия файла, токен в Keychain, экспорт переменных, первый `figma-pull`.

**M1 · Ядро** (не зависит от UI, можно вести параллельно с M2). `extract-guide.ts`, pack, `core/model`,
`core/compile`, `core/lint` (правила D и S), `parsePrompt`, `scripts/lint-text.ts`.
*Проверка:* побайтный golden compile (К2, К3·2, К1·3 из `*.project.json`); round-trip `parsePrompt` →
resolve = оригинал; golden lint на шести промптах (см. Verification); `verbatim.lock`; архитектурный тест.

**M2 · UI-kit Lab UI.** `build-tokens` → tokens/materials → foundations → компоненты в порядке нужности
(Button, TextField, TextArea, SegmentedControl, Switch, Checkbox, Select, Tabs, Accordion, Card, Chip,
Tooltip, Popover, Dialog, Toast, Progress/Meter, Sidebar, RefThumb…) → галерея `/ui` → сверка с Figma.
*Проверка:* stylelint-гейт, тест соответствия токенов, сверка `compare/` по каждому компоненту в
светлой теме, затем в тёмной; axe-core по галерее; клавиатурные тесты (Testing Library).

**M3 · Приложение без LLM.** Сервер и хранилище (тесты через `app.request`: path traversal, NFC-пути,
атомарность, 409 по `rev`, Host/Origin) → страница «Проверить готовый промпт» (первой) → проекты, мир,
рефы с canvas-ресайзом, полоса панели, группы редактора, превью, линтер-UI (squiggles, quick-fix,
suppress), экспорт и гейт. EN-абзацы пока пишутся вручную с пикером плейсхолдеров — уже сильнее
конструктора гайда. *Ручной сценарий:* собрать Кадр 2 за ≤15 минут; перестановка панели меняет номера
везде; вставить К3·1 → подсвечены «from with», `@image7`, «внимание», «Ка», «,.», «The scene ends.».

**M4 · LLM-писатель.** `claudeCli/*`, очередь, `translate`, `write`, `rewriteBlock`, SSE, validate +
repair, staleness, review-diff, прогресс и отмена, журнал LLM, mock, `npm run eval:writer`.
*Проверка:* юнит-тесты args/env/ndjson/classify/tripwire на записанных NDJSON; `doctor` зелёный;
вживую: К2 из русских битов < 120 с, блоки без error; после отмены `pgrep -f "claude -p"` пуст;
закрытая вкладка → результат предлагается применить; ручная правка переживает «Написать кадр».

**M5 · Петля попыток.** Снимки, разбор, mp4 с маркерами, словарь симптомов, рецепты, `fix`, diff,
«Что поменяли», личные правила, paste-back. *Проверка — реплей истории гайда:* К1·1 с симптомами «не тот
пикап», «лишний персонаж», «не та одежда» → предложены REF_KEY_OBJECT_NO_REF, REF_ON_EXTRA,
REF_LOOK_MISMATCH; К1·2 с «оператор в кадре» → три слоя починки гайда (точка съёмки вне тела, запрет,
правило чтения + глаголы камеры); diff попытки 2 → 3 показывает замены operator → camera.

**M6 · Vision-анализ рефов.** `vision`-задача, предложения роли, флаги → линтер.
*Проверка:* location-реф с человеком → `hasPeople` → REF_LOCATION_IGNORE_PEOPLE; spec-card → REF_TEXT_ON_REF.

**После v1:** LLM-критик (смысловые правила поверх regex), профили full/lean (lean детерминированно:
short-варианты, без «приправы», верхние 4 дефекта) и A/B через `variantOf`, таймкоды `0-8s:`, новые
packs, редактор своего комплекта, раннер генерации через Higgsfield API с бюджетным гейтом владельца.

## Verification (сквозная)

1. `npm run check` зелёный после каждой сессии. Golden lint фиксирует **точные** наборы
   `ruleId + блок + evidence`, включая true positives на удачных промптах:

   | промпт | обязаны сработать |
   |---|---|
   | К1·1 (не вошла) | OP_PORTRAIT_IN_STYLE, REF_ON_EXTRA, MICRO_ACTION_OVERLOAD, UNSHOWABLE_SENSE, UNSHOWABLE_SILENT_SPEECH; на структурной фикстуре — REF_KEY_OBJECT_NO_REF |
   | К1·2 (не вошла) | OP_VANTAGE_VIA_PERSON, OP_ACTOR_VERB, OP_BODY_NOUN, OP_PORTRAIT_IN_STYLE, SHOT_SIZE_KEY_MOMENTS, HYG_PUNCT |
   | К3·1 (не вошла) | REF_SYNTAX_FOREIGN, REF_DANGLING_PREP, HYG_CYRILLIC_OUTSIDE_QUOTES, HYG_PUNCT, FINALE_COMMAND, ROLE_FX_ON_PROP; на структурной — ROLE_SPLIT_REQUIRED, CONT_HANDS_PHYSICS |
   | К1·3, К2, К3·2 (в монтаже) | без неожиданных error; ожидаемо: К1·3 → OP_ACTOR_VERB (в видео рука на двери действительно была), MECH_RISK, SAME_OBJECTS_MERGE; К2 → OP_BAN_CONTRADICTED (suppress с причиной); К3·2 → FINALE_COMMAND |

2. `npm start` → браузер (headless browse со скриншотами): проект → 3 рефа → панель → перестановка меняет
   номера в превью → кадр по-русски → «Написать кадр» → линтер чист → гейт → попытка 1 в `data/…/attempts/`.
3. `npm run doctor` — изоляция и здоровье LLM-моста, перезапускаемо после каждого обновления Claude Code.
4. `/ui` — визуальная сверка с рендерами Figma по каждому компоненту, обе темы, масштаб 75/100/133.
5. Реальная генерация в Higgsfield — только с ведома владельца (правило бюджета); инструмент сам ничего
   не генерирует и кредиты не тратит.

## Риски

- **Синтаксис ссылок при вставке в Higgsfield** не подтверждён документацией. Если вставленный текст не
  становится чипом и модель его не понимает, ручная расстановка ~15 ссылок обесценивает инструмент.
  Закрывается M0-c; запасные пути — диалект `@Image N`, затем отдельная задача автоматизации ввода.
- **Дрейф CLI** (`-p` может стать `--bare` по умолчанию, автообновления): хеджи — `doctor`, tripwire,
  профиль B, Agent SDK за тем же интерфейсом.
- **Длинный промпт — ставка школы, а не норма модели**; промпты эпохи 2.0 переносятся в 2.5 плохо.
  v1 следует гайду, счётчики по блокам видны всегда, lean отложен, но «приправа» структурно отделена.
- **Русская озвучка** в официальном списке языков не названа; у автора гайда работает. Языковая фраза —
  параметр pack.
- **Квота Max общая с обычной работой в Claude Code; латентность 40–90 с на кадр:** LLM только по
  клику, concurrency 1, переключатель модели, стриминг, отмена, поблочная перегенерация; ядро работает
  и при исчерпанном лимите.
- **Лимиты Figma REST на Starter не проверены** → pull в ≤5 запросов с дисковым кэшем; запасной путь —
  ручной экспорт. Производные токены v2.1.1 могут не попасть в экспорт плагина как формула → тогда
  берутся разрешённые значения по модам, а связка «цвет × непрозрачность» восстанавливается по
  `boundVariables` узлов.
- **Liquid glass в браузере** — приближение (backdrop-filter, слои, блик по кромке), не точная копия
  рендера Figma; критерий — сверка бок о бок. Стекло под плотным текстом не используется.
- **Объём:** перенос дизайн-системы — отдельный этап, сопоставимый с ядром. Порядок строго вертикальными
  срезами; самая трудоёмкая часть — pack и UI-kit, обе защищены автоматическими гейтами (побайтный
  golden, `verbatim.lock`, stylelint, сверка).
- **Чужой контент:** гайд Cinema Ai Tech внутри pack и авторизация по подписке → репозиторий только
  локальный. Lab UI — CC BY 4.0, атрибуция обязательна.
- **Regex-линтер даёт ложные срабатывания** на смысловых правилах → severity мягкая, есть suppress с
  причиной; настоящий смысловой слой — отложенный LLM-критик.

## После утверждения

Первое действие реализации — M0-a: создать каталог проекта, сохранить снимок гайда и этот план в
`docs/`, завести `CLAUDE.md` проекта. Запись о новом проекте в память Claude Code
(`seedance-prompter.md`: где лежит, инварианты, статус этапов) — тогда же. Параллельно владельцу
уходит чек-лист из трёх ручных действий: проверка вставки в Higgsfield (M0-c), копия файла Lab UI +
токен в Keychain + экспорт переменных (M0-d).
