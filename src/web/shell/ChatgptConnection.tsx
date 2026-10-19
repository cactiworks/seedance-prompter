import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatgptAccount } from '../../core/chatgpt.ts';
import { Button, Dialog, Text } from '../ui/components/index.ts';
import styles from './ChatgptConnection.module.css';

export function ChatgptConnection() {
  const [account, setAccount] = useState<ChatgptAccount | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState('');
  const [copied, setCopied] = useState(false);
  const version = useRef(0);
  const refresh = useCallback(async () => {
    const current = version.current;
    try {
      const res = await fetch('/api/chatgpt', { cache: 'no-store' });
      if (!res.ok) throw new Error();
      const next = await res.json() as ChatgptAccount;
      if (current === version.current) { setAccount(next); setLoadError(''); }
    } catch { if (current === version.current) setLoadError('Не удалось проверить подключение. Попробуй ещё раз.'); }
  }, []);
  useEffect(() => { void refresh(); window.addEventListener('focus', refresh); return () => window.removeEventListener('focus', refresh); }, [refresh]);
  useEffect(() => {
    if (!open) return;
    void refresh(); const timer = window.setInterval(() => { if (!busy) void refresh(); }, 2500);
    return () => clearInterval(timer);
  }, [open, busy, refresh]);
  async function change(action: 'login' | 'logout') {
    version.current++; setBusy(true); setError(''); setCopied(false);
    try {
      const res = await fetch(`/api/chatgpt/${action}`, { method: 'POST', headers: { 'x-sp-client': '1' } });
      const next = await res.json() as ChatgptAccount & { messageRu?: string };
      if (!res.ok) throw new Error(next.messageRu ?? 'Не удалось изменить подключение.');
      setAccount(next);
    } catch (e) { setError(e instanceof Error ? e.message : 'Не удалось изменить подключение.'); }
    finally { version.current++; setBusy(false); }
  }
  if (account?.enabled === false) return null;
  const connected = account?.status === 'connected';
  const connecting = account?.status === 'connecting';
  return <>
    <Button variant="border" size="s" onClick={() => setOpen(true)} title={connected ? `Твой ChatGPT: ${account.email ?? 'подключён'}` : 'Подключить свой аккаунт ChatGPT'}>
      {connected ? 'Мой ChatGPT' : 'Подключить ChatGPT'}
    </Button>
    <Dialog open={open} onOpenChange={setOpen} title="Твой ChatGPT" description="Аккаунт для Codex в этом браузере. Материалы студии общие."
      footer={connected
        ? <Button variant="border" loading={busy} onClick={() => void change('logout')}>Отключить аккаунт</Button>
        : connecting
          ? <Button variant="border" loading={busy} onClick={() => void change('logout')}>Отменить вход</Button>
          : <Button variant="primary" loading={busy} onClick={() => void change('login')}>Подключить ChatGPT</Button>}>
      <div className={styles.body}>
        {connected ? <>
          <div className={styles.account}><Text variant="caption" tone="secondary">Подключён</Text><Text medium>{account.email ?? 'Твой аккаунт ChatGPT'}</Text>{account.plan && <Text variant="caption" tone="secondary">План: {account.plan}</Text>}</div>
          <Text tone="secondary">Режиссёр, prompts и критик используют квоту этого аккаунта. Фоновые этапы сохраняют аккаунт, с которого ты подтвердил запуск.</Text>
        </> : connecting ? <>
          {account.login ? <>
            <Text>Открой страницу OpenAI, войди в свой аккаунт и введи этот код:</Text>
            <div className={styles.code}><Text as="code" variant="title-m" mono>{account.login.code}</Text><Button variant="soft" onClick={() => { void navigator.clipboard.writeText(account.login!.code).then(() => setCopied(true)).catch(() => setError('Выдели и скопируй код вручную.')); }}>{copied ? 'Скопировано' : 'Копировать код'}</Button></div>
            <a className={styles.link} href={account.login.url} target="_blank" rel="noopener noreferrer">Открыть вход OpenAI ↗</a>
            <Text variant="caption" tone="secondary">Проверь аккаунт на странице OpenAI перед подтверждением. Код действует до {new Date(account.login.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.</Text>
          </> : <Text>Получаем код для входа…</Text>}
          <Text role="status" tone="secondary">Ожидаем подтверждение. Это окно обновится автоматически.</Text>
        </> : <>
          <Text>Подключи свой ChatGPT, чтобы запускать режиссёра и другие AI-инструменты за счёт своей подписки.</Text>
          <Text tone="secondary">Вход подтверждается на странице OpenAI. Пароль в студию вводить не нужно. Библиотека, Canvas и серии останутся общими.</Text>
          {account?.message && <Text role="status">{account.message}</Text>}
        </>}
        {(error || loadError) && <Text role="alert">{error || loadError}</Text>}
        {!connected && <Text variant="caption" tone="secondary">Если OpenAI отклоняет вход по коду, включи device code login в настройках безопасности ChatGPT. <a className={styles.link} href="https://learn.chatgpt.com/docs/auth" target="_blank" rel="noopener noreferrer">Помощь со входом</a></Text>}
      </div>
    </Dialog>
  </>;
}
