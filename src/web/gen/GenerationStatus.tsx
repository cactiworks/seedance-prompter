import { isActive, needsAttention } from '../../core/gen/jobStatus.ts';
import { useGen } from './genStore.ts';
import { Button, Text } from '../ui/components/index.ts';
import styles from './GenerationStatus.module.css';

/** Shared feedback stays visible when a creator leaves the screen that launched a job. */
export function GenerationStatus({ onOpen }: { onOpen: () => void }) {
  const { jobs, jobsLoading, jobsError, libraryError, jobsCheckedAt, submitting, submissionError, loadJobs } = useGen();
  const active = jobs.filter(isActive).length;
  const attention = jobs.filter(needsAttention).length;
  const summary = jobsCheckedAt === null ? jobsError === null ? 'Проверяю задачи…' : 'Статус задач недоступен' : `${jobsError === null ? '' : 'Последние данные: '}${active > 0 ? `В работе: ${active}` : 'Активных генераций нет'}`;
  return <section className={styles.bar} aria-label="Состояние генераций">
    <div className={styles.line}>
      <Text variant="caption" role="status">{submitting > 0 ? `Отправляется запросов: ${submitting} · ` : ''}{summary}{attention > 0 ? ` · Требуют внимания: ${attention}` : ''}</Text>
      <Button variant="ghost" size="xs" onClick={onOpen}>Задачи и результаты</Button>
      <Button variant="ghost" size="xs" loading={jobsLoading} onClick={() => void loadJobs()}>Обновить статусы</Button>
    </div>
    {(jobsError !== null || libraryError !== null) && <Text variant="caption" role="alert">{jobsError ?? libraryError}{jobsCheckedAt !== null && jobsError !== null ? ` Последняя проверка: ${new Date(jobsCheckedAt).toLocaleTimeString('ru-RU')}.` : ''}</Text>}
    {submissionError !== null && <div className={styles.line}><Text variant="caption" role="alert">{submissionError}</Text><Button variant="ghost" size="xs" onClick={() => useGen.setState({ submissionError: null })}>Скрыть сообщение</Button></div>}
  </section>;
}
