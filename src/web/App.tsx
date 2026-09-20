import { useEffect, useState } from 'react';
import { APP_NAME, APP_VERSION } from '../core/meta.ts';

type Health = { ok: boolean; name: string; version: string };

// Заглушка этапа M0: подтверждает, что один процесс отдаёт и SPA, и API.
export function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/health')
      .then((res) => res.json() as Promise<Health>)
      .then(setHealth)
      .catch((cause: unknown) => setError(String(cause)));
  }, []);

  return (
    <main>
      <h1>
        {APP_NAME} {APP_VERSION}
      </h1>
      <p>Каркас запущен. Интерфейс появится после переноса дизайн-системы Lab UI (этап M2).</p>
      <p>API: {error ?? (health === null ? 'проверяю…' : health.ok ? 'работает' : 'не отвечает')}</p>
    </main>
  );
}
