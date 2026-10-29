import { ui, getLanguage } from '../language.ts';
import { useState } from 'react';
import type { ShotBuild } from '../../core/pipeline.ts';
import type { Finding } from '../../core/lint/index.ts';
import type { Critique, Shot } from '../../core/model/project.ts';
import { activeCritiqueFindings, critiqueFingerprint } from '../../core/review.ts';
import { Button, Card, Icon, Tag, Text, type TagTone } from '../ui/components/index.ts';
import styles from './Findings.module.css';

const SEVERITY: Record<Finding['severity'], { tone: TagTone; label: string }> = {
  error: { tone: 'danger', label: 'ошибка' },
  warning: { tone: 'warning', label: 'проверь' },
  info: { tone: 'info', label: 'заметка' },
};
const CRITIC_SEVERITY: Record<Critique['findings'][number]['severity'], { tone: TagTone; label: string }> = {
  critical: { tone: 'danger', label: 'серьёзно' },
  warning: { tone: 'warning', label: 'проверь' },
  note: { tone: 'info', label: 'заметка' },
};
const VERDICT: Record<Critique['verdict'], { tone: TagTone; label: string }> = {
  ready: { tone: 'success', label: 'готов' },
  risky: { tone: 'warning', label: 'с рисками' },
  'not-ready': { tone: 'danger', label: 'не готов' },
};

interface FindingsProps {
  build: ShotBuild;
  shot: Shot;
  /** Подпись блока промпта по индексу абзаца — чтобы находка называла место словами. */
  blockLabel: (paragraph: number) => string;
  onSuppress: (fingerprint: string, reasonRu: string, messageRu?: string) => void;
  onRestore: (fingerprint: string) => void;
  /** Критик: запускается только по клику, результат привязан к тексту промпта. */
  critic: { running: boolean; error: string | null; onRun: () => void; onCancel: () => void };
}

const jump = (paragraph: number | null): void => {
  if (paragraph !== null) document.getElementById(`p-${paragraph}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
};

function Dismiss({ fingerprint, messageRu, onSuppress }: { fingerprint: string; messageRu: string; onSuppress: FindingsProps['onSuppress'] }) {
  return <Button variant="ghost" size="xs" icon={<Icon name="eye-off" size={0.875} />} onClick={() => onSuppress(fingerprint, 'Не влияет на результат этого кадра — решение владельца.', messageRu)}>{ui("Не исправлять")}</Button>;
}

function Row({ finding, blockLabel, onSuppress }: { finding: Finding; blockLabel: FindingsProps['blockLabel']; onSuppress: FindingsProps['onSuppress'] }) {
  return (
    <div className={styles.finding}>
      <Tag tone={SEVERITY[finding.severity].tone} dot>{ui(SEVERITY[finding.severity].label)}</Tag>
      <div className={styles.body}>
        <Text variant="label">{localIssue(finding.messageRu)}</Text>
        {finding.evidence.trim() !== '' && <Text variant="caption" tone="secondary" mono className={styles.evidence}>{finding.evidence.trim().slice(0, 160)}</Text>}
        <Text variant="caption" tone="secondary">{ui(finding.fixHintRu)}</Text>
        <div className={styles.actions}>
          <Text variant="caption" tone="tertiary" mono>{finding.ruleId}{finding.paragraph !== null ? ` · ${blockLabel(finding.paragraph)}` : ''}</Text>
          <span className={styles.spacer} />
          {finding.paragraph !== null && <Button variant="ghost" size="xs" onClick={() => jump(finding.paragraph)}>{ui("К абзацу")}</Button>}
          <Dismiss fingerprint={finding.fingerprint} messageRu={finding.messageRu} onSuppress={onSuppress} />
        </div>
      </div>
    </div>
  );
}

/** Окно проверки: что не даёт копировать, что стоит посмотреть, что просто к сведению. */
export function Findings({ build, shot, blockLabel, onSuppress, onRestore, critic }: FindingsProps) {
  const [showNotes, setShowNotes] = useState(false);
  const [showSuppressed, setShowSuppressed] = useState(false);
  const [showReadback, setShowReadback] = useState(false);
  const errors = build.findings.filter((f) => f.severity === 'error');
  const warnings = build.findings.filter((f) => f.severity === 'warning');
  const notes = build.findings.filter((f) => f.severity === 'info');
  const blocking = build.blockers.length + errors.length;
  const critique = shot.critique !== null && shot.critique.prompt === build.prompt ? shot.critique : null;
  const activeCritic = activeCritiqueFindings(shot, build.prompt);
  const dismissedCritic = (critique?.findings.length ?? 0) - activeCritic.length;
  const stale = shot.critique !== null && critique === null;

  return (
    <Card padding="l" className={styles.card} id="findings">
      <header className={styles.head}>
        <Text variant="caption" tone="secondary" as="h3">{ui("Проверка перед генерацией")}</Text>
        <div className={styles.summary}>
          <Tag tone={blocking > 0 ? 'danger' : 'success'} dot>{blocking > 0 ? ui("блокирует: {0}", blocking) : ui("ничего не блокирует")}</Tag>
          {warnings.length > 0 && <Tag tone="warning" dot>{ui("проверить: ")}{warnings.length}</Tag>}
        </div>
      </header>

      <Text variant="caption" tone="tertiary">{ui("Если замечание не влияет на этот кадр, нажми «Не исправлять». Его можно вернуть из списка исключений.")}</Text>

      {blocking > 0 && (
        <section className={styles.group}>
          <Text variant="caption" tone="tertiary">{ui("Блокирует копирование — с этим промпт в генерацию не уйдёт")}</Text>
          {build.blockers.map((blocker, i) => (
            <div key={`${blocker.code}-${i}`} className={styles.finding}>
              <Tag tone="danger" dot>{ui("не готово")}</Tag>
              <div className={styles.body}>
                <Text variant="label">{localIssue(blocker.messageRu)}</Text>
                <div className={styles.actions}>
                  <Text variant="caption" tone="tertiary" mono>{blocker.code}</Text>
                  <span className={styles.spacer} />
                  {blocker.fingerprint !== undefined && <Dismiss fingerprint={blocker.fingerprint} messageRu={blocker.messageRu} onSuppress={onSuppress} />}
                </div>
                {blocker.fingerprint === undefined && <Text variant="caption" tone="tertiary">{ui("Нужно исправить, чтобы собрать промпт: исключение здесь недоступно.")}</Text>}
              </div>
            </div>
          ))}
          {errors.map((finding) => <Row key={finding.fingerprint} finding={finding} blockLabel={blockLabel} onSuppress={onSuppress} />)}
        </section>
      )}

      {warnings.length > 0 && (
        <section className={styles.group}>
          <Text variant="caption" tone="tertiary">{ui("Стоит проверить — копировать можно, но это типичные причины испорченной генерации")}</Text>
          {warnings.map((finding) => <Row key={finding.fingerprint} finding={finding} blockLabel={blockLabel} onSuppress={onSuppress} />)}
        </section>
      )}

      {blocking === 0 && warnings.length === 0 && <Text variant="label" tone="tertiary">{ui("Ошибок и предупреждений нет.")}</Text>}

      <section className={`${styles.group} ${styles.critic}`}>
        <div className={styles.criticHead}>
          <div className={styles.criticTitle}>
            <Icon name="sparkles" size={1} />
            <Text variant="label" medium>{ui("Критик — итоговая проверка агентом")}</Text>
            {critique !== null && <Tag tone={dismissedCritic > 0 ? 'outline' : VERDICT[critique.verdict].tone} dot>{dismissedCritic > 0 ? ui("осталось замечаний: {0}", activeCritic.length) : ui(VERDICT[critique.verdict].label)}</Tag>}
            {stale && <Tag tone="outline">{ui("промпт изменился после проверки")}</Tag>}
            {shot.critique === null && !critic.running && <Tag tone="outline">{ui("не запускался")}</Tag>}
          </div>
          <div className={styles.actions}>
            {critic.running && <Button variant="ghost" size="xs" onClick={critic.onCancel}>{ui("Отмена")}</Button>}
            <Button variant={critique === null ? 'primary' : 'soft'} size="s" icon={<Icon name="eye" size={1} />} loading={critic.running} disabled={blocking > 0} onClick={critic.onRun}>
              {critic.running ? ui("Критик читает… до пары минут") : critique === null ? (stale ? ui("Перепроверить") : ui("Проверить итоговую")) : ui("Перепроверить")}
            </Button>
          </div>
        </div>
        <Text variant="caption" tone="tertiary">
          {blocking > 0 ? ui("Сначала сними блокеры: критик читает только собранный промпт.") : ui("Читает промпт как видеомодель: пересказывает, что увидит зритель, и называет то, чего regex не видит — физику, причинность, роли, двусмысленности. Вердикт — мнение, не пропуск.")}
        </Text>
        {critic.error !== null && <Text variant="label" tone="secondary">{critic.error}</Text>}
        {critique !== null && (
          <>
            {dismissedCritic > 0 && <Text variant="caption" tone="tertiary">{ui("Не исправляем: ")}{dismissedCritic}{ui(". Исходная оценка критика: «")}{ui(VERDICT[critique.verdict].label)}».</Text>}
            <Text variant="label">{critique.summaryRu}</Text>
            {activeCritic.map((f, i) => (
              <div key={`${f.paragraph}-${i}`} className={styles.finding}>
                <Tag tone={CRITIC_SEVERITY[f.severity].tone} dot>{CRITIC_SEVERITY[f.severity].label}</Tag>
                <div className={styles.body}>
                  <Text variant="label">{f.problemRu}</Text>
                  <Text variant="caption" tone="secondary" mono className={styles.evidence}>{f.quote}</Text>
                  <Text variant="caption" tone="secondary">{f.fixRu}</Text>
                  <div className={styles.actions}>
                    <Text variant="caption" tone="tertiary" mono>{ui("критик · ")}{f.category}{f.symptomId !== undefined ? ` · ${f.symptomId}` : ''} · {blockLabel(f.paragraph - 1)}</Text>
                    <span className={styles.spacer} />
                    <Button variant="ghost" size="xs" onClick={() => jump(f.paragraph - 1)}>{ui("К абзацу")}</Button>
                    <Dismiss fingerprint={critiqueFingerprint(critique, f)} messageRu={f.problemRu} onSuppress={onSuppress} />
                  </div>
                </div>
              </div>
            ))}
            {critique.readback.length > 0 && (
              <>
                <Button variant="ghost" size="xs" icon={<Icon name={showReadback ? 'chevron-up' : 'chevron-down'} size={0.875} />} onClick={() => setShowReadback(!showReadback)}>
                  {ui("Что увидит зритель — пересказ по абзацам")}</Button>
                {showReadback && critique.readback.map((r) => (
                  <div key={r.paragraph} className={styles.readbackRow}>
                    <Text variant="caption" tone="tertiary" mono>{String(r.paragraph).padStart(2, '0')}</Text>
                    <div className={styles.body}>
                      <Text variant="label">{r.seesRu}</Text>
                      {r.unsureRu !== undefined && r.unsureRu !== '' && <Text variant="caption" tone="secondary">{ui("Не уверен: ")}{r.unsureRu}</Text>}
                    </div>
                  </div>
                ))}
              </>
            )}
            {critique.droppedRu.length > 0 && <Text variant="caption" tone="tertiary">{ui("Выброшено проверкой ответа (цитаты нет в тексте): ")}{critique.droppedRu.length}.</Text>}
          </>
        )}
      </section>

      {notes.length > 0 && (
        <section className={styles.group}>
          <Button variant="ghost" size="xs" icon={<Icon name={showNotes ? 'chevron-up' : 'chevron-down'} size={0.875} />} onClick={() => setShowNotes(!showNotes)}>
            {ui("Заметки · ")}{notes.length} {ui(" — риски и советы, действий не требуют")}</Button>
          {showNotes && notes.map((finding) => <Row key={finding.fingerprint} finding={finding} blockLabel={blockLabel} onSuppress={onSuppress} />)}
        </section>
      )}

      {shot.suppressed.length > 0 && (
        <section className={styles.group}>
          <Button variant="ghost" size="xs" icon={<Icon name={showSuppressed ? 'chevron-up' : 'chevron-down'} size={0.875} />} onClick={() => setShowSuppressed(!showSuppressed)}>
            {ui("Осознанные исключения · ")}{shot.suppressed.length}
          </Button>
          {showSuppressed && <Text variant="caption" tone="tertiary">{ui("Решения для сохранённых версий кадра. После изменения текста или новой проверки критика замечания могут появиться снова.")}</Text>}
          {showSuppressed && shot.suppressed.map((item) => (
            <div key={item.fingerprint} className={styles.finding}>
              <Tag tone="outline">{ui("решение")}</Tag>
              <div className={styles.body}>
                {item.messageRu !== undefined && <Text variant="label">{item.messageRu}</Text>}
                <Text variant="caption" tone="secondary">{item.reasonRu}</Text>
                <div className={styles.actions}>
                  <Text variant="caption" tone="tertiary" mono>{item.messageRu === undefined ? item.fingerprint.slice(0, 70) : item.fingerprint.startsWith('critic:') ? ui("Критик") : item.fingerprint.startsWith('blocker:') ? ui("Проверка сборки") : ui("Линтер")}</Text>
                  <span className={styles.spacer} />
                  <Button variant="ghost" size="xs" onClick={() => onRestore(item.fingerprint)}>{ui("Вернуть")}</Button>
                </div>
              </div>
            </div>
          ))}
        </section>
      )}
    </Card>
  );
}


function localIssue(message: string): string {
  if (getLanguage() !== 'en') return message;
  const changed = /^Изменено после сборки: (.*)\. Нажми «Собрать промпт» — агент перепишет это в промпт\.$/.exec(message);
  if (changed) return 'Changed since the last build. Click Build prompt to update the English output from your current fields.';
  return ui(message);
}
