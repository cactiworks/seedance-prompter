export interface DiffPart {
  type: 'same' | 'add' | 'del';
  text: string;
}

/** Плейсхолдер — один токен: {{line:L1}} нельзя показывать как правку трёх «слов». */
const TOKEN = /\{\{[^}]*\}\}|\s+|[^\s{]+|\{/g;

/** Пословный diff (LCS). Абзацы промпта — сотни слов, квадратичная таблица здесь дёшева. */
export function diffWords(before: string, after: string): DiffPart[] {
  const a = before.match(TOKEN) ?? [];
  const b = after.match(TOKEN) ?? [];
  const rows = a.length + 1;
  const cols = b.length + 1;
  const table = new Uint32Array(rows * cols);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i * cols + j] = a[i] === b[j] ? (table[(i + 1) * cols + j + 1] ?? 0) + 1 : Math.max(table[(i + 1) * cols + j] ?? 0, table[i * cols + j + 1] ?? 0);
    }
  }

  const parts: DiffPart[] = [];
  const push = (type: DiffPart['type'], text: string): void => {
    const last = parts.at(-1);
    if (last !== undefined && last.type === type) last.text += text;
    else parts.push({ type, text });
  };
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      push('same', a[i] ?? '');
      i += 1;
      j += 1;
    } else if ((table[(i + 1) * cols + j] ?? 0) >= (table[i * cols + j + 1] ?? 0)) {
      push('del', a[i] ?? '');
      i += 1;
    } else {
      push('add', b[j] ?? '');
      j += 1;
    }
  }
  while (i < a.length) push('del', a[i++] ?? '');
  while (j < b.length) push('add', b[j++] ?? '');
  return parts;
}

export function changeRatio(parts: DiffPart[]): number {
  const changed = parts.filter((p) => p.type !== 'same').reduce((n, p) => n + p.text.trim().length, 0);
  const total = parts.reduce((n, p) => n + p.text.trim().length, 0);
  return total === 0 ? 0 : changed / total;
}
