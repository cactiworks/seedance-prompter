import { ui } from '../language.ts';
import { useEffect, useState } from 'react';
import { VERDICT_RU, VERDICT_SYMPTOMS, VERDICTS, type Verdict } from '../../core/gen/calibration.ts';
import { Icon, type IconName } from '../ui/components/index.ts';
import styles from './Calibration.module.css';
import { useJournal } from './journalStore.ts';

const MARK: Record<Verdict, IconName> = { good: 'checkmark', almost: 'minus', bad: 'close' };

/**
 * Оценка файла: годно / почти / мимо; если не годно — что именно (те же слова, что у рецептов починки) и заметка.
 * `compact` — для сетки калибровки: без заметки, чипы мельче.
 */
export function VerdictBar({ mediaId, compact = false }: { mediaId: string; compact?: boolean }) {
  const entry = useJournal((s) => s.verdicts.find((v) => v.mediaId === mediaId));
  const { setVerdict, clearVerdict, loaded, load } = useJournal();
  const [note, setNote] = useState(entry?.noteRu ?? '');
  useEffect(() => setNote(entry?.noteRu ?? ''), [entry?.noteRu, mediaId]);
  // Просмотр открывают из студии и библиотеки — журнал подтягивается при первой оценке на экране.
  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);

  return (
    <div className={`${styles.verdict} ${compact ? styles.verdictCompact : ''}`}>
      <div className={styles.verdictButtons} role="radiogroup" aria-label={ui("Оценка")}>
        {VERDICTS.map((v) => (
          <button
            key={v}
            type="button"
            role="radio"
            aria-checked={entry?.verdict === v}
            className={`${styles.verdictButton} ${entry?.verdict === v ? styles[`verdict_${v}`] : ''}`}
            title={ui(VERDICT_RU[v])}
            onClick={() => void (entry?.verdict === v ? clearVerdict(mediaId) : setVerdict(mediaId, { verdict: v }))}
          >
            <Icon name={MARK[v]} size={0.875} />
            {!compact && ui(VERDICT_RU[v])}
          </button>
        ))}
      </div>
      {entry !== undefined && entry.verdict !== 'good' && (
        <div className={styles.symptoms}>
          {VERDICT_SYMPTOMS.map((s) => {
            const on = entry.symptoms.includes(s.id);
            return (
              <button key={s.id} type="button" aria-pressed={on} className={`${styles.symptom} ${on ? styles.symptomOn : ''}`} onClick={() => void setVerdict(mediaId, { verdict: entry.verdict, symptoms: on ? entry.symptoms.filter((x) => x !== s.id) : [...entry.symptoms, s.id] })}>
                {s.labelRu}
              </button>
            );
          })}
        </div>
      )}
      {!compact && entry !== undefined && (
        <input className={styles.verdictNote} value={note} placeholder={ui("Заметка: что именно не так")} lang="ru" onChange={(event) => setNote(event.target.value)} onBlur={() => note !== entry.noteRu && void setVerdict(mediaId, { verdict: entry.verdict, noteRu: note })} />
      )}
    </div>
  );
}
