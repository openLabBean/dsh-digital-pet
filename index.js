/**
 * @local/dsh-digital-pet — Host half.
 *
 * 电子宠物插件的权威服务端：宠物档案、四状态结算、动作调度、金币经济与持久化
 * 全部在这里完成；浏览器半只负责渲染与发命令，不自行决定价格、恢复量或寿终时间。
 *
 * 判定与数值全部委托给与 IO 无关的确定性内核 `src/core/`（纯函数，时间由调用方传入），
 * 这一层只负责：存档、路由、时区/离线判定、session/event → 金币。
 *
 * 对外接口（同源路由，Web 客户端直接 fetch）：
 *   GET  /dsh-digital-pet/api/ping                 健康检查
 *   GET  /dsh-digital-pet/api/state                权威快照
 *   GET  /dsh-digital-pet/api/assets/<rel-path>    精灵图等静态素材
 *   POST /dsh-digital-pet/api/adopt                领养
 *   POST /dsh-digital-pet/api/care                 六项照护操作
 *   POST /dsh-digital-pet/api/pet                  抚摸
 *   POST /dsh-digital-pet/api/buy                  购买食品
 *   POST /dsh-digital-pet/api/claim-relief         领取救济口粮
 *   POST /dsh-digital-pet/api/settings             可见性/大小/位置/免打扰/作息/托管
 *
 * 说明：Desktop renderer 会把同源路径转发给 Host，因此 Client 不需要生成 RPC。
 */
import { createHash, randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, extname, join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as core from './src/core/index.js'

export const name = 'dsh-digital-pet'

/** 只在 Web 载体存在时挂载路由。 */
export const inject = ['webServer']

/** 本插件自己的拟定协议前缀（不是 Harness 官方接口）。 */
export const ROUTE_PREFIX = '/dsh-digital-pet/api'

const PACKAGE_ROOT = fileURLToPath(new URL('.', import.meta.url))
const ASSET_ROOT = join(PACKAGE_ROOT, 'assets')

const MIME = new Map([
  ['.png', 'image/png'],
  ['.webp', 'image/webp'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.svg', 'image/svg+xml'],
  ['.json', 'application/json; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
])

const STORE_VERSION = 2

/**
 * 素材版本号（缓存破坏用）：跟着 manifest.json 的统计信息走。
 * 素材带 `cache-control: immutable`，重新导出精灵后版本号变化，客户端 URL 加 ?v= 即可破缓存。
 */
function computeAssetsVersion() {
  try {
    const file = join(ASSET_ROOT, 'manifest.json')
    const stat = statSync(file)
    const manifest = JSON.parse(readFileSync(file, 'utf8'))
    const bytes = Number(manifest?.totals?.bytes ?? 0)
    const files = Number(manifest?.totals?.files ?? 0)
    return createHash('sha1').update(`${stat.size}:${Math.round(stat.mtimeMs)}:${files}:${bytes}`).digest('hex').slice(0, 10)
  } catch {
    return '0'
  }
}

const ASSETS_VERSION = computeAssetsVersion()

/** 金币常数：每 1,000 有效 Token = 1 金币，每自然日封顶 100 金币（§9.1）。 */
export const TOKENS_PER_COIN = 1000000
export const DAILY_COIN_CAP = 100
/** 离线判定阈值：两次请求间隔超过该值，视为一次离线结算（触发保护/自动托管）。 */
export const OFFLINE_GAP_MS = 10 * 60 * 1000

/** 物种目录：九款全部开放领养（含 v1.1 补齐的牛牛/山羊与新增恐龙）。 */
export const SPECIES = [
  { id: 'whale', speciesZh: '鲸鱼', speciesEn: 'Whale', nameZh: '泡泡', nameEn: 'Bubbles', grooming: '皮肤刷洗', extension: false },
  { id: 'monkey', speciesZh: '猴子', speciesEn: 'Monkey', nameZh: '桃桃', nameEn: 'Peaches', grooming: '梳毛', extension: false },
  { id: 'duck', speciesZh: '鸭子', speciesEn: 'Duck', nameZh: '嘎嘎', nameEn: 'Waddles', grooming: '羽毛护理', extension: false },
  { id: 'chick', speciesZh: '小鸡', speciesEn: 'Chick', nameZh: '啾啾', nameEn: 'Chirpy', grooming: '绒羽护理', extension: false },
  { id: 'cat', speciesZh: '猫', speciesEn: 'Cat', nameZh: '糯糯', nameEn: 'Mochi', grooming: '梳毛', extension: false },
  { id: 'dog', speciesZh: '狗', speciesEn: 'Dog', nameZh: '豆豆', nameEn: 'Biscuit', grooming: '梳毛', extension: false },
  { id: 'cow', speciesZh: '牛牛', speciesEn: 'Cow', nameZh: '奶糖', nameEn: 'Toffee', grooming: '梳毛', extension: false },
  { id: 'goat', speciesZh: '山羊', speciesEn: 'Goat', nameZh: '咩咩', nameEn: 'Clover', grooming: '梳理羊毛', extension: false },
  { id: 'dinosaur', speciesZh: '恐龙', speciesEn: 'Dinosaur', nameZh: '迪诺', nameEn: 'Dinosaur', grooming: '鳞片护理', extension: false },
]

/** 食品目录（价格单位：金币；整份口粮可拆成两份半份）。由内核常量派生，保持单一事实源。 */
export const FOODS = Object.values(core.FOOD_CATALOG)
  .filter((food) => food.id !== 'water')
  .map((food) => ({
    id: food.id,
    nameZh: food.name,
    price: food.price,
    halfPrice: food.splittable === true ? food.price / food.unitHalfUnits : null,
    hunger: food.effectsPerWhole.H,
    mood: food.effectsPerWhole.M,
    kind: food.staple === true ? 'meal' : 'snack',
    dailyLimit: food.dailyLimit ?? null,
    free: food.price === 0 && food.id === 'relief',
  }))

/** $DSH_HOME 目录（与 wiki-manager 同约定）。 */
export function dshHomeDir() {
  const home = process.env.DSH_HOME && process.env.DSH_HOME !== '' ? process.env.DSH_HOME : join(homedir(), '.dsh')
  return home
}

/** 旧版全局存档位置：$DSH_HOME/dsh-digital-pet/pet-state.json */
export function legacyDataFile() {
  return join(dshHomeDir(), 'dsh-digital-pet', 'pet-state.json')
}

/**
 * 存档位置：**按 profile 隔离**，落在 `<profileDir>/dsh-digital-pet/pet-state.json`。
 *
 * 设计文档要求「每个本地 profile 一只在养宠物」，因此不能所有 profile 共用一份存档。
 * Host 的 ctx.baseUrl 指向 profile 目录（file:///<profileDir>/），据此定位；
 * 拿不到 profile 目录时退回旧的全局位置。可用环境变量 DSH_PET_DATA_FILE 强制指定（测试用）。
 */
export function profileDir(ctx) {
  const baseUrl = typeof ctx?.baseUrl === 'string' ? ctx.baseUrl : (typeof ctx?.root?.baseUrl === 'string' ? ctx.root.baseUrl : null)
  if (baseUrl === null) return null
  try {
    const url = new URL(baseUrl, 'file:///')
    if (url.protocol === 'file:' && /\/profiles\/[^/]+\/$/u.test(url.pathname)) return fileURLToPath(url)
  } catch {
    /* 非法 baseUrl：当作没有 profile 目录 */
  }
  return null
}

export function profileDataFile(ctx) {
  const override = process.env.DSH_PET_DATA_FILE
  if (typeof override === 'string' && override !== '') return override
  const dir = profileDir(ctx)
  if (dir !== null) return join(dir, 'dsh-digital-pet', 'pet-state.json')
  return legacyDataFile()
}

/**
 * 更名前的旧存档位置（插件曾叫 dsh-pet），只用于一次性迁移：
 * 1) 同一 profile 下的 <profileDir>/dsh-pet/pet-state.json
 * 2) 旧版全局位置 $DSH_HOME/dsh-pet/pet-state.json
 */
export function legacyDataFiles(ctx) {
  const list = []
  const dir = profileDir(ctx)
  if (dir !== null) list.push(join(dir, 'dsh-pet', 'pet-state.json'))
  list.push(join(dshHomeDir(), 'dsh-pet', 'pet-state.json'))
  return list
}

/**
 * 解析最终存档路径，并把旧版全局存档一次性迁移进 profile 目录
 * （只在目标不存在且有旧存档时做，之后不再读旧文件）。
 */
export function resolveDataFile(ctx, config = {}) {
  if (typeof config.dataFile === 'string' && config.dataFile !== '') return config.dataFile
  const file = profileDataFile(ctx)
  try {
    if (!existsSync(file)) {
      const candidates = legacyDataFiles(ctx).concat([legacyDataFile()])
      for (const legacy of candidates) {
        if (legacy === file || !existsSync(legacy)) continue
        mkdirSync(dirname(file), { recursive: true })
        copyFileSync(legacy, file)
        break
      }
    }
  } catch {
    /* 迁移失败不阻塞：后续读写会重新创建空存档 */
  }
  return file
}

/** 兼容旧名字：不带 ctx 时返回全局存档位置。 */
export function defaultDataFile() {
  return legacyDataFile()
}

/** 空存档：没有宠物，但 profile 级状态（首次赠礼、钱包、金币流水）已经存在。 */
export function emptyStore() {
  return {
    version: STORE_VERSION,
    profile: {
      firstGiftGranted: false,
      createdAt: Date.now(),
      /** 记账日使用的固定时区：领养时确定，跨设备/改系统时区不回溯历史。 */
      rewardTimezone: null,
      /** 上次服务端活动时间，用于识别离线区间。 */
      lastSeenAtMs: null,
    },
    wallet: { balance: 0 },
    inventory: {},
    ledger: [],
    usage: {
      dayKey: null,
      eligibleTokens: 0,
      grantedCoins: 0,
      /** 已结算响应键（sessionId:seq），防止重放/重启重复发币。 */
      awardedKeys: [],
    },
    daily: { dayKey: null, snacksUsed: 0, pettingRewards: 0, reliefLastClaimedAtMs: null },
    settings: {
      visible: true,
      size: 72,
      position: { x: null, y: null },
      quiet: false,
      sleepStart: '23:00',
      sleepEnd: '07:00',
      locale: 'zh',
    },
    pet: null,
    memorial: [],
  }
}

/** v1 存档把基础口粮记为 staple，内核目录用 basic；读取时统一迁移。 */
function migrateInventory(raw) {
  const inventory = raw !== null && typeof raw === 'object' ? { ...raw } : {}
  if (inventory.basic === undefined && Number.isFinite(inventory.staple)) {
    inventory.basic = Math.max(0, Math.floor(inventory.staple))
  }
  delete inventory.staple
  return inventory
}

function toCount(value, fallback = 0) {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback
}

function sanitize(raw) {
  const base = emptyStore()
  if (raw === null || typeof raw !== 'object') return base
  const settings = raw.settings !== null && typeof raw.settings === 'object' ? raw.settings : {}
  const daily = raw.daily !== null && typeof raw.daily === 'object' ? raw.daily : {}
  return {
    version: STORE_VERSION,
    profile: {
      firstGiftGranted: raw.profile?.firstGiftGranted === true,
      createdAt: typeof raw.profile?.createdAt === 'number' ? raw.profile.createdAt : base.profile.createdAt,
      rewardTimezone: typeof raw.profile?.rewardTimezone === 'string' && raw.profile.rewardTimezone !== ''
        ? raw.profile.rewardTimezone : null,
      lastSeenAtMs: Number.isFinite(raw.profile?.lastSeenAtMs) ? raw.profile.lastSeenAtMs : null,
    },
    wallet: { balance: toCount(raw.wallet?.balance, 0) },
    inventory: migrateInventory(raw.inventory),
    ledger: Array.isArray(raw.ledger) ? raw.ledger.slice(-2000) : [],
    usage: {
      dayKey: typeof raw.usage?.dayKey === 'string' ? raw.usage.dayKey : null,
      eligibleTokens: toCount(raw.usage?.eligibleTokens, 0),
      grantedCoins: toCount(raw.usage?.grantedCoins, 0),
      awardedKeys: Array.isArray(raw.usage?.awardedKeys)
        ? raw.usage.awardedKeys.filter((key) => typeof key === 'string').slice(-5000)
        : [],
    },
    daily: {
      dayKey: typeof daily.dayKey === 'string' ? daily.dayKey : null,
      snacksUsed: toCount(daily.snacksUsed, 0),
      pettingRewards: toCount(daily.pettingRewards, 0),
      reliefLastClaimedAtMs: Number.isFinite(daily.reliefLastClaimedAtMs) ? daily.reliefLastClaimedAtMs : null,
      affinityGained: toCount(daily.affinityGained, 0),
    },
    settings: {
      visible: settings.visible !== false,
      size: [72, 96, 128].includes(settings.size) ? settings.size : 72,
      position: {
        x: typeof settings.position?.x === 'number' ? settings.position.x : null,
        y: typeof settings.position?.y === 'number' ? settings.position.y : null,
      },
      quiet: settings.quiet === true,
      sleepStart: parseHHMM(settings.sleepStart, '23:00'),
      sleepEnd: parseHHMM(settings.sleepEnd, '07:00'),
      locale: settings.locale === 'en' ? 'en' : 'zh',
    },
    pet: raw.pet !== null && typeof raw.pet === 'object' ? raw.pet : null,
    memorial: Array.isArray(raw.memorial) ? raw.memorial.slice(-24) : [],
  }
}

export function readStore(file) {
  try {
    return sanitize(JSON.parse(readFileSync(file, 'utf8')))
  } catch {
    return emptyStore()
  }
}

let writeChain = Promise.resolve()

/** 原子写：临时文件 + rename，串行化避免多窗口互相覆盖。 */
export function writeStore(file, data) {
  const next = writeChain.then(() => {
    mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, `${JSON.stringify({ ...data, version: STORE_VERSION }, null, 2)}\n`, 'utf8')
    renameSync(tmp, file)
  })
  writeChain = next.catch(() => {})
  return next
}

/**
 * 串行读改写：所有存档修改都走这里。
 *
 * 读-改-写必须作为一个整体排队，否则后台金币结算与用户操作会互相覆盖
 * （例如领养刚写入、Token 结算读到旧快照后又写回）。
 */
export function mutateStore(file, mutate) {
  const next = writeChain.then(() => {
    const store = readStore(file)
    const result = mutate(store)
    mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, `${JSON.stringify({ ...store, version: STORE_VERSION }, null, 2)}\n`, 'utf8')
    renameSync(tmp, file)
    return result
  })
  writeChain = next.then(() => {}, () => {})
  return next
}

/* ------------------------------------------------------------------ */
/* Token → 金币                                                        */
/* ------------------------------------------------------------------ */

/** 一次唯一模型响应的实际 Token 数：各 usage 桶互不重叠，缓存/推理不重复相加。 */
export function usageTokensOf(usage) {
  if (usage === null || typeof usage !== 'object') return 0
  const total = usage.totalTokens
  if (Number.isSafeInteger(total) && total > 0) return total
  const input = Number.isSafeInteger(usage.inputTokens) ? usage.inputTokens : 0
  const output = Number.isSafeInteger(usage.outputTokens) ? usage.outputTokens : 0
  const read = Number.isSafeInteger(usage.cacheReadTokens) ? usage.cacheReadTokens : 0
  const write = Number.isSafeInteger(usage.cacheWriteTokens) ? usage.cacheWriteTokens : 0
  return input + output + read + write
}

/** 从一次 assistant/message 事件里取用量：优先 data.usage，其次收尾 stream 里的 usage chunk。 */
export function usageOfEvent(event) {
  if (event === null || typeof event !== 'object' || event.type !== 'assistant/message') return undefined
  const data = event.data
  if (data === null || typeof data !== 'object') return undefined
  if (data.usage !== undefined && data.usage !== null) return data.usage
  const stream = data.stream
  if (!Array.isArray(stream)) return undefined
  for (let index = stream.length - 1; index >= 0; index -= 1) {
    const record = stream[index]
    if (record?.type === 'chunk' && record.chunk?.type === 'usage' && record.chunk.usage !== undefined) return record.chunk.usage
  }
  return undefined
}

/**
 * 把一次响应的 Token 记入当日额度并补发差额金币（§9.1）。
 *
 * `G = min(dailyCap, floor(T / tokensPerCoin))`，每次只发 `G - 已发`；
 * 不足一金币的部分在当日累积、日终不结转。返回本次实际发放额。
 */
export function awardUsageTokens(store, tokens, { nowMs, tz, tokensPerCoin = TOKENS_PER_COIN, dailyCap = 100 }) {
  const dayKey = core.localDayKey(nowMs, tz)
  if (store.usage.dayKey !== dayKey) {
    store.usage.dayKey = dayKey
    store.usage.eligibleTokens = 0
    store.usage.grantedCoins = 0
  }
  const add = Number.isSafeInteger(tokens) && tokens > 0 ? tokens : 0
  store.usage.eligibleTokens += add
  const perCoin = Math.max(1, Math.floor(tokensPerCoin))
  const cap = Math.max(0, Math.floor(dailyCap))
  const target = Math.min(cap, Math.floor(store.usage.eligibleTokens / perCoin))
  // 当日已发金币只增不减：调整兑换比例（如 1,000 → 1,000,000）时，已发的不会被回收，
  // 也不会因为 target 变小而把计数改小、随后重复补发。
  const nextGranted = Math.max(store.usage.grantedCoins, target)
  const delta = nextGranted - store.usage.grantedCoins
  store.usage.grantedCoins = nextGranted
  if (delta > 0) {
    store.wallet.balance += delta
    store.ledger.push({ id: randomUUID(), at: nowMs, source: 'usage', delta, dayKey, tokens: add })
  }
  return { awarded: delta, dayKey, eligibleTokens: store.usage.eligibleTokens, grantedCoins: nextGranted }
}

/**
 * 订阅 Host 的 session/event，把真实模型响应用量换成金币。
 *
 * 只统计"事件到达时"的新响应：历史重放、导入会话、插件安装前的用量都不发币。
 */
export function createUsageAccountant({ dataFile, config = {} }) {
  const tokensPerCoin = Number.isFinite(config.tokensPerCoin) && config.tokensPerCoin > 0 ? config.tokensPerCoin : TOKENS_PER_COIN
  const dailyCap = Number.isFinite(config.dailyCoinCap) && config.dailyCoinCap >= 0 ? config.dailyCoinCap : 100

  const handle = async (session, event) => {
    const usage = usageOfEvent(event)
    const tokens = usageTokensOf(usage)
    if (tokens <= 0) return { skipped: 'no-usage' }
    const sessionId = typeof session?.id === 'string' ? session.id : 'unknown'
    const seq = Number.isSafeInteger(event?.seq) ? event.seq : -1
    if (seq < 0) return { skipped: 'no-seq' }
    const key = `${sessionId}:${seq}`
    return mutateStore(dataFile, (store) => {
      if (store.usage.awardedKeys.includes(key)) return { skipped: 'duplicate', key }
      store.usage.awardedKeys.push(key)
      if (store.usage.awardedKeys.length > 5000) store.usage.awardedKeys.splice(0, store.usage.awardedKeys.length - 5000)
      if (store.profile.rewardTimezone === null) store.profile.rewardTimezone = detectTimezone()
      const nowMs = Date.now()
      const result = awardUsageTokens(store, tokens, {
        nowMs, tz: store.profile.rewardTimezone, tokensPerCoin, dailyCap,
      })
      // 金币是 profile 级资源：有宠物时同步进它的 state，保证快照与存档一致。
      if (store.pet !== null && Number.isFinite(store.pet.wallet?.balance)) {
        store.pet.wallet = { ...store.pet.wallet, balance: store.wallet.balance }
      }
      return { key, tokens, ...result }
    })
  }

  return {
    tokensPerCoin,
    dailyCap,
    handle,
    start(ctx) {
      const listener = (session, event) => {
        handle(session, event).catch(() => {})
      }
      const dispose = ctx.on('session/event', listener)
      if (typeof dispose === 'function') return dispose
      return () => {
        ctx.off?.('session/event', listener)
      }
    },
  }
}

/* ------------------------------------------------------------------ */
/* HTTP 小工具                                                         */
/* ------------------------------------------------------------------ */

class HttpError extends Error {
  constructor(status, code, message) {
    super(message)
    this.status = status
    this.code = code
  }
}

function httpError(status, code, message) {
  return new HttpError(status, code, message)
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(text)
}

function readBody(req, limit = 256 * 1024) {
  return new Promise((resolvePromise, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(httpError(413, 'PAYLOAD_TOO_LARGE', '请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (text === '') {
        resolvePromise({})
        return
      }
      try {
        resolvePromise(JSON.parse(text))
      } catch {
        reject(httpError(400, 'INVALID_JSON', '请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

/** 只允许读取 assets/ 内的文件，拒绝路径穿越。 */
export function resolveAsset(relPath) {
  const decoded = decodeURIComponent(relPath)
  const target = normalize(join(ASSET_ROOT, decoded))
  const root = normalize(ASSET_ROOT + sep)
  if (!target.startsWith(root)) return null
  return target
}

function serveAsset(req, res, relPath) {
  const file = resolveAsset(relPath)
  if (file === null || !existsSync(file) || !statSync(file).isFile()) {
    sendJson(res, 404, { error: '素材不存在' })
    return true
  }
  const stat = statSync(file)
  const etag = `"${createHash('sha1').update(`${file}:${stat.size}:${stat.mtimeMs}`).digest('hex')}"`
  if (req.headers['if-none-match'] === etag) {
    res.statusCode = 304
    res.end()
    return true
  }
  res.statusCode = 200
  res.setHeader('content-type', MIME.get(extname(file).toLowerCase()) ?? 'application/octet-stream')
  res.setHeader('cache-control', 'public, max-age=31536000, immutable')
  res.setHeader('etag', etag)
  res.end(readFileSync(file))
  return true
}

/* ------------------------------------------------------------------ */
/* 时间 / 配置                                                         */
/* ------------------------------------------------------------------ */

/** 校验 "HH:MM" 并返回分钟数；非法返回 fallback 字符串。 */
export function parseHHMM(value, fallback) {
  if (typeof value === 'string') {
    const match = /^(\d{1,2}):(\d{2})$/u.exec(value.trim())
    if (match !== null) {
      const hours = Number(match[1])
      const minutes = Number(match[2])
      if (hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59) {
        return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
      }
    }
  }
  return fallback
}

function hhmmToMinutes(text) {
  const [hours, minutes] = text.split(':').map(Number)
  return hours * 60 + minutes
}

/** 内核运行配置：作息窗口按存档设置换算成分钟数。 */
export function settingsCfg(store) {
  return {
    sleepStart: hhmmToMinutes(store.settings.sleepStart),
    sleepEnd: hhmmToMinutes(store.settings.sleepEnd),
  }
}

export function detectTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai'
  } catch {
    return 'Asia/Shanghai'
  }
}

/* ------------------------------------------------------------------ */
/* 宠物服务（存档内状态 ↔ 内核纯函数）                                  */
/* ------------------------------------------------------------------ */

/** 用存档里的货币/库存/每日计数覆盖 state 上的同名副本（存档为真实来源）。 */
function hydratePet(store, nowMs) {
  const state = core.normalizeState(store.pet, nowMs)
  state.wallet = { balance: toCount(store.wallet.balance, 0) }
  state.inventory = { ...store.inventory }
  state.daily = { ...state.daily, ...store.daily }
  state.visible = store.settings.visible !== false
  return state
}

function syncPetToStore(store, state) {
  store.pet = state
  store.wallet = { balance: toCount(state.wallet?.balance, 0) }
  store.inventory = { ...(state.inventory ?? {}) }
  store.daily = { ...state.daily }
}

function archivePet(store, state) {
  if (state === null || state.lifecycle !== 'deceased') return
  const petId = state.petId
  if (store.memorial.some((item) => item.petId === petId)) return
  store.memorial.push({
    petId,
    speciesId: state.speciesId,
    nickname: state.nickname,
    adoptedAtMs: state.adoptedAtMs,
    deceasedAtMs: Number.isFinite(state.deceasedAtMs) ? state.deceasedAtMs : state.lastSettledAtMs,
    lifeEndsAtMs: state.lifeEndsAtMs,
    careCount: state.careCount ?? 0,
    affinity: state.affinity ?? 0,
  })
}

/**
 * 自动饮水：喂水按钮已从 UI 移除，但喝水本身免费且影响心情。
 * 到「需要喝水」节点（默认 18h）时由 host 自动补一次，并清空未饮水惩罚计数；
 * 不发放手动喂水的心情奖励（+2）与亲密度。
 */
function maybeAutoDrink(state, nowMs) {
  if (state === null || state.lifecycle !== 'alive') return false
  const dueHours = core.WATER_RULES?.needAfterHours ?? 18
  const last = Number.isFinite(state.lastWaterAtMs) ? state.lastWaterAtMs : (Number.isFinite(state.adoptedAtMs) ? state.adoptedAtMs : nowMs)
  if (nowMs - last < dueHours * 3600 * 1000) return false
  state.lastWaterAtMs = nowMs
  state.waterPenaltyM = 0
  state.waterRewardedAtMs = null
  return true
}

/**
 * 推进存档里的宠物到 nowMs：结算时间、完成到点的动作、归档寿终。
 * 返回内核结算结果（{state, events, deceased}）。
 */
export function settleStore(store, nowMs) {
  if (store.pet === null || store.pet === undefined) {
    return { state: null, events: [], deceased: false }
  }
  const cfg = settingsCfg(store)
  const lastSeenAtMs = Number.isFinite(store.profile.lastSeenAtMs) ? store.profile.lastSeenAtMs : null
  const offline = lastSeenAtMs !== null && nowMs - lastSeenAtMs > OFFLINE_GAP_MS
  const state = hydratePet(store, nowMs)
  const result = core.settle(state, nowMs, { ...cfg, offline })
  maybeAutoDrink(result.state, nowMs)
  syncPetToStore(store, result.state)
  archivePet(store, result.state)
  store.profile.lastSeenAtMs = nowMs
  return result
}

/** 宠物展示视图（客户端只读字段）。 */
export function petView(state, nowMs, cfg, alive) {
  const ageMs = core.ageMsOfState(state, nowMs)
  const stage = core.stageAtNow(state, nowMs)
  const needs = alive ? core.resolveNeeds(state, nowMs, cfg) : { need: null, needs: [] }
  const actions = alive ? core.availableActions(state, nowMs, cfg) : []
  const activeAction = state.activeAction
  const presentWaste = Array.isArray(state.pendingWaste)
    ? state.pendingWaste.filter((item) => Number.isFinite(item.atMs) && item.atMs <= nowMs).length
    : 0
  const needLabels = needs.needs.map((item) => item.label)
  return {
    petId: state.petId,
    speciesId: state.speciesId,
    nickname: state.nickname,
    adoptedAtMs: state.adoptedAtMs,
    lifeEndsAtMs: state.lifeEndsAtMs,
    tz: state.tz,
    H: state.H,
    M: state.M,
    E: state.E,
    C: state.C,
    stage: stage.key,
    stageLabel: stage.label,
    ageMs,
    lifecycle: state.lifecycle,
    deceasedAtMs: state.deceasedAtMs,
    mode: state.mode,
    boardingSinceMs: state.boardingSinceMs,
    sleeping: state.sleeping,
    resting: state.resting,
    affinity: state.affinity ?? 0,
    careCount: state.careCount ?? 0,
    need: needs.need === null ? null : { key: needs.need, label: needLabels[0] ?? null },
    needs: needs.needs,
    availableActions: actions,
    activeAction: activeAction === null || activeAction === undefined
      ? null
      : {
          id: activeAction.id,
          type: activeAction.type,
          startedAtMs: activeAction.startedAtMs,
          endsAtMs: activeAction.endsAtMs,
          itemId: activeAction.itemId,
          halfUnits: activeAction.halfUnits,
        },
    pendingWaste: presentWaste,
    lastWaterAtMs: state.lastWaterAtMs,
    lastBatheAtMs: state.lastBatheAtMs,
    lastGroomAtMs: state.lastGroomAtMs,
    lastWalkAtMs: state.lastWalkAtMs,
  }
}

/** 救济口粮状态（可领/冷却）。 */
function reliefView(store, state, nowMs) {
  const stock = toCount(store.inventory.relief, 0)
  const lastClaimedAtMs = Number.isFinite(store.daily.reliefLastClaimedAtMs) ? store.daily.reliefLastClaimedAtMs : null
  const cooldownMs = core.ECONOMY_RULES.reliefCooldownHours * core.HOUR_MS
  const cooldownUntilMs = lastClaimedAtMs === null ? null : lastClaimedAtMs + cooldownMs
  const alive = state !== null && state.lifecycle === 'alive'
  let reason = null
  if (!alive) reason = 'NO_PET'
  else if (stock >= 2) reason = 'RELIEF_IN_STOCK'
  else if (cooldownUntilMs !== null && nowMs < cooldownUntilMs) reason = 'RELIEF_COOLDOWN'
  return {
    halfUnits: stock,
    cooldownHours: core.ECONOMY_RULES.reliefCooldownHours,
    lastClaimedAtMs,
    nextClaimAtMs: cooldownUntilMs,
    claimable: reason === null,
    reason,
  }
}

/**
 * 派生权威快照（不修改存档）。
 * 若传入的 store 还未结算，调用方应先 settleStore（GET /state 会这么做）。
 */
export function snapshotOf(store, nowMs, config = {}) {
  const tokensPerCoin = Number.isFinite(config.tokensPerCoin) && config.tokensPerCoin > 0 ? config.tokensPerCoin : TOKENS_PER_COIN
  const dailyCap = Number.isFinite(config.dailyCoinCap) && config.dailyCoinCap >= 0 ? config.dailyCoinCap : DAILY_COIN_CAP
  const cfg = settingsCfg(store)
  const state = store.pet
  const alive = state !== null && state !== undefined && state.lifecycle === 'alive'
  const pet = state === null || state === undefined ? null : petView(state, nowMs, cfg, alive)
  return {
    ok: true,
    hasPet: alive,
    pet,
    wallet: { balance: toCount(store.wallet.balance, 0) },
    inventory: { ...store.inventory },
    daily: { ...store.daily },
    usage: { ...store.usage },
    settings: {
      ...store.settings,
      boarding: state !== null && state !== undefined && state.mode === 'boarding',
    },
    memorial: store.memorial,
    species: SPECIES,
    foods: FOODS,
    economy: {
      tokensPerCoin,
      dailyCap,
      dayKey: store.usage.dayKey,
      eligibleTokens: store.usage.eligibleTokens,
      grantedCoins: store.usage.grantedCoins,
    },
    relief: reliefView(store, state, nowMs),
    serverNowMs: nowMs,
    assetsVersion: ASSETS_VERSION,
  }
}

/** 兼容旧调用：deriveSnapshot(store, nowMs, config) —— 不做时间结算。 */
export function deriveSnapshot(store, nowMs = Date.now(), config = {}) {
  return snapshotOf(store, nowMs, config)
}

/* ------------------------------------------------------------------ */
/* 命令实现                                                            */
/* ------------------------------------------------------------------ */

/** 领养：校验物种/昵称/唯一在养，并按 profile 首次赠礼规则创建内核状态。 */
export function adoptPet(store, body, nowMs, config = {}) {
  const speciesId = typeof body?.speciesId === 'string' ? body.speciesId : ''
  const species = SPECIES.find((item) => item.id === speciesId)
  if (species === undefined) throw httpError(400, 'UNKNOWN_SPECIES', '未知物种')
  if (species.extension === true && config.allowExtension !== true) {
    throw httpError(400, 'EXTENSION_SPECIES', `${species.speciesZh}将在 v1.1 开放`)
  }
  const nickname = String(body?.nickname ?? '').trim()
  const length = Array.from(nickname).length
  if (length < 1 || length > 12) throw httpError(400, 'INVALID_NICKNAME', '昵称需要 1～12 个字符')
  if (store.pet !== null && store.pet.lifecycle === 'alive') {
    throw httpError(409, 'ALREADY_HAS_PET', '已经有一只宠物了')
  }
  const tz = store.profile.rewardTimezone ?? detectTimezone()
  store.profile.rewardTimezone = tz
  const state = core.createInitialState({
    petId: randomUUID(),
    speciesId,
    nickname,
    adoptedAtMs: nowMs,
    tz,
    firstGiftGranted: store.profile.firstGiftGranted === true,
    wallet: store.wallet,
    inventory: store.inventory,
    daily: store.daily,
    sleepStart: hhmmToMinutes(store.settings.sleepStart),
    sleepEnd: hhmmToMinutes(store.settings.sleepEnd),
  })
  store.profile.firstGiftGranted = true
  syncPetToStore(store, state)
  store.profile.lastSeenAtMs = nowMs
  // 新宠默认以 72px 展示（用户之后可在偏好里改成 96/128）。
  store.settings.size = 72
  return state
}

/** 六项照护：先结算到当前，再走内核 startAction（条件校验/预留/时长由内核决定）。 */
export function carePet(store, body, nowMs) {
  if (store.pet === null) throw httpError(409, 'NO_PET', '还没有宠物')
  settleStore(store, nowMs)
  const state = store.pet
  if (state.lifecycle === 'deceased') throw httpError(409, 'PET_DECEASED', '宠物已经离开了')
  const type = String(body?.action ?? '')
  const cmd = { type }
  if (type === 'feed') {
    const inventory = store.inventory
    const requested = typeof body?.itemId === 'string' ? body.itemId : null
    if (requested !== null) {
      cmd.itemId = requested
      cmd.halfUnits = Number.isInteger(body?.halfUnits) ? body.halfUnits : 2
    } else {
      const picked = pickFeedCommand(inventory, state)
      if (picked === null) throw httpError(409, 'ITEM_MISSING', '背包里没有口粮了')
      cmd.itemId = picked.itemId
      cmd.halfUnits = picked.halfUnits
    }
  }
  const result = core.startAction(state, cmd, nowMs, settingsCfg(store))
  if (!result.ok) throw httpError(409, result.error ?? 'ACTION_REJECTED', actionErrorMessage(result.error))
  syncPetToStore(store, result.state)
  return result.state.activeAction
}

function actionErrorMessage(code) {
  const messages = {
    BUSY: '正在照顾中，等这次完成吧',
    ITEM_MISSING: '背包里没有这份食品',
    NOT_HUNGRY: '它还不饿',
    LOW_ENERGY: '体力不够，先让它休息一下',
    TOO_CLEAN: '已经很干净了',
    ON_COOLDOWN: '还在冷却中',
    NO_WASTE: '地面很干净',
    DAILY_LIMIT: '今天的额度用完了',
    INVALID_PORTION: '份量不合法',
    PET_DECEASED: '宠物已经离开了',
    UNKNOWN_ACTION: '未知操作',
    NOT_ENOUGH_COINS: '金币不够',
    NOT_PURCHASABLE: '这个食品不能购买',
    RELIEF_IN_STOCK: '背包里还有一整份救济口粮，先吃完再领',
    RELIEF_COOLDOWN: '今天已经领过了，明天再来',
    GIFT_ALREADY_GRANTED: '首次赠礼已经发过了',
    ALREADY_BOARDING: '已经在托管中',
    NOT_BOARDING: '当前没有托管',
    NO_ACTIVE_ACTION: '没有进行中的动作',
  }
  return messages[code] ?? '这个操作暂时不能进行'
}

/** 喂食默认口粮：优先整份基础口粮 → 半份基础 → 喜爱主食 → 救济口粮 → 零食。 */
function pickFeedCommand(inventory, state) {
  const stock = (id) => Math.max(0, Math.floor(inventory[id] ?? 0))
  if (stock('basic') >= 2) return { itemId: 'basic', halfUnits: 2 }
  if (stock('basic') >= 1) return { itemId: 'basic', halfUnits: 1 }
  if (stock('favorite') >= 2) return { itemId: 'favorite', halfUnits: 2 }
  if (stock('favorite') >= 1) return { itemId: 'favorite', halfUnits: 1 }
  if (stock('relief') >= 2) return { itemId: 'relief', halfUnits: 2 }
  if (stock('relief') >= 1) return { itemId: 'relief', halfUnits: 1 }
  if (stock('snack') >= 2) return { itemId: 'snack', halfUnits: 2 }
  return null
}

/**
 * 送养（用户操作）：把当前宠物送进救助站。
 * 语义：删除当前宠物数据（在途动作随之失效），金币/口粮/每日计数等 profile 级资源保留；
 * 不写入纪念册（纪念册只记录自然寿终），之后可直接重新领养（首次赠礼不会重复发放）。
 */
export function surrenderPet(store, body, nowMs) {
  if (store.pet === null || store.pet === undefined) {
    throw httpError(409, 'NO_PET', '当前没有在养的宠物')
  }
  settleStore(store, nowMs)
  const state = store.pet
  if (state === null || state === undefined) throw httpError(409, 'NO_PET', '当前没有在养的宠物')
  if (state.lifecycle !== 'alive') throw httpError(409, 'PET_DECEASED', '宠物已经离开了，可以直接领养下一只')
  if (body?.confirm !== true) throw httpError(400, 'CONFIRM_REQUIRED', '请确认送养操作')
  const record = {
    petId: state.petId,
    speciesId: state.speciesId,
    nickname: state.nickname,
    adoptedAtMs: state.adoptedAtMs,
    careCount: state.careCount ?? 0,
    affinity: state.affinity ?? 0,
  }
  // 结算后 wallet/inventory/daily 已同步到 store（profile 级资源），只清空宠物本身。
  store.pet = null
  store.profile.lastSeenAtMs = nowMs
  return { surrendered: true, pet: record }
}

/** 抚摸（§7.1）：内核负责冷却与每日上限。 */
export function petAction(store, nowMs) {
  if (store.pet === null) throw httpError(409, 'NO_PET', '还没有宠物')
  settleStore(store, nowMs)
  if (store.pet.lifecycle === 'deceased') throw httpError(409, 'PET_DECEASED', '宠物已经离开了')
  const result = core.pet(store.pet, nowMs, settingsCfg(store))
  syncPetToStore(store, result.state)
  if (!result.ok) throw httpError(409, result.error ?? 'PET_REJECTED', actionErrorMessage(result.error))
  return result
}

/** 购买食品（金币扣减与库存增加由内核保证原子一致）。 */
export function buyFood(store, body, nowMs) {
  if (store.pet === null) throw httpError(409, 'NO_PET', '还没有宠物')
  settleStore(store, nowMs)
  const itemId = typeof body?.itemId === 'string' ? body.itemId : ''
  const cmd = { itemId }
  if (Number.isInteger(body?.halfUnits)) cmd.halfUnits = body.halfUnits
  else if (Number.isInteger(body?.quantity)) cmd.halfUnits = body.quantity * 2
  const result = core.buyItem(store.pet, cmd, nowMs, settingsCfg(store))
  if (!result.ok) throw httpError(409, result.error ?? 'BUY_REJECTED', actionErrorMessage(result.error))
  syncPetToStore(store, result.state)
  return { cost: result.cost, itemId }
}

/** 领取救济口粮。 */
export function claimReliefFood(store, nowMs) {
  if (store.pet === null) throw httpError(409, 'NO_PET', '还没有宠物')
  settleStore(store, nowMs)
  const result = core.claimRelief(store.pet, nowMs, settingsCfg(store))
  if (!result.ok) throw httpError(409, result.error ?? 'RELIEF_REJECTED', actionErrorMessage(result.error))
  syncPetToStore(store, result.state)
  return result.claim
}

/** 设置页的偏好写入；托管走内核 setBoarding。 */
export function updateSettings(store, body, nowMs) {
  const patch = body !== null && typeof body === 'object' ? body : {}
  if (patch.visible !== undefined) store.settings.visible = patch.visible !== false
  if (patch.size !== undefined) {
    if (![72, 96, 128].includes(patch.size)) throw httpError(400, 'INVALID_SIZE', '大小只能是 72/96/128')
    store.settings.size = patch.size
  }
  if (patch.position !== undefined) {
    const x = Number.isFinite(patch.position?.x) ? Math.round(patch.position.x) : null
    const y = Number.isFinite(patch.position?.y) ? Math.round(patch.position.y) : null
    store.settings.position = { x, y }
  }
  if (patch.quiet !== undefined) store.settings.quiet = patch.quiet === true
  if (patch.locale !== undefined) {
    if (patch.locale !== 'zh' && patch.locale !== 'en') throw httpError(400, 'INVALID_LOCALE', '语言只能是 zh 或 en')
    store.settings.locale = patch.locale
  }
  if (patch.sleepStart !== undefined) {
    const parsed = parseHHMM(patch.sleepStart, null)
    if (parsed === null) throw httpError(400, 'INVALID_SLEEP_WINDOW', '作息格式应为 HH:MM')
    store.settings.sleepStart = parsed
  }
  if (patch.sleepEnd !== undefined) {
    const parsed = parseHHMM(patch.sleepEnd, null)
    if (parsed === null) throw httpError(400, 'INVALID_SLEEP_WINDOW', '作息格式应为 HH:MM')
    store.settings.sleepEnd = parsed
  }
  if (store.pet !== null) {
    settleStore(store, nowMs)
    if (patch.boarding !== undefined) {
      const result = core.setBoarding(store.pet, patch.boarding === true, nowMs, settingsCfg(store))
      syncPetToStore(store, result.state)
      if (!result.ok) throw httpError(409, result.error ?? 'BOARDING_REJECTED', actionErrorMessage(result.error))
    }
  }
  return store.settings
}

/* ------------------------------------------------------------------ */
/* 路由                                                                */
/* ------------------------------------------------------------------ */

/** 兼容旧测试：从参数创建内核宠物状态（不落盘）。 */
export function createPet({ speciesId, nickname, tz }, nowMs, extra = {}) {
  return core.createInitialState({
    petId: randomUUID(),
    speciesId,
    nickname,
    adoptedAtMs: nowMs,
    tz,
    ...extra,
  })
}

/** 兼容旧调用：仅做 profile 级首次赠礼（不依赖内核状态）。 */
export function grantFirstGift(store) {
  if (store.profile.firstGiftGranted === true) return null
  store.profile.firstGiftGranted = true
  store.wallet.balance += core.ECONOMY_RULES.firstGiftCoins
  const halfUnits = core.ECONOMY_RULES.firstGiftBasicWholeUnits * core.FOOD_CATALOG.basic.unitHalfUnits
  store.inventory.basic = toCount(store.inventory.basic, 0) + halfUnits
  store.ledger.push({ id: randomUUID(), at: Date.now(), source: 'first-gift', delta: core.ECONOMY_RULES.firstGiftCoins })
  return { coins: core.ECONOMY_RULES.firstGiftCoins, stapleHalfUnits: halfUnits }
}

export function lifeEndsAtMs(adoptedAtMs, tz) {
  return core.lifeEndsAtMs(adoptedAtMs, tz)
}

export function localDayKey(ms, tz) {
  return core.localDayKey(ms, tz)
}

export function registerRoutes(ctx, config = {}) {
  const dataFile = resolveDataFile(ctx, config)
  const now = () => Date.now()

  const handler = async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    const path = url.pathname.slice(ROUTE_PREFIX.length).replace(/\/+$/u, '') || '/'
    const method = (req.method ?? 'GET').toUpperCase()

    if (path.startsWith('/assets/')) {
      serveAsset(req, res, path.slice('/assets/'.length))
      return
    }

    try {
      if (path === '/ping' && method === 'GET') {
        sendJson(res, 200, { ok: true, name, version: '0.1.0', dataFile })
        return
      }

      if (path === '/state' && method === 'GET') {
        const at = now()
        const snapshot = await mutateStore(dataFile, (store) => {
          settleStore(store, at)
          return snapshotOf(store, at, config)
        })
        sendJson(res, 200, snapshot)
        return
      }

      if (method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'METHOD_NOT_ALLOWED' })
        return
      }

      const body = await readBody(req)
      const at = now()

      const result = await mutateStore(dataFile, (store) => {
        let payload = null
        if (path === '/adopt') {
          adoptPet(store, body, at, config)
          payload = { adopted: true }
        } else if (path === '/care') {
          const action = carePet(store, body, at)
          payload = { action }
        } else if (path === '/pet') {
          const result2 = petAction(store, at)
          payload = { reward: result2.events.find((event) => event.type === 'pet.reward') ?? null }
        } else if (path === '/buy') {
          payload = buyFood(store, body, at)
        } else if (path === '/claim-relief') {
          payload = claimReliefFood(store, at)
        } else if (path === '/surrender') {
          payload = surrenderPet(store, body, at)
        } else if (path === '/settings') {
          payload = { settings: updateSettings(store, body, at) }
        } else {
          throw httpError(404, 'NOT_FOUND', `未知接口 ${path}`)
        }
        return { ...payload, store: snapshotOf(store, at, config) }
      })
      sendJson(res, 200, { ok: true, ...result })
    } catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : 500
      const code = typeof error?.code === 'string' ? error.code : 'INTERNAL_ERROR'
      sendJson(res, status, { ok: false, code, error: error?.message ?? '内部错误' })
    }
  }

  const routes = []
  if (ctx?.webServer && typeof ctx.webServer.register === 'function') {
    routes.push(ctx.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler }))
  }
  return routes
}

export function apply(ctx, config = {}) {
  const dataFile = resolveDataFile(ctx, config)
  const disposers = []

  ctx.effect(() => {
    const disposer = registerRoutes(ctx, { ...config, dataFile })
    return () => {
      for (const item of disposer) {
        if (typeof item === 'function') item()
      }
    }
  }, 'dsh-digital-pet: routes')

  ctx.effect(() => {
    const accountant = createUsageAccountant({ dataFile, config })
    const dispose = accountant.start(ctx)
    return () => {
      if (typeof dispose === 'function') dispose()
    }
  }, 'dsh-digital-pet: token economy')

  return disposers
}

export const internals = {
  TOKENS_PER_COIN,
  ASSETS_VERSION,
  computeAssetsVersion,
  sanitize,
  snapshotOf,
  mutateStore,
  awardUsageTokens,
  usageTokensOf,
  usageOfEvent,
  createUsageAccountant,
  adoptPet,
  surrenderPet,
  carePet,
  petAction,
  buyFood,
  claimReliefFood,
  updateSettings,
  settleStore,
  maybeAutoDrink,
  petView,
  settingsCfg,
  parseHHMM,
  hhmmToMinutes,
  pickFeedCommand,
  OFFLINE_GAP_MS,
  dshHomeDir,
  legacyDataFile,
  legacyDataFiles,
  profileDataFile,
  profileDir,
  resolveDataFile,
}
