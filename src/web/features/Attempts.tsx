import { useEffect, useState } from 'react';
import { diffWords } from '../../core/attempts/diff.ts';
import type { Attempt } from '../../core/model/project.ts';
import { Button, Card, Icon, SegmentedControl, Tag, Text, TextField, type TagTone } from '../ui/components/index.ts';
import { currentShot, useStore } from '../store.ts';
import styles from './Attempts.module.css';
import { ShotGenerations } from './ShotGenerations.tsx';

const VERDICT: Record<Attempt['verdict'], { label: string; tone: TagTone }> = {
  pending: { label: 'жду результат', tone: 'outline' },
  'in-edit': { label: 'в монтаже', tone: 'success' },
  partial: { label: 'частично', tone: 'warning' },
  rejected: { label: 'не вошла', tone: 'danger' },
};

function Diff({ before, after }: { before: string; after: string }) {
  return (
    <p className={styles.diff}>
      {diffWords(before, after).map((part, i) => (
        <span key={i} className={part.type === 'add' ? styles.add : part.type === 'del' ? styles.del : undefined}>
          {part.text}
        </span>
      ))}
    </p>
  );
}

/** Петля попыток: снимок → разбор результата → симптомы → починка агентом → принять по абзацам. */
export function Attempts({ prompt, canSave }: { prompt: string; canSave: boolean }) {
  const store = useStore();
  const shot = useStore(currentShot);
  const [selected, setSelected] = useState<number | null>(null);

  useEffect(() => {
    if (store.symptoms === null) void store.loadSymptoms();
  }, [store]);

  if (shot === null) return null;
  const attempts = [...shot.attempts].sort((a, b) => b.n - a.n);
  const attempt = attempts.find((a) => a.n === selected) ?? attempts[0] ?? null;
  const catalog = store.symptoms;
  const chosen = catalog?.symptoms.filter((s) => attempt?.symptomIds.includes(s.id)) ?? [];
  const proposals = store.proposals !== null && store.proposals.attemptN === attempt?.n ? store.proposals : null;

  return (
    <Card padding="l" className={styles.card}>
      <div className={styles.head}>
        <Text variant="caption" tone="secondary">Попытки · {attempts.length}</Text>
        <Button variant="secondary" size="xs" icon={<Icon name="bookmark" size={0.875} />} disabled={!canSave} onClick={() => store.saveAttempt(prompt)}>
          Сохранить как попытку {Math.max(0, ...shot.attempts.map((a) => a.n)) + 1}
        </Button>
      </div>

      {attempts.length === 0 && <Text variant="label" tone="tertiary">Сохрани попытку перед генерацией: потом будет с чем сравнить и что чинить по симптомам.</Text>}

      {attempts.length > 0 && attempt !== null && (
        <>
          <div className={styles.tabs}>
            {attempts.map((a) => (
              <button key={a.n} type="button" className={`${styles.tab} ${a.n === attempt.n ? styles.tabOn : ''}`} onClick={() => setSelected(a.n)}>
                <Text variant="label" medium>№{a.n}</Text>
                <Tag tone={VERDICT[a.verdict].tone}>{VERDICT[a.verdict].label}</Tag>
              </button>
            ))}
          </div>

          {store.project !== null && <ShotGenerations slug={store.project.slug} shotId={shot.id} attemptN={attempt.n} />}

          <div className={styles.row}>
            <Text variant="label" tone="secondary">Итог генерации</Text>
            <SegmentedControl aria-label="Вердикт попытки" size="s" value={attempt.verdict} onChange={(verdict) => store.updateAttempt(attempt.n, { verdict })} options={[{ value: 'pending', label: 'Жду' }, { value: 'in-edit', label: 'В монтаже' }, { value: 'partial', label: 'Частично' }, { value: 'rejected', label: 'Не вошла' }]} />
          </div>

          <TextField multiline label="Что получилось" placeholder="Пикап тёмный, как на референсе. Оператор не виден." value={attempt.workedRu} onChange={(event) => store.updateAttempt(attempt.n, { workedRu: event.target.value })} />
          <TextField multiline label="Что не получилось" placeholder="Борт открылся не по физике. Три кейса слиплись в один." value={attempt.failedRu} onChange={(event) => store.updateAttempt(attempt.n, { failedRu: event.target.value })} />

          {catalog !== null && (
            <div className={styles.symptoms}>
              <Text variant="caption" tone="secondary">Симптомы — таблица ошибок гайда</Text>
              {Object.entries(catalog.groups).map(([group, title]) => (
                <div key={group} className={styles.group}>
                  <Text variant="caption" tone="tertiary">{title}</Text>
                  <div className={styles.chips}>
                    {catalog.symptoms.filter((s) => s.group === group).map((symptom) => {
                      const on = attempt.symptomIds.includes(symptom.id);
                      return (
                        <button key={symptom.id} type="button" aria-pressed={on} className={`${styles.chip} ${on ? styles.chipOn : ''}`} onClick={() => store.updateAttempt(attempt.n, { symptomIds: on ? attempt.symptomIds.filter((id) => id !== symptom.id) : [...attempt.symptomIds, symptom.id] })}>
                          {symptom.titleRu}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}

          {chosen.map((symptom) => (
            <div key={symptom.id} className={styles.recipe}>
              <Text variant="label" medium>{symptom.titleRu}</Text>
              <Text variant="label" tone="secondary">Причина: {symptom.causeRu}</Text>
              {symptom.checkRu !== '' && <Text variant="label">Сделай сам: {symptom.checkRu}</Text>}
              <Text variant="caption" tone="tertiary">{symptom.guide}{symptom.fixEn === '' ? ' · текстом не чинится' : ' · абзацы поправит агент'}</Text>
            </div>
          ))}

          <div className={styles.row}>
            <Text variant="caption" tone="tertiary">Агент правит абзацы минимально: всё, что сработало, остаётся байт в байт.</Text>
            <Button variant="soft" size="s" icon={<Icon name="bulb" />} loading={store.fixing} disabled={chosen.length === 0 && attempt.failedRu.trim() === ''} onClick={() => void store.proposeFix(attempt.n)}>
              {store.fixing ? 'Агент чинит…' : 'Предложить правки'}
            </Button>
          </div>

          {proposals !== null && (
            <div className={styles.proposals}>
              <Text variant="label" medium>{proposals.messageRu}</Text>
              {proposals.items.map((item) => {
                const index = shot.segments.findIndex((s) => s.id === item.segmentId);
                const before = shot.segments[index]?.text.en ?? '';
                return (
                  <div key={item.segmentId} className={styles.proposal}>
                    <div className={styles.head}>
                      <Text variant="label" medium>Отрезок {index + 1}</Text>
                      <div className={styles.actions}>
                        <Button variant="ghost" size="xs" onClick={() => store.dismissProposal(item.segmentId)}>Отклонить</Button>
                        <Button variant="primary" size="xs" icon={<Icon name="checkmark" size={0.875} />} onClick={() => store.acceptProposal(item.segmentId)}>Принять</Button>
                      </div>
                    </div>
                    {item.notesRu !== '' && <Text variant="label" tone="secondary">{item.notesRu}</Text>}
                    <Diff before={before} after={item.en} />
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </Card>
  );
}
