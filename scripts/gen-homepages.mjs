import fs from 'node:fs/promises';
import path from 'node:path';

const dataDir = 'src/data/news';
const digestPath = 'src/data/daily-digest.json';

const CL = {
  'digital-a11y': { en: 'Digital A11y', 'zh-TW': '數位無障礙' },
  'assistive-tech': { en: 'Assistive Tech', 'zh-TW': '輔助科技' },
  'laws-rights': { en: 'Laws & Rights', 'zh-TW': '政策與法規' },
  'physical-design': { en: 'Physical Design', 'zh-TW': '空間與通用設計' },
  'lifestyle-culture': { en: 'Lifestyle & Culture', 'zh-TW': '文化與生活' },
  'case-studies': { en: 'Case Studies', 'zh-TW': '案例與最佳實踐' },
  'social-signals': { en: 'Social Signals', 'zh-TW': '社群訊號' },
  general: { en: 'General', 'zh-TW': '綜合' },
};
const LR = { US:{en:'English','zh-TW':'英文'}, TW:{en:'Chinese','zh-TW':'中文'}, KR:{en:'Korean','zh-TW':'韓文'}, JP:{en:'Japanese','zh-TW':'日文'}, SA:{en:'Arabic','zh-TW':'阿拉伯文'}, AE:{en:'Arabic','zh-TW':'阿拉伯文'} };
const SC = {
  en: { siteTitle:'Inclusion and Accessibility News Hub', siteName:'Inclusion and Accessibility News Hub', subtitle:'Stay on top of global accessibility news.', intro:'This site curates news on diversity, equity, inclusion, and accessibility from sources in multiple languages. English translations are provided to make reporting from different regions more accessible to more readers.', contactInvite:'Have a source we should follow?', contactLinkLabel:'Contact us', digest:'Daily Digest', digestUpdated:'Updated', digestFallback:'No digest available yet.', latest:'Latest Coverage', search:'Search', allCategories:'All Categories', empty:'No stories found.' },
  'zh-TW': { siteTitle:'包容與無障礙新聞中心', siteName:'包容與無障礙新聞中心', subtitle:'掌握全球無障礙新聞。', intro:'本站彙整來自多語言來源的多元、公平、包容與無障礙新聞。提供英文翻譯，讓不同地區的報導能被更多讀者閱讀。', contactInvite:'有推薦的來源嗎？', contactLinkLabel:'聯絡我們', digest:'每日摘要', digestUpdated:'更新於', digestFallback:'暫無摘要。', latest:'最新報導', search:'搜尋', allCategories:'所有分類', empty:'找不到相關報導。' },
};

const esc = s => String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

function card(loc, e) {
  const c = e.category||'general', cl = CL[c]?.[loc]??CL.general[loc];
  const rc = e.sourceCountry??e.queryRegion??e.region??null;
  const ll = rc ? (LR[rc]?.[loc]??null) : null;
  const dt = new Date(e.publishedAt).toLocaleDateString(loc==='zh-TW'?'zh-Hant-TW':'en-US',{year:'numeric',month:'short',day:'numeric'});
  return `<article class="group rounded-3xl border border-slate-200 bg-white p-5 shadow-sm transition-all duration-300 hover:-translate-y-1 hover:shadow-lg sm:p-8"><div class="flex flex-wrap items-center gap-3 text-sm text-slate-600"><span class="rounded-full bg-indigo-600 px-3 py-1 font-semibold text-white">${esc(cl)}</span>${ll?`<span class="text-slate-500">-</span><span class="font-medium text-slate-600">${esc(ll)}</span>`:''}<time datetime="${new Date(e.publishedAt).toISOString()}">${esc(dt)}</time></div><h2 class="mt-5 text-2xl font-black tracking-tight text-slate-900 sm:text-3xl"><a href="${esc(e.sourceUrl)}" target="_blank" rel="noopener noreferrer" class="focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-indigo-300">${esc(e.title)}</a></h2><p class="mt-4 text-base font-normal leading-relaxed text-slate-700">${esc(e.summary)}</p></article>`;
}

async function load(loc) {
  const sfx = loc==='zh-TW'?'.zh-TW.json':'.en.json';
  const files = (await fs.readdir(dataDir)).filter(f=>f.endsWith(sfx));
  let all=[];
  for(const f of files){all.push(...JSON.parse(await fs.readFile(path.join(dataDir,f),'utf8')));}
  all.sort((a,b)=>new Date(b.publishedAt)-new Date(a.publishedAt));
  return all;
}

function build(loc, entries, dd) {
  const c = SC[loc], lang = loc==='zh-TW'?'zh-Hant':'en', ll = loc==='zh-TW'?'繁體中文':'English', bp = loc==='zh-TW'?'/zh-tw':'/en';
  const cats={}; entries.forEach(e=>{const k=e.category||'general';cats[k]=(cats[k]||0)+1;});
  const cc = Object.entries(cats).sort((a,b)=>b[1]-a[1]);
  const ld = dd[loc]??null;
  const ddDate = dd.generatedAt ? new Date(dd.generatedAt).toLocaleDateString(loc==='zh-TW'?'zh-Hant-TW':'en-US') : '';
  const catBtns = [`<a href="${bp}" data-category="" class="category-btn rounded-full border-2 border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 transition-all duration-300 hover:border-indigo-400 hover:text-indigo-700">${esc(c.allCategories)}</a>`, ...cc.map(([k,v])=>`<a href="${bp}?category=${k}" data-category="${k}" class="category-btn rounded-full border-2 border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 transition-all duration-300 hover:border-indigo-400 hover:text-indigo-700">${esc(CL[k]?.[loc]??k)} (${v})</a>`)].join('\n        ');
  const stories = entries.map((e,i)=>`<article data-story data-category="${esc(e.category||'general')}" data-index="${i}" style="display:none">${card(loc,e)}</article>`).join('\n      ');
  let dh='';
  if(ld?.highlights&&ld.highlights.length>0){const ebs=new Map(entries.map(e=>[e.slug,e]));dh=`<p class="mt-4 font-['Merriweather'] text-lg leading-relaxed text-slate-700">${esc(ld.summary)}</p><ul class="mt-5 grid gap-3 sm:grid-cols-2">${ld.highlights.map(h=>{const sh=ebs.get(h.slug)?.sourceUrl??`${bp}/news/${h.slug}`;const ex=sh.startsWith('http');return`<li class="rounded-2xl border border-white/80 bg-white/70 p-4"><a href="${esc(sh)}"${ex?' target="_blank" rel="noopener noreferrer"':''} class="font-semibold text-slate-800 transition-all duration-300 hover:text-indigo-700">${esc(h.title)}</a></li>`;}).join('')}</ul>`;}else{dh=`<p class="mt-4 text-slate-600">${esc(c.digestFallback)}</p>`;}
  return `<!DOCTYPE html>
<html lang="${lang}">
  <head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><meta name="description" content="Global accessibility news in English and Traditional Chinese."><meta name="theme-color" content="#4f46e5"><meta name="mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-status-bar-style" content="black-translucent"><meta name="apple-mobile-web-app-title" content="Inclu.si"><link rel="icon" type="image/svg+xml" href="/favicon.svg"><link rel="icon" href="/favicon.ico"><link rel="apple-touch-icon" href="/apple-touch-icon.svg"><link rel="manifest" href="/manifest.json"><meta name="generator" content="Astro v6.1.9"><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;700;800&family=Merriweather:wght@400;700;900&display=swap" rel="stylesheet"><meta property="og:title" content="${esc(c.siteTitle)}"><meta property="og:description" content="Global accessibility news in English and Traditional Chinese."><meta property="og:type" content="website"><meta property="og:locale" content="${loc==='zh-TW'?'zh_TW':'en_US'}"><title>${esc(c.siteTitle)}</title><link rel="stylesheet" href="/_astro/Layout.B6xH8DG_.css"></head>
  <body class="min-h-screen bg-slate-50 text-slate-800 antialiased">
    <div class="mx-auto w-full max-w-6xl px-5 pt-10 sm:px-8 sm:pt-14"><header class="relative overflow-hidden rounded-3xl border border-slate-200 bg-gradient-to-br from-slate-50 via-white to-indigo-50 p-5 sm:p-10"><div class="absolute -right-12 -top-14 h-48 w-48 rounded-full bg-indigo-200/60 blur-3xl"></div><div class="absolute -bottom-16 -left-10 h-48 w-48 rounded-full bg-cyan-200/50 blur-3xl"></div><div class="relative flex flex-col gap-6 sm:flex-row sm:flex-wrap sm:items-start sm:justify-between"><div class="max-w-3xl"><p class="font-['Manrope'] text-sm font-bold uppercase tracking-[0.18em] text-indigo-700">Inclusion and Accessibility News Hub</p><h1 class="mt-3 font-['Merriweather'] text-4xl font-black tracking-tight text-slate-900 sm:text-5xl">${esc(c.siteName)}</h1><p class="mt-4 max-w-2xl font-['Merriweather'] text-lg leading-relaxed text-slate-700">${esc(c.subtitle)}</p></div><nav aria-label="Navigation" class="flex w-fit flex-col gap-3 sm:flex-row sm:items-center"><a href="${bp}/search" class="rounded-full border border-slate-300 bg-white px-4 py-2 text-sm font-bold text-slate-700 transition-all duration-300 hover:border-indigo-400 hover:text-indigo-700">${esc(c.search)}</a><details class="group relative"><summary class="cursor-pointer rounded-full border border-slate-300 bg-white px-4 py-2 text-sm font-bold text-slate-700 transition-all duration-300 hover:border-indigo-400 hover:text-indigo-700 marker:hidden">${ll} ▾</summary><ul class="absolute right-0 top-full z-50 mt-2 min-w-max rounded-2xl border border-slate-200 bg-white shadow-lg"><li><a href="/en" class="block px-4 py-2 text-sm font-semibold transition-all duration-300 first:rounded-t-xl last:rounded-b-xl ${loc==='en'?'bg-indigo-600 text-white':'text-slate-700 hover:bg-slate-100'}">English</a></li><li><a href="/zh-tw" class="block px-4 py-2 text-sm font-semibold transition-all duration-300 first:rounded-t-xl last:rounded-b-xl ${loc==='zh-TW'?'bg-indigo-600 text-white':'text-slate-700 hover:bg-slate-100'}">繁體中文</a></li></ul></details></nav></div></header></div>
    <main class="mx-auto flex w-full max-w-6xl flex-col space-y-12 px-5 pb-10 pt-6 sm:px-8 sm:pb-14 sm:pt-8">
      <section class="rounded-2xl border border-slate-200 bg-white px-6 py-5 sm:px-8"><p class="text-base leading-relaxed text-slate-600">${esc(c.intro)}</p><p class="mt-3 text-base leading-relaxed text-slate-600">${esc(c.contactInvite)} <a href="${bp}/contact" class="font-bold text-indigo-700 underline decoration-indigo-300 underline-offset-2 hover:text-indigo-800">${esc(c.contactLinkLabel)}</a>${loc==='zh-TW'?'。':'.'}</p></section>
      <section class="rounded-3xl border border-indigo-200 bg-gradient-to-r from-indigo-50 via-white to-cyan-50 p-5 sm:p-8"><div class="flex flex-wrap items-center justify-between gap-3"><h2 class="font-['Merriweather'] text-3xl font-black tracking-tight text-slate-900">${esc(c.digest)}</h2><span class="rounded-full border border-indigo-200 bg-white px-3 py-1 text-xs font-bold uppercase tracking-wide text-indigo-700">${esc(c.digestUpdated)}: ${esc(ddDate)}</span></div>${dh}</section>
      <section class="rounded-3xl border border-slate-200 bg-white p-5 sm:p-8"><div><h2 class="font-['Merriweather'] text-3xl font-black tracking-tight text-slate-900">${esc(c.latest)}</h2></div></section>
      <section class="space-y-8" data-base-path="${bp}" data-per-page="20" data-initial-page="1"><div id="category-filter" class="flex flex-wrap gap-2">${catBtns}</div><div id="stories-container">${stories}<article id="stories-empty" style="display:none" class="rounded-3xl border border-dashed border-slate-300 bg-white p-8 text-slate-600">${esc(c.empty)}</article></div><nav id="pagination-nav" aria-label="Pagination" class="hidden items-center justify-center gap-4 py-8"><button id="prev-btn" type="button" class="rounded-full border border-slate-300 bg-white px-6 py-2 font-semibold text-slate-700 transition-all duration-300 hover:border-indigo-400 hover:text-indigo-700">← ${loc==='zh-TW'?'上一頁':'Previous'}</button><span id="page-indicator" class="text-sm font-semibold text-slate-600"></span><button id="next-btn" type="button" class="rounded-full border border-slate-300 bg-white px-6 py-2 font-semibold text-slate-700 transition-all duration-300 hover:border-indigo-400 hover:text-indigo-700">${loc==='zh-TW'?'下一頁':'Next'} →</button></nav></section>
    </main>
    <script>
      const section=document.querySelector('section[data-base-path]'),perPage=Number(section?.getAttribute('data-per-page')??'20'),ip=Number(section?.getAttribute('data-initial-page')??'1');let sc='',cp=Number.isFinite(ip)&&ip>0?ip:1;
      const gcu=()=>new URLSearchParams(window.location.search).get('category')??'';
      const gpf=()=>{const m=window.location.pathname.match(/\\/page\\/(\\d+)\\/?$/);if(!m)return cp;const n=Number.parseInt(m[1],10);return Number.isFinite(n)&&n>0?n:1;};
      const sacb=c=>{document.querySelectorAll('.category-btn').forEach(b=>{const x=b.getAttribute('data-category')??'',a=x===c;b.classList.toggle('border-indigo-600',a);b.classList.toggle('bg-indigo-600',a);b.classList.toggle('text-white',a);b.classList.toggle('border-slate-300',!a);b.classList.toggle('bg-white',!a);b.classList.toggle('text-slate-700',!a);});};
      const render=()=>{const s=Array.from(document.querySelectorAll('[data-story]')),f=sc?s.filter(n=>n.getAttribute('data-category')===sc):s,tp=Math.max(1,Math.ceil(f.length/perPage));cp=Math.max(1,Math.min(cp,tp));const st=(cp-1)*perPage,v=new Set(f.slice(st,st+perPage));s.forEach(n=>{n.style.display=v.has(n)?'':'none';});const e=document.getElementById('stories-empty');if(e)e.style.display=f.length===0?'':'none';const nav=document.getElementById('pagination-nav'),ind=document.getElementById('page-indicator'),pb=document.getElementById('prev-btn'),nb=document.getElementById('next-btn');if(ind)ind.textContent=cp+' / '+tp;if(pb)pb.style.visibility=cp<=1?'hidden':'visible';if(nb)nb.style.visibility=cp>=tp?'hidden':'visible';if(nav){nav.classList.toggle('hidden',tp<=1);nav.classList.toggle('flex',tp>1);}};
      const pcu=()=>{const bp=section?.getAttribute('data-base-path')??'',p=new URLSearchParams();if(sc)p.set('category',sc);const q=p.toString(),pt=cp>1?bp+'/page/'+cp:bp;history.pushState({},'',pt+(q?'?'+q:''));};
      sc=gcu();cp=gpf();sacb(sc);render();
      document.querySelectorAll('.category-btn').forEach(l=>{l.addEventListener('click',e=>{e.preventDefault();sc=l.getAttribute('data-category')??'';cp=1;sacb(sc);pcu();render();window.scrollTo({top:0,behavior:'smooth'});});});
      document.getElementById('prev-btn')?.addEventListener('click',()=>{cp=Math.max(1,cp-1);pcu();render();window.scrollTo({top:0,behavior:'smooth'});});
      document.getElementById('next-btn')?.addEventListener('click',()=>{cp+=1;pcu();render();window.scrollTo({top:0,behavior:'smooth'});});
      window.addEventListener('popstate',()=>{sc=gcu();cp=gpf();sacb(sc);render();});
    </script>
  </body>
</html>`;
}

async function main() {
  const dd = JSON.parse(await fs.readFile(digestPath,'utf8'));
  for (const loc of ['en','zh-TW']) {
    const entries = await load(loc);
    const html = build(loc, entries, dd);
    const dir = loc==='zh-TW'?'dist/zh-tw':'dist/en';
    await fs.mkdir(dir,{recursive:true});
    await fs.writeFile(path.join(dir,'index.html'),html);
    console.log(`${dir}/index.html: ${entries.length} entries, digest=${dd.generatedAt?.slice(0,10)}`);
  }
}
main();
