import { compileShot, joinParagraphs, type CompiledParagraph, type CompileIssue, type Kit, type VerbatimPack } from './compile/compile.ts';
import { resolve, type DialectPack, type ResolveIssue } from './compile/dialect.ts';
import { lintText, type Finding, type Lexicon, type LintParams } from './lint/index.ts';
import { countWords } from './lint/tokenize.ts';
import { activeStates, type Project, type Shot } from './model/project.ts';

/** Всё, что ядру нужно знать о режиме съёмки. Код правил гайда не знает — он исполняет pack. */
export interface PackBundle {
  id: string;
  verbatim: VerbatimPack;
  kits: Record<string, Kit>;
  dialects: DialectPack;
  lexicon: Lexicon;
  lintParams: LintParams;
}

export interface ShotBuild {
  /** Абзацы в плейсхолдерной форме с происхождением. */
  paragraphs: CompiledParagraph[];
  /** Итоговый текст для вставки в Higgsfield. */
  prompt: string;
  /** Итог по абзацам — для предпросмотра и привязки находок. */
  resolvedParagraphs: string[];
  /** Блокирующие проблемы сборки: пока они есть, промпт копировать нельзя. */
  blockers: { code: string; messageRu: string }[];
  findings: Finding[];
  metrics: { chars: number; words: number; speechWords: number; speechCapacity: number; refsInPanel: number; refsUsed: number };
}

const blocker = (issue: CompileIssue | ResolveIssue): { code: string; messageRu: string } => ({ code: issue.code, messageRu: issue.messageRu });

/** Проект + кадр → промпт, находки линтера, метрики. Чистая функция: работает в браузере на каждое нажатие. */
export function buildShot(project: Project, shot: Shot, pack: PackBundle): ShotBuild {
  const blockers: ShotBuild['blockers'] = [];
  const kit = pack.kits[shot.kitId];
  if (kit === undefined) {
    return { paragraphs: [], prompt: '', resolvedParagraphs: [], blockers: [{ code: 'UNKNOWN_KIT', messageRu: `В pack нет комплекта «${shot.kitId}».` }], findings: [], metrics: { chars: 0, words: 0, speechWords: 0, speechCapacity: 0, refsInPanel: shot.panel.length, refsUsed: 0 } };
  }

  const [ref1, ref2] = shot.locationRefs;
  if (ref1 === undefined) blockers.push({ code: 'NO_LOCATION_REF', messageRu: 'Не выбран референс локации. Гайд: «текст не заменяет референс».' });
  if (project.world.place.en.trim() === '') blockers.push({ code: 'NO_PLACE', messageRu: 'Локация не описана по-английски (поле «Место»).' });

  const compiled = compileShot(
    {
      kit,
      defects: shot.defects ?? undefined,
      behavior: shot.behavior,
      operatorRule: shot.operatorRule,
      locationRule: shot.locationRule,
      locationRefs: [ref1 ?? 'missing-location-ref', ref2 ?? ref1 ?? 'missing-location-ref'],
      world: { placeEn: project.world.place.en.trim(), useOnlyEn: project.world.useOnlyEn, weatherEn: project.world.weather.en.trim() },
      languageName: pack.dialects.languageNames[project.language] ?? project.language,
      roleSplit: shot.roleSplit ?? undefined,
      segments: shot.segments.map((segment) => ({ id: segment.id, en: segment.text.en })),
    },
    pack.verbatim,
  );
  blockers.push(...compiled.issues.filter((issue) => issue.code !== 'EMPTY_SEGMENT').map(blocker));

  const ctx = {
    panel: shot.panel,
    lines: Object.fromEntries(project.lines.map((line) => [line.id, { ru: line.ru }])),
    entities: Object.fromEntries(project.entities.map((e) => [e.key, { name: e.name, kind: e.kind, refKey: e.refKey ?? undefined, studioBackdrop: project.refs.find((r) => r.key === e.refKey)?.flags.studioBackdrop }])),
    states: Object.fromEntries(project.states.map((state) => [state.id, state.en])),
    dialect: project.dialect,
    language: project.language,
    pack: pack.dialects,
  };

  const resolvedParagraphs: string[] = [];
  for (const paragraph of compiled.paragraphs) {
    const out = resolve(paragraph.text, ctx);
    blockers.push(...out.issues.map(blocker));
    resolvedParagraphs.push(out.text);
  }
  const prompt = resolvedParagraphs.join('\n\n');

  const findings = lintText(prompt, {
    lexicon: pack.lexicon,
    params: pack.lintParams,
    refSyntax: project.dialect.refSyntax,
    panelSize: shot.panel.length,
    durationSec: project.durationSec,
    suppressed: shot.suppressed.map((s) => s.fingerprint),
  });

  // Непрерывность — структурные правила: текста мало, нужно знать, что было в прошлых кадрах.
  const source = joinParagraphs(compiled.paragraphs);
  const suppressed = new Set(shot.suppressed.map((s) => s.fingerprint));
  for (const state of activeStates(project, shot.id)) {
    const label = state.titleRu.trim() === '' ? state.id : `${state.id} «${state.titleRu}»`;
    const drafts: Pick<Finding, 'ruleId' | 'severity' | 'messageRu' | 'fixHintRu'>[] = [];
    if (!source.includes(`{{state:${state.id}}}`)) {
      drafts.push({ ruleId: 'CONT_STATE_PRESENT', severity: 'error', messageRu: `Последствие прошлого кадра ${label} не попало в этот кадр.`, fixHintRu: `Приём 11 «память между кадрами»: вставь {{state:${state.id}}} там, где герой или предмет впервые виден.` });
    }
    const hasSide = /\b(left|right|front|rear|back|both)\b/i.test(state.en);
    const hasLimiter = /\b(no|only|just|slight|light|small|faint)\b/i.test(state.en);
    if (!hasSide || !hasLimiter) {
      drafts.push({ ruleId: 'CONT_STATE_COMPLETE', severity: 'warning', messageRu: `У последствия ${label} нет ${[!hasSide && 'стороны', !hasLimiter && 'степени или ограничителя'].filter(Boolean).join(' и ')}.`, fixHintRu: 'Гайд, Кадр 3: «right side only… no blood, no cut, just a light bruise» — иначе модель нарисует разбитое лицо не с той стороны.' });
    }
    for (const draft of drafts) {
      const fingerprint = `${draft.ruleId}:${state.id}`;
      if (!suppressed.has(fingerprint)) findings.unshift({ ...draft, family: 'continuity', paragraph: null, range: null, evidence: state.en.slice(0, 80), fingerprint });
    }
  }

  // Риски референсов — по флагам, которые ставит владелец или vision-анализ.
  for (const key of shot.panel) {
    const ref = project.refs.find((r) => r.key === key);
    if (ref === undefined) continue;
    const drafts: Pick<Finding, 'ruleId' | 'severity' | 'messageRu' | 'fixHintRu'>[] = [];
    if (ref.flags.hasText) drafts.push({ ruleId: 'REF_TEXT_ON_REF', severity: 'warning', messageRu: `На референсе «${ref.label}» есть читаемый текст — надписи могут просочиться в кадр.`, fixHintRu: 'Гайд, панель Кадра 1: карточка со спецификациями ненадёжна, чистое фото предмета лучше.' });
    if (ref.flags.hasPeople && ref.kind !== 'location' && ref.kind !== 'character') drafts.push({ ruleId: 'REF_PEOPLE_ON_OBJECT_REF', severity: 'warning', messageRu: `На референсе предмета «${ref.label}» есть человек — модель может забрать и его.`, fixHintRu: 'Гайд: у пикапа рядом стоял человек — нужна оговорка «only the vehicle» или картинка без людей.' });
    if (ref.flags.studioBackdrop && !project.entities.some((e) => e.refKey === ref.key)) drafts.push({ ruleId: 'REF_STUDIO_BACKDROP', severity: 'warning', messageRu: `У «${ref.label}» студийный задник, а сущности с этим референсом нет — клаузу «do not take the background» поставить некуда.`, fixHintRu: 'Привяжи референс к герою в секции «Герои и предметы» и вводи его кнопкой-плейсхолдером.' });
    for (const draft of drafts) {
      const fingerprint = `${draft.ruleId}:${ref.key}`;
      if (!suppressed.has(fingerprint)) findings.push({ ...draft, family: 'refs', paragraph: null, range: null, evidence: ref.label, fingerprint });
    }
  }

  // Какие картинки панели реально вызваны: {{ref:key}} напрямую, {{intro:key}} — через референс сущности.
  const used = new Set<string>();
  for (const match of source.matchAll(/\{\{(ref|intro):([^}]+)\}\}/g)) {
    const refKey = match[1] === 'ref' ? match[2] : project.entities.find((e) => e.key === match[2])?.refKey;
    if (refKey !== undefined && refKey !== null && shot.panel.includes(refKey)) used.add(refKey);
  }
  const speechWords = [...prompt.matchAll(/«([^»]*)»/g)].reduce((n, m) => n + countWords(m[1] ?? ''), 0);
  const { wordsPerSecond, speakingShare } = pack.lintParams.speech;

  return {
    paragraphs: compiled.paragraphs,
    prompt,
    resolvedParagraphs,
    blockers,
    findings,
    metrics: { chars: prompt.length, words: countWords(prompt), speechWords, speechCapacity: Math.round(project.durationSec * speakingShare * wordsPerSecond), refsInPanel: shot.panel.length, refsUsed: used.size },
  };
}
