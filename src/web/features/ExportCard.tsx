import { ui } from '../language.ts';
import { remoteStudio } from '../download.ts';
import { useEffect, useState } from 'react';
import { activeCritiqueFindings } from '../../core/review.ts';
import { estimate, findModel, paramsFor, validateGen } from '../../core/gen/models.ts';
import { submissionIssue } from '../../core/gen/jobStatus.ts';
import type { Project, Shot } from '../../core/model/project.ts';
import type { ShotBuild } from '../../core/pipeline.ts';
import { hasRefsConsent, useGen } from '../gen/genStore.ts';
import { Button, Dialog, Icon, SegmentedControl, Switch, Tag, Text, type TagTone } from '../ui/components/index.ts';
import { useStore } from '../store.ts';
import { PromptText } from './PromptText.tsx';
import styles from './ExportCard.module.css';

const KIND_RU: Record<string, string> = { location: 'локация', character: 'герой', object: 'предмет', gear: 'техника', frame: 'кадр раскадровки', other: 'другое' };
const VERDICT: Record<string, { label: string; tone: TagTone }> = { ready: { label: 'критик: готов', tone: 'success' }, risky: { label: 'критик: с рисками', tone: 'warning' }, 'not-ready': { label: 'критик: не готов', tone: 'danger' } };

interface ExportCardProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project: Project;
  shot: Shot;
  shotIndex: number;
  build: ShotBuild;
  durationSec: number;
  warnings: number;
}

interface GateItem {
  id: string;
  label: string;
  /** Пункт закрыт машиной — галочку ставить не нужно. */
  auto?: boolean;
}

/**
 * Одно окно с тем, что нужно перенести в Higgsfield, в порядке действий там: настройки → картинки по
 * номерам → промпт. Чек-лист закрывает то, чего линтер не видит; любая правка текста сбрасывает отметки.
 */
export function ExportCard({ open, onOpenChange, project, shot, shotIndex, build, durationSec, warnings }: ExportCardProps) {
  const store = useStore();
  const [gate, setGate] = useState<{ reviewKey: string; ticks: string[] }>({ reviewKey: '', ticks: [] });
  const [copied, setCopied] = useState<string | null>(null);
  const [savedN, setSavedN] = useState<{ prompt: string; n: number } | null>(null);

  const reviewKey = JSON.stringify([build.prompt, shot.critique, shot.suppressed]);
  const ticks = gate.reviewKey === reviewKey ? gate.ticks : [];
  const activeCritic = activeCritiqueFindings(shot, build.prompt);
  const critique = shot.critique !== null && shot.critique.prompt === build.prompt ? shot.critique : null;
  const stale = shot.critique !== null && critique === null;
  const refByKey = new Map(project.refs.map((r) => [r.key, r]));
  const boundTo = (key: string): string[] => project.entities.filter((e) => e.refKey === key).map((e) => e.name);
  const refSyntax = (n: number): string => (project.dialect.refSyntax === 'higgsfield-chip' ? `<<<image_${n}>>>` : `@Image ${n}`);
  const exported = store.exportResult;
  const nextAttempt = Math.max(0, ...shot.attempts.map((a) => a.n)) + 1;

  const items: GateItem[] = [
    { id: 'settings', label: ui("В Higgsfield выставлено: Seedance 2.5, {0}, {1} с, Enhance Prompt выключен", project.aspectRatio, durationSec) },
    { id: 'panel', label: ui("Картинки загружены в этом порядке: {0}", shot.panel.map((_, i) => i + 1).join(' → ')) },
    ...(warnings > 0 ? [{ id: 'warnings', label: ui("Предупреждения линтера ({0}) просмотрены", warnings) }] : []),
    critique === null
      ? { id: 'no-critic', label: stale ? 'Промпт менялся после проверки критиком — иду без перепроверки, осознанно' : 'Иду без итоговой проверки критиком — осознанно' }
      : critique.findings.length === 0
        ? { id: 'critic-clean', label: 'Критик прочитал этот текст и замечаний не нашёл', auto: true }
        : activeCritic.length === 0
          ? { id: 'critic-dismissed', label: ui("Все замечания критика ({0}) оставлены без исправления по твоему решению", critique.findings.length), auto: true }
          : { id: 'critic', label: ui("Оставшиеся замечания критика ({0}) просмотрены", activeCritic.length) },
  ];
  const passed = items.every((item) => item.auto === true || ticks.includes(item.id));
  const tick = (id: string, on: boolean): void => setGate({ reviewKey, ticks: on ? [...ticks, id] : ticks.filter((x) => x !== id) });

  // Генерация отсюда (решения 21–23): Seedance 2.5 через Higgsfield. Формат и длительность — из кадра, картинки — панель по
  // порядку (@ImageN). Настройки Higgsfield и порядок загрузки сервер выставляет сам — эти пункты чек-листа не нужны.
  const gen = useGen();
  const { loadStatus } = gen;
  const seedance = findModel('higgsfield/seedance-2-5');
  // Разрешение по умолчанию — из каталога (черновик 480p, решение 38).
  const [genRes, setGenRes] = useState(() => String(seedance?.params.find((p) => p.key === 'resolution')?.default ?? '480p'));
  const [genAudio, setGenAudio] = useState(true);
  const [consent, setConsent] = useState(false);
  const [genBusy, setGenBusy] = useState(false);
  const [genState, setGenState] = useState<{ prompt: string; n: number; errorRu?: string } | null>(null);
  useEffect(() => {
    if (open) void loadStatus();
  }, [open, loadStatus]);
  const genParams = seedance === undefined ? {} : paramsFor(seedance, { resolution: genRes, aspectRatio: project.aspectRatio, durationSec, audio: genAudio });
  const panelFiles = shot.panel.map((key, i) => ({ n: i + 1, label: refByKey.get(key)?.label ?? key, file: refByKey.get(key)?.file ?? null }));
  const genCost = seedance === undefined ? null : estimate(seedance, genParams, 1, panelFiles.length);
  const apiPassed = items.filter((item) => item.id !== 'settings' && item.id !== 'panel').every((item) => item.auto === true || ticks.includes(item.id));
  const needConsent = panelFiles.length > 0 && !hasRefsConsent() && !consent;
  const genProblems = [
    ...(gen.status.higgsfield !== undefined && !gen.status.higgsfield.hasKey ? [`Higgsfield: ${gen.status.higgsfield.keyProblem ?? 'нет ключа'}.`] : []),
    ...panelFiles.filter((f) => f.file === null).map((f) => ui("У картинки {0} панели нет файла.", f.n)),
    ...(seedance === undefined ? [] : validateGen(seedance, build.prompt, genParams, panelFiles.map(() => project.production ? 'start' as const : 'ref' as const))),
  ];
  const genBlockers = [
    ...(!apiPassed ? ['Отметь просмотренные предупреждения и замечания в шаге 5. Настройки и порядок картинок сервер выставит сам.'] : []),
    ...(needConsent ? ['Подтверди передачу картинок панели в Higgsfield API галочкой выше.'] : []),
    ...genProblems,
  ];
  const generate = async (): Promise<void> => {
    if (seedance === undefined || genCost === null) return;
    setGenBusy(true);
    const n = savedN?.prompt === build.prompt ? savedN.n : nextAttempt;
    try {
      const jobs = await gen.run({
        modelId: seedance.id,
        prompt: build.prompt,
        params: genParams,
        refs: panelFiles.map((f) => ({ label: f.label, source: { type: 'projectRef', slug: project.slug, file: f.file ?? '' }, role: project.production ? 'start' : 'ref' })),
        count: 1,
        confirmCredits: genCost.credits,
        refsConsent: panelFiles.length > 0 ? true : undefined,
        origin: { projectSlug: project.slug, shotId: shot.id, attemptN: n },
      }, () => {
        if (useStore.getState().project?.slug !== project.slug) throw new Error('Открыт другой Prompter. Повтори запуск из нужного кадра.');
        if (savedN?.prompt !== build.prompt) { store.saveAttempt(build.prompt); setSavedN({ prompt: build.prompt, n }); }
      });
      setGenState({ prompt: build.prompt, n, errorRu: submissionIssue(jobs) ?? undefined });
    } catch (error) {
      setGenState({ prompt: build.prompt, n, errorRu: error instanceof Error ? error.message : 'Генерация не запустилась.' });
    } finally {
      setGenBusy(false);
    }
  };
  const launched = genState?.prompt === build.prompt ? genState : null;

  const copy = async (): Promise<void> => {
    await navigator.clipboard.writeText(build.prompt);
    setCopied(build.prompt);
    setTimeout(() => setCopied((c) => (c === build.prompt ? null : c)), 2000);
  };
  const save = (): void => {
    store.saveAttempt(build.prompt);
    setSavedN({ prompt: build.prompt, n: nextAttempt });
  };

  const footer = (
    <>
      <Text variant="caption" tone="secondary" className={styles.footNote}>
        {!passed ? ui("Отметь пункты чек-листа — кнопка откроется.") : savedN?.prompt === build.prompt ? ui("Попытка №{0} сохранена. После генерации разбери её в блоке «Попытки».", savedN.n) : ui("После копирования сохрани попытку: будет с чем сравнить результат.")}
      </Text>
      <Button variant="secondary" size="m" icon={<Icon name="bookmark" />} disabled={!passed || savedN?.prompt === build.prompt} onClick={save}>
        {ui("Сохранить как попытку ")}{nextAttempt}
      </Button>
      <Button variant="dark" size="m" icon={<Icon name={copied === build.prompt ? 'checkmark' : 'copy'} />} disabled={!passed} onClick={() => void copy()}>
        {copied === build.prompt ? ui("Скопировано") : ui("Скопировать промпт")}
      </Button>
    </>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange} size="l" title={ui("{0} → генерация", project.production ? shot.title : `Кадр ${shotIndex + 1}`)} description={ui("Запустить через Higgsfield API или перенести в Higgsfield вручную по шагам ниже. Здесь ничего не редактируется.")} footer={footer}>
      <div className={styles.steps}>
        <section className={styles.step}>
          <StepHead n="▶" title={ui("Сгенерировать здесь — Seedance 2.5 через Higgsfield")} />
          <div className={styles.row}>
            <SegmentedControl<string> aria-label={ui("Разрешение")} size="s" value={genRes} onChange={setGenRes} options={['480p', '720p', '1080p'].map((r) => ({ value: r, label: r }))} />
            <Switch checked={genAudio} onChange={setGenAudio} label={ui("Звук")} />
            <div className={styles.chips}>
              <Tag tone="neutral">{project.aspectRatio}</Tag>
              <Tag tone="neutral">{durationSec} {ui(" с")}</Tag>
              <Tag tone="outline">{ui("картинок: ")}{panelFiles.length} → @Image1…</Tag>
            </div>
          </div>
          {panelFiles.length > 0 && !hasRefsConsent() && (
            <label className={styles.gateItem}>
              <input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} />
              <Text variant="label">{ui("Картинки панели (")}{panelFiles.length}{ui(") уйдут в Higgsfield API. Если на них лицо, оно тоже уйдёт.")}</Text>
            </label>
          )}
          {genBlockers.length > 0 && (
            <Text variant="caption" tone="secondary" role="status">
              {ui("Чтобы рассчитать стоимость: ")}{genBlockers.join(' ')}
            </Text>
          )}
          <div className={styles.row}>
            <Button variant="dark" size="m" icon={<Icon name="sparkle" />} loading={genBusy} disabled={genBlockers.length > 0 || genCost === null} onClick={() => void generate()}>
              {ui("Рассчитать стоимость видео")}</Button>
            {launched !== null && (
              <Text variant="label" tone={launched.errorRu === undefined ? 'secondary' : 'accent'}>
                {launched.errorRu ?? ui("Задача попытки №{0} добавлена в «Материалы». Статус виден также в блоке «Попытки»; файл появится после завершения.", launched.n)}
              </Text>
            )}
          </div>
        </section>

        <section className={styles.step}>
          <StepHead n="1" title={ui("Настройки генерации")} />
          <div className={styles.chips}>
            <Tag tone="neutral">Seedance 2.5</Tag>
            <Tag tone="neutral">{project.aspectRatio}</Tag>
            <Tag tone="neutral">{durationSec} {ui(" с")}</Tag>
            <Tag tone="danger">{ui("Enhance Prompt: выкл")}</Tag>
            <Tag tone="outline">{ui("ссылки: ")}{project.dialect.refSyntax === 'higgsfield-chip' ? '<<<image_N>>>' : '@Image N'}</Tag>
          </div>
        </section>

        <section className={styles.step}>
          <StepHead n="2" title={ui("Референсы — {0} шт., загружать строго по номерам", shot.panel.length)} />
          <div className={styles.refs}>
            {shot.panel.map((key, i) => {
              const ref = refByKey.get(key);
              const file = ref?.file ?? null;
              const names = boundTo(key);
              return (
                <div key={key} className={styles.ref}>
                  <div className={`${styles.thumb} ${file === null ? 'lab-hatch' : ''}`}>
                    {file !== null && <img src={`/api/projects/${project.slug}/refs/${file}`} alt={ref?.label ?? key} />}
                    <span className={styles.number}>{i + 1}</span>
                  </div>
                  <Text variant="label" medium>{ref?.label ?? key}</Text>
                  <Text variant="caption" tone="secondary">{ui(KIND_RU[ref?.kind ?? 'other'])}{names.length > 0 ? ` · ${names.join(', ')}` : ''}</Text>
                  <Text variant="caption" tone="tertiary" mono>{refSyntax(i + 1)}</Text>
                  {file === null && <Tag tone="warning">{ui("нет файла")}</Tag>}
                </div>
              );
            })}
          </div>
          <div className={styles.row}>
            <Button variant="secondary" size="s" icon={<Icon name="folder" />} loading={store.exporting} disabled={shot.panel.length === 0} onClick={() => void store.exportPanel()}>
              {remoteStudio ? ui("Скачать файлы по номерам в ZIP") : ui("Сложить в папку по номерам и открыть в Finder")}
            </Button>
            <Text variant="caption" tone="tertiary">{ui("Файлы получат имена 01-…, 02-… в порядке панели, перетаскивай по одному сверху вниз.")}</Text>
          </div>
          {exported !== null && (
            <div className={`${styles.note} ${exported.errorRu !== undefined ? styles.noteBad : ''}`}>
              {exported.errorRu !== undefined ? (
                <Text variant="label">{exported.errorRu}</Text>
              ) : (
                <>
                  <Text variant="label" medium>{exported.downloadUrl ? ui("Архив подготовлен к скачиванию") : ui("Папка открыта: {0}", exported.dir)}</Text>
                  <Text variant="caption" tone="secondary" mono>{exported.files.map((f) => f.file ?? ui("{0} — нет файла ({1})", String(f.n).padStart(2, '0'), f.key)).join(' · ')}</Text>
                </>
              )}
            </div>
          )}
        </section>

        <section className={styles.step}>
          <StepHead n="3" title={ui("Промпт — {0} знаков", build.metrics.chars)} />
          <div className={styles.prompt}>
            <PromptText text={build.prompt} />
          </div>
        </section>

        <section className={styles.step}>
          <StepHead n="4" title={ui("Что должно получиться")} />
          {critique === null ? (
            <div className={styles.row}>
              <Text variant="label" tone="secondary">{stale ? ui("Критик читал прошлую версию текста — пересказ устарел.") : ui("Критик этот текст не читал: пересказа «что увидит зритель» нет.")}</Text>
              <Button variant="soft" size="s" icon={<Icon name="eye" />} loading={store.critiquing} onClick={() => void store.critiqueShot()}>{store.critiquing ? ui("Критик читает…") : stale ? ui("Перепроверить") : ui("Проверить критиком")}</Button>
            </div>
          ) : (
            <div className={styles.readback}>
              <div className={styles.chips}>
                <Tag tone={activeCritic.length < critique.findings.length ? 'outline' : VERDICT[critique.verdict]?.tone ?? 'neutral'} dot>{ui("Исходная оценка: ")}{ui(VERDICT[critique.verdict]?.label) ?? critique.verdict}</Tag>
                <Text variant="label" tone="secondary">{critique.summaryRu}</Text>
              </div>
              {activeCritic.length < critique.findings.length && <Text variant="caption" tone="secondary">{ui("Осталось замечаний: ")}{activeCritic.length}{ui(". Оставлено без исправления: ")}{critique.findings.length - activeCritic.length}.</Text>}
              {critique.readback.map((r) => (
                <div key={r.paragraph} className={styles.readbackRow}>
                  <Text variant="caption" tone="tertiary" mono>{String(r.paragraph).padStart(2, '0')}</Text>
                  <div>
                    <Text variant="label">{r.seesRu}</Text>
                    {r.unsureRu !== undefined && r.unsureRu !== '' && <Text variant="caption" tone="secondary">{ui("Не уверен: ")}{r.unsureRu}</Text>}
                  </div>
                </div>
              ))}
              {critique.findings.length > 0 && <Text variant="caption" tone="secondary">{ui("Замечания критика (")}{critique.findings.length}{ui(") — в окне «Проверка перед генерацией».")}</Text>}
            </div>
          )}
        </section>

        <section className={styles.step}>
          <StepHead n="5" title={ui("Перед тем как нажать «Генерировать»")} />
          <div className={styles.gate}>
            {items.map((item) => (
              <label key={item.id} className={styles.gateItem}>
                <input type="checkbox" checked={item.auto === true || ticks.includes(item.id)} disabled={item.auto === true} onChange={(event) => tick(item.id, event.target.checked)} />
                <Text variant="label" tone={item.auto === true ? 'secondary' : 'primary'}>{item.label}</Text>
              </label>
            ))}
            <Text variant="caption" tone="tertiary">{ui("Любая правка промпта сбрасывает отметки: галочки относятся к этому тексту.")}</Text>
          </div>
        </section>
      </div>
    </Dialog>
  );
}

function StepHead({ n, title }: { n: string; title: string }) {
  return (
    <header className={styles.stepHead}>
      <span className={styles.stepN}>{n}</span>
      <Text as="h3" variant="label" medium>{title}</Text>
    </header>
  );
}
