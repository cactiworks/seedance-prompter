import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { marked } from '/Users/matveylytkin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/marked/lib/marked.esm.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const files = ['research', 'onboarding', 'competitors', 'current-product-audit'];
const style = `@font-face{font-family:Geist;src:url('prototype/fonts/geist-cyrillic-wght-normal.woff2');font-weight:100 900;unicode-range:U+0400-045F,U+0490-0491,U+04B0-04B1,U+2116}@font-face{font-family:Geist;src:url('prototype/fonts/geist-latin-wght-normal.woff2');font-weight:100 900;unicode-range:U+0000-00FF,U+2000-206F,U+20AC,U+2122,U+2191,U+2193}*{box-sizing:border-box}body{margin:0;background:#f7f7fa;color:#17171b;font:16px/1.65 Geist,system-ui,sans-serif}header{padding:18px 5vw;background:white;border-bottom:1px solid #e7e7ed;display:flex;gap:22px;align-items:center;flex-wrap:wrap}header a{font-size:14px}a{color:#0069d9;text-decoration:none}a:hover{text-decoration:underline}main{max-width:1260px;margin:auto;padding:44px 5vw 100px}h1{font-size:36px;line-height:1.2;letter-spacing:-1.2px;font-weight:500;max-width:1000px}h2{font-size:25px;line-height:1.25;font-weight:500;letter-spacing:-.5px;margin:56px 0 20px}h3{font-size:19px;font-weight:500;margin-top:30px}p,li{max-width:900px}p{margin:16px 0}strong{font-weight:500}table{width:100%;border-collapse:collapse;background:#fff;font-size:14px;line-height:1.55;margin:24px 0}td,th{text-align:left;vertical-align:top;padding:15px;border-bottom:1px solid #e8e8ee;min-width:120px}th{background:#f0f0f5;font-weight:500}.table-wrap{overflow:auto}pre{background:#fff;border:1px solid #e8e8ee;border-radius:12px;padding:24px;overflow:auto;line-height:1.5;font-size:14px}code{font-size:.88em}img{max-width:100%;border-radius:12px}aside{padding:20px 24px;background:white;border:1px solid #e7e7ed;border-radius:14px;margin:28px 0}aside a{display:inline-block;margin:4px 18px 4px 0;font-size:14px}.pill{padding:8px 14px;background:#17171b;color:white;border-radius:99px}.meta{color:#74747f;font-size:13px}.local-source{color:#555;overflow-wrap:anywhere}footer{font-size:13px;color:#777;margin-top:60px}@media(max-width:700px){main{padding:26px 20px 70px}h1{font-size:29px}h2{font-size:23px}header{padding:14px 20px;gap:12px}td,th{padding:12px}.pill{display:inline-block}}`;
for (const file of files) {
  const source = await readFile(path.join(root, `${file}.md`), 'utf8');
  let body = marked.parse(source);
  body = body.replace(/href="([^"#]+)\.md(#[^"]*)?"/g, (full, link, anchor='') => {
    const base = path.basename(link);
    if (files.includes(base)) return `href="${base}.html${anchor}"`;
    return full;
  }).replace(/<a href="(\/Users\/[^\"]+)"[^>]*>(.*?)<\/a>/g, '<span class="local-source" title="$1">$2</span>');
  body = body.replace(/<table>/g, '<div class="table-wrap"><table>').replace(/<\/table>/g, '</table></div>');
  let n=0;const toc=[];
  body=body.replace(/<h2>(.*?)<\/h2>/g,(_,title)=>{const id=`section-${++n}`;toc.push(`<a href="#${id}">${title}</a>`);return `<h2 id="${id}">${title}</h2>`;});
  body=body.replace(/(<h2 id="section-1">)/,`<aside aria-label="Содержание">${toc.join('')}</aside>$1`);
  const title=source.split('\n')[0].replace(/^# /,'');
  const html=`<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>${style}</style></head><body><header><a href="research.html">Исследование</a><a href="onboarding.html">Onboarding</a><a href="competitors.html">Конкуренты</a><a href="current-product-audit.html">Аудит</a><a class="pill" href="prototype/">Открыть интерактивный черновик ↗</a></header><main>${body}<footer>Подготовлено 11 октября 2026. Проектные предложения не внедрены в рабочее приложение. <a href="${file}.md">Исходный Markdown</a></footer></main></body></html>`;
  await writeFile(path.join(root,`${file}.html`),html);
}
await writeFile(path.join(root,'index.html'),'<!doctype html><html lang="ru"><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=research.html"><title>UX Seedance Prompter</title><a href="research.html">Открыть исследование UX</a></html>');
console.log('Rendered 4 research pages and index.');
