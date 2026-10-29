import { ui } from '../language.ts';
import { isActive, needsAttention } from '../../core/gen/jobStatus.ts';
import { useGen } from './genStore.ts';
import { Button, Text } from '../ui/components/index.ts';
import styles from './GenerationStatus.module.css';

/** Shared feedback stays visible when a creator leaves the screen that launched a job. */
export function GenerationStatus({ onOpen }: { onOpen: () => void }) {
  const { jobs, jobsLoading, jobsError, libraryError, jobsCheckedAt, submitting, submissionError, loadJobs } = useGen();
  const active = jobs.filter(isActive).length;
  const attention = jobs.filter(needsAttention).length;
  const summary = jobsCheckedAt === null ? jobsError === null ? ui("Проверяю задачи…") : ui("Статус задач недоступен") : `${jobsError === null ? '' : ui("Последние данные: ")}${active > 0 ? ui("В работе: {0}", active) : ui("Активных генераций нет")}`;
  return <section className={styles.bar} aria-label={ui("Состояние генераций")}>
    <div className={styles.line}>
      <Text variant="caption" role="status">{submitting > 0 ? ui("Отправляется запросов: {0} · ", submitting) : ''}{summary}{attention > 0 ? ui(" · Требуют внимания: {0}", attention) : ''}</Text>
      <Button variant="ghost" size="xs" onClick={onOpen}>{ui("Задачи и результаты")}</Button>
      <Button variant="ghost" size="xs" loading={jobsLoading} onClick={() => void loadJobs()}>{ui("Обновить статусы")}</Button>
    </div>
    {(jobsError !== null || libraryError !== null) && <Text variant="caption" role="alert">{jobsError ?? libraryError}{jobsCheckedAt !== null && jobsError !== null ? ui(" Последняя проверка: {0}.", new Date(jobsCheckedAt).toLocaleTimeString('ru-RU')) : ''}</Text>}
    {submissionError !== null && <div className={styles.line}><Text variant="caption" role="alert">{submissionError}</Text><Button variant="ghost" size="xs" onClick={() => useGen.setState({ submissionError: null })}>{ui("Скрыть сообщение")}</Button></div>}
  </section>;
}
