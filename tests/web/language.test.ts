import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { applyLanguage, readLanguage, setLanguage, getLanguage, ui, LANGUAGE_KEY } from '../../src/web/language.ts';
import { Text } from '../../src/web/ui/components/Text.tsx';
import { formatCost, tariffNote } from '../../src/web/formatCost.ts';
import { nodeTitle } from '../../src/web/canvas/nodeTitle.ts';
import { CanvasNodeSchema } from '../../src/core/model/canvas.ts';

let storage: Map<string,string>;
beforeEach(() => {
  storage = new Map();
  vi.stubGlobal('window', { localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key:string,value:string) => storage.set(key,value) } });
  vi.stubGlobal('document', { documentElement: { lang: '', dataset: {} as Record<string, string> } });
  setLanguage('ru');
});
afterEach(() => { setLanguage('ru'); vi.unstubAllGlobals(); });

it('defaults to Russian and persists the chosen English language', () => {
  storage.clear(); expect(readLanguage()).toBe('ru');
  setLanguage('en'); expect(storage.get(LANGUAGE_KEY)).toBe('en'); expect(readLanguage()).toBe('en');
  expect(document.documentElement.lang).toBe('en'); expect(ui('Производство')).toBe('Production');
  setLanguage('ru'); expect(ui('Производство')).toBe('Производство');
});
it('keeps working in memory when storage is blocked', () => {
  window.localStorage.setItem = () => { throw new Error('blocked'); };
  window.localStorage.getItem = () => { throw new Error('blocked'); };
  setLanguage('en'); expect(getLanguage()).toBe('en'); expect(ui('Создать холст')).toBe('Create canvas');
});
it('preserves Russian copy byte for byte and retains whitespace for English JSX fragments', () => {
  expect(ui('  Производство ')).toBe('  Производство ');
  setLanguage('en'); expect(ui('  Производство ')).toBe('  Production ');
  expect(ui('OpenAI')).toBe('OpenAI');expect(ui('constructor')).toBe('constructor');expect(ui(undefined)).toBeUndefined();
});
it('interpolates without translating or interpreting creator text', () => {
  setLanguage('en'); expect(ui('Открыть {0}','Производство {1}')).toBe('Open Производство {1}');
  expect(renderToStaticMarkup(createElement(Text,null,'Производство'))).toContain('Производство');
  const named=CanvasNodeSchema.parse({id:'n',type:'image',label:'Производство',x:0,y:0});
  expect(nodeTitle(named)).toBe('Производство');expect(nodeTitle({...named,type:'seedance'})).toBe('Seedance Prompter');
});
it('changes display units without changing quoted numbers', () => {
  const quote={credits:42,usd:0.21,unitRu:'кр Higgsfield'};const original=JSON.stringify(quote);
  setLanguage('en');expect(formatCost(quote)).toBe('42 Higgsfield credits ≈ $0.21');expect(JSON.stringify(quote)).toBe(original);
  expect(formatCost({credits:0,usd:0,unitRu:'$',requiresQuote:true})).toBe('estimate Higgsfield price');
});
it('applies document language independently of project settings', () => {
  applyLanguage('en'); expect(document.documentElement.dataset.language).toBe('en');
  applyLanguage('ru'); expect(document.documentElement.lang).toBe('ru');
});

it('localizes only the known tariff note, preserving its numbers and unknown provider text', () => {
  const source = 'Ориентир по тарифу Higgsfield для 16:9: $0.2056/с × 5 с, до скидок аккаунта. Фактическое списание зависит от размеров результата и может отличаться. Это не верхний предел расходов.';
  expect(tariffNote(source)).toBe(source);
  setLanguage('en');
  expect(tariffNote(source)).toBe('Reference Higgsfield tariff for 16:9: $0.2056/s × 5 s, before account discounts. Actual charges depend on output dimensions and may differ. This is not a spending cap.');
  expect(tariffNote('Собственное описание провайдера')).toBe('Собственное описание провайдера');
  expect(tariffNote(undefined)).toBeUndefined();
});
