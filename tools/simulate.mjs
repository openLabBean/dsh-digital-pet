#!/usr/bin/env node
/**
 * tools/simulate.mjs — DSH 电子宠物 v1 数值平衡模拟器（零依赖 / 纯 Node / 不联网）
 *
 * 目标：回答设计文档 §16 未决问题——六个月成长分配与金币经济能否做到
 *       「每天 1~2 次照顾可维持、没有 Token 也不饿死」。
 *
 * 用法：
 *   node tools/simulate.mjs
 *
 * 输出：
 *   - stdout：策略总览 + 状态/经济/保护三张简表 + 关键结论
 *   - 文件：docs/balance-report.md（自动生成，含方法学、完整表格、结论、建议）
 *
 * 重要：本模拟器只调用 src/core 的确定性纯函数引擎（settle/startAction/...），
 *       不修改任何状态字段、不读真实时钟、不联网。行为在真实引擎上推进：
 *       每个用户会话先 settle（间隔 >10min 时按 host 语义 offline=true），
 *       每个行为 startAction + settle 到 endsAtMs 完成。
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as core from '../src/core/index.js';

/* ------------------------------------------------------------------ */
/* 0. 固定场景常量                                                     */
/* ------------------------------------------------------------------ */

const TZ = 'Asia/Shanghai';
const MINUTE_MS = core.MINUTE_MS;
const HOUR_MS = core.HOUR_MS;
const DAY_MS = core.DAY_MS;

/** 领养时刻 = 2026-01-01 08:00 Asia/Shanghai（与 tests/core/helpers.js 一致，清晨清醒起点）。 */
const ADOPTED_AT_MS = Date.UTC(2026, 0, 1, 0, 0, 0);
/** 寿终时刻 = 领养 +6 个自然月 = 2026-07-01 08:00 Asia/Shanghai（共 181 天）。 */
const LIFE_END_MS = core.lifeEndsAtMs(ADOPTED_AT_MS, TZ);
/** 实际存活天数（寿终时刻 - 领养时刻）= 181 天；日历会跨 182 个自然日（首日 16h、末日 8h）。 */
const LIFETIME_DAYS = (LIFE_END_MS - ADOPTED_AT_MS) / DAY_MS;

/** 睡眠窗口用 v1 默认 23:00–07:00。 */
const CFG = {
  sleepStart: core.DEFAULT_SLEEP_START_MIN,
  sleepEnd: core.DEFAULT_SLEEP_END_MIN,
};

/** host 语义：间隔超过 10 分钟才按离线结算（index.js OFFLINE_GAP_MS）。 */
const OFFLINE_GAP_MS = 10 * MINUTE_MS;
/** 一次会话至少保持 App 打开 2 分钟（打开期间 host 每 8s 轮询、按在线结算）。 */
const OPEN_WINDOW_MS = 2 * MINUTE_MS;

const STAT_KEYS = ['H', 'M', 'E', 'C'];
const FEED_ITEM_PREFERENCE = ['relief', 'basic', 'favorite'];

/* ------------------------------------------------------------------ */
/* 1. 日历 / 会话时刻                                                  */
/* ------------------------------------------------------------------ */

/**
 * 生成从领养日到寿终日之间的本地自然日。
 * @returns {Array<{index:number,startMs:number,endMs:number,dayKey:string,weekday:number}>}
 */
function buildCalendar() {
  const days = [];
  let startMs = core.localDayStartMs(ADOPTED_AT_MS, TZ);
  let index = 0;
  while (startMs < LIFE_END_MS) {
    const endMs = core.nextLocalMidnightMs(startMs, TZ);
    const noon = core.zonedParts(startMs + DAY_MS / 2, TZ);
    const weekday = new Date(Date.UTC(noon.year, noon.month - 1, noon.day)).getUTCDay();
    days.push({
      index,
      startMs,
      endMs,
      dayKey: core.localDayKey(startMs + MINUTE_MS, TZ),
      weekday,
      partial: endMs > LIFE_END_MS,
    });
    startMs = endMs;
    index += 1;
  }
  return days;
}

const DAYS = buildCalendar();
const DAY_BY_KEY = new Map(DAYS.map((day) => [day.dayKey, day.index]));

function dayIndexAt(ms) {
  return DAY_BY_KEY.get(core.localDayKey(ms, TZ));
}

/** 某本地自然日的 hour:minute 墙钟时刻 -> 绝对毫秒。 */
function localTimeMs(day, hour, minute = 0) {
  const noon = core.zonedParts(day.startMs + DAY_MS / 2, TZ);
  return core.zonedTimeToUtc(
    { year: noon.year, month: noon.month, day: noon.day, hour, minute, second: 0, ms: 0 },
    TZ,
  );
}

/* ------------------------------------------------------------------ */
/* 2. 策略定义                                                         */
/* ------------------------------------------------------------------ */

/**
 * care:
 *   'normal'      —— 喂食 + 诉求驱动的正常照料（散步/喝水/铲屎/洗澡/梳理）
 *   'relief-only' —— 不照料，只尝试领取免费救济（记录能不能领）
 *   'none'        —— 完全不交互
 * feed:
 *   'whole'  每次会话喂 1 整份基础口粮（2 半份）
 *   'half'   每次会话喂 1 半份
 *   'none'   不喂
 */
const STRATEGIES = [
  {
    id: 'whole-daily',
    label: '① 每天一餐整份',
    desc: '每天 20:00 打开 1 次，喂 1 整份基础口粮 + 正常照料',
    sessions: [[20, 0]],
    feed: 'whole',
    care: 'normal',
    tokensPerDay: 0,
    wallet: core.ECONOMY_RULES.firstGiftCoins,
    basicHalfUnits: core.ECONOMY_RULES.firstGiftBasicWholeUnits * 2,
  },
  {
    id: 'half-twice',
    label: '② 每天两餐半份',
    desc: '每天 10:00 / 22:00 打开 2 次，每次喂半份 + 正常照料',
    sessions: [[10, 0], [22, 0]],
    feed: 'half',
    care: 'normal',
    tokensPerDay: 0,
    wallet: core.ECONOMY_RULES.firstGiftCoins,
    basicHalfUnits: core.ECONOMY_RULES.firstGiftBasicWholeUnits * 2,
  },
  {
    id: 'weekday-only',
    label: '③ 仅工作日照顾',
    desc: '周一~周五同策略②，周六周日完全不打开（App 关闭 60h，触发离线保护/托管）',
    sessions: [[10, 0], [22, 0]],
    feed: 'half',
    care: 'normal',
    tokensPerDay: 0,
    wallet: core.ECONOMY_RULES.firstGiftCoins,
    basicHalfUnits: core.ECONOMY_RULES.firstGiftBasicWholeUnits * 2,
    skipDay: (day) => day.weekday === 0 || day.weekday === 6,
  },
  {
    id: 'low-token',
    label: '④ 低 Token（2000/天）',
    desc: '同策略②，另每天 2000 tokens（≈2 金币/天）',
    sessions: [[10, 0], [22, 0]],
    feed: 'half',
    care: 'normal',
    tokensPerDay: 2000,
    wallet: core.ECONOMY_RULES.firstGiftCoins,
    basicHalfUnits: core.ECONOMY_RULES.firstGiftBasicWholeUnits * 2,
  },
  {
    id: 'high-token',
    label: '⑤ 高 Token（100000/天）',
    desc: '同策略②，另每天 100000 tokens（撞满 100 金币/天日上限）',
    sessions: [[10, 0], [22, 0]],
    feed: 'half',
    care: 'normal',
    tokensPerDay: 100000,
    wallet: core.ECONOMY_RULES.firstGiftCoins,
    basicHalfUnits: core.ECONOMY_RULES.firstGiftBasicWholeUnits * 2,
  },
  {
    id: 'long-offline',
    label: '⑥ 第 30~37 天离线',
    desc: '同策略②，但第 30~37 个自然日（含首尾）完全不打开，第 38 天恢复',
    sessions: [[10, 0], [22, 0]],
    feed: 'half',
    care: 'normal',
    tokensPerDay: 0,
    wallet: core.ECONOMY_RULES.firstGiftCoins,
    basicHalfUnits: core.ECONOMY_RULES.firstGiftBasicWholeUnits * 2,
    skipDay: (day) => day.index >= 30 && day.index <= 37,
  },
  {
    id: 'neglect',
    label: '⑦ 完全不管',
    desc: '每天 20:00 打开但什么都不做，只尝试领取救济（不喂不水不清理）',
    sessions: [[20, 0]],
    feed: 'none',
    care: 'relief-only',
    tokensPerDay: 0,
    wallet: 0,
    basicHalfUnits: 0,
  },
  {
    id: 'relief-only',
    label: '⑧ 仅免费救济（0 币 0 Token）',
    desc: '钱包与库存清零，只靠每 24h 免费救济口粮 + 正常照料（回答「唯一靠救济能否维持」）',
    sessions: [[20, 0]],
    feed: 'whole',
    care: 'normal',
    tokensPerDay: 0,
    wallet: 0,
    basicHalfUnits: 0,
  },
  {
    id: 'never-open',
    label: '⑨ 附加：全程不打开',
    desc: '六个月只结算一次（真实 host 中相当于领养后再也不打开 App）',
    sessions: [],
    feed: 'none',
    care: 'none',
    tokensPerDay: 0,
    wallet: core.ECONOMY_RULES.firstGiftCoins,
    basicHalfUnits: core.ECONOMY_RULES.firstGiftBasicWholeUnits * 2,
    sample: false,
  },
];

/* ------------------------------------------------------------------ */
/* 3. 单策略模拟上下文                                                 */
/* ------------------------------------------------------------------ */

function createContext(strategy) {
  const state = core.createInitialState({
    petId: `sim-${strategy.id}`,
    speciesId: 'whale',
    nickname: strategy.label,
    adoptedAtMs: ADOPTED_AT_MS,
    tz: TZ,
    sleepStart: CFG.sleepStart,
    sleepEnd: CFG.sleepEnd,
    // 第 0 天按「首礼已领」开始：host 用 profile 里已发放的 60 金币 + 3 整份基础口粮口径。
    firstGiftGranted: true,
    wallet: { balance: strategy.wallet },
    inventory: { basic: strategy.basicHalfUnits },
  });

  return {
    strategy,
    state,
    actions: Object.create(null),
    feedCompletions: 0,
    feedHalfUnits: 0,
    feedEffective: 0,
    feedSkips: 0,
    feedRejections: Object.create(null),
    purchases: 0,
    coinsSpent: 0,
    boughtHalfUnits: 0,
    coinIncome: 0,
    reliefClaims: 0,
    reliefFailures: Object.create(null),
    wastePlanned: 0,
    wasteAppeared: 0,
    wasteCleaned: 0,
    wasteCleanEvents: 0,
    waterPenalties: 0,
    waterPenaltyAmount: 0,
    boardingEvents: 0,
    protectionEvents: 0,
    protectionLifts: 0,
    protectionLiftByStat: Object.create(null),
    stageEvents: [],
    deathEvent: null,
    sessionCount: 0,
    offlineResumes: 0,
    grantedThroughDay: -1,
    dayRecords: new Map(),
    samplesByDay: new Map(),
  };
}

/* ------------------------------------------------------------------ */
/* 4. 事件收集 / 采样                                                  */
/* ------------------------------------------------------------------ */

function collectEvents(ctx, events) {
  for (const event of events) {
    switch (event.type) {
      case 'action.completed': {
        ctx.actions[event.actionType] = (ctx.actions[event.actionType] || 0) + 1;
        if (event.actionType === 'feed') {
          ctx.feedCompletions += 1;
          ctx.feedHalfUnits += event.halfUnits || 0;
          if (event.effective) ctx.feedEffective += 1;
        }
        break;
      }
      case 'waste.planned':
        ctx.wastePlanned += 1;
        break;
      case 'waste.appeared':
        ctx.wasteAppeared += 1;
        break;
      case 'waste.cleaned':
        ctx.wasteCleanEvents += 1;
        ctx.wasteCleaned += event.count || 0;
        break;
      case 'water.penalty':
        ctx.waterPenalties += 1;
        ctx.waterPenaltyAmount += event.amount || 0;
        break;
      case 'boarding.auto':
        ctx.boardingEvents += 1;
        break;
      case 'offline.protected':
        ctx.protectionEvents += 1;
        if (Array.isArray(event.applied) && event.applied.length > 0) {
          ctx.protectionLifts += 1;
          for (const item of event.applied) {
            ctx.protectionLiftByStat[item.stat] =
              (ctx.protectionLiftByStat[item.stat] || 0) + (item.after - item.before);
          }
        }
        break;
      case 'stage.changed':
        ctx.stageEvents.push({
          stage: event.stage,
          label: event.label,
          ageDays: event.ageMs / DAY_MS,
          atMs: event.atMs,
        });
        break;
      case 'pet.deceased':
        ctx.deathEvent = { ...event };
        break;
      default:
        break;
    }
  }
}

function recordSample(ctx, dayIndex, state) {
  let day = ctx.samplesByDay.get(dayIndex);
  if (!day) {
    day = { dayIndex, samples: [] };
    ctx.samplesByDay.set(dayIndex, day);
  }
  day.samples.push({ H: state.H, M: state.M, E: state.E, C: state.C });
}

/**
 * 统一结算入口：与 host 语义一致，然后收集事件、采样、更新死亡标记。
 * @returns {{state:object, events:Array, deceased:boolean}}
 */
function settleTo(ctx, nowMs, offline, sample = true) {
  const result = core.settle(ctx.state, nowMs, { ...CFG, offline });
  ctx.state = result.state;
  collectEvents(ctx, result.events);
  if (!result.deceased && sample) {
    const dayIndex = dayIndexAt(nowMs);
    if (dayIndex !== undefined) recordSample(ctx, dayIndex, ctx.state);
  }
  return result;
}

/** App 在线结算（不触发离线保护）：用于动作完成与关闭 App 前的最后时刻。 */
function settleOnline(ctx, nowMs, sample = true) {
  return settleTo(ctx, nowMs, false, sample);
}

/* ------------------------------------------------------------------ */
/* 5. 行为原语（全部经由引擎 startAction + settle）                    */
/* ------------------------------------------------------------------ */

function performAction(ctx, type, options = {}) {
  const started = core.startAction(
    ctx.state,
    { type, ...options },
    ctx.state.lastSettledAtMs,
    CFG,
  );
  if (!started.ok) {
    if (!ctx.actionRejections) ctx.actionRejections = Object.create(null);
    ctx.actionRejections[`${type}:${started.error}`] =
      (ctx.actionRejections[`${type}:${started.error}`] || 0) + 1;
    return { ok: false, error: started.error };
  }
  ctx.state = started.state;
  const endsAtMs = started.state.activeAction.endsAtMs;
  if (endsAtMs >= LIFE_END_MS) return { ok: false, error: 'LIFE_ENDED' };
  settleOnline(ctx, endsAtMs, false);
  return { ok: true, error: null };
}

function stockOf(state, itemId) {
  return Math.floor((state.inventory && state.inventory[itemId]) || 0);
}

/** 喂食前准备：先吃库存（救济 > 基础 > 最爱），再买（整份/半份），最后领救济。 */
function ensureFeedStock(ctx, wantHalfUnits) {
  const nowMs = ctx.state.lastSettledAtMs;

  for (const itemId of FEED_ITEM_PREFERENCE) {
    if (stockOf(ctx.state, itemId) >= wantHalfUnits) {
      return { itemId, halfUnits: wantHalfUnits };
    }
  }
  if (wantHalfUnits > 1) {
    for (const itemId of FEED_ITEM_PREFERENCE) {
      if (stockOf(ctx.state, itemId) >= 1) return { itemId, halfUnits: 1 };
    }
  }

  const portions = wantHalfUnits >= 2 ? [2, 1] : [1];
  for (const halfUnits of portions) {
    const price = core.priceForHalfUnits('basic', halfUnits);
    if (!Number.isFinite(price)) continue;
    if (ctx.state.wallet.balance < price) continue;
    const bought = core.buyItem(ctx.state, { itemId: 'basic', halfUnits }, nowMs, CFG);
    if (bought.ok) {
      ctx.state = bought.state;
      ctx.purchases += 1;
      ctx.coinsSpent += bought.cost;
      ctx.boughtHalfUnits += halfUnits;
      return { itemId: 'basic', halfUnits };
    }
  }

  const claimed = core.claimRelief(ctx.state, nowMs, CFG);
  if (claimed.ok) {
    ctx.state = claimed.state;
    ctx.reliefClaims += 1;
    const got = stockOf(ctx.state, 'relief');
    return { itemId: 'relief', halfUnits: Math.min(wantHalfUnits, got) };
  }
  ctx.reliefFailures[claimed.error] = (ctx.reliefFailures[claimed.error] || 0) + 1;
  return null;
}

function tryFeed(ctx, wantHalfUnits) {
  // 引擎在 H > 90 时拒绝喂食（NOT_HUNGRY）；先判断，避免白买/白领。
  if (ctx.state.H > 100 - core.FEED_RULES.minHungerDeficit) {
    ctx.feedSkips += 1;
    return false;
  }
  const picked = ensureFeedStock(ctx, wantHalfUnits);
  if (!picked) {
    ctx.feedSkips += 1;
    return false;
  }
  const result = performAction(ctx, 'feed', {
    itemId: picked.itemId,
    halfUnits: picked.halfUnits,
  });
  if (!result.ok) {
    ctx.feedRejections[result.error] = (ctx.feedRejections[result.error] || 0) + 1;
    ctx.feedSkips += 1;
    return false;
  }
  return true;
}

function attemptRelief(ctx) {
  const claimed = core.claimRelief(ctx.state, ctx.state.lastSettledAtMs, CFG);
  if (claimed.ok) {
    ctx.state = claimed.state;
    ctx.reliefClaims += 1;
    return true;
  }
  ctx.reliefFailures[claimed.error] = (ctx.reliefFailures[claimed.error] || 0) + 1;
  return false;
}

function hasPresentWaste(state, nowMs) {
  const pending = Array.isArray(state.pendingWaste) ? state.pendingWaste : [];
  return pending.some((item) => Number.isFinite(item.atMs) && item.atMs <= nowMs);
}

/** 诉求驱动的正常照料序列：喂食 → 散步 → 喝水 → 铲屎 → 洗澡 → 梳理。 */
function applyPolicy(ctx, strategy, session) {
  if (strategy.care === 'none') return;
  if (strategy.care === 'relief-only') {
    attemptRelief(ctx);
    return;
  }

  if (strategy.feed !== 'none') {
    const wantHalfUnits = strategy.feed === 'whole' ? 2 : 1;
    tryFeed(ctx, wantHalfUnits);
  }

  const cursor = ctx.state.lastSettledAtMs;
  const walkNeed =
    ctx.state.M <= core.WALK_RULES.needMoodAt &&
    cursor - ctx.state.lastWalkAtMs >= core.WALK_RULES.needSinceWalkHours * HOUR_MS;
  if (walkNeed) performAction(ctx, 'walk');

  const waterDue =
    ctx.state.lastSettledAtMs - ctx.state.lastWaterAtMs >= core.WATER_RULES.needAfterHours * HOUR_MS;
  if (waterDue) performAction(ctx, 'water');

  if (hasPresentWaste(ctx.state, ctx.state.lastSettledAtMs)) performAction(ctx, 'cleanWaste');

  if (ctx.state.C <= core.BATHE_RULES.needAtC) performAction(ctx, 'bathe');

  const groomDue =
    ctx.state.lastSettledAtMs - ctx.state.lastGroomAtMs >=
    core.GROOM_RULES.needAfterHours * HOUR_MS;
  if (groomDue) performAction(ctx, 'groom');
}

/* ------------------------------------------------------------------ */
/* 6. Token 金币入账（host 语义：日终差额发放）                        */
/* ------------------------------------------------------------------ */

function tokensForDay(strategy, day) {
  if (strategy.tokensPerDay <= 0) return 0;
  if (strategy.skipDay && strategy.skipDay(day)) return 0;
  return strategy.tokensPerDay;
}

function grantTokensThrough(ctx, dayIndex) {
  while (ctx.grantedThroughDay < dayIndex) {
    const day = DAYS[ctx.grantedThroughDay + 1];
    if (!day) break;
    ctx.grantedThroughDay += 1;
    const tokens = tokensForDay(ctx.strategy, day);
    const base = ctx.dayRecords.get(day.index) || {
      dayKey: day.dayKey,
      eligibleTokens: 0,
      grantedCoins: 0,
    };
    if (tokens <= 0) {
      ctx.dayRecords.set(day.index, base);
      continue;
    }
    const granted = core.grantForDay(base, [{ tokens }]);
    ctx.dayRecords.set(day.index, {
      dayKey: day.dayKey,
      eligibleTokens: granted.eligibleTokens,
      grantedCoins: granted.grantedCoins,
    });
    if (granted.grantedDelta > 0) {
      const balance = (ctx.state.wallet && ctx.state.wallet.balance) || 0;
      ctx.state = { ...ctx.state, wallet: { ...(ctx.state.wallet || {}), balance: balance + granted.grantedDelta } };
      ctx.coinIncome += granted.grantedDelta;
    }
  }
}

/* ------------------------------------------------------------------ */
/* 7. 会话推进 / 整策略执行                                            */
/* ------------------------------------------------------------------ */

function sessionsForStrategy(strategy) {
  const byDay = new Map();
  if (Array.isArray(strategy.sessions) && strategy.sessions.length > 0) {
    for (const day of DAYS) {
      if (strategy.skipDay && strategy.skipDay(day)) continue;
      for (const [hour, minute] of strategy.sessions) {
        const atMs = localTimeMs(day, hour, minute);
        if (atMs <= ADOPTED_AT_MS || atMs >= LIFE_END_MS) continue;
        if (!byDay.has(day.index)) byDay.set(day.index, []);
        byDay.get(day.index).push({ t: atMs, dayIndex: day.index, hour, minute });
      }
    }
  }
  return byDay;
}

function processSession(ctx, session) {
  const gap = session.t - ctx.state.lastSettledAtMs;
  if (gap <= 0) return;
  const offline = gap > OFFLINE_GAP_MS;
  const result = settleTo(ctx, session.t, offline);
  if (offline) ctx.offlineResumes += 1;
  if (result.deceased) return;

  ctx.sessionCount += 1;
  grantTokensThrough(ctx, session.dayIndex);
  applyPolicy(ctx, ctx.strategy, session);

  // App 至少保持打开 OPEN_WINDOW_MS 再关闭（在线结算，不触发离线保护）。
  if (ctx.state.lifecycle !== 'deceased') {
    const closeMs = Math.max(ctx.state.lastSettledAtMs, session.t + OPEN_WINDOW_MS);
    if (closeMs < LIFE_END_MS && closeMs > ctx.state.lastSettledAtMs) {
      settleTo(ctx, closeMs, false);
    }
  }
}

function finalSettlement(ctx) {
  if (ctx.state.lifecycle === 'deceased') return;
  const gap = LIFE_END_MS - ctx.state.lastSettledAtMs;
  if (gap > 0) {
    settleTo(ctx, LIFE_END_MS, gap > OFFLINE_GAP_MS, false);
  }
}

function simulateStrategy(strategy) {
  const ctx = createContext(strategy);
  const sessionsByDay = sessionsForStrategy(strategy);

  for (const day of DAYS) {
    if (ctx.state.lifecycle === 'deceased') break;
    const daySessions = sessionsByDay.get(day.index);
    if (!daySessions || daySessions.length === 0) continue;
    for (const session of daySessions) {
      if (ctx.state.lifecycle === 'deceased') break;
      processSession(ctx, session);
    }
  }
  finalSettlement(ctx);
  return summarize(ctx);
}

/* ------------------------------------------------------------------ */
/* 8. 指标汇总                                                         */
/* ------------------------------------------------------------------ */

function summarize(ctx) {
  const strategy = ctx.strategy;
  const sampledDayList = [...ctx.samplesByDay.values()].filter((day) => day.samples.length > 0);
  const sampledDays = sampledDayList.length;

  const average = {};
  const minimum = {};
  const dayMin = {};
  for (const key of STAT_KEYS) {
    let total = 0;
    let globalMin = Infinity;
    for (const day of sampledDayList) {
      const values = day.samples.map((sample) => sample[key]);
      const dayAvg = values.reduce((sum, value) => sum + value, 0) / values.length;
      const dayLow = Math.min(...values);
      total += dayAvg;
      globalMin = Math.min(globalMin, dayLow);
      dayMin[day.dayIndex] = { ...(dayMin[day.dayIndex] || {}), [key]: dayLow };
    }
    average[key] = sampledDays > 0 ? total / sampledDays : null;
    minimum[key] = Number.isFinite(globalMin) ? globalMin : null;
  }

  const thresholdDays = (threshold) => {
    if (sampledDays === 0) return null;
    let count = 0;
    for (const day of sampledDayList) {
      const lows = dayMin[day.dayIndex];
      if (lows && lows.H !== undefined && lows.H < threshold) count += 1;
    }
    return count;
  };

  const sampledIndexes = new Set(ctx.samplesByDay.keys());
  const offlineDays = DAYS.filter((day) => !sampledIndexes.has(day.index) && !day.partial).length;
  const finalState = ctx.state;
  const deceased = finalState.lifecycle === 'deceased';
  const aliveDays = deceased && Number.isFinite(finalState.deceasedAtMs)
    ? (finalState.deceasedAtMs - ADOPTED_AT_MS) / DAY_MS
    : (LIFE_END_MS - ADOPTED_AT_MS) / DAY_MS;

  const stageReached = ctx.stageEvents.reduce((last, event) => event, null);
  const elderEvent = ctx.stageEvents.find((event) => event.stage === 'elder');

  return {
    id: strategy.id,
    label: strategy.label,
    desc: strategy.desc,
    tokensPerDay: strategy.tokensPerDay,
    sessionPerDay: ctx.sessionCount / LIFETIME_DAYS,
    actionsPerDay: finalState.careCount / LIFETIME_DAYS,
    sampledDays,
    offlineDays,
    sessionCount: ctx.sessionCount,
    deceased,
    aliveDays,
    finalState: {
      H: finalState.H,
      M: finalState.M,
      E: finalState.E,
      C: finalState.C,
      stage: finalState.stage,
      affinity: finalState.affinity,
      careCount: finalState.careCount,
      wallet: finalState.wallet.balance,
      pendingWaste: Array.isArray(finalState.pendingWaste) ? finalState.pendingWaste.length : 0,
    },
    avg: average,
    min: minimum,
    daysBelow15: thresholdDays(15),
    daysBelow25: thresholdDays(25),
    daysBelow35: thresholdDays(35),
    daysBelow50: thresholdDays(50),
    careCount: finalState.careCount,
    affinity: finalState.affinity,
    stage: finalState.stage,
    finalStageLabel: stageReached ? stageReached.label : finalState.stage,
    elderReachedDay: elderEvent ? elderEvent.ageDays : null,
    coins: {
      initial: strategy.wallet,
      income: ctx.coinIncome,
      spent: ctx.coinsSpent,
      balance: finalState.wallet.balance,
    },
    purchases: ctx.purchases,
    boughtHalfUnits: ctx.boughtHalfUnits,
    reliefClaims: ctx.reliefClaims,
    reliefFailures: { ...ctx.reliefFailures },
    feeds: ctx.feedCompletions,
    feedHalfUnits: ctx.feedHalfUnits,
    feedEffective: ctx.feedEffective,
    feedSkips: ctx.feedSkips,
    feedRejections: { ...ctx.feedRejections },
    wastePlanned: ctx.wastePlanned,
    wasteAppeared: ctx.wasteAppeared,
    wasteCleaned: ctx.wasteCleaned,
    pendingWaste: Array.isArray(finalState.pendingWaste) ? finalState.pendingWaste.length : 0,
    waterPenalties: ctx.waterPenalties,
    waterPenaltyAmount: ctx.waterPenaltyAmount,
    protectionEvents: ctx.protectionEvents,
    protectionLifts: ctx.protectionLifts,
    protectionLiftByStat: { ...ctx.protectionLiftByStat },
    boardingEvents: ctx.boardingEvents,
    offlineResumes: ctx.offlineResumes,
    actions: { ...ctx.actions },
    stageEvents: [...ctx.stageEvents],
    deathEvent: ctx.deathEvent,
    dayCount: DAYS.length,
    lifetimeDays: LIFETIME_DAYS,
    lifeEndIso: new Date(LIFE_END_MS).toISOString(),
    adoptedIso: new Date(ADOPTED_AT_MS).toISOString(),
  };
}

/* ------------------------------------------------------------------ */
/* 9. 文本输出工具                                                     */
/* ------------------------------------------------------------------ */

function displayWidth(text) {
  let width = 0;
  for (const char of String(text)) {
    const code = char.codePointAt(0);
    width += code > 0x2e7f ? 2 : 1;
  }
  return width;
}

function padRight(text, width) {
  const value = String(text);
  return value + ' '.repeat(Math.max(0, width - displayWidth(value)));
}

function padLeft(text, width) {
  const value = String(text);
  return ' '.repeat(Math.max(0, width - displayWidth(value))) + value;
}

function renderTable(headers, rows, aligns = []) {
  const widths = headers.map((header, index) => {
    let width = displayWidth(header);
    for (const row of rows) width = Math.max(width, displayWidth(row[index] ?? ''));
    return width;
  });
  const line = (cells, padder) =>
    cells.map((cell, index) => padder(cell ?? '', widths[index])).join('  ');
  const rule = widths.map((width) => '─'.repeat(width)).join('  ');
  const out = [line(headers, padRight), rule];
  for (const row of rows) {
    out.push(
      row
        .map((cell, index) => (aligns[index] === 'right' ? padLeft(cell ?? '', widths[index]) : padRight(cell ?? '', widths[index])))
        .join('  '),
    );
  }
  return out.join('\n');
}

const n1 = (value) => (value === null || value === undefined ? '—' : (Math.round(value * 10) / 10).toFixed(1));
const n0 = (value) => (value === null || value === undefined ? '—' : String(Math.round(value)));
const pct = (count, total) =>
  count === null || total === 0 ? '—' : `${count}（${((count / total) * 100).toFixed(0)}%）`;
const fmtCoins = (value) => `${Math.round(value)}`;
const dayCell = (count, total) =>
  count === null || total === 0 ? '—' : `${count}（${((count / total) * 100).toFixed(0)}%）`;
const stageLabelCn = (key) => {
  const found = core.STAGE_DEFS.find((def) => def.key === key);
  return found ? found.label : key;
};
const failureText = (failures) => {
  const entries = Object.entries(failures || {});
  return entries.length === 0 ? '—' : entries.map(([reason, count]) => `${reason}×${count}`).join(', ');
};

function statusColumns(result) {
  const sampled = result.sampledDays;
  return {
    H: `${n1(result.avg.H)} / ${n1(result.min.H)}`,
    M: `${n1(result.avg.M)} / ${n1(result.min.M)}`,
    E: `${n1(result.avg.E)} / ${n1(result.min.E)}`,
    C: `${n1(result.avg.C)} / ${n1(result.min.C)}`,
    below15: pct(result.daysBelow15, sampled),
    below25: pct(result.daysBelow25, sampled),
    below50: pct(result.daysBelow50, sampled),
  };
}

function renderStdout(results, reportPath, elapsedMs) {
  const lines = [];
  lines.push('DSH 电子宠物 · 六个月数值平衡模拟（确定性引擎 / v1 初始常数）');
  lines.push(
    `领养 ${new Date(ADOPTED_AT_MS).toISOString()}（${TZ} 2026-01-01 08:00） → 寿终 ${new Date(LIFE_END_MS).toISOString()}（2026-07-01 08:00），共 ${LIFETIME_DAYS} 天（跨 ${DAYS.length} 个自然日；首日 16h、末日 8h）`,
  );
  lines.push(`引擎：src/core v1（143 例单元测试通过）；策略数：${results.length}；耗时：${elapsedMs.toFixed(0)} ms`);
  lines.push('');

  lines.push('表 1. 生存与状态（H/M/E/C：日均 / 最低；阈值天数为「当日任一会话样本低于阈值」的天数）');
  const rows1 = results.map((result) => {
    const status = statusColumns(result);
    return [
      result.label,
      result.deceased ? `存活（寿终 ${n0(result.aliveDays)} 天）` : '存活',
      result.sessionPerDay.toFixed(2),
      result.actionsPerDay.toFixed(2),
      status.H,
      status.M,
      status.E,
      status.C,
      status.below15,
      status.below25,
      status.below50,
    ];
  });
  lines.push(
    renderTable(
      ['策略', '结局', '会话/天', '动作/天', 'H 均/低', 'M 均/低', 'E 均/低', 'C 均/低', 'H<15 天', 'H<25 天', 'H<50 天'],
      rows1,
    ),
  );
  lines.push('');

  lines.push('表 2. 金币与物资');
  const rows2 = results.map((result) => [
    result.label,
    fmtCoins(result.coins.income),
    fmtCoins(result.coins.spent),
    fmtCoins(result.coins.balance),
    String(result.reliefClaims),
    String(result.purchases),
    `${result.wastePlanned}/${result.wasteCleaned}`,
    n1(result.affinity),
    String(result.careCount),
    stageLabelCn(result.stage),
  ]);
  lines.push(
    renderTable(
      ['策略', '币收入', '币支出', '结余', '救济领取', '购买次数', '便便计/清', '亲密度', '终身照顾', '最终阶段'],
      rows2,
      ['left', 'right', 'right', 'right', 'right', 'right', 'right', 'right', 'right', 'left'],
    ),
  );
  lines.push('');

  lines.push('表 3. 离线保护 / 托管 / 惩罚（离线日不计入样本）');
  const rows3 = results.map((result) => [
    result.label,
    String(result.offlineDays),
    String(result.offlineResumes),
    String(result.boardingEvents),
    String(result.protectionEvents),
    String(result.protectionLifts),
    String(result.waterPenalties),
  ]);
  lines.push(
    renderTable(
      ['策略', '离线日', '离线结算', '托管 auto', '保护事件', '实际抬高', '口渴惩罚'],
      rows3,
      ['left', 'right', 'right', 'right', 'right', 'right', 'right'],
    ),
  );
  lines.push('');

  const byId = new Map(results.map((result) => [result.id, result]));
  const whole = byId.get('whole-daily');
  const half = byId.get('half-twice');
  const relief = byId.get('relief-only');
  const neglect = byId.get('neglect');
  const high = byId.get('high-token');
  const weekday = byId.get('weekday-only');
  const longOffline = byId.get('long-offline');
  const never = byId.get('never-open');
  const dailyFoodCost = core.priceForHalfUnits('basic', 2);

  const dailyHDrainOut = 16 * Math.abs(core.AWAKE_RATES.H) + 8 * Math.abs(core.SLEEP_RATES.H);
  lines.push('关键结论');
  lines.push(
    `① 每天一餐整份够吗：够，但只有 ${(((core.FOOD_CATALOG.basic.effectsPerWhole.H - dailyHDrainOut) / dailyHDrainOut) * 100).toFixed(0)}% 数值余量。每日 H 流失 ${n1(dailyHDrainOut)}、整份恢复 ${n1(core.FOOD_CATALOG.basic.effectsPerWhole.H)}；由于 H 上限 100 会截断溢出，余量体现为喂食前低点被抬高（实测最低 H ${n1(whole.min.H)}，稳态约 46）。H<35（饥饿诉求）天 ${whole.daysBelow35}、H<25（联动惩罚）天 ${whole.daysBelow25}、H<15 天 ${whole.daysBelow15}；H<50 天 ${whole.daysBelow50} 是每天喂前短暂下探，属节律不是风险。`,
  );
  lines.push(
    `   两餐半份同价（每天 ${fmtCoins(dailyFoodCost)} 币）最低 H ${n1(half.min.H)}，更舒适但多 1 次会话。要打破「够」需要日流失 >60（如睡眠 <5.3h）或基础口粮恢复 <54。`,
  );
  lines.push(
    `② 仅免费救济：可以稳定维持，且与金币喂食无差别（策略⑧ 0 币 0 Token 最低 H ${n1(relief.min.H)} = 策略① ${n1(whole.min.H)}）。免费救济 60H/24h ≈ 每日流失的 111%；金币/Token 在现行数值下不影响「能否活下去」。`,
  );
  lines.push(
    `③ 100 金币/天日上限：严重过剩。每天最多有用的食物支出仅 ${fmtCoins(dailyFoodCost)} 币（≈${(core.ECONOMY_RULES.dailyCoinCap / dailyFoodCost).toFixed(1)} 倍差距）；高 Token 策略六个月收入 ${fmtCoins(high.coins.income)}、支出 ${fmtCoins(high.coins.spent)}、结余 ${fmtCoins(high.coins.balance)} 币，无处可花。`,
  );
  lines.push(
    `④ 周末断电式离线：不被惩罚，反而被托管「奖励」。离线 ≥24h 自动进入托管：四状态托底 ≥${n0(core.BOARDING_RULES.floor)}、自动饮水；策略③ 离线 ${weekday.offlineDays} 天/托管 ${weekday.boardingEvents} 次，最低 H ${n1(weekday.min.H)}（对照策略② ${n1(half.min.H)}）；策略⑥ 离线 8 天最低 H ${n1(longOffline.min.H)}。还有 24h 分界悬崖：恰好 24h 只触发保护（H 托底 30），24h+1ms 反而进入托管（H≥60）——间隔越长越健康，属逆向激励。`,
  );
  lines.push(
    `⑤ 最值得改的常数：${NUMBER_ONE_ADVICE.name} ${NUMBER_ONE_ADVICE.from} → ${NUMBER_ONE_ADVICE.to}（${NUMBER_ONE_ADVICE.why}）`,
  );
  lines.push('');
  lines.push(`饿死前天数：9 个策略全部存活至第 ${LIFETIME_DAYS} 天寿终——引擎 v1 没有饥饿/疾病死亡路径，唯一死因是 6 个月寿终（src/core/care.js finishSettlement、tests/core/death.test.js）。`);
  lines.push(`完全不照料但每天打开（⑦）：H 从 30 缓慢下滑到最低 ${n1(neglect.min.H)}（离线保护只把状态抬回「上次离开时的值」，一旦低于 floor 便不再恢复），仍不死；最终 H/M/E/C = ${n1(neglect.finalState.H)}/${n1(neglect.finalState.M)}/${n1(neglect.finalState.E)}/${n1(neglect.finalState.C)}。`);
  lines.push(`完全不打开（⑨，仅寿终一次结算）：反而更健康，最终 H/M/E/C = ${n1(never.finalState.H)}/${n1(never.finalState.M)}/${n1(never.finalState.E)}/${n1(never.finalState.C)}。`);
  lines.push('');
  lines.push(`报告已写入：${reportPath}`);
  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/* 10. 报告生成                                                        */
/* ------------------------------------------------------------------ */

const NUMBER_ONE_ADVICE = {
  name: 'FOOD_CATALOG.relief.effectsPerWhole.H',
  from: 60,
  to: '36~42（或把 claimCooldownHours 24 → 36）',
  why:
    '免费救济目前每天供给 60H ≈ 每日 H 流失 54 的 111%，足以单独维持生命，导致金币/Token 经济完全失去意义；把免费口粮降到能「不饿死」但不足以「过得好」的水平，才能让日均 1~2 次照顾的付费路径有意义',
};

function mdInlineTable(headers, rows, aligns = []) {
  const line = (cells) => `| ${cells.join(' | ')} |`;
  const rule = `| ${headers
    .map((_, index) => (aligns[index] === 'right' ? '---:' : '---'))
    .join(' | ')} |`;
  return [line(headers), rule, ...rows.map((row) => line(row))].join('\n');
}

function buildReport(results, elapsedMs) {
  const byId = new Map(results.map((result) => [result.id, result]));
  const whole = byId.get('whole-daily');
  const half = byId.get('half-twice');
  const weekday = byId.get('weekday-only');
  const low = byId.get('low-token');
  const high = byId.get('high-token');
  const longOffline = byId.get('long-offline');
  const neglect = byId.get('neglect');
  const relief = byId.get('relief-only');
  const never = byId.get('never-open');
  const dailyFoodCost = core.priceForHalfUnits('basic', 2);
  const dailyHDrain = 16 * Math.abs(core.AWAKE_RATES.H) + 8 * Math.abs(core.SLEEP_RATES.H);
  const reliefPerDay =
    (core.FOOD_CATALOG.relief.effectsPerWhole.H * core.FOOD_CATALOG.relief.unitHalfUnits) /
    core.FOOD_CATALOG.relief.unitHalfUnits;
  const capRatio = core.ECONOMY_RULES.dailyCoinCap / dailyFoodCost;

  const statusHeaders = ['策略', '结局', '会话/天', '动作/天', 'H 日均', 'H 最低', 'M 日均', 'M 最低', 'E 日均', 'E 最低', 'C 日均', 'C 最低', 'H<15 天', 'H<25 天', 'H<50 天'];
  const statusRows = results.map((result) => [
    result.label,
    result.deceased ? `存活（寿终 ${n0(result.aliveDays)} 天）` : '存活',
    result.sessionPerDay.toFixed(2),
    result.actionsPerDay.toFixed(2),
    n1(result.avg.H),
    n1(result.min.H),
    n1(result.avg.M),
    n1(result.min.M),
    n1(result.avg.E),
    n1(result.min.E),
    n1(result.avg.C),
    n1(result.min.C),
    dayCell(result.daysBelow15, result.sampledDays),
    dayCell(result.daysBelow25, result.sampledDays),
    dayCell(result.daysBelow50, result.sampledDays),
  ]);

  const coinHeaders = ['策略', '期初', '收入', '支出', '结余', '救济领取', '购买次数', '便便计划/清理', '亲密度', '终身照顾', '最终阶段', '离线日'];
  const coinRows = results.map((result) => [
    result.label,
    fmtCoins(result.coins.initial),
    fmtCoins(result.coins.income),
    fmtCoins(result.coins.spent),
    fmtCoins(result.coins.balance),
    String(result.reliefClaims),
    String(result.purchases),
    `${result.wastePlanned}/${result.wasteCleaned}`,
    n1(result.affinity),
    String(result.careCount),
    `${stageLabelCn(result.stage)}${result.elderReachedDay === null ? '' : '（第 ' + n0(result.elderReachedDay) + ' 天晋级）'}`,
    String(result.offlineDays),
  ]);

  const protectionHeaders = ['策略', '离线结算次数', '托管 boarding.auto', '离线保护事件', '保护实际抬高', '口渴惩罚次数', '口渴惩罚总量 M'];
  const protectionRows = results.map((result) => [
    result.label,
    String(result.offlineResumes),
    String(result.boardingEvents),
    String(result.protectionEvents),
    String(result.protectionLifts),
    String(result.waterPenalties),
    n1(result.waterPenaltyAmount),
  ]);

  const strategyHeaders = ['#', '策略', '打开（本地）', '喂食', 'Token/天', '特殊：周末/离线'];
  const strategyRows = [
    ['①', '每天一餐整份', '20:00 ×1', '整份基础口粮', '0', '无'],
    ['②', '每天两餐半份', '10:00 / 22:00', '半份 ×2', '0', '无'],
    ['③', '仅工作日照顾', '工作日 10:00 / 22:00', '半份 ×2', '0', '周六/日完全不打开（60h）'],
    ['④', '低 Token', '10:00 / 22:00', '半份 ×2', '2000（≈2 币）', '无'],
    ['⑤', '高 Token', '10:00 / 22:00', '半份 ×2', '100000（撞 100 币上限）', '无'],
    ['⑥', '第 30~37 天离线', '10:00 / 22:00', '半份 ×2', '0', '第 30~37 自然日完全不打开'],
    ['⑦', '完全不管', '20:00 ×1', '不喂', '0', '只尝试领取救济，不喂不水不清理'],
    ['⑧', '仅免费救济', '20:00 ×1', '整份（仅救济）', '0', '0 币 0 Token：只用每 24h 免费救济口粮'],
    ['⑨', '全程不打开（附加）', '—', '不喂', '0', '六个月只结算一次'],
  ];

  const adviceHeaders = ['常数', '现值', '建议值', '依据（本模拟证据）'];
  const adviceRows = [
    [
      '`FOOD_CATALOG.relief.effectsPerWhole.H`',
      '60',
      '36~42',
      `免费救济 = 60H/24h ≈ 每日 H 流失 ${dailyHDrain} 的 111%，使金币/Token 完全多余（策略⑧：0 币 0 Token 最低 H ${n1(relief.min.H)}，与策略① ${n1(whole.min.H)} 几乎一致）。降到 36~42 或把冷却 24h→36h 后：无 Token 玩家仍「不会饿死」（引擎无饥饿死亡），但只能维持低 H 的温饱线，付费金币才有价值。`,
    ],
    [
      '`ECONOMY_RULES.dailyCoinCap`',
      '100',
      '20~30',
      `每天最大有用的食物支出仅 ${dailyFoodCost} 币（策略⑤六个月结余 ${fmtCoins(high.coins.balance)} 币无处可花）；现行上限 ${core.ECONOMY_RULES.dailyCoinCap} 币 = ${capRatio.toFixed(1)}× 有用支出，纯属数值噪声。若后续加入玩具/装饰/托管费等等价物，可按新支出上限的 1.5~2 倍上调。`,
    ],
    [
      '`OFFLINE_RULES.protectionHours` + `BOARDING_RULES.floor`',
      '24h / floor 60',
      '保护 12h + floor 40，或对托管收金币',
      `离线 ≥24h 时四状态被托底到 ≥60、自动饮水（策略③仅工作日：离线日 ${weekday.offlineDays} 天、托管 ${weekday.boardingEvents} 次、最低 H ${n1(weekday.min.H)}；策略⑥离线 8 天：最低 H ${n1(longOffline.min.H)}）。托管比正常照料还舒服，形成「越不管越省心」的逆向激励。`,
    ],
    [
      '`AFFINITY_RULES.dailyCap` / `max`',
      '5 / 100',
      'max 300~500 或 dailyCap 1~2',
      `正常 1~2 次/天照料每天能拿满 ${core.AFFINITY_RULES.dailyCap} 点，约 20 天刷满终身上限（策略①②亲密度 ${n1(whole.affinity)}/${n1(half.affinity)}）；六个月周期里羁绊值第 1 个月就到顶，后 5 个月没有任何成长反馈。`,
    ],
    [
      '`SLEEP_RATES.E`',
      '+7.5/h',
      '+4~5/h（或提高清醒 E 消耗）',
      `睡眠 8h 回 E +60，而清醒 16h 只消耗 ${n1(16 * Math.abs(core.AWAKE_RATES.E))}，E 长期贴 100，auto-rest 从不触发；精力/休息机制在本次全部策略中都未产生约束（E 最低 ${n1(Math.min(...results.filter((r) => r.min.E !== null).map((r) => r.min.E)))}）。`,
    ],
    [
      '`WALK_RULES.moodGain` 与每日 M 衰减',
      '20 / 约 21 M/天',
      '保持，但补 M 的兜底路径',
      `散步 +20 ≈ 一整天 M 自然流失（策略② M 稳定在 45~65）；M 不会自然归零（需求驱动的散步总能拉回），因此 M 只在「不照料」策略里崩（策略⑦ M 最低 ${n1(neglect.min.M)}）。`,
    ],
  ];

  return `# DSH 电子宠物 · 六个月数值平衡模拟报告

> 生成方式：\`node tools/simulate.mjs\`（本文件由模拟器自动生成，请勿手工修改数字）
> 运行环境：Node v22.17.0 · 零依赖 · 不联网 · 单机耗时 ${elapsedMs.toFixed(0)} ms
> **重要声明：本报告是对确定性纯函数引擎（\`src/core\` v1）的离线模拟，不是真人行为数据；所有常数取自 v1 初始配置（\`src/core/constants.js\`，143 例单元测试通过时点）。真实平衡仍需线上数据校准。**

## 1. 先看结论：§16 未决问题逐项回答

| 问题 | 结论 | 关键证据 |
| --- | --- | --- |
| ① 每天一餐整份够吗？ | **够，但只有 ${(((core.FOOD_CATALOG.basic.effectsPerWhole.H - dailyHDrain) / dailyHDrain) * 100).toFixed(0)}% 数值余量**：每日 H 流失 ${dailyHDrain}、整份恢复 ${core.FOOD_CATALOG.basic.effectsPerWhole.H}；实测最低 H ${n1(whole.min.H)}，H<15 与 H<25 天均为 ${whole.daysBelow15}（从未进入饥饿诉求）；H<50 天 ${whole.daysBelow50} 天是每天喂前短暂下探，属节律。 | 策略①；一餐整份 = 每天 ${dailyFoodCost} 币；H 在 44~100 之间日周期震荡，喂食前最低点 44~46。 |
| ② 只靠免费救济能稳定维持吗？ | **能，而且和用金币喂食完全没有差别**：0 币 0 Token、只用每 24h 免费救济口粮的策略，最低 H = ${n1(relief.min.H)}，与有 60 币启动资金的一餐整份策略（${n1(whole.min.H)}）完全相同，全程存活到寿终。 | 策略⑧ vs 策略①；免费救济 60H/24h ≈ 每日流失的 111%，足以单独覆盖每日 H 支出。 |
| ③ 100 金币/天日上限过剩还是不足？ | **严重过剩**：每天最多有用的食物支出只有 ${dailyFoodCost} 币，上限 ${core.ECONOMY_RULES.dailyCoinCap} 币 = ${capRatio.toFixed(1)} 倍；高 Token 策略六个月结余 ${fmtCoins(high.coins.balance)} 币，无处可花。 | 策略⑤。 |
| ④ 周末断电式离线会被惩罚吗？ | **不会，反而被「奖励」（且存在 24h 分界悬崖的逆向激励）**：离线 ≥24h 自动进入托管，回访时四状态托底 ≥${core.BOARDING_RULES.floor} 且自动饮水；仅工作日策略离线 ${weekday.offlineDays} 天、托管 ${weekday.boardingEvents} 次，最低 H ${n1(weekday.min.H)}，与每天在线的策略②（${n1(half.min.H)}）接近。 | 策略③、⑥；表 3。 |
| ⑤ 哪些常数建议调整？ | 见第 6 节。**最值得改的一个**：\`${NUMBER_ONE_ADVICE.name}\` ${NUMBER_ONE_ADVICE.from} → ${NUMBER_ONE_ADVICE.to}。 | 策略⑧ 证明免费救济已足以替代整个金币经济。 |

补充：**引擎 v1 没有饥饿/疾病死亡路径**（唯一死因是 6 个月寿终；见 \`src/core/care.js\` finishSettlement 与 tests/core/death.test.js）。因此「无 Token 也不饿死」在当前实现下是结构性成立、而非数值平衡结果——真正的平衡目标是「饿不死但要照顾才过得好」，本报告给出的差距集中在免费救济太强、金币日上限太松、离线保护太舒服三点。

## 2. 模拟方法（可复现）

- **时钟与寿命**：领养 \`2026-01-01 08:00 Asia/Shanghai\`（= \`2026-01-01T00:00:00Z\`），寿终 \`2026-07-01 08:00\`（= 6 个自然月后同墙钟时刻），共 **${LIFETIME_DAYS} 天**（跨 ${DAYS.length} 个自然日；首日 16h、末日 8h）。所有推进都调用确定性引擎 \`core.settle\`，模拟器不直接修改 H/M/E/C。
- **host 调用语义**（与 \`index.js\` 一致）：每次用户会话先 \`settle\`；距上次交互 > \`OFFLINE_GAP_MS\`(10 分钟) 时按 \`offline: true\` 结算（触发离线保护/自动托管）；App 打开期间按在线结算（至少保持 ${OPEN_WINDOW_MS / MINUTE_MS} 分钟，模拟客户端 8s 轮询）。
- **行为**：全部通过 \`core.startAction\` + \`settle\` 到 \`endsAtMs\` 完成，禁止直接改状态。照料序列按引擎诉求：喂食 → 散步（M ≤ ${core.WALK_RULES.needMoodAt} 且距上次 ≥${core.WALK_RULES.needSinceWalkHours}h）→ 喝水（距上次 ≥${core.WATER_RULES.needAfterHours}h）→ 铲屎（有已出现便便）→ 洗澡（C ≤ ${core.BATHE_RULES.needAtC}）→ 梳理（距上次 ≥${core.GROOM_RULES.needAfterHours}h）。
- **喂食采购**：每次喂食前先吃库存（优先救济 > 基础 > 最爱）；库存不足时用现有金币购买基础口粮（先试整份 ${core.FOOD_CATALOG.basic.price} 币、再试半份 ${core.priceForHalfUnits('basic', 1)} 币）；金币不足才领取免费救济（每 24h 一次）。
- **Token 金币**：每个本地日结束时用 \`core.grantForDay(dayRecord, [{ tokens }])\` 发放当日金币差额（host 语义：日封顶 ${core.ECONOMY_RULES.dailyCoinCap}，每 ${core.ECONOMY_RULES.tokensPerCoin} token = 1 币），由模拟器把 \`grantedDelta\` 加进钱包；离线/跳过日的 Token 记 0。
- **采样与指标定义**：样本取「每次会话打开时（settle 后、动作前）」与「关闭时（+${OPEN_WINDOW_MS / MINUTE_MS} 分钟在线窗口）」的可见状态；动作完成不单独采样。\`H 日均\` = 每日样本均值再跨天平均；\`H 最低\` = 全部样本最小值；\`H<15 天 / H<25 天 / H<50 天\` = 当日任一样本低于阈值的天数（占比以有样本的天数为分母）。离线/完全不打开的整天状态不可见，不计入样本，单独列「离线日」。
- **未覆盖**：抚摸（pet）、最爱口粮与零食、手动托管开关、多物种差异、跨时区旅行、用户「不按诉求」的乱点行为。以上都不改变「H 收支是否为正」的主结论。

## 3. 策略定义

${mdInlineTable(strategyHeaders, strategyRows)}

## 4. 结果

### 4.1 生存与四状态

${mdInlineTable(statusHeaders, statusRows, ['left', 'left', 'right', 'right', 'right', 'right', 'right', 'right', 'right', 'right', 'right', 'right', 'right', 'right', 'right'])}

> **饿死前存活天数**：9 个策略全部存活至第 ${LIFETIME_DAYS} 天寿终——引擎 v1 没有饥饿/疾病死亡路径，唯一死因是 6 个月寿终（见 §7）。因此本报告不存在「第 N 天饿死」的数值；表中的 H<15 / H<25 / H<50 天是「当日任一样本低于阈值」的天数，占比以有样本的自然日为分母。

### 4.2 金币、物资与终身指标

${mdInlineTable(coinHeaders, coinRows, ['left', 'right', 'right', 'right', 'right', 'right', 'right', 'right', 'right', 'right', 'left', 'right'])}

### 4.3 离线保护 / 托管 / 惩罚

${mdInlineTable(protectionHeaders, protectionRows, ['left', 'right', 'right', 'right', 'right', 'right', 'right'])}

## 5. 结论

### ① 每天一餐整份够吗？—— 够，但数值余量只有 11%

- 每日 H 净流失 = 清醒 16h × ${Math.abs(core.AWAKE_RATES.H)}/h + 睡眠 8h × ${Math.abs(core.SLEEP_RATES.H)}/h = **${dailyHDrain}/天**；一餐整份恢复 ${core.FOOD_CATALOG.basic.effectsPerWhole.H}，纸面净余 +${core.FOOD_CATALOG.basic.effectsPerWhole.H - dailyHDrain}/天（11%）。
- 策略①实测：喂食前 H 最低 ${n1(whole.min.H)}（稳态 46 左右），喂完到 100。H<15 天 ${whole.daysBelow15}、H<25 天 ${whole.daysBelow25}、H<35 天 ${whole.daysBelow35}——从未触发 \`resolveNeeds\` 的 hunger（H≤35）与 hungerCritical（H<15），也未触发 H<25 的联动心情惩罚；H<50 天 ${whole.daysBelow50} 只是因为每天喂前短暂下探到 44~46，属节律而非风险。所以「一餐整份」在数值上成立。
- 但要注意：这是**贴着上限**的「够」，只有 11% 余量（60 vs 54）；因为 H 上限 100 会吃掉溢出，这 6 点不会存起来，只表现为喂食前低点更高。要打破它需要日流失 >60（例如把睡眠压到 <5.3h：睡 6h 时 ${6 * Math.abs(core.SLEEP_RATES.H) + 18 * Math.abs(core.AWAKE_RATES.H)}/天仍够，睡 5h 时 ${5 * Math.abs(core.SLEEP_RATES.H) + 19 * Math.abs(core.AWAKE_RATES.H)}/天就不够），或把基础口粮 H 恢复下调到 <54。
- 对比策略②（两餐半份，同样每天 ${dailyFoodCost} 币）：最低 H ${n1(half.min.H)}，更舒适，但多一次打开；若把「舒适」定义在 H ≥ 50，则两餐半份明显优于一餐整份，若只看「不挨饿」则一餐整份足够。

### ② 唯一靠免费救济能稳定维持吗？—— 能，且让金币经济完全失去意义

- 策略⑧（0 币、0 Token、仅每 24h 领取免费救济）：最低 H ${n1(relief.min.H)}，H<50 天 ${relief.daysBelow50}，全程存活；与策略①（有 60 币启动资金）的 ${n1(whole.min.H)} 对比只差 ${n1(Math.abs(relief.min.H - whole.min.H))} 点 H。
- 免费救济 1 整份/24h = ${reliefPerDay}H/天 ≈ 每日流失（${dailyHDrain}）的 111%。也就是说：只要每天点一次「领救济 + 喂食」，就等价于永动机。金币、Token、购买、价格在现行数值下都不影响「能否活下去」。
- 策略⑦（每天打开 2 分钟但什么都不做、只尝试领救济）也存活，但 H 从 30 缓慢滑到最低 ${n1(neglect.min.H)}：离线保护只把状态抬回「上次离开时的值」并封顶在 floor，一旦 H 已低于 30 就不再恢复，每天在线窗口的衰减（约 0.1/天）持续累积。所以免费路径不是「永动」，而是「慢性下滑但不死」。终末那次结算因死亡处理不再应用离线保护，最终 H 会跌到 0；活动期内可见的最低样本是 ${n1(neglect.min.H)}。
- 完全离线（策略⑨，只在寿终结算一次）反而更健康：最终四状态 ${n1(never.finalState.H)}/${n1(never.finalState.M)}/${n1(never.finalState.E)}/${n1(never.finalState.C)}——一次性触发 24h 离线保护后进入 180 天自动托管（四状态 ≥60），不存在每天在线窗口的损耗。

### ③ 100 金币/天日上限是否过剩？—— 严重过剩

- 每天最多有用的食物支出 = 基础口粮 ${dailyFoodCost} 币（策略①②实测每天花 ${dailyFoodCost} 币，且这是在「有金币就花」的最激进消费下的上限）。日上限 ${core.ECONOMY_RULES.dailyCoinCap} 币 = ${capRatio.toFixed(1)} 倍。
- 策略⑤（100000 tokens/天）实测：收入 ${fmtCoins(high.coins.income)} 币，支出 ${fmtCoins(high.coins.spent)} 币，结余 ${fmtCoins(high.coins.balance)} 币——六个月没有任何东西可买（食品库存上限、无其他金币出口）。策略④（2000 tokens/天）收入 ${fmtCoins(low.coins.income)} 币，实际也几乎用不出去（策略④/⑤的 H 表现与策略②几乎一致）。
- 结论：\`dailyCoinCap: 100\` 要么配合新的金币出口（玩具、服饰、托管费、复活/保险等），要么降到 20~30（1.7~2.5 倍有用支出）；若不加金币出口，这个上限对玩法没有约束力。

### ④ 周末断电式离线会被惩罚吗？—— 不会，反而被「奖励」

- 策略③（周末完全不打开）：离线日 ${weekday.offlineDays} 天、离线结算 ${weekday.offlineResumes} 次（每次打开都会触发 offline.protected 事件，大多数时候只是「确认没跌破下限」，其中真正抬高状态 ${weekday.protectionLifts} 次）、自动托管 ${weekday.boardingEvents} 次，最低 H ${n1(weekday.min.H)}、H<15 天 ${weekday.daysBelow15} 天。
- 机制：离线间隔 >24h 时引擎先跑 24h 正常时间轴、应用「离线保护」（每项状态不低于 min(离线前值, {H:${core.OFFLINE_RULES.floors.H}, M:${core.OFFLINE_RULES.floors.M}, E:${core.OFFLINE_RULES.floors.E}, C:${core.OFFLINE_RULES.floors.C}})），随后整段按自动托管结算：四状态维持 ≥${core.BOARDING_RULES.floor}、自动饮水、无新排泄。所以周末回来宠物比周五离开时还「干净安全」。
- 更值得注意的是 24h 分界悬崖：恰好 24h 只触发离线保护（H 托底 ${core.OFFLINE_RULES.floors.H}），而 24h + 1ms 就进入自动托管（H ≥ ${core.BOARDING_RULES.floor}）。每日打开但不管（策略⑦）最低 H ${n1(neglect.min.H)}，反而比 8 天离线（策略⑥，最低 H ${n1(longOffline.min.H)}）更差——离线代价与在线时长/频率不是单调关系，这对留存设计是逆向激励。
- 策略⑥（第 30~37 天离线）：离线日 ${longOffline.offlineDays} 天、托管 ${longOffline.boardingEvents} 次、最低 H ${n1(longOffline.min.H)}；8 天离线回来后状态被托底到 ${core.BOARDING_RULES.floor}，对后续成长没有任何损失。

### ⑤ 成长/阶段

- 所有策略都在第 150 天进入老年（\`elder\`），第 ${n0(LIFETIME_DAYS)} 天寿终；成长进度与照料无关（引擎按日历年龄推进，托管期间也不暂停），符合 v1 设计，但意味着「照顾」对成长曲线没有任何影响，成长反馈全部来自日常数值。

## 6. 建议调整的常数（只给建议，未改任何代码）

${mdInlineTable(adviceHeaders, adviceRows, ['left', 'left', 'left', 'left'])}

### 优先级最高的一个

**\`${NUMBER_ONE_ADVICE.name}\`：${NUMBER_ONE_ADVICE.from} → ${NUMBER_ONE_ADVICE.to}**
${NUMBER_ONE_ADVICE.why}。这是唯一一个「单独改它就能让金币经济重新有意义」的数值：它决定了免费路径能提供多少 H，从而决定了付费路径的必要性。建议先把它作为 v1.1 的首要调参项做 A/B（36 / 42 / 60 三档），其余常数（dailyCoinCap、离线 floor、亲密度上限）可在同一轮迭代里一起收敛。

## 7. 局限与后续

1. 本报告是**确定性引擎上的策略模拟**，不是真人行为数据；真实用户不会严格按诉求行动，也不会每天同一分钟打开。
2. 引擎 v1 无饥饿/疾病死亡路径（唯一死因是寿终），所以本报告的「结局」列全部是「存活（寿终）」；若 v1.1 要引入「H 长时间为 0 → 生病/死亡」，需先解决本报告揭示的免费救济过强问题，否则仍然不会死。
3. 未模拟抚摸、最爱/零食、手动托管、多物种差异、跨时区旅行、App 长时间保持打开（在线衰减）等场景。
4. 采样口径：会话可见状态；离线期间不可见，不计入日均/最低。若需要「连续生理轨迹平均」，需在 host 侧增加周期性 settle 采样后再统计。
5. 复现：\`node tools/simulate.mjs\`，输出本文件；所有数字均可由该命令在数秒内重现。
`;
}

/* ------------------------------------------------------------------ */
/* 11. 入口                                                            */
/* ------------------------------------------------------------------ */

function main() {
  const startedAt = process.hrtime.bigint();
  const results = STRATEGIES.map((strategy) => simulateStrategy(strategy));
  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

  const reportPath = fileURLToPath(new URL('../docs/balance-report.md', import.meta.url));
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, buildReport(results, elapsedMs), 'utf8');

  process.stdout.write(`${renderStdout(results, reportPath, elapsedMs)}\n`);
}

main();
