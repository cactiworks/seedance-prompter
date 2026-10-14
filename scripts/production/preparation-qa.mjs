// Browser-only response fixtures: no real Codex or media requests reach the server.
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { newRun, completePreparation, advanceRun } from '../../src/core/production/engine.ts';
import { DEMO_INPUT } from '../../src/core/production/model.ts';
import { withShotIds } from '../../src/core/production/plan.ts';
import { sceneDraft, promptPlan, SCRIPT } from '../../tests/production/fixtures.ts';

const [toolRoot, output] = process.argv.slice(2);
if (!toolRoot || !output) throw new Error('Pass existing Playwright root and new evidence directory.');
const { chromium } = createRequire(path.join(path.resolve(toolRoot), 'package.json'))('playwright');
await mkdir(output);
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
let current = null; const errors = []; const forbidden = []; const checks = [];
const base = () => newRun('pr-browser-fixture', { ...DEMO_INPUT, title: 'QA fixture · подготовка Codex', script: SCRIPT, planningMode: 'codex', scenario: 'normal' }, 0, 1);
const call = stage => ({ stage, at: new Date(0).toISOString(), status: 'accepted', model: 'QA response fixture', durationMs: 1200, inputTokens: 100, outputTokens: 200, message: null });
page.on('pageerror', e => errors.push(e.message));
await page.route('**/*', route => {
  const request = route.request(); const url = new URL(request.url());
  if (url.pathname.startsWith('/api/production')) {
    if (request.method() === 'POST') {
      if (url.pathname.endsWith('/actions')) {
        const action = request.postDataJSON();
        if (action.type !== 'retryPreparation') throw new Error(`Unexpected fixture action: ${action.type}`);
        current.preparation.status = 'running'; current.preparation.error = null; current.preparation.attempt++; current.rev++;
      } else { assert.equal(request.postDataJSON().planningMode, 'codex'); current = base(); }
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(url.pathname === '/api/production' && request.method() === 'GET' ? current ? [current] : [] : current) });
  }
  if (url.origin !== 'http://127.0.0.1:4318' || /^\/api\/(?:llm\/|gen\/jobs)/.test(url.pathname)) { forbidden.push(url.pathname); return route.abort(); }
  return route.continue();
});
const settle = async () => { await page.waitForTimeout(220); await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))); };
const screen = async name => { await settle(); await page.screenshot({ path: path.join(output, `${name}.png`), animations: 'disabled' }); };
const main = page.locator('[data-production]');
const openPlan = async () => { const head = page.locator('[data-stage="plan"] > button'); if (await head.getAttribute('aria-expanded') !== 'true') await head.click(); };
const segments = async (name, target) => {
  await settle();
  await main.evaluate(el => { el.scrollTop = 0; });
  await settle();
  const end = await target.evaluate(el => { const root = el.closest('[data-production]'); return Math.max(0, el.getBoundingClientRect().bottom - root.getBoundingClientRect().top + root.scrollTop - root.clientHeight); });
  for (let top = 0, index = 0; ; top += 720, index++) {
    await main.evaluate((el, y) => { el.scrollTop = y; }, Math.min(top, end));
    await screen(`${name}-${index}`);
    if (top >= end) break;
  }
  const measurements = await main.evaluate(el => ({ width: innerWidth, document: document.documentElement.scrollWidth, main: el.clientWidth, scroll: el.scrollWidth }));
  assert.equal(measurements.width, measurements.document); assert.ok(measurements.scroll <= measurements.main + 1); checks.push({ name, ...measurements });
};
try {
  for (const width of [1440, 1280, 1089, 1087, 1024, 769, 767]) {
    current = null; await page.setViewportSize({ width, height: 1000 }); await page.goto('http://127.0.0.1:4318/#/production');
    await page.getByRole('button', { name: 'Подготовить с Codex', exact: true }).waitFor();
    await segments(`form-${width}`, page.locator('form'));
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('button', { name: 'Подготовить с Codex', exact: true }).click();
  await page.getByText('Готовит сцену', { exact: true }).waitFor(); await main.evaluate(el => { el.scrollTop = 0; }); await screen('running-director');
  current.scenePlan = withShotIds(sceneDraft(5)); current.preparation.stage = 'prompts'; current.preparation.calls.push(call('scene')); current.rev++;
  await page.getByText('Пишет prompts', { exact: true }).waitFor(); await screen('running-prompts');
  current.preparation.status = 'failed'; current.preparation.error = 'Тестовая ошибка: квота временно недоступна.'; current.rev++;
  await page.getByRole('button', { name: 'Повторить этап Codex', exact: true }).waitFor(); await screen('failed-with-saved-scene');
  await page.getByRole('button', { name: 'Повторить этап Codex', exact: true }).click();
  await page.getByText('Пишет prompts', { exact: true }).waitFor(); assert.equal(current.preparation.attempt, 2);
  current.promptPlan = promptPlan(5); current.preparation.calls.push(call('prompts')); current = completePreparation(current, 0, 1);
  for (let i = 0; i < 30; i++) current = advanceRun(current, 100 + i * 100, 1);
  for (const width of [1440, 1280, 1089, 1087, 1024, 769, 767]) {
    await page.setViewportSize({ width, height: 1000 }); await page.reload(); await openPlan();
    await page.getByText('Prompts кадра · фото и движение', { exact: true }).first().click();
    await segments(`plan-${width}`, page.locator('[data-stage="plan"]'));
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('radio', { name: 'Тёмная тема', exact: true }).check(); await segments('plan-dark-1440', page.locator('[data-stage="plan"]'));
  await page.getByRole('radio', { name: 'Светлая тема', exact: true }).check();
  for (const width of [1440, 767, 1024]) {
    await page.setViewportSize({ width, height: width === 1024 ? 640 : 1000 });
    const gate = page.locator('[data-stage="photoReview"]');
    if (await gate.locator('button').first().getAttribute('aria-expanded') !== 'true') await gate.locator('button').first().click();
    await gate.getByRole('button', { name: 'Правка фото', exact: true }).first().click();
    const dialog = page.getByRole('dialog'); const button = dialog.getByRole('button', { name: 'Создать mock-правку', exact: true });
    await screen(`edit-${width}`);
    const box = await dialog.boundingBox(); const foot = await button.boundingBox();
    assert.ok(box.height > 250); assert.ok(foot.y + foot.height <= box.y + box.height); assert.ok(box.y + box.height <= page.viewportSize().height);
    checks.push({ popup: width, height: page.viewportSize().height, dialog: box, button: foot });
    await dialog.getByRole('button', { name: 'Закрыть', exact: true }).click();
    await page.getByRole('button', { name: 'Как пользоваться', exact: true }).click(); await screen(`onboarding-${width}`);
    await page.getByRole('dialog').getByRole('button', { name: 'Закрыть', exact: true }).click();
  }
  assert.deepEqual(errors, []); assert.deepEqual(forbidden, []);
  await writeFile(path.join(output, 'results.json'), JSON.stringify({ checks, errors, forbidden, source: 'Browser-intercepted response fixtures. No real model calls.' }, null, 2));
  console.log(JSON.stringify({ output, checks: checks.length, errors, forbidden }));
} finally { await browser.close(); }
