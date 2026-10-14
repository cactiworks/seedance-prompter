// Local, offline prototype checks. Requires the bundled Playwright runtime.
import { chromium } from '/Users/matveylytkin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const browser = await chromium.launch({headless:true,executablePath:'/Users/matveylytkin/Library/Caches/ms-playwright/chromium_headless_shell-1208/chrome-headless-shell-mac-arm64/chrome-headless-shell'});
const page = await browser.newPage({viewport:{width:1440,height:900},deviceScaleFactor:1});
const errors=[];
page.on('pageerror', e => errors.push(e.message));
const results=[];
await page.route('**/*',route => new URL(route.request().url()).origin === 'http://127.0.0.1:4329' ? route.continue() : route.abort());
try {
  for(const [width,height] of [[1440,900],[1024,768],[390,844]]) {
    await page.setViewportSize({width,height});
    await page.goto('http://127.0.0.1:4329/');
    await page.evaluate(()=>document.fonts.ready);
    const metrics=await page.evaluate(()=>({viewport:[innerWidth,innerHeight],pageWidth:document.documentElement.scrollWidth,canvasWidth:document.querySelector('#canvas-scroll').clientWidth,flowWidth:document.querySelector('#flow').scrollWidth}));
    assert.equal(metrics.pageWidth,width,'No page-level horizontal overflow');
    await page.screenshot({path:`responsive-${width}.png`});
    results.push({check:'responsive',...metrics,screenshot:`responsive-${width}.png`});
  }
  await page.setViewportSize({width:1024,height:768});
  await page.goto('http://127.0.0.1:4329/');
  await page.getByRole('button',{name:'Выбрать вариант A — студия',exact:true}).click();
  assert.match(await page.locator('#edit-lineage').innerText(),/варианта B/);
  await page.locator('#node-edit').click();
  await page.getByRole('button',{name:'Посмотреть историю версий →',exact:true}).click();
  assert.equal(await page.locator('[data-select="variants"] .art').getAttribute('data-scene'),'B');
  await page.getByRole('button',{name:'Выбрать вариант A — студия',exact:true}).click();
  await page.getByRole('button',{name:'Править выбранный вариант →',exact:true}).click();
  await page.getByRole('button',{name:'Показать правку в демо',exact:true}).click();
  assert.match(await page.locator('#edit-lineage').innerText(),/варианта A/);
  assert.match(await page.locator('#node-edit .node-top').innerText(),/v3/);
  results.push({check:'source identity preserved until new edit, then v3 from A',passed:true});
  await page.getByRole('button',{name:'? Помощь',exact:true}).click();
  await page.getByRole('button',{name:'Пройти onboarding →',exact:true}).click();
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(()=>document.activeElement.id),'tour-start');
  results.push({check:'Help tour closes to visible Canvas focus',passed:true});
  await page.locator('#tour-start').click();
  for(let i=0;i<7;i++){
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    const rect=await page.locator('#tour-card').boundingBox();
    assert(rect.x>=0&&rect.y>=0&&rect.x+rect.width<=1024&&rect.y+rect.height<=768);
    if(i===4){await page.waitForTimeout(300);await page.screenshot({path:'tour-1024.png'});}
    if(i===5)await page.locator('#tour-action').click();
    await page.locator('#tour-next').click();
  }
  assert(await page.locator('#tour-layer').isHidden());
  results.push({check:'7-step onboarding fits viewport, actions and finish work',passed:true,screenshot:'tour-1024.png'});
  await page.locator('#node-export').click();
  await page.locator('#trim-start').fill('4.5');
  await page.locator('#trim-start').dispatchEvent('input');
  assert.equal(await page.locator('#duration-value').innerText(),'0.5 сек');
  const downloadEvent=page.waitForEvent('download');
  await page.getByRole('button',{name:'Скачать план демо · JSON',exact:true}).click();
  const download=await downloadEvent;
  assert.equal(download.suggestedFilename(),'form-demo-plan.json');
  const manifest=JSON.parse(await fs.readFile(await download.path(),'utf8'));
  assert.equal(manifest.proposedVideo.actualMedia,null);
  assert.equal(manifest.proposedVideo.trimmedSeconds,.5);
  assert.equal(manifest.editedFromVariant,'A');
  results.push({check:'trim minimum and honest JSON plan download',passed:true});
  for(const view of ['projects','assets','exports','connections','help']){
    await page.locator(`.sidebar [data-view="${view}"]`).click();
    assert(await page.locator('#secondary-view').isVisible());
  }
  results.push({check:'all sidebar views functional',passed:true});
  await page.setViewportSize({width:390,height:844});
  await page.goto('http://127.0.0.1:4329/');
  await page.locator('#tour-start').click();
  for(let i=0;i<7;i++){
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    const rect=await page.locator('#tour-card').boundingBox();
    assert(rect.x>=0&&rect.y>=0&&rect.x+rect.width<=390&&rect.y+rect.height<=844);
    if(i===1){await page.waitForTimeout(300);await page.screenshot({path:'tour-390.png'});}
    await page.locator('#tour-next').click();
  }
  results.push({check:'mobile tour panel remains within viewport',passed:true,screenshot:'tour-390.png'});
  assert.deepEqual(errors,[]);
  results.push({check:'JavaScript runtime errors',errors});
  await fs.writeFile('qa-results.json',JSON.stringify(results,null,2));
  console.log(JSON.stringify(results,null,2));
} finally {await browser.close();}
