/** Browser regression test using the real client components, isolated from user saves.
 * NODE_PATH is not needed; pass --deps /absolute/path/to/node_modules if necessary.
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import assert from 'node:assert/strict'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const arg = process.argv.indexOf('--deps')
const deps = arg < 0 ? resolve(root, 'node_modules') : resolve(process.argv[arg + 1])
const require = createRequire(join(deps, '__hover_test.cjs'))
const { chromium } = require(join(deps, 'playwright'))
// Bundle installed CJS React without adding a dependency to the plugin.
const modules = [], ids = new Map()
function add(file) {
  if (ids.has(file)) return ids.get(file)
  const id = modules.length
  ids.set(file, id); modules.push('')
  const req = createRequire(file)
  const code = readFileSync(file, 'utf8').replace(/require\(['"]([^'"]+)['"]\)/g, (_, name) => `load(${add(req.resolve(name))})`)
  modules[id] = `${id}:function(module,exports,load){${code}\n}`
  return id
}
const reactId = add(require.resolve(join(deps, 'react'))), domId = add(require.resolve(join(deps, 'react-dom/client')))
const source = readFileSync(join(root, 'client.js'), 'utf8').replace('return { inject, apply }',
  'return { inject, apply, test: { HoverStage, PetOverlay, DashboardCard, FramePet, HOVER_SPECIES, HOVER_STAGES, CSS } }')
const boot = `window.process={env:{NODE_ENV:'production'}};(()=>{const modules={${modules.join(',')}};const cache={};function load(id){if(cache[id])return cache[id].exports;const m=cache[id]={exports:{}};modules[id](m,m.exports,load);return m.exports}window.React=load(${reactId});window.ReactDOM=load(${domId})})();
window.__ModuleLoader__={load({factory}){window.petClient=factory(()=>React)}};\n${source}\n`
const fixture = `
const {createElement:h}=React, t=petClient.test;
const style=document.createElement('style');style.textContent=t.CSS;document.head.append(style);
const species=Object.keys(t.HOVER_SPECIES).map(id=>({id,speciesZh:id,nameZh:id,price:0}));
let snap={hasPet:true,pet:{speciesId:'dinosaur',nickname:'测试恐龙',stage:'elder',ageMs:0,pendingWaste:1,needs:{},stats:{},status:'awake',availableActions:[]},settings:{visible:true,size:100,position:{x:1080,y:600}},species,wallet:{balance:0},assetsBase:'/assets',assetsVersion:'test'};
window.fetch=async()=>({ok:true,json:async()=>snap});
const app=ReactDOM.createRoot(document.getElementById('app'));
window.renderCase=(patch={})=>{snap={...snap,pet:{...snap.pet,...patch}};app.render(h(React.Fragment,null,
 h('div',{className:'actual-hero'},h(t.DashboardCard,{snap,refresh:()=>{}})),h(t.PetOverlay),
 h('section',{className:'gallery'},...Object.keys(t.HOVER_SPECIES).flatMap(id=>t.HOVER_STAGES.map(stage=>
 h('article',{key:id+stage},h(t.HoverStage,{snap:{pet:{speciesId:id,stage}},className:'sample','data-testid':id+'-'+stage,style:{width:100,height:110}},
 h(t.FramePet,{snap:{pet:{speciesId:id,stage}},size:90,'data-mood':'awake',src:'/assets/sprites/'+id+'/'+stage+'.png',alt:id,draggable:false})),h('p',null,id+' · '+stage),h('small',null,'逐帧眨眼与肢体动作')))))));};renderCase();`
const html = `<!doctype html><meta charset="utf-8"><style>body{font:12px system-ui;margin:24px;background:#f4f6fb}.actual-hero{width:800px}.gallery{display:grid;grid-template-columns:repeat(6,140px);gap:16px;margin-top:30px}article{padding:12px;background:white;border-radius:16px;text-align:center}.sample{display:flex;align-items:flex-end;justify-content:center;margin:auto}small{color:#667085}p{margin:12px 0 4px}</style><div id="app"></div><script>${boot.replaceAll('</script','<\\/script')}</script><script>${fixture}</script>`
const server=createServer((req,res)=>{
 if(req.url==='/'){res.setHeader('Content-Type','text/html');res.end(html);return}
 const assetPath=req.url.split('?')[0].replace('/dsh-digital-pet/api/assets/','/assets/');
 if(assetPath.startsWith('/assets/')){try{const file=resolve(root,'.'+decodeURIComponent(assetPath));assert(file.startsWith(join(root,'assets')+'/'));res.setHeader('Content-Type','image/png');res.end(readFileSync(file));return}catch{}}
 res.statusCode=404;res.end()
})
await new Promise(r=>server.listen(0,'127.0.0.1',r))
const out=join(root,'docs/hover-frames');mkdirSync(out,{recursive:true})
let browser
const checks=[]
function chromePath() {
 if(process.env.CHROME_BIN) return process.env.CHROME_BIN
 if(existsSync(chromium.executablePath())) return chromium.executablePath()
 const cache=join(homedir(),'Library/Caches/ms-playwright')
 if(existsSync(cache)) for(const version of readdirSync(cache).filter(n=>n.startsWith('chromium_headless_shell-')).sort().reverse()) {
  const bin=join(cache,version,'chrome-headless-shell-mac-arm64/chrome-headless-shell')
  if(existsSync(bin)) return bin
 }
 throw new Error('Chromium not found; set CHROME_BIN to a local headless browser executable')
}
try{
 browser=await chromium.launch({headless:true,executablePath:chromePath()})
 const page=await browser.newPage({viewport:{width:1280,height:850}})
 const errors=[];page.on('pageerror',e=>errors.push(e.message))
 await page.goto(`http://127.0.0.1:${server.address().port}`)
 await page.waitForFunction(()=>document.querySelectorAll('[data-testid] [data-atlas-ready="true"]').length===54)
 const info=selector=>page.locator(selector).evaluate(el=>({hover:el.dataset.hovering,frame:el.querySelector('[data-frame]')?.dataset.frame,ready:el.querySelector('[data-atlas-ready]')?.dataset.atlasReady,background:el.querySelector('.dsh-digital-pet-frame-surface')?.style.backgroundPosition,animations:el.getAnimations({subtree:true}).map(a=>a.animationName)}))
 const still=async selector=>{await page.waitForFunction(selector=>{const el=document.querySelector(selector);return !el?.querySelector('[data-frame]')||el.querySelector('[data-frame]').dataset.frame==='0'},selector);const state=await info(selector);assert.equal(state.animations.length,0,JSON.stringify(state));return state}
 const moving=async selector=>{await page.locator(selector).hover();await page.waitForFunction(selector=>Number(document.querySelector(selector).querySelector('[data-frame]')?.dataset.frame)>0,selector);const state=await info(selector);assert.equal(state.ready,'true');assert(!state.animations.some(n=>n.startsWith('dsh-pet-hover-')));return state}
 for(const id of ['whale','monkey','duck','chick','cat','dog','cow','goat','dinosaur'])for(const stage of ['baby','toddler','child','teen','adult','elder']){
  const selector='[data-testid="'+id+'-'+stage+'"]';await page.mouse.move(1250,5);await still(selector);await moving(selector);await page.mouse.move(1250,5);await still(selector)
 }
 checks.push('54 installed atlases: loaded, real frame selection on hover, reset to first frame on leave; no old transform animations')
 const hero='.actual-hero .dsh-digital-pet-hover-stage',overlay='.dsh-digital-pet-float .dsh-digital-pet-hover-stage'
 for(const selector of [hero,overlay]){
  await moving(selector);await page.mouse.down();await still(selector);await page.mouse.up()
  await page.mouse.move(1250,5);await moving(selector);await page.locator(selector).dispatchEvent('pointercancel',{pointerType:'mouse'});await still(selector)
  await page.mouse.move(1250,5);await moving(selector);await page.locator(selector).dispatchEvent('contextmenu');await still(selector)
  await page.mouse.move(1250,5);await moving(selector);await page.evaluate(()=>window.dispatchEvent(new Event('blur')));await still(selector)
 }
 checks.push('Real overlay and dashboard: pointer press/cancel, context menu and blur cancel playback')
 // Actual drag keeps the stationary hit area and releases without a phantom hover outside the pet.
 await page.mouse.move(1250,5);await moving(overlay);await page.mouse.down();await page.mouse.move(900,480,{steps:5});await page.mouse.up();await page.mouse.move(1250,5);await still(overlay)
 checks.push('Real pointer capture drag/release works and leaves neutral frame')
 await page.evaluate(()=>renderCase({stage:{key:'child'}}));await page.waitForTimeout(40);await page.mouse.move(1250,5);await moving(hero)
 assert((await page.locator(hero+' .dsh-digital-pet-frame-surface').getAttribute('style')).includes('/dinosaur/child.png'))
 await page.emulateMedia({reducedMotion:'reduce'});await still(hero);await page.waitForTimeout(140);await still(hero)
 await page.emulateMedia({reducedMotion:'no-preference'});await page.mouse.move(1250,5);await moving(hero)
 checks.push('Object-shaped host stages and live reduced-motion changes work')
 for(const type of ['feed','bathe','walk','cleanWaste','groom','water']){
  await page.evaluate(type=>renderCase({activeAction:{type,endsAtMs:Date.now()+60000}}),type);await page.waitForTimeout(40)
  assert.equal(await page.locator(hero+' .dsh-digital-pet-frame-pet').count(),0)
  await page.mouse.move(1250,5);await still(hero);await page.locator(hero).hover();await page.waitForTimeout(30)
  assert((await info(hero)).animations.some(n=>n.startsWith('dsh-digital-pet-act-')))
  await page.mouse.move(1250,5);await still(hero)
 }
 checks.push('All six existing care poses take priority and remain hover-only')
 await page.evaluate(()=>renderCase({activeAction:null,sleeping:true}));await page.waitForTimeout(40);await page.mouse.move(1250,5);await still(hero)
 assert.equal(await page.locator(hero+' .dsh-digital-pet-zzz').count(),1)
 await page.locator(hero).dispatchEvent('pointerenter',{pointerType:'touch',buttons:0});await still(hero)
 checks.push('Sleep marker retained; touch does not latch animation')
 // Missing atlas must leave an interactive static pet rather than disappearing.
 await page.route('**/hover-v1/atlases/cat/baby.png*',r=>r.fulfill({status:404,body:''}))
 await page.evaluate(()=>renderCase({speciesId:'cat',stage:'baby',sleeping:false}));await page.waitForTimeout(150)
 assert.equal((await info(hero)).ready,'false');assert(await page.locator(hero+' img').evaluate(img=>img.complete&&img.naturalWidth>0&&getComputedStyle(img).visibility==='visible'))
 await page.mouse.move(1250,5);await page.locator(hero).hover();await page.waitForTimeout(100);await still(hero)
 checks.push('404 atlas falls back to visible static poster without a frame loop')
 await page.unroute('**/hover-v1/atlases/cat/baby.png*')
 await page.evaluate(()=>renderCase({speciesId:'dinosaur',stage:'elder'}));await page.waitForTimeout(80);await page.mouse.move(1250,5)
 await page.screenshot({path:join(out,'installed-gallery.png'),fullPage:true})
 assert.deepEqual(errors,[])
 writeFileSync(join(out,'verification.json'),JSON.stringify({passed:true,profiles:54,checks,browserErrors:errors},null,2))
 console.log(JSON.stringify({passed:true,profiles:54,checks,out},null,2))
}finally{await browser?.close();server.close()}
