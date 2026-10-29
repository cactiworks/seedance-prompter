import { ui } from '../language.ts';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatgptAccount } from '../../core/chatgpt.ts';
import { Button, Dialog, SegmentedControl, Text, TextField } from '../ui/components/index.ts';
import styles from './ChatgptConnection.module.css';

export function ChatgptConnection() {
  const [account, setAccount] = useState<ChatgptAccount | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState('');
  const [copied, setCopied] = useState(false);
  const [method, setMethod] = useState<'chatgpt' | 'api'>('chatgpt');
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('https://api.openai.com/v1');
  const version = useRef(0);
  const refresh = useCallback(async () => {
    const current = version.current;
    try {
      const res = await fetch('/api/chatgpt', { cache: 'no-store' });
      if (!res.ok) throw new Error();
      const next = await res.json() as ChatgptAccount;
      if (current === version.current) {
        setAccount(next); setLoadError('');
        if (next.method === 'api') { setMethod('api'); if (next.baseUrl) setBaseUrl(next.baseUrl); }
      }
    } catch { if (current === version.current) setLoadError('Не удалось проверить подключение. Попробуй ещё раз.'); }
  }, []);
  useEffect(() => { void refresh(); window.addEventListener('focus', refresh); return () => window.removeEventListener('focus', refresh); }, [refresh]);
  useEffect(() => {
    if (!open) return;
    void refresh(); const timer = window.setInterval(() => { if (!busy) void refresh(); }, 2500);
    return () => clearInterval(timer);
  }, [open, busy, refresh]);
  async function change(action: 'login' | 'logout' | 'api-key') {
    version.current++; setBusy(true); setError(''); setCopied(false);
    try {
      const res = await fetch(`/api/chatgpt/${action}`, { method: 'POST', headers: { 'x-sp-client': '1', 'content-type':'application/json' }, ...(action === 'api-key' ? { body:JSON.stringify({ apiKey, baseUrl }) } : {}) });
      const next = await res.json() as ChatgptAccount & { messageRu?: string };
      if (!res.ok) throw new Error(next.messageRu ?? 'Не удалось изменить подключение.');
      setAccount(next); setApiKey('');
    } catch (e) { setError(e instanceof Error ? e.message : 'Не удалось изменить подключение.'); }
    finally { version.current++; setBusy(false); }
  }
  if (account?.enabled === false) return null;
  const connected = account?.status === 'connected';
  const connecting = account?.status === 'connecting';
  const viaApi = account?.method === 'api';
  const close = (next: boolean) => { setOpen(next); if (!next) { setApiKey(''); setError(''); } };
  return <>
    <Button variant="border" size="s" onClick={() => setOpen(true)} title={connected ? viaApi ? ui("Твой API key подключён") : ui("Твой ChatGPT: {0}", account.email ?? ui("подключён")) : ui("Подключить ChatGPT или API key")}>
      {connected ? viaApi ? ui("Мой API") : ui("Мой ChatGPT") : ui("Подключить AI")}
    </Button>
    <Dialog open={open} onOpenChange={close} title={ui("Твоё AI-подключение")} description={ui("ChatGPT или API key для этого браузера. Материалы студии общие.")}
      footer={connected
        ? <Button variant="border" loading={busy} onClick={() => void change('logout')}>{ui("Отключить ")}{viaApi ? 'API key' : ui("аккаунт")}</Button>
        : connecting
          ? <Button variant="border" loading={busy} onClick={() => void change('logout')}>{ui("Отменить вход")}</Button>
          : <Button variant="primary" loading={busy} disabled={method === 'api' && !apiKey.trim()} onClick={() => void change(method === 'api' ? 'api-key' : 'login')}>{method === 'api' ? ui("Подключить API key") : ui("Подключить ChatGPT")}</Button>}>
      <div className={styles.body}>
        {connected ? <>
          <div className={styles.account}><Text variant="caption" tone="secondary">{ui("Подключён")}</Text><Text medium>{viaApi ? 'API key' : account.email ?? ui("Твой аккаунт ChatGPT")}</Text>{account.plan && <Text variant="caption" tone="secondary">{ui("План: ")}{account.plan}</Text>}</div>
          <Text tone="secondary">{viaApi ? ui("Режиссёр, prompts и критик оплачиваются через твой API-сервис. Подписка ChatGPT для этого подключения не нужна.") : ui("Режиссёр, prompts и критик используют квоту этого аккаунта.")} {ui(" Фоновые этапы сохраняют подключение, с которого ты подтвердил запуск.")}</Text>
          {viaApi && <Text variant="caption" tone="secondary">{ui("Сервис: ")}{account.baseUrl}{ui(". Ключ сохранён. Доступ к модели и API-балансу проверится при первом запуске агента.")}</Text>}
        </> : connecting ? <>
          {account.login ? <>
            <Text>{ui("Открой страницу OpenAI, войди в свой аккаунт и введи этот код:")}</Text>
            <div className={styles.code}><Text as="code" variant="title-m" mono>{account.login.code}</Text><Button variant="soft" onClick={() => { void navigator.clipboard.writeText(account.login!.code).then(() => setCopied(true)).catch(() => setError('Выдели и скопируй код вручную.')); }}>{copied ? ui("Скопировано") : ui("Копировать код")}</Button></div>
            <a className={styles.link} href={account.login.url} target="_blank" rel="noopener noreferrer">{ui("Открыть вход OpenAI ↗")}</a>
            <Text variant="caption" tone="secondary">{ui("Проверь аккаунт на странице OpenAI перед подтверждением. Код действует до ")}{new Date(account.login.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.</Text>
          </> : <Text>{ui("Получаем код для входа…")}</Text>}
          <Text role="status" tone="secondary">{ui("Ожидаем подтверждение. Это окно обновится автоматически.")}</Text>
        </> : <>
          <SegmentedControl aria-label={ui("Способ подключения")} value={method} onChange={value => { setMethod(value); setError(''); setApiKey(''); }} options={[{ value:'chatgpt', label:'ChatGPT' }, { value:'api', label:'API key' }]} />
          {method === 'api' ? <>
            <Text>{ui("Укажи API-сервис и вставь свой ключ. Вызовы агентов оплачиваются на его стороне.")}</Text>
            <TextField label="Base URL" type="url" autoComplete="off" spellCheck={false} autoCapitalize="none" value={baseUrl} disabled={busy} onChange={e => setBaseUrl(e.target.value)} placeholder="https://api.example.com/v1" maxLength={1024} helper={ui("Адрес из настроек твоего Codex. Нужен совместимый Responses API.")} />
            <TextField label="API key" type="password" autoComplete="off" spellCheck={false} autoCapitalize="none" value={apiKey} disabled={busy} onChange={e => setApiKey(e.target.value)} placeholder="sk-…" maxLength={1024} helper={ui("Ключ хранится на сервере отдельно от материалов и привязан к этому браузеру. После сохранения он не показывается.")} />
            <Text variant="caption" tone="secondary">{ui("Подключение сохраняет ключ без платного запроса. Доступ к модели проверится при первом запуске. ")}<a className={styles.link} href="https://platform.openai.com/api-keys" target="_blank" rel="noopener noreferrer">{ui("Ключи OpenAI ↗")}</a></Text>
          </> : <>
            <Text>{ui("Подключи свой ChatGPT, чтобы запускать режиссёра и другие AI-инструменты за счёт своей подписки.")}</Text>
            <Text tone="secondary">{ui("Вход подтверждается на странице OpenAI. Пароль в студию вводить не нужно.")}</Text>
          </>}
          {account?.message && <Text role="status">{account.message}</Text>}
        </>}
        {(error || loadError) && <Text role="alert">{error || loadError}</Text>}
        {!connected && (method === 'chatgpt' || connecting) && <Text variant="caption" tone="secondary">{ui("Если OpenAI отклоняет вход по коду, включи device code login в настройках безопасности ChatGPT. ")}<a className={styles.link} href="https://learn.chatgpt.com/docs/auth" target="_blank" rel="noopener noreferrer">{ui("Помощь со входом")}</a></Text>}
      </div>
    </Dialog>
  </>;
}
