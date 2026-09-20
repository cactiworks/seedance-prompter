# Seedance Prompter

Локальный конструктор промптов для Seedance 2.5 (генерация в Higgsfield). Один пользователь, только
localhost. Полный план — `docs/PLAN.md`, решения и результаты проверок — `docs/DECISIONS.md`.

## Нельзя

1. **Репозиторий не публиковать** (никаких публичных remote): внутри дословный текст чужого гайда
   Cinema Ai Tech (`docs/source/`, `packs/cinema-doc/`) и вызовы LLM по личной подписке Claude Code.
2. Не править руками `packs/cinema-doc/verbatim.json` «для улучшения»: формулировки гайда дословные,
   sha256 каждой — в `verbatim.lock.json`, побайтный golden-тест это ловит.
3. Не писать сырые цвета, радиусы, тени в CSS приложения — только `var(--lab-*)` (stylelint-гейт).
   `src/web/ui/tokens/tokens.css` генерируется `scripts/design/build-tokens.ts`, руками не правится.
4. В `src/core` нет `node:*`, `react`, DOM — ядро обязано работать в браузере и в Vitest.
5. LLM никогда не запускается без клика пользователя. Генераций видео инструмент не делает вообще.
6. Секреты — только в macOS Keychain (`figma-pat-lab-ui`), в контексте и файлах — только имя записи.

## Инварианты (подробно — `docs/PLAN.md`, раздел «Инварианты»)

- Номера ссылок на референсы не пишет никто: в тексте плейсхолдеры `{{intro:key}}`, `{{ref:key}}`,
  `{{line:L3}}`, `{{state:S1}}`; компилятор разворачивает их в диалект по порядку панели кадра.
- LLM не пишет реплики, языковую фразу и травмы — только выбирает место плейсхолдера.
- Абзац = отрезок времени = `Segment` (1:1). Хранится `TextUnit` (ввод + текст с происхождением),
  блоки промпта — производные с provenance-спанами, не хранятся.
- Headless-вызовы `claude -p` изолированы: `--safe-mode`, env по allowlist, tripwire по `system/init`.

## Команды

- `npm start` — запуск для владельца (один процесс: Hono `/api/*` + Vite middleware), порт 4317.
- `npm run dev` — то же с watch.
- `npm run check` — `tsc --noEmit && eslint && stylelint && vitest run && vite build`. Единственный
  критерий «готово» для сессии.
- `npm run doctor` — проверки LLM-моста (изоляция, схема, латентность). Тратит квоту подписки.

## Код

- TypeScript исполняется Node 26 нативно: `erasableSyntaxOnly`, импорты с расширением `.ts`, только
  относительные пути, без enum / namespace / parameter properties.
- Слои: `src/core` (чистый TS) ← `src/server` (Hono, хранилище, LLM-мост) и `src/web` (React, UI-kit).
- Знания гайда — данные в `packs/cinema-doc/`, код их исполняет. Сообщения пользователю — по-русски.

## Статус этапов

См. `docs/DECISIONS.md` → «Статус». Обновлять в конце каждой сессии.
