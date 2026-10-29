#!/usr/bin/env node
// 照护动作动效证据采集器。
//
// 用 Playwright 缓存的 chrome-headless-shell + 原生 CDP 驱动一个真实的 dsh 实例：
//   1. 打开实例 → 设置 → 电子宠物；
//   2. 通过 HTTP 接口把宠物重置成全新状态（送养 + 领养），保证每次采集可复现；
//   3. 依次触发喂食/洗澡/逛街（以及有便便时的铲屎）动作，暂停动画时间轴后按帧截图；
//   4. 断言动画实现（animationName / 小道具节点 / 覆盖层与设置页两处）并输出 JSON；
//   5. 用 Emulation.setEmulatedMedia 模拟 prefers-reduced-motion 验证静音。
//
// 用法：
//   node tools/action-fx/capture.mjs http://127.0.0.1:PORT/?token=…
//   node tools/action-fx/capture.mjs http://… --out .tmp/action-fx --skip-frames
//
// 只依赖 Node（>=22，内置 WebSocket）与本机 Playwright 的 chromium headless shell。
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import http from 'node:http'

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = resolve(here, '..', '..')

const CYCLE_MS = { feed: 1800, bathe: 1500, walk: 2800, cleanWaste: 1100, groom: 1800, water: 1600 }
const FRAME_COUNT = 8

// ---------------------------------------------------------------------------
// 极简 CDP 客户端
// ---------------------------------------------------------------------------
function httpGetJson(url) {
  return new Promise((resolvePromise, reject) => {
    http.get(url, (res) => {
      let data = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () => {
        try { resolvePromise(JSON.parse(data)) } catch (err) { reject(err) }
      })
    }).on('error', reject)
  })
}

class Cdp {
  constructor(ws) {
    this.ws = ws
    this.nextId = 1
    this.pending = new Map()
    this.events = new Map()
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data)
      if (msg.id !== undefined) {
        const slot = this.pending.get(msg.id)
        if (slot === undefined) return
        this.pending.delete(msg.id)
        if (msg.error) slot.reject(new Error(`${slot.method}: ${msg.error.message}`))
        else slot.resolve(msg.result)
        return
      }
      const waiters = this.events.get(msg.method)
      if (waiters === undefined) return
      this.events.delete(msg.method)
      for (const waiter of waiters) waiter(msg.params)
    })
  }

  send(method, params = {}) {
    const id = this.nextId++
    this.ws.send(JSON.stringify({ id, method, params }))
    return new Promise((resolvePromise, reject) => this.pending.set(id, { resolve: resolvePromise, reject, method }))
  }

  once(method, timeoutMs = 15000) {
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => reject(new Error(`CDP 事件超时：${method}`)), timeoutMs)
      const waiter = (params) => { clearTimeout(timer); resolvePromise(params) }
      const list = this.events.get(method) ?? []
      list.push(waiter)
      this.events.set(method, list)
    })
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true })
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text
      throw new Error(`页面脚本异常：${detail}`)
    }
    return result.result?.value
  }

  async screenshot(clip) {
    const result = await this.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false,
      ...(clip === undefined ? {} : { clip: { ...clip, scale: clip.scale ?? 1 } }),
    })
    return Buffer.from(result.data, 'base64')
  }

  close() { try { this.ws.close() } catch {} }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

function findChrome() {
  if (process.env.CHROME_BIN !== undefined && existsSync(process.env.CHROME_BIN)) return process.env.CHROME_BIN
  const cache = join(process.env.HOME, 'Library/Caches/ms-playwright')
  const candidates = readdirSync(cache)
    .filter((name) => name.startsWith('chromium_headless_shell-'))
    .sort()
    .reverse()
  for (const name of candidates) {
    const bin = join(cache, name, 'chrome-headless-shell-mac-arm64', 'chrome-headless-shell')
    if (existsSync(bin)) return bin
  }
  throw new Error('找不到 Playwright 的 chrome-headless-shell，可用 CHROME_BIN 指定')
}

async function launchChrome() {
  const bin = findChrome()
  const profile = join('/tmp', `dsh-action-fx-chrome-${process.pid}`)
  try { rmSync(profile, { recursive: true, force: true }) } catch {}
  const child = spawn(bin, [
    '--headless',
    // DSH 自己的文件沙箱会拦住 Chrome 的子进程沙箱，headless 采集固定关闭它
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    '--window-size=1280,800',
    '--hide-scrollbars',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] })

  const wsBrowser = await new Promise((resolvePromise, reject) => {
    let buffer = ''
    const timer = setTimeout(() => reject(new Error('等待 DevTools 端点超时')), 20000)
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      buffer += chunk
      const hit = buffer.match(/DevTools listening on (ws:\/\/\S+)/)
      if (hit !== null) { clearTimeout(timer); resolvePromise(hit[1]) }
    })
    child.on('exit', (code) => reject(new Error(`chrome 退出：${code}`)))
  })
  return { child, wsBrowser, profile }
}

// ---------------------------------------------------------------------------
// 页面侧脚本（作为字符串注入，避免额外构建）
// ---------------------------------------------------------------------------
const PAGE_HELPERS = String.raw`
window.__fx = {
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  visible: (el) => el !== null && el.isConnected && el.getBoundingClientRect().width > 0,
  buttons: () => [...document.querySelectorAll('button')].filter((el) => window.__fx.visible(el)),
  text: (el) => (el.innerText || '').trim(),
  matches(el, labels) {
    const text = window.__fx.text(el)
    return labels.some((label) => text === label || text.startsWith(label + '\n') || text.startsWith(label + ' ') || text.startsWith(label + '（'))
  },
  findButton(labels, last) {
    const list = window.__fx.buttons().filter((el) => window.__fx.matches(el, labels))
    if (list.length === 0) return null
    return last === true ? list[list.length - 1] : list[0]
  },
  clickText(text, selector = 'button') {
    const nodes = [...document.querySelectorAll(selector)].filter((el) => window.__fx.visible(el) && (el.innerText || '').trim().includes(text) && el.disabled !== true)
    if (nodes.length === 0) return false
    nodes[nodes.length - 1].click()
    return true
  },
  hasPetSection() { return document.querySelector('.dsh-digital-pet-settings') !== null },
  heroStage() { return document.querySelector('.dsh-digital-pet-hero-stage') },
  overlayStage() { return document.querySelector('.dsh-digital-pet-float .dsh-digital-pet-act-stage') },
  adoptCard() { return document.querySelector('.dsh-digital-pet-input') },
  async dismissModals() {
    // 预览版说明/新手引导：中英文界面都要能关掉
    for (let i = 0; i < 3; i += 1) {
      const ok = window.__fx.findButton(['继续', 'Continue', '知道了', 'Got it'])
      if (ok === null) return
      ok.click()
      await window.__fx.sleep(250)
    }
  },
  async api(path, body) {
    const res = await fetch('/dsh-digital-pet/api' + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    let data = null
    try { data = await res.json() } catch {}
    return { status: res.status, data }
  },
  async resetPet() {
    await window.__fx.api('/surrender', { confirm: true })
    const adopted = await window.__fx.api('/adopt', { speciesId: 'whale', nickname: '泡泡' })
    return adopted.status
  },
  async remountPetSection() {
    // 切到别的设置分区再回来，强制重新拉一次快照（中英文导航都兼容）
    const general = window.__fx.findButton(['通用设置', 'General'])
    if (general !== null) { general.click(); await window.__fx.sleep(150) }
    const pet = window.__fx.findButton(['电子宠物', 'Pet'])
    if (pet !== null) { pet.click() }
    for (let i = 0; i < 120; i += 1) {
      if (window.__fx.heroStage() !== null || window.__fx.adoptCard() !== null) return true
      await window.__fx.sleep(100)
    }
    return false
  },
  async openPetSettings() {
    await window.__fx.dismissModals()
    if (window.__fx.heroStage() !== null) return true
    if (window.__fx.hasPetSection()) return true
    // 侧边栏最底部的「更多 / More」→ 菜单里的「设置 / Settings」（菜单项是普通 button）
    for (let i = 0; i < 40; i += 1) {
      const more = window.__fx.findButton(['更多', 'More'], true)
      if (more !== null) { more.click(); break }
      await window.__fx.sleep(150)
    }
    for (let i = 0; i < 40; i += 1) {
      const settings = window.__fx.findButton(['设置', 'Settings'])
      if (settings !== null) { settings.click(); break }
      await window.__fx.sleep(150)
    }
    // 设置导航里的插件分区（插件自带中文 label「电子宠物」，英文界面也一样）
    for (let i = 0; i < 60; i += 1) {
      const nav = window.__fx.findButton(['电子宠物', 'Pet'])
      if (nav !== null) { nav.click(); break }
      await window.__fx.sleep(150)
    }
    for (let i = 0; i < 90; i += 1) {
      await window.__fx.dismissModals()
      if (window.__fx.hasPetSection()) return true
      await window.__fx.sleep(100)
    }
    return false
  },
  async ensurePet() {
    if (window.__fx.heroStage() !== null) return 'already'
    if (window.__fx.adoptCard() !== null) {
      const status = await window.__fx.resetPet()
      return status === 200 ? 'adopted' : 'adopt-failed:' + status
    }
    return 'no-adopt-card'
  },
  async care(action) {
    const res = await window.__fx.api('/care', { action })
    return { status: res.status, error: res.data?.error ?? null, message: res.data?.message ?? null }
  },
  pauseAnimations() {
    for (const anim of document.getAnimations()) {
      try { anim.pause() } catch {}
    }
  },
  playAnimations() {
    for (const anim of document.getAnimations()) {
      try { anim.play() } catch {}
    }
  },
  seekAnimations(ms) {
    for (const anim of document.getAnimations()) {
      try { anim.currentTime = ms } catch {}
    }
  },
  stageInfo(selector) {
    const el = document.querySelector(selector)
    if (el === null) return null
    const rect = el.getBoundingClientRect()
    const img = el.querySelector('img')
    const over = el.querySelector('.dsh-digital-pet-fx-over')
    const under = el.querySelector('.dsh-digital-pet-fx-under')
    const style = img === null ? null : getComputedStyle(img)
    return {
      action: el.getAttribute('data-action'),
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      imgAction: img === null ? null : img.getAttribute('data-action'),
      imgMood: img === null ? null : img.getAttribute('data-mood'),
      animationName: style === null ? null : style.animationName,
      animationDuration: style === null ? null : style.animationDuration,
      under: under === null ? [] : [...under.children].map((child) => child.className),
      over: over === null ? [] : [...over.children].map((child) => child.className),
      fxVisible: over === null ? null : getComputedStyle(over).display,
    }
  },
  async waitAction(selector, action, timeoutMs) {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      const info = window.__fx.stageInfo(selector)
      if (info !== null && info.action === action) return info
      await window.__fx.sleep(80)
    }
    return null
  },
  async waitActionEnd(selector, timeoutMs) {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      const info = window.__fx.stageInfo(selector)
      if (info === null || info.action === null) return true
      await window.__fx.sleep(150)
    }
    return false
  },
}
`

// ---------------------------------------------------------------------------
// 采集主流程
// ---------------------------------------------------------------------------
async function main() {
  const url = process.argv[2]
  if (url === undefined || !/^https?:\/\//.test(url)) {
    console.error('用法：node tools/action-fx/capture.mjs <dsh-web-url> [--out <dir>] [--skip-frames]')
    process.exit(2)
  }
  const outArg = process.argv.indexOf('--out')
  const outDir = resolve(outArg > 0 ? process.argv[outArg + 1] : join(pluginRoot, '.tmp', 'action-fx'))
  const skipFrames = process.argv.includes('--skip-frames')
  const framesDir = join(outDir, 'frames')
  const fullDir = join(outDir, 'full')
  mkdirSync(framesDir, { recursive: true })
  mkdirSync(fullDir, { recursive: true })

  const { child, wsBrowser, profile } = await launchChrome()
  const report = { url, startedAt: new Date().toISOString(), actions: {}, reducedMotion: null, errors: [] }
  let ws = null
  try {
    // 浏览器级端点只用来建页面 target，页面交互走页面级 WebSocket。
    const browserWs = new WebSocket(wsBrowser)
    await new Promise((r, j) => { browserWs.addEventListener('open', r, { once: true }); browserWs.addEventListener('error', j, { once: true }) })
    const browserCdp = new Cdp(browserWs)
    const { targetId } = await browserCdp.send('Target.createTarget', { url: 'about:blank' })
    browserCdp.close()
    await sleep(150)
    const port = new URL(wsBrowser).port
    const targets = await httpGetJson(`http://127.0.0.1:${port}/json/list`)
    const pageTarget = targets.find((item) => item.id === targetId) ?? targets.find((item) => item.type === 'page')
    if (pageTarget === undefined) throw new Error('找不到页面 target')
    ws = new WebSocket(pageTarget.webSocketDebuggerUrl)
    await new Promise((r, j) => { ws.addEventListener('open', r, { once: true }); ws.addEventListener('error', j, { once: true }) })
    const cdp = new Cdp(ws)
    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false })
    const loaded = cdp.once('Page.loadEventFired')
    await cdp.send('Page.navigate', { url })
    await loaded
    await cdp.evaluate(PAGE_HELPERS)

    // 1. 打开「设置 → 电子宠物」，必要时领养一只
    // 等应用外壳挂载完成（SPA 首屏按钮渲染完毕）再操作
    for (let i = 0; i < 100; i += 1) {
      const ready = await cdp.evaluate('window.__fx.buttons().length >= 5')
      if (ready === true) break
      await sleep(150)
    }
    const opened = await cdp.evaluate('window.__fx.openPetSettings()')
    if (opened !== true) {
      const dump = await cdp.evaluate(`({ url: location.href, text: document.body.innerText.slice(0, 1200), buttons: window.__fx.buttons().map((el) => (el.innerText || '').trim().slice(0, 24)), settingsRoot: !!document.querySelector('.dsh-digital-pet-settings'), menuOpen: [...document.querySelectorAll('button')].some((el) => (el.innerText || '').trim().startsWith('设置')) })`)
      writeFileSync(join(outDir, 'debug-nav.json'), `${JSON.stringify(dump, null, 2)}\n`)
      writeFileSync(join(outDir, 'debug-nav.png'), await cdp.screenshot())
      throw new Error(`未能打开电子宠物设置页：${JSON.stringify(dump.buttons)}`)
    }
    await sleep(400)
    const ensured = await cdp.evaluate('window.__fx.ensurePet()')
    report.petSetup = ensured
    await sleep(300)

    // 2. 送养重领一次，确保是全新宠物（首次领养会赠礼口粮），之后动作之间靠等结束衔接，
    //    不再频繁送养——送养会清空背包，之前因此把口粮耗光导致喂食被拒。
    const resetStatus = await cdp.evaluate('window.__fx.resetPet()')
    await sleep(400)
    await cdp.evaluate('window.__fx.remountPetSection()')
    const stateResult = await cdp.evaluate('window.__fx.api("/state")')
    const inventory = stateResult?.data?.inventory ?? {}
    report.petSetup = { ensure: ensured, resetStatus, inventory }
    const hasFood = (inventory.basic ?? 0) >= 2

    const clipFor = (rect) => ({
      x: Math.max(0, rect.x - 26),
      y: Math.max(0, rect.y - 34),
      width: rect.width + 52,
      height: rect.height + 68,
      scale: 2,
    })
    const captureFrames = async (action, info) => {
      const clip = clipFor(info.rect)
      await cdp.evaluate('window.__fx.pauseAnimations()')
      await sleep(120)
      const cycle = CYCLE_MS[action] ?? 1800
      for (let i = 0; i < FRAME_COUNT; i += 1) {
        await cdp.evaluate(`window.__fx.seekAnimations(${Math.round((cycle * i) / FRAME_COUNT)})`)
        await sleep(60)
        writeFileSync(join(framesDir, `${action}-${String(i).padStart(2, '0')}.png`), await cdp.screenshot(clip))
      }
      await cdp.evaluate(`window.__fx.seekAnimations(${Math.round(cycle / 4)})`)
      await sleep(60)
      writeFileSync(join(fullDir, `${action}.png`), await cdp.screenshot())
      return {
        frameCount: FRAME_COUNT,
        frameSize: { width: Math.round(clip.width * clip.scale), height: Math.round(clip.height * clip.scale) },
        cycleMs: cycle,
      }
    }
    const runAction = async (action, options = {}) => {
      const entry = { action }
      try {
        const care = await cdp.evaluate(`window.__fx.care(${JSON.stringify(action)})`)
        entry.careStatus = care.status
        if (care.status !== 200) throw new Error(`动作被拒绝：${care.status} ${care.error ?? ''} ${care.message ?? ''}`)
        // 设置页快照轮询 6s，喂食只有 5s；动作触发后立刻重挂分区拉新快照，保证一定看到
        await cdp.evaluate('window.__fx.remountPetSection()')
        const info = await cdp.evaluate(`window.__fx.waitAction('.dsh-digital-pet-hero-stage', ${JSON.stringify(action)}, 15000)`)
        if (info === null) throw new Error('动作画面未出现（快照轮询未刷新）')
        entry.hero = info
        if (options.overlay !== false) {
          entry.overlay = await cdp.evaluate(`window.__fx.waitAction('.dsh-digital-pet-float .dsh-digital-pet-act-stage', ${JSON.stringify(action)}, 12000)`)
        }
        if (options.frames !== false) Object.assign(entry, await captureFrames(action, info))
        if (options.waitEnd !== false) {
          entry.ended = await cdp.evaluate(`window.__fx.waitActionEnd('.dsh-digital-pet-hero-stage', ${options.endTimeout ?? 20000})`)
        }
      } catch (err) {
        entry.error = err.message
        report.errors.push(`${action}: ${err.message}`)
      }
      report.actions[action] = entry
      return entry
    }

    // 3. 喂食 → 洗澡
    if (hasFood) await runAction('feed', { overlay: false })
    else report.errors.push('feed: 背包无口粮，跳过喂食采集')
    await runAction('bathe')

    // 5. 逛街放最后：动作 60s，顺手做「减弱动态效果」验证与悬浮层特写
    await runAction('walk', { waitEnd: false })
    try {
      // 5.1 模拟系统「减弱动态效果」：动作姿态仍在，但动画关闭、小道具隐藏
      await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
      await sleep(220)
      const reducedHero = await cdp.evaluate(`window.__fx.stageInfo('.dsh-digital-pet-hero-stage')`)
      const reducedOverlay = await cdp.evaluate(`window.__fx.stageInfo('.dsh-digital-pet-float .dsh-digital-pet-act-stage')`)
      report.reducedMotion = { hero: reducedHero, overlay: reducedOverlay }
      writeFileSync(join(fullDir, 'reduced-motion.png'), await cdp.screenshot())
      await cdp.send('Emulation.setEmulatedMedia', { features: [] })
      await sleep(220)
      report.reducedMotionRestored = await cdp.evaluate(`window.__fx.stageInfo('.dsh-digital-pet-hero-stage')`)

      // 5.2 悬浮层特写
      const overlayAction = await cdp.evaluate(`window.__fx.waitAction('.dsh-digital-pet-float .dsh-digital-pet-act-stage', 'walk', 20000)`)
      if (overlayAction !== null) {
        await cdp.evaluate('window.__fx.playAnimations()')
        await sleep(200)
        const rect = overlayAction.rect
        writeFileSync(join(fullDir, 'walk-overlay.png'), await cdp.screenshot({
          x: Math.max(0, rect.x - 44),
          y: Math.max(0, rect.y - 64),
          width: rect.width + 88,
          height: rect.height + 116,
          scale: 2,
        }))
        report.walkOverlayShot = true
      }
    } catch (err) {
      report.errors.push(`walk-overlay: ${err.message}`)
    }

  } finally {
    if (ws !== null) { try { ws.close() } catch {} }
    child.kill('SIGKILL')
    await new Promise((done) => {
      if (child.exitCode !== null) { done(); return }
      child.once('exit', done)
      setTimeout(done, 3000)
    })
    try { rmSync(profile, { recursive: true, force: true }) } catch {}
    writeFileSync(join(outDir, 'verify.json'), `${JSON.stringify(report, null, 2)}\n`)
  }

  // 4. 汇总断言
  const checks = []
  for (const action of ['feed', 'bathe', 'walk']) {
    const entry = report.actions[action] ?? {}
    checks.push({ name: `${action} / 设置页动画名`, ok: entry.hero?.animationName === `dsh-digital-pet-act-${action === 'feed' ? 'eat' : action}` , actual: entry.hero?.animationName })
    checks.push({
      name: `${action} / 悬浮层动画名`,
      ok: entry.overlay == null || entry.overlay?.animationName === `dsh-digital-pet-act-${action === 'feed' ? 'eat' : action}`,
      actual: entry.overlay == null ? '未捕获（动作短于悬浮层 8s 轮询）' : entry.overlay.animationName,
    })
    checks.push({ name: `${action} / 小道具节点`, ok: (entry.hero?.under?.length ?? 0) + (entry.hero?.over?.length ?? 0) > 0, actual: [...(entry.hero?.under ?? []), ...(entry.hero?.over ?? [])] })
    checks.push({ name: `${action} / 动作帧`, ok: skipFrames || (entry.frameCount === FRAME_COUNT), actual: entry.frameCount })
  }
  checks.push({ name: 'reduced-motion / 动画关闭', ok: report.reducedMotion?.hero?.animationName === 'none', actual: report.reducedMotion?.hero?.animationName })
  checks.push({ name: 'reduced-motion / 小道具隐藏', ok: report.reducedMotion?.hero?.fxVisible === 'none', actual: report.reducedMotion?.hero?.fxVisible })
  checks.push({ name: 'reduced-motion / 悬浮层同步', ok: report.reducedMotion?.overlay == null || report.reducedMotion?.overlay?.animationName === 'none', actual: report.reducedMotion?.overlay?.animationName ?? '未捕获（悬浮层未轮询到）' })
  checks.push({ name: 'reduced-motion / 恢复后动画回来', ok: report.reducedMotionRestored?.animationName === 'dsh-digital-pet-act-walk', actual: report.reducedMotionRestored?.animationName })
  report.checks = checks
  writeFileSync(join(outDir, 'verify.json'), `${JSON.stringify(report, null, 2)}\n`)

  const failed = checks.filter((item) => item.ok !== true)
  console.log(JSON.stringify({ outDir, checks, errors: report.errors }, null, 2))
  if (failed.length > 0) process.exitCode = 1
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
