import { useState } from 'react';
import type { ShotBuild } from '../../core/pipeline.ts';
import type { Finding } from '../../core/lint/index.ts';
import type { Critique, Shot } from '../../core/model/project.ts';
import { Button, Card, Icon, Tag, Text, TextField, type TagTone } from '../ui/components/index.ts';
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
  onSuppress: (fingerprint: string, reasonRu: string) => void;
  onRestore: (fingerprint: string) => void;
  /** Критик: запускается только по клику, результат привязан к тексту промпта. */
  critic: { running: boolean; error: string | null; onRun: () => void; onCancel: () => void };
}

const jump = (paragraph: number | null): void => {
  if (paragraph !== null) document.getElementById(`p-${paragraph}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
};

function Row({ finding, blockLabel, onSuppress }: { finding: Finding; blockLabel: FindingsProps['blockLabel']; onSuppress: FindingsProps['onSuppress'] }) {
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState('');
  const confirm = (): void => {
    if (reason.trim() === '') return;
    onSuppress(finding.fingerprint, reason.trim());
    setAsking(false);
    setReason('');
  };

  return (
    <div className={styles.finding}>
      <Tag tone={SEVERITY[finding.severity].tone} dot>{SEVERITY[finding.severity].label}</Tag>
      <div className={styles.body}>
        <Text variant="label">{finding.messageRu}</Text>
        {finding.evidence.trim() !== '' && <Text variant="caption" tone="secondary" mono className={styles.evidence}>{finding.evidence.trim().slice(0, 160)}</Text>}
        <Text variant="caption" tone="secondary">{finding.fixHintRu}</Text>
        <div className={styles.actions}>
          <Text variant="caption" tone="tertiary" mono>{finding.ruleId}{finding.paragraph !== null ? ` · ${blockLabel(finding.paragraph)}` : ''}</Text>
          <span className={styles.spacer} />
          {finding.paragraph !== null && <Button variant="ghost" size="xs" onClick={() => jump(finding.paragraph)}>К абзацу</Button>}
          {!asking && <Button variant="ghost" size="xs" icon={<Icon name="eye-off" size={0.875} />} onClick={() => setAsking(true)}>Здесь это не ошибка</Button>}
        </div>
        {asking && (
          <div className={styles.suppress}>
            <TextField label="Почему здесь это допустимо" placeholder="Мимолётное отражение оператора — осознанно, как в Кадре 2 гайда" value={reason} onChange={(event) => setReason(event.target.value)} onKeyDown={(event) => event.key === 'Enter' && confirm()} helper="Причина сохранится в кадре. Находка скроется только для этого места и вернётся, если текст изменится." />
            <div className={styles.actions}>
              <span className={styles.spacer} />
              <Button variant="ghost" size="xs" onClick={() => setAsking(false)}>Отмена</Button>
              <Button variant="secondary" size="xs" disabled={reason.trim() === ''} onClick={confirm}>Скрыть с причиной</Button>
            </div>
          </div>
        )}
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
  const stale = shot.critique !== null && critique === null;

  return (
    <Card padding="l" className={styles.card} id="findings">
      <header className={styles.head}>
        <Text variant="caption" tone="secondary" as="h3">Проверка перед генерацией</Text>
        <div className={styles.summary}>
          <Tag tone={blocking > 0 ? 'danger' : 'success'} dot>{blocking > 0 ? `блокирует: ${blocking}` : 'ничего не блокирует'}</Tag>
          {warnings.length > 0 && <Tag tone="warning" dot>проверить: {warnings.length}</Tag>}
        </div>
      </header>

      {blocking > 0 && (
        <section className={styles.group}>
          <Text variant="caption" tone="tertiary">Блокирует копирование — с этим промпт в генерацию не уйдёт</Text>
          {build.blockers.map((blocker, i) => (
            <div key={`${blocker.code}-${i}`} className={styles.finding}>
              <Tag tone="danger" dot>не готово</Tag>
              <div className={styles.body}>
                <Text variant="label">{blocker.messageRu}</Text>
                <Text variant="caption" tone="tertiary" mono>{blocker.code}</Text>
              </div>
            </div>
          ))}
          {errors.map((finding) => <Row key={finding.fingerprint} finding={finding} blockLabel={blockLabel} onSuppress={onSuppress} />)}
        </section>
      )}

      {warnings.length > 0 && (
        <section className={styles.group}>
          <Text variant="caption" tone="tertiary">Стоит проверить — копировать можно, но это типичные причины испорченной генерации</Text>
          {warnings.map((finding) => <Row key={finding.fingerprint} finding={finding} blockLabel={blockLabel} onSuppress={onSuppress} />)}
        </section>
      )}

      {blocking === 0 && warnings.length === 0 && <Text variant="label" tone="tertiary">Ошибок и предупреждений нет.</Text>}

      <section className={`${styles.group} ${styles.critic}`}>
        <div className={styles.criticHead}>
          <div className={styles.criticTitle}>
            <Icon name="sparkles" size={1} />
            <Text variant="label" medium>Критик — итоговая проверка агентом</Text>
            {critique !== null && <Tag tone={VERDICT[critique.verdict].tone} dot>{VERDICT[critique.verdict].label}</Tag>}
            {stale && <Tag tone="outline">промпт изменился после проверки</Tag>}
            {shot.critique === null && !critic.running && <Tag tone="outline">не запускался</Tag>}
          </div>
          <div className={styles.actions}>
            {critic.running && <Button variant="ghost" size="xs" onClick={critic.onCancel}>Отмена</Button>}
            <Button variant={critique === null ? 'primary' : 'soft'} size="s" icon={<Icon name="eye" size={1} />} loading={critic.running} disabled={blocking > 0} onClick={critic.onRun}>
              {critic.running ? 'Критик читает… до пары минут' : critique === null ? (stale ? 'Перепроверить' : 'Проверить итоговую') : 'Перепроверить'}
            </Button>
          </div>
        </div>
        <Text variant="caption" tone="tertiary">
          {blocking > 0 ? 'Сначала сними блокеры: критик читает только собранный промпт.' : 'Читает промпт как видеомодель: пересказывает, что увидит зритель, и называет то, чего regex не видит — физику, причинность, роли, двусмысленности. Вердикт — мнение, не пропуск.'}
        </Text>
        {critic.error !== null && <Text variant="label" tone="secondary">{critic.error}</Text>}
        {critique !== null && (
          <>
            <Text variant="label">{critique.summaryRu}</Text>
            {critique.findings.map((f, i) => (
              <div key={`${f.paragraph}-${i}`} className={styles.finding}>
                <Tag tone={CRITIC_SEVERITY[f.severity].tone} dot>{CRITIC_SEVERITY[f.severity].label}</Tag>
                <div className={styles.body}>
                  <Text variant="label">{f.problemRu}</Text>
                  <Text variant="caption" tone="secondary" mono className={styles.evidence}>{f.quote}</Text>
                  <Text variant="caption" tone="secondary">{f.fixRu}</Text>
                  <div className={styles.actions}>
                    <Text variant="caption" tone="tertiary" mono>критик · {f.category}{f.symptomId !== undefined ? ` · ${f.symptomId}` : ''} · {blockLabel(f.paragraph - 1)}</Text>
                    <span className={styles.spacer} />
                    <Button variant="ghost" size="xs" onClick={() => jump(f.paragraph - 1)}>К абзацу</Button>
                  </div>
                </div>
              </div>
            ))}
            {critique.readback.length > 0 && (
              <>
                <Button variant="ghost" size="xs" icon={<Icon name={showReadback ? 'chevron-up' : 'chevron-down'} size={0.875} />} onClick={() => setShowReadback(!showReadback)}>
                  Что увидит зритель — пересказ по абзацам
                </Button>
                {showReadback && critique.readback.map((r) => (
                  <div key={r.paragraph} className={styles.readbackRow}>
                    <Text variant="caption" tone="tertiary" mono>{String(r.paragraph).padStart(2, '0')}</Text>
                    <div className={styles.body}>
                      <Text variant="label">{r.seesRu}</Text>
                      {r.unsureRu !== undefined && r.unsureRu !== '' && <Text variant="caption" tone="secondary">Не уверен: {r.unsureRu}</Text>}
                    </div>
                  </div>
                ))}
              </>
            )}
            {critique.droppedRu.length > 0 && <Text variant="caption" tone="tertiary">Выброшено проверкой ответа (цитаты нет в тексте): {critique.droppedRu.length}.</Text>}
          </>
        )}
      </section>

      {notes.length > 0 && (
        <section className={styles.group}>
          <Button variant="ghost" size="xs" icon={<Icon name={showNotes ? 'chevron-up' : 'chevron-down'} size={0.875} />} onClick={() => setShowNotes(!showNotes)}>
            Заметки · {notes.length} — риски и советы, действий не требуют
          </Button>
          {showNotes && notes.map((finding) => <Row key={finding.fingerprint} finding={finding} blockLabel={blockLabel} onSuppress={onSuppress} />)}
        </section>
      )}

      {shot.suppressed.length > 0 && (
        <section className={styles.group}>
          <Button variant="ghost" size="xs" icon={<Icon name={showSuppressed ? 'chevron-up' : 'chevron-down'} size={0.875} />} onClick={() => setShowSuppressed(!showSuppressed)}>
            Осознанные исключения · {shot.suppressed.length}
          </Button>
          {showSuppressed && shot.suppressed.map((item) => (
            <div key={item.fingerprint} className={styles.finding}>
              <Tag tone="outline">скрыто</Tag>
              <div className={styles.body}>
                <Text variant="label">{item.reasonRu}</Text>
                <div className={styles.actions}>
                  <Text variant="caption" tone="tertiary" mono>{item.fingerprint.slice(0, 70)}</Text>
                  <span className={styles.spacer} />
                  <Button variant="ghost" size="xs" onClick={() => onRestore(item.fingerprint)}>Вернуть</Button>
                </div>
              </div>
            </div>
          ))}
        </section>
      )}
    </Card>
  );
}
