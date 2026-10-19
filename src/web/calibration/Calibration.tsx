import { studioFetch as fetch } from '../remoteFetch.ts';
import { useEffect, useMemo, useState } from 'react';
import { calibrationTag, expandSuite, parseCalibrationTag, repeatedSymptoms, suiteCost, VERDICT_RU, VERDICT_SYMPTOMS, VERDICTS, type CalibrationSuite, type Repeat } from '../../core/gen/calibration.ts';
import { findModel, GEN_MODELS } from '../../core/gen/models.ts';
import type { GenJob, MediaItem } from '../../core/model/media.ts';
import { STATUS_RU, submissionIssue } from '../../core/gen/jobStatus.ts';
import { mediaUrl, useGen } from '../gen/genStore.ts';
import { MediaPreview } from '../studio/MediaPreview.tsx';
import { Button, Dialog, Icon, Select, Tag, Text } from '../ui/components/index.ts';
import styles from './Calibration.module.css';
import { useJournal } from './journalStore.ts';
import { VerdictBar } from './VerdictBar.tsx';

const HEADERS = { 'x-sp-client': '1', 'content-type': 'application/json' };
const JOURNAL = 'journal';

const costLine = (suite: CalibrationSuite): string =>
  suiteCost(suite)
    .map((c) => (c.unitRu === '$' ? `$${c.usd} Higgsfield` : `${c.credits} кр ≈ $${c.usd}`))
    .join(' + ');

const runDate = (runId: string): string => new Date(parseInt(runId, 36)).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const symptomRu = (id: string): string => VERDICT_SYMPTOMS.find((s) => s.id === id)?.labelRu ?? id;

function Cell({ job, onOpen }: { job: GenJob | undefined; onOpen: (mediaId: string) => void }) {
  const mediaId = job?.mediaIds.find((id): id is string => id !== null);
  if (job === undefined) return <div className={`${styles.cellEmpty} lab-hatch`} />;
  if (mediaId === undefined) {
    return (
      <div className={styles.cellEmpty}>
        <Text variant="caption" tone={job.status === 'failed' ? 'primary' : 'tertiary'} className={job.status === 'failed' ? styles.failed : undefined}>
          {job.error?.messageRu ?? STATUS_RU[job.status]}
        </Text>
      </div>
    );
  }
  return (
    <div className={styles.cell}>
      <button type="button" className={styles.cellImage} onClick={() => onOpen(mediaId)} title="Открыть">
        <img src={mediaUrl(mediaId)} alt="" loading="lazy" />
      </button>
      <VerdictBar mediaId={mediaId} compact />
    </div>
  );
}

function SuiteView({ suite, onOpen }: { suite: CalibrationSuite; onOpen: (mediaId: string, list: string[]) => void }) {
  const { jobs, run, loadSessions } = useGen();
  const verdicts = useJournal((s) => s.verdicts);
  const [confirm, setConfirm] = useState(false);
  const [state, setState] = useState<{ busy: boolean; messageRu: string | null }>({ busy: false, messageRu: null });
  const planned = useMemo(() => expandSuite(suite), [suite]);
  const runs = useMemo(() => [...new Set(jobs.flatMap((j) => (parseCalibrationTag(j.tag)?.suiteId === suite.id ? [parseCalibrationTag(j.tag)?.runId ?? ''] : [])))].sort((a, b) => parseInt(b, 36) - parseInt(a, 36)), [jobs, suite.id]);
  const [runId, setRunId] = useState<string>('');
  const shown = runId !== '' && runs.includes(runId) ? runId : (runs[0] ?? '');
  const jobOf = (caseId: string, modelKey: string): GenJob | undefined => jobs.find((j) => j.tag === calibrationTag(shown, suite.id, caseId, modelKey));
  const media = suite.cases.flatMap((c) => suite.models.flatMap((m) => jobOf(c.id, m.key)?.mediaIds.filter((id): id is string => id !== null) ?? []));

  const launch = async (): Promise<void> => {
    setConfirm(false);
    setState({ busy: true, messageRu: null });
    const id = Date.now().toString(36);
    const errors: string[] = [];
    try {
      const res = await fetch('/api/studio/sessions', { method: 'POST', headers: HEADERS, body: JSON.stringify({ kind: 'image', title: `Калибровка · ${suite.titleRu}` }) });
      if (!res.ok) throw new Error('Не удалось создать подборку калибровки. Генерации не отправлены.');
      const session = (await res.json()) as { id: string };
      for (const job of planned) {
        try {
          const created = await run({ modelId: job.modelId, prompt: job.prompt, params: job.params, count: 1, confirmCredits: job.credits, sessionId: session.id, tag: calibrationTag(id, suite.id, job.caseId, job.modelKey) });
          const issue = submissionIssue(created);
          if (issue !== null) errors.push(issue);
          if (created.some((task) => task.status === 'unknown')) { errors.push('Остальные задачи не отправлены: сначала проверь неизвестный исход.'); break; }
        } catch (error) {
          errors.push(`${suite.models.find((m) => m.key === job.modelKey)?.labelRu ?? job.modelKey}: ${error instanceof Error ? error.message : 'не запустилось'}`);
        }
      }
      void loadSessions('image');
      setRunId(id);
      setState({ busy: false, messageRu: errors.length === 0 ? `Запущено ${planned.length} генераций — результаты появятся в сетке и в сессии «Калибровка · ${suite.titleRu}».` : `Есть задачи, требующие внимания: ${[...new Set(errors)].join('; ')}. Статусы — в сетке и в «Материалах».` });
    } catch (error) {
      setState({ busy: false, messageRu: error instanceof Error ? error.message : 'Набор не запустился.' });
    }
  };

  return (
    <section className={styles.suite}>
      <header className={styles.suiteHead}>
        <div className={styles.stack}>
          <Text variant="title-m" medium>
            {suite.titleRu}
          </Text>
          <Text tone="secondary">{suite.questionRu}</Text>
          <Text variant="caption" tone="tertiary">
            {suite.whyRu}
          </Text>
        </div>
        <div className={styles.launch}>
          <Button variant="primary" size="m" icon={<Icon name="sparkles" size={1} />} loading={state.busy} onClick={() => setConfirm(true)}>
            Запустить · {costLine(suite)}
          </Button>
          <Text variant="caption" tone="tertiary">
            {planned.length} генераций · {suite.cases.length} × {suite.models.length}
          </Text>
        </div>
      </header>
      {state.messageRu !== null && <Text variant="label">{state.messageRu}</Text>}

      {runs.length > 0 && (
        <div className={styles.runs}>
          <Select label="Запуск" value={shown} onChange={setRunId} options={runs.map((r) => ({ value: r, label: runDate(r) }))} />
        </div>
      )}

      <div className={styles.grid} style={{ gridTemplateColumns: `11rem repeat(${suite.models.length}, minmax(9rem, 13rem))` }}>
        <span />
        {suite.models.map((m) => (
          <Text key={m.key} variant="label" medium className={styles.colHead}>
            {m.labelRu}
          </Text>
        ))}
        {suite.cases.map((c) => (
          <div key={c.id} className={styles.row}>
            <div className={styles.rowHead}>
              <Text variant="label" medium>
                {c.labelRu}
              </Text>
              <details className={styles.promptDetails}>
                <summary>промпт</summary>
                <Text variant="caption" tone="secondary">
                  {c.prompt}
                </Text>
              </details>
            </div>
            {suite.models.map((m) => (
              <Cell key={m.key} job={shown === '' ? undefined : jobOf(c.id, m.key)} onOpen={(mediaId) => onOpen(mediaId, media)} />
            ))}
          </div>
        ))}
        <Text variant="caption" tone="tertiary">
          Итог
        </Text>
        {suite.models.map((m) => {
          const ids = suite.cases.flatMap((c) => jobOf(c.id, m.key)?.mediaIds.filter((id): id is string => id !== null) ?? []);
          const marks = verdicts.filter((v) => ids.includes(v.mediaId));
          return (
            <div key={m.key} className={styles.summary}>
              {VERDICTS.map((v) => (
                <Tag key={v} tone={v === 'good' ? 'success' : v === 'almost' ? 'warning' : 'danger'}>
                  {VERDICT_RU[v]} {marks.filter((x) => x.verdict === v).length}
                </Tag>
              ))}
            </div>
          );
        })}
      </div>

      <Dialog
        open={confirm}
        onOpenChange={setConfirm}
        title={`Запустить «${suite.titleRu}»?`}
        description="Картинок на входе нет — уходят только промпты. Каждая генерация проходит обычный гейт цены; если у провайдера не хватит баланса, задача упадёт без списания."
        footer={
          <>
            <Button variant="ghost" size="s" onClick={() => setConfirm(false)}>
              Отмена
            </Button>
            <Button variant="primary" size="s" onClick={() => void launch()}>
              Запустить · {costLine(suite)}
            </Button>
          </>
        }
      >
        <ul className={styles.planList}>
          {suite.models.map((m) => {
            const mine = planned.filter((j) => j.modelKey === m.key);
            const provider = findModel(m.modelId)?.provider;
            const sum = mine.reduce((s, j) => s + j.credits, 0);
            return (
              <li key={m.key}>
                <Text variant="label">
                  {m.labelRu} — {mine.length} × {provider === 'higgsfield' ? `$${mine[0]?.credits ?? 0}` : `${mine[0]?.credits ?? 0} кр`} = {provider === 'higgsfield' ? `$${Math.round(sum * 1000) / 1000}` : `${sum} кр`}
                </Text>
              </li>
            );
          })}
        </ul>
      </Dialog>
    </section>
  );
}

function RepeatCard({ repeat }: { repeat: Repeat }) {
  const addLearning = useJournal((s) => s.addLearning);
  const title = findModel(repeat.modelId)?.titleRu ?? repeat.modelId;
  const [text, setText] = useState(`«${symptomRu(repeat.symptom)}» — ${repeat.count} из ${repeat.of} оценок. `);
  return (
    <div className={styles.repeat}>
      <Text variant="label" medium>
        {title} · {symptomRu(repeat.symptom)} — {repeat.count} из {repeat.of}
      </Text>
      <textarea className={styles.ruleText} rows={2} value={text} lang="ru" onChange={(event) => setText(event.target.value)} />
      <Button variant="border" size="s" icon={<Icon name="bookmark" size={1} />} disabled={text.trim().length < 10} onClick={() => void addLearning(repeat.modelId, text, repeat.mediaIds)}>
        В правила промптера
      </Button>
    </div>
  );
}

function JournalView() {
  const { verdicts, learnings, addLearning, removeLearning } = useJournal();
  const library = useGen((s) => s.library);
  const modelOf = (mediaId: string): string | undefined => library.find((m) => m.id === mediaId)?.modelId;
  const repeats = repeatedSymptoms(verdicts, modelOf);
  const imageModels = GEN_MODELS.filter((m) => m.kind === 'image');
  const [manual, setManual] = useState({ modelId: imageModels[0]?.id ?? '', text: '' });

  return (
    <section className={styles.suite}>
      <div className={styles.stack}>
        <Text variant="title-m" medium>
          Журнал и правила
        </Text>
        <Text tone="secondary">Оценки со всех генераций — из калибровки и из студии. Одна ошибка у одной модели три раза — повод для правила.</Text>
      </div>

      <div className={styles.stats}>
        {GEN_MODELS.map((model) => {
          const mine = verdicts.filter((v) => modelOf(v.mediaId) === model.id);
          if (mine.length === 0) return null;
          return (
            <div key={model.id} className={styles.stat}>
              <Text variant="label" medium>
                {model.titleRu}
              </Text>
              <Text variant="caption" tone="secondary">
                оценок: {mine.length} · {VERDICTS.map((v) => `${VERDICT_RU[v].toLowerCase()} ${mine.filter((x) => x.verdict === v).length}`).join(' · ')}
              </Text>
            </div>
          );
        })}
        {verdicts.length === 0 && (
          <Text variant="label" tone="tertiary" className={styles.wide}>
            Оценок пока нет. Оценивай в сетке калибровки или в просмотре любой картинки (вкладка «Инфо»).
          </Text>
        )}
      </div>

      {repeats.length > 0 && (
        <div className={styles.stack}>
          <Text variant="caption" tone="secondary">
            Повторяется три раза и больше — допиши вывод и отправь в правила
          </Text>
          {repeats.map((r) => (
            <RepeatCard key={`${r.modelId}-${r.symptom}`} repeat={r} />
          ))}
        </div>
      )}

      <div className={styles.stack}>
        <Text variant="caption" tone="secondary">
          Правила промптера — агент получает их в карточке модели, они главнее заявлений вендора
        </Text>
        {learnings.length === 0 && (
          <Text variant="label" tone="tertiary">
            Правил пока нет.
          </Text>
        )}
        {learnings.map((l) => (
          <div key={l.id} className={styles.rule}>
            <Tag tone="outline">{findModel(l.modelId)?.titleRu ?? l.modelId}</Tag>
            <Text variant="label" className={styles.ruleBody}>
              {l.textRu}
            </Text>
            <Text variant="caption" tone="tertiary">
              {l.evidence.length} прогонов · {new Date(l.at).toLocaleDateString('ru-RU')}
            </Text>
            <Button variant="ghost" size="xs" iconOnly aria-label="Удалить правило" icon={<Icon name="bin" size={0.875} />} onClick={() => void removeLearning(l.id)} />
          </div>
        ))}
        <div className={styles.manual}>
          <Select label="Модель" value={manual.modelId} onChange={(modelId) => setManual({ ...manual, modelId })} options={imageModels.map((m) => ({ value: m.id, label: m.titleRu }))} />
          <textarea className={styles.ruleText} rows={2} value={manual.text} placeholder="Своё правило: «Soul 2 режет ноги при full body — просить medium-full shot»" lang="ru" onChange={(event) => setManual({ ...manual, text: event.target.value })} />
          <Button
            variant="border"
            size="s"
            disabled={manual.text.trim().length < 10}
            onClick={() => {
              void addLearning(manual.modelId, manual.text, []);
              setManual({ ...manual, text: '' });
            }}
          >
            Добавить правило
          </Button>
        </div>
      </div>
    </section>
  );
}

/** Список наборов в сайдбаре оболочки (как flows у Canvas). */
export function CalibrationList() {
  const { pack, selected, select, error } = useJournal();
  const suites = pack?.suites ?? [];
  const current = selected === JOURNAL ? JOURNAL : (suites.find((s) => s.id === selected) ?? suites[0])?.id;
  return (
    <nav className={styles.list}>
      <Text variant="caption" tone="tertiary" className={styles.listTitle}>
        Наборы
      </Text>
      {suites.map((s) => (
        <button key={s.id} type="button" className={`${styles.item} ${current === s.id ? styles.itemOn : ''}`} onClick={() => select(s.id)}>
          <Text variant="label" medium>
            {s.titleRu}
          </Text>
          <Text variant="caption" tone="secondary">
            {costLine(s)}
          </Text>
        </button>
      ))}
      <button type="button" className={`${styles.item} ${current === JOURNAL ? styles.itemOn : ''}`} onClick={() => select(JOURNAL)}>
        <Text variant="label" medium>
          Журнал и правила
        </Text>
        <Text variant="caption" tone="secondary">
          оценки → правила промптера
        </Text>
      </button>
      {error !== null && (
        <Text variant="caption" className={styles.failed}>
          {error}
        </Text>
      )}
    </nav>
  );
}

/** Калибровка (этап 4, решение 33): наборы тестов, оценки и правила, которые уходят в промптер. */
export function Calibration() {
  const { pack, selected, load } = useJournal();
  const { library, loadJobs, loadLibrary } = useGen();
  const [open, setOpen] = useState<{ item: MediaItem; list: MediaItem[] } | null>(null);

  useEffect(() => {
    void load();
    void loadJobs();
    void loadLibrary();
  }, [load, loadJobs, loadLibrary]);

  const suites = pack?.suites ?? [];
  const current = selected === JOURNAL ? null : (suites.find((s) => s.id === selected) ?? suites[0] ?? null);

  return (
    <div className={styles.page}>
      <div className={styles.body}>
        {current !== null ? (
          <SuiteView
            key={current.id}
            suite={current}
            onOpen={(mediaId, ids) => {
              const item = library.find((m) => m.id === mediaId);
              if (item !== undefined) setOpen({ item, list: ids.map((id) => library.find((m) => m.id === id)).filter((m): m is MediaItem => m !== undefined) });
            }}
          />
        ) : (
          <JournalView />
        )}
      </div>
      <MediaPreview item={open?.item ?? null} list={open?.list} onClose={() => setOpen(null)} />
    </div>
  );
}
