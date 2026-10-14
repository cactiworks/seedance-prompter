import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const [toolRoot, output] = process.argv.slice(2);
if (!toolRoot || !output) throw new Error('Pass existing Playwright root and new evidence directory.');
const { chromium } = createRequire(path.join(path.resolve(toolRoot), 'package.json'))('playwright');
await mkdir(output); // Fresh evidence only.
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = []; const forbidden = []; const checks = [];
page.on('pageerror', error => errors.push(error.message));
await page.route('**/*', route => {
  const url = new URL(route.request().url());
  if (url.pathname === '/api/production' && route.request().method() === 'POST' && route.request().postDataJSON()?.planningMode === 'codex') { forbidden.push('real Codex preparation'); return route.abort(); }
  if (url.origin !== 'http://127.0.0.1:4318' || /^\/api\/(?:llm\/|gen\/jobs)/.test(url.pathname)) { forbidden.push(url.pathname); return route.abort(); }
  return route.continue();
});
const screen = async name => { await page.waitForTimeout(220); await page.screenshot({ path: path.join(output, `${name}.png`), animations: 'disabled' }); };
const run = async () => { const rows = await (await page.request.get('http://127.0.0.1:4318/api/production')).json(); return rows.find(r => r.title === title); };
const waitRun = async predicate => { for (let i = 0; i < 100; i++) { const r = await run(); if (r && predicate(r)) return r; await page.waitForTimeout(300); } throw new Error('Mock stage timed out'); };
const title = `QA ${Date.now()}`;
const stage = id => page.locator(`[data-stage="${id}"]`);
const openStage = async id => { const head = stage(id).locator('button').first(); if (await head.getAttribute('aria-expanded') !== 'true') await head.click(); await stage(id).scrollIntoViewIfNeeded(); };
try {
  await page.goto('http://127.0.0.1:4318/#/production');
  await page.getByRole('button', { name: 'Новая серия', exact: true }).click();
  await page.getByLabel('Название серии', { exact: true }).fill(title);
  await page.getByRole('radio', { name: 'Только mock', exact: true }).check();
  await screen('01-create');
  await page.getByRole('button', { name: 'Запустить mock-серию', exact: true }).click();
  await page.getByRole('button', { name: 'Пауза', exact: true }).click();
  const paused = await run(); await page.waitForTimeout(1700); assert.equal((await run()).rev, paused.rev);
  await screen('02-paused');
  await page.reload(); await page.getByRole('button', { name: 'Продолжить', exact: true }).click();
  await waitRun(r => r.shots.length === 3 && r.shots.every(s => s.step === 'photoReview'));
  await openStage('photoReview');
  assert.equal(await stage('photoReview').getByRole('checkbox', { name: 'Выбрать Мысль на бумаге', exact: true }).isDisabled(), true);
  assert.equal((await run()).artifacts.filter(a => a.kind === 'video').length, 0);
  for (const width of [1440, 1280, 1089, 1087, 1024, 769, 767]) {
    await page.setViewportSize({ width, height: 1000 });
    await openStage('photoReview');
    await page.waitForTimeout(150);
    const measurements = await page.evaluate(() => ({ width: innerWidth, document: document.documentElement.scrollWidth, main: document.querySelector('[data-production]').clientWidth, scroll: document.querySelector('[data-production]').scrollWidth, images: [...document.querySelectorAll('[data-stage="photoReview"] img')].every(i => i.complete && i.naturalWidth > 0) }));
    assert.equal(measurements.document, width); assert.ok(measurements.scroll <= measurements.main + 1); assert.equal(measurements.images, true);
    await screen(`03-photo-${width}`); checks.push({ responsive: width, ...measurements });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('radio', { name: 'Тёмная тема', exact: true }).check();
  await openStage('photoReview'); await screen('04-photo-dark');
  await page.getByRole('radio', { name: 'Светлая тема', exact: true }).check();
  const bad = stage('photoReview').locator('[data-artifact="shot-2-photo-v1"]');
  await bad.getByRole('button', { name: 'Правка фото', exact: true }).click(); await screen('05-edit-dialog');
  await page.getByRole('button', { name: 'Создать mock-правку', exact: true }).click();
  // Inject a failure through the actual visible demo control while the edit runs.
  await page.getByText('Проверить поведение при сбое', { exact: true }).click();
  await page.getByRole('button', { name: 'Смоделировать сбой этапа', exact: true }).click();
  await page.getByRole('button', { name: 'Повторить mock-этап', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Повторить mock-этап', exact: true }).scrollIntoViewIfNeeded();
  await screen('06-failure');
  await page.getByRole('button', { name: 'Повторить mock-этап', exact: true }).click();
  await waitRun(r => r.shots[1].step === 'photoReview' && r.shots[1].photoId === 'shot-2-photo-v2');
  await openStage('photoReview');
  await stage('photoReview').getByRole('checkbox', { name: 'Выбрать У окна', exact: true }).check();
  await stage('photoReview').getByRole('button', { name: 'Принять фото', exact: true }).click();
  await waitRun(r => r.shots[0].step === 'videoReview');
  let state = await run(); assert.equal(state.shots[1].step, 'photoReview'); assert.equal(state.shots[2].step, 'photoReview');
  await page.reload();
  await openStage('videoReview'); await screen('07-video-milestone');
  await stage('videoReview').getByRole('button', { name: 'Открыть У окна, видео, версия 1', exact: true }).click();
  await page.locator('video').waitFor();
  await page.locator('video').evaluate(async video => { await video.play(); });
  await page.waitForTimeout(700);
  const video = await page.locator('video').evaluate(v => ({ width: v.videoWidth, height: v.videoHeight, duration: v.duration, time: v.currentTime }));
  assert.equal(video.width, 480); assert.equal(video.height, 854); assert.equal(video.duration, 4); assert.ok(video.time > 0);
  await screen('08-video-playback');
  await page.getByRole('button', { name: 'Закрыть', exact: true }).click();
  state = await run(); assert.equal(state.artifacts.filter(a => a.kind === 'final').length, 0);
  await stage('videoReview').getByRole('button', { name: 'Выбрать доступные', exact: true }).click();
  await stage('videoReview').getByRole('button', { name: 'Принять и продолжить до Topaz', exact: true }).click();
  await waitRun(r => r.shots[0].step === 'ready');
  await openStage('photoReview');
  await stage('photoReview').getByRole('button', { name: 'Выбрать доступные', exact: true }).click();
  await stage('photoReview').getByRole('button', { name: 'Принять фото', exact: true }).click();
  await waitRun(r => r.shots.slice(1).every(s => s.step === 'videoReview'));
  await openStage('videoReview');
  await stage('videoReview').getByRole('checkbox', { name: 'Выбрать Маленькая деталь', exact: true }).waitFor();
  await stage('videoReview').getByRole('button', { name: 'Выбрать доступные', exact: true }).click();
  await stage('videoReview').getByRole('button', { name: 'Принять и продолжить до Topaz', exact: true }).click();
  await waitRun(r => r.shots.every(s => s.step === 'ready'));
  await openStage('ready');
  await stage('ready').getByText(/^3 из 3 клипов готовы\./).waitFor();
  await screen('09-delivery');
  state = await run();
  const manifest = await (await page.request.get(`http://127.0.0.1:4318/api/production/${state.id}/manifest`)).json();
  assert.equal(manifest.artifacts.length, 6);
  assert.equal(manifest.artifacts.some(a => a.id === 'shot-2-photo-v1'), false);
  for (const asset of manifest.artifacts) { const file = await page.request.get(`http://127.0.0.1:4318${asset.url}`); assert.equal(file.status(), 200); assert.match(file.headers()['content-type'], /image\/png|video\/mp4/); }
  await page.getByText(`История версий и действий · ${state.events.length}`, { exact: true }).click();
  await screen('10-history');
  await openStage('plan'); await screen('11-scene');
  assert.deepEqual(errors, []); assert.deepEqual(forbidden, []);
  checks.push({ pauseReloadResume: true, partialApproval: true, edit: true, failureRetry: true, bothGates: true, playback: video, manifestFiles: 6, errors, forbidden, runId: state.id });
  await writeFile(path.join(output, 'results.json'), JSON.stringify(checks, null, 2));
  console.log(JSON.stringify({ output, checks: checks.length, runId: state.id }));
} finally { await browser.close(); }
