/**
 * 核心确定性结算（§5/§6/§8/§10/§13）。
 *
 * settle(state, nowMs, cfg) 是唯一推进时间的入口：
 * 输入“前一状态 + 可信时间段 + 配置”，输出“新状态 + 按时间排序的事件列表”。
 * 引擎绝不逐秒/逐分循环：时间轴只在硬事件点分段结算
 * （作息边界、动作到时、排泄出现/变脏满 4h、饮水惩罚、本地日切、阶段切换、寿终）。
 *
 * 纯函数约束：不读 Date.now()/process.env/fs，时区从 state.tz 取。
 */

import {
  ACTION_ORDER,
  AUTO_REST_RULES,
  AWAKE_RATES,
  BATHE_RULES,
  BOARDING_RULES,
  GROOM_RULES,
  HOUR_MS,
  LINKAGE_RULES,
  MINUTE_MS,
  NEED_KEYS,
  NEED_LABELS,
  NEED_PRIORITIES,
  OFFLINE_RULES,
  PET_RULES,
  SLEEP_RATES,
  STATUS_KEYS,
  WALK_RULES,
  WASTE_RULES,
  WATER_RULES,
} from './constants.js';
import { ageMsAt, lifeEndsAtMs, nextStageBoundaryMs, stageAt } from './growth.js';
import {
  isSleepingAt,
  localDayKey,
  nextBoundaryMs,
  nextLocalMidnightMs,
} from './time.js';
import {
  applyStatusDelta,
  clampStatus,
  cloneState,
  normalizeConfig,
  rollDailyCounters,
  syncLinkageFlags,
} from './state.js';
import {
  applyActionCompletion,
  checkAction,
} from './actions.js';
import { engineError } from './errors.js';

const MAX_LOOP_GUARD = 50_000;

function assertState(state) {
  if (!state || typeof state !== 'object') {
    throw engineError('INVALID_ARGUMENT', 'state is required');
  }
}

function pushEvent(events, event) {
  events.push(event);
}

function sortEvents(events) {
  // Array.prototype.sort 在现代 V8 中是稳定排序，保证同一时刻的事件顺序确定。
  events.sort((a, b) => (Number.isFinite(a.atMs) ? a.atMs : 0) - (Number.isFinite(b.atMs) ? b.atMs : 0));
  return events;
}

function hoursOf(ms) {
  return ms / HOUR_MS;
}

/** 某时刻是否已有“出现满 4h”的排泄（用于联动心情附加衰减）。 */
function hasAgedWaste(state, atMs) {
  const pending = Array.isArray(state.pendingWaste) ? state.pendingWaste : [];
  const ageMs = LINKAGE_RULES.wasteAgeHours * HOUR_MS;
  return pending.some((item) => Number.isFinite(item.atMs) && item.atMs + ageMs <= atMs);
}

/** 清醒时心情联动额外衰减速率（点/小时，合计封顶 1）。 */
function awakeExtraMoodRate(state, atMs) {
  let extra = 0;
  if (state.lowH === true) extra += LINKAGE_RULES.lowHExtraMoodPerHour;
  if (state.lowC === true) extra += LINKAGE_RULES.lowCExtraMoodPerHour;
  if (hasAgedWaste(state, atMs)) extra += LINKAGE_RULES.wasteExtraMoodPerHour;
  return Math.min(extra, LINKAGE_RULES.maxExtraMoodPerHour);
}

/** 从当前值以某速率到达阈值的毫秒数；已越过/不可达返回 0 或 Infinity。 */
function msUntilThreshold(current, target, ratePerHour) {
  if (
    !Number.isFinite(current) ||
    !Number.isFinite(target) ||
    !Number.isFinite(ratePerHour) ||
    ratePerHour === 0
  ) {
    return Infinity;
  }
  const distance = ratePerHour > 0 ? target - current : current - target;
  if (!(distance > 0)) return 0;
  return (distance / Math.abs(ratePerHour)) * HOUR_MS;
}

/** 下一次饮水惩罚时刻（最后一次有效饮水 +36h 起，每 6h 扣 2，累计封顶 8）。 */
function nextWaterPenaltyTickMs(state) {
  if (!Number.isFinite(state.lastWaterAtMs)) return null;
  if (state.waterPenaltyM >= WATER_RULES.maxPenalty) return null;
  const ticksApplied = Math.floor(state.waterPenaltyM / WATER_RULES.penaltyAmount + 1e-9);
  const offsetMs =
    WATER_RULES.penaltyAfterHours * HOUR_MS +
    (ticksApplied + 1) * WATER_RULES.penaltyEveryHours * HOUR_MS;
  return state.lastWaterAtMs + offsetMs;
}

function applyWaterPenaltyOnce(state, tickMs, events) {
  const remaining = WATER_RULES.maxPenalty - state.waterPenaltyM;
  if (remaining <= 0) return false;
  const amount = Math.min(WATER_RULES.penaltyAmount, remaining);
  applyStatusDelta(state, 'M', -amount);
  state.waterPenaltyM += amount;
  events.push({
    type: 'water.penalty',
    atMs: tickMs,
    amount,
    totalPenalty: state.waterPenaltyM,
  });
  return true;
}

function applyOverdueWaterPenalty(state, atMs, events) {
  let guard = 0;
  while (guard < 32) {
    guard += 1;
    const tickMs = nextWaterPenaltyTickMs(state);
    if (tickMs === null || tickMs > atMs) break;
    if (!applyWaterPenaltyOnce(state, tickMs, events)) break;
  }
}

function applyOverdueWasteAppearance(state, atMs, events) {
  const pending = Array.isArray(state.pendingWaste) ? state.pendingWaste : [];
  for (const waste of pending) {
    if (waste.penalized === true) continue;
    if (!(Number.isFinite(waste.atMs) && waste.atMs <= atMs)) continue;
    waste.penalized = true;
    const cleanDelta = applyStatusDelta(state, 'C', -WASTE_RULES.appearanceCleanPenalty);
    events.push({
      type: 'waste.appeared',
      atMs: waste.atMs,
      wasteId: waste.id,
      cleanDelta,
    });
  }
}

function syncSleeping(state, atMs, cfg, events) {
  const sleeping = isSleepingAt(atMs, cfg);
  if (sleeping === state.sleeping) return;
  state.sleeping = sleeping;
  if (sleeping) state.resting = false;
  events.push({ type: sleeping ? 'sleep.start' : 'sleep.end', atMs });
}

function syncStage(state, atMs, events) {
  const ageMs = ageMsAt(state.adoptedAtMs, atMs);
  const target = stageAt(ageMs);
  if (state.stage === target.key) return;
  const previous = state.stage;
  state.stage = target.key;
  events.push({
    type: 'stage.changed',
    atMs,
    previous,
    stage: target.key,
    label: target.label,
    ageMs,
  });
}

/* ------------------------------------------------------------------ */
/* 时间轴模拟                                                          */
/* ------------------------------------------------------------------ */

function applySleepFragment(state, durationMs) {
  if (!(durationMs > 0)) return;
  const hours = hoursOf(durationMs);
  state.H = clampStatus(state.H + SLEEP_RATES.H * hours);
  state.M = clampStatus(state.M + SLEEP_RATES.M * hours);
  state.E = clampStatus(state.E + SLEEP_RATES.E * hours);
  state.C = clampStatus(state.C + SLEEP_RATES.C * hours);
  syncLinkageFlags(state);
}

/**
 * 清醒片段结算：按 E=20/40（自动休息）、H=25、C=30（联动阈值）切分子段，
 * 保证联动附加衰减与休息恢复的分段积分精确。
 */
function applyAwakeFragment(state, startAtMs, durationMs) {
  let remaining = durationMs;
  let guard = 0;
  while (remaining > 1e-6) {
    guard += 1;
    if (guard > 1_000) {
      // 数值极端情况兜底：按当前速率一次性结算剩余，不改变语义方向。
      remaining = 0;
      break;
    }
    if (state.E <= AUTO_REST_RULES.triggerBelow) state.resting = true;
    else if (state.resting && state.E >= AUTO_REST_RULES.recoverAt) state.resting = false;

    let step = remaining;
    if (state.resting) {
      step = Math.min(
        step,
        msUntilThreshold(state.E, AUTO_REST_RULES.recoverAt, AUTO_REST_RULES.restorePerHour),
      );
    } else {
      step = Math.min(
        step,
        msUntilThreshold(state.E, AUTO_REST_RULES.triggerBelow, -AWAKE_RATES.E),
      );
    }
    step = Math.min(step, msUntilThreshold(state.H, LINKAGE_RULES.lowHThreshold, -AWAKE_RATES.H));
    step = Math.min(step, msUntilThreshold(state.C, LINKAGE_RULES.lowCThreshold, -AWAKE_RATES.C));
    if (!Number.isFinite(step) || step <= 0) step = remaining;

    const span = Math.min(step, remaining);
    const hours = hoursOf(span);
    const extraMood = awakeExtraMoodRate(state, startAtMs);
    state.H = clampStatus(state.H + AWAKE_RATES.H * hours);
    state.M = clampStatus(state.M + (AWAKE_RATES.M - extraMood) * hours);
    state.E = clampStatus(
      state.E +
        (state.resting ? AUTO_REST_RULES.restorePerHour : AWAKE_RATES.E) * hours,
    );
    state.C = clampStatus(state.C + AWAKE_RATES.C * hours);
    remaining -= span;
    syncLinkageFlags(state);
  }
  // 片段结束时同步休息标记：正好休息到 E>=40 的边界也要立刻结束休息态。
  if (state.resting && state.E >= AUTO_REST_RULES.recoverAt) state.resting = false;
  else if (state.E <= AUTO_REST_RULES.triggerBelow) state.resting = true;
}

/** 计算下一个硬事件时刻（严格大于 cursor，且不超过 limit）。 */
function nextEventTime(state, cursor, limit, cfg, exclusiveEnd) {
  let next = limit;
  const consider = (candidate) => {
    if (!Number.isFinite(candidate)) return;
    if (candidate <= cursor) return;
    if (candidate < next) next = candidate;
  };
  consider(nextBoundaryMs(cursor, cfg));
  if (state.activeAction) consider(state.activeAction.endsAtMs);
  for (const waste of state.pendingWaste || []) {
    if (!Number.isFinite(waste.atMs)) continue;
    if (waste.penalized !== true) consider(waste.atMs);
    consider(waste.atMs + LINKAGE_RULES.wasteAgeHours * HOUR_MS);
  }
  consider(nextWaterPenaltyTickMs(state));
  consider(nextLocalMidnightMs(cursor, cfg.tz));
  consider(nextStageBoundaryMs(state.adoptedAtMs, cursor));
  return next;
}

/**
 * 正常（非托管）时间轴模拟 [fromMs, toMs)。
 * toMs 是寿终时刻时 exclusiveEnd=true：恰在寿终瞬间到点的动作不再结算。
 */
function simulateTimeline(state, fromMs, toMs, cfg, events, options = {}) {
  if (!(toMs > fromMs)) return;
  const exclusiveEnd = options.exclusiveEnd === true;
  let cursor = fromMs;
  let guard = 0;

  // 起点之前已到期的动作：补算完成（承诺效果不取消）。
  if (state.activeAction && state.activeAction.endsAtMs <= cursor) {
    applyActionCompletion(state, state.activeAction, cursor, cfg, events);
  }
  // 起点之前已到期的惩罚（正常不会发生，防御性补算）。
  applyOverdueWasteAppearance(state, cursor, events);
  applyOverdueWaterPenalty(state, cursor, events);
  if (rollDailyCounters(state, localDayKey(cursor, cfg.tz))) {
    events.push({ type: 'day.rolled', atMs: cursor, dayKey: state.daily.dayKey });
  }
  syncStage(state, cursor, events);

  while (cursor < toMs) {
    guard += 1;
    if (guard > MAX_LOOP_GUARD) {
      throw engineError('SETTLE_LOOP_GUARD', 'settle timeline exceeded iteration guard');
    }
    syncSleeping(state, cursor, cfg, events);
    const sleeping = state.sleeping === true;

    const next = nextEventTime(state, cursor, toMs, cfg, exclusiveEnd);
    const segEnd = next > cursor ? next : toMs;
    const span = segEnd - cursor;
    if (span > 0) {
      if (sleeping) applySleepFragment(state, span);
      else applyAwakeFragment(state, cursor, span);
      cursor = segEnd;
    }

    if (cursor >= toMs && exclusiveEnd) break;
    if (cursor >= toMs) {
      // 收尾：处理恰在终点到点的事件（包含终点动作完成）。
      processInstantEvents(state, cursor, cfg, events);
      break;
    }
    processInstantEvents(state, cursor, cfg, events);
  }
}

/** 处理恰好在 atMs 到点的离散事件（动作完成/排泄出现/饮水惩罚/跨日/阶段）。 */
function processInstantEvents(state, atMs, cfg, events) {
  if (state.activeAction && state.activeAction.endsAtMs <= atMs) {
    applyActionCompletion(state, state.activeAction, atMs, cfg, events);
  }
  applyOverdueWasteAppearance(state, atMs, events);
  applyOverdueWaterPenalty(state, atMs, events);
  if (rollDailyCounters(state, localDayKey(atMs, cfg.tz))) {
    events.push({ type: 'day.rolled', atMs, dayKey: state.daily.dayKey });
  }
  syncStage(state, atMs, events);
}

/* ------------------------------------------------------------------ */
/* 托管 / 离线保护                                                     */
/* ------------------------------------------------------------------ */

function applyOfflineProtection(state, snapshot, atMs, events) {
  const floors = OFFLINE_RULES.floors;
  const applied = [];
  for (const key of STATUS_KEYS) {
    const startValue = Number.isFinite(snapshot[key]) ? snapshot[key] : 0;
    const target = Math.min(startValue, floors[key]);
    if (state[key] < target) {
      const before = state[key];
      state[key] = target;
      applied.push({ stat: key, before, after: target });
    }
  }
  events.push({
    type: 'offline.protected',
    atMs,
    floors: { ...floors },
    applied,
  });
}

/**
 * 托管区间结算：
 * - 不自然衰减，四状态维持 >=60；
 * - 自动喂水（区间结束时视为已饮水）；
 * - 无新排泄、无主动诉求；
 * - 已开始动作的承诺效果照常结算（按原始结束时刻）；
 * - 成长/阶段/跨日照常推进（生命周期不暂停）。
 */
function simulateBoardingRange(state, fromMs, toMs, cfg, events, options = {}) {
  if (!(toMs > fromMs)) return;
  const isAuto = options.auto === true;

  // 阶段边界逐一推进（数量有限）。
  let boundary = nextStageBoundaryMs(state.adoptedAtMs, fromMs);
  while (boundary !== null && boundary <= toMs) {
    syncStage(state, boundary, events);
    boundary = nextStageBoundaryMs(state.adoptedAtMs, boundary);
  }

  // 离线前已开始的动作：到点后结算承诺效果。
  if (state.activeAction) {
    const actionEnd = state.activeAction.endsAtMs;
    if (actionEnd < toMs) {
      syncStage(state, actionEnd, events);
      applyActionCompletion(state, state.activeAction, actionEnd, cfg, events);
    }
  }

  for (const key of STATUS_KEYS) {
    state[key] = clampStatus(Math.max(state[key], BOARDING_RULES.floor));
  }
  state.lastWaterAtMs = toMs;
  state.waterPenaltyM = 0;
  state.waterRewardedAtMs = toMs;
  state.resting = false;

  if (rollDailyCounters(state, localDayKey(toMs, state.tz))) {
    events.push({ type: 'day.rolled', atMs: toMs, dayKey: state.daily.dayKey });
  }
  if (isAuto) {
    events.push({ type: 'boarding.auto', atMs: fromMs, endMs: toMs });
  }
}

/* ------------------------------------------------------------------ */
/* 收尾                                                                */
/* ------------------------------------------------------------------ */

function finishSettlement(state, params) {
  const { nowMs, deathAtMs, cfg, events } = params;
  const endMs = deathAtMs !== null ? deathAtMs : nowMs;

  if (deathAtMs !== null && deathAtMs <= nowMs) {
    if (state.activeAction) {
      const action = state.activeAction;
      state.activeAction = null;
      events.push({
        type: 'action.cancelled',
        atMs: deathAtMs,
        actionId: action.id,
        actionType: action.type,
        reason: 'PET_DECEASED',
      });
    }
    state.stage = stageAt(ageMsAt(state.adoptedAtMs, deathAtMs)).key;
    state.lifecycle = 'deceased';
    state.deceasedAtMs = deathAtMs;
    state.sleeping = false;
    state.resting = false;
    events.push({
      type: 'pet.deceased',
      atMs: deathAtMs,
      ageMs: ageMsAt(state.adoptedAtMs, deathAtMs),
      stage: state.stage,
    });
  } else {
    syncSleeping(state, endMs, cfg, events);
    syncStage(state, endMs, events);
    if (rollDailyCounters(state, localDayKey(endMs, state.tz))) {
      events.push({ type: 'day.rolled', atMs: endMs, dayKey: state.daily.dayKey });
    }
  }
  state.lastSettledAtMs = nowMs;
}

/**
 * 核心结算：从 lastSettledAtMs 推进到 nowMs。
 * @param {object} state 前一状态（不会被修改）
 * @param {number} nowMs 调用方提供的时间戳
 * @param {object} cfg {sleepStart,sleepEnd,offline}
 * @returns {{state: object, events: Array, deceased: boolean}}
 */
export function settle(state, nowMs, cfg = {}) {
  assertState(state);
  if (!Number.isFinite(nowMs)) {
    throw engineError('INVALID_ARGUMENT', 'nowMs must be a finite number', { field: 'nowMs' });
  }
  const config = normalizeConfig(cfg, state.tz);

  if (state.lifecycle === 'deceased') {
    const lastSettledAtMs = Math.max(state.lastSettledAtMs ?? nowMs, nowMs);
    return {
      state: { ...state, lastSettledAtMs },
      events: [],
      deceased: true,
    };
  }

  const startMs = state.lastSettledAtMs;
  if (!(nowMs > startMs)) {
    return { state, events: [], deceased: false };
  }

  const next = cloneState(state);
  const events = [];
  const snapshot = { H: next.H, M: next.M, E: next.E, C: next.C };

  const lifeEnd = Number.isFinite(next.lifeEndsAtMs)
    ? next.lifeEndsAtMs
    : lifeEndsAtMs(next.adoptedAtMs, next.tz);
  next.lifeEndsAtMs = lifeEnd;
  const deathAtMs = nowMs >= lifeEnd ? lifeEnd : null;
  const settleEndMs = deathAtMs !== null ? deathAtMs : nowMs;
  next.lifeEndsAtMs = lifeEnd;

  // 起点状态同步（防御 host 注入的过期派生字段）。
  next.sleeping = isSleepingAt(startMs, config);
  if (next.sleeping) next.resting = false;
  syncLinkageFlags(next);

  if (next.mode === 'boarding') {
    simulateBoardingRange(next, startMs, settleEndMs, config, events, { auto: false });
    finishSettlement(next, { nowMs, deathAtMs, cfg: config, events });
    sortEvents(events);
    return { state: next, events, deceased: next.lifecycle === 'deceased' };
  }

  if (config.offline === true) {
    const protectionMs = OFFLINE_RULES.protectionHours * HOUR_MS;
    const protectionEndMs = Math.min(settleEndMs, startMs + protectionMs);
    const protectionExclusive = deathAtMs !== null && deathAtMs === protectionEndMs;
    simulateTimeline(next, startMs, protectionEndMs, config, events, {
      exclusiveEnd: protectionExclusive,
    });
    if (settleEndMs > protectionEndMs) {
      applyOfflineProtection(next, snapshot, protectionEndMs, events);
      simulateBoardingRange(next, protectionEndMs, settleEndMs, config, events, {
        auto: true,
      });
    } else if (deathAtMs === null) {
      applyOfflineProtection(next, snapshot, protectionEndMs, events);
    }
  } else {
    simulateTimeline(next, startMs, settleEndMs, config, events, {
      exclusiveEnd: deathAtMs !== null,
    });
  }

  finishSettlement(next, { nowMs, deathAtMs, cfg: config, events });
  sortEvents(events);
  return { state: next, events, deceased: next.lifecycle === 'deceased' };
}

/* ------------------------------------------------------------------ */
/* 诉求 / 可用操作 / 抚摸 / 托管开关                                   */
/* ------------------------------------------------------------------ */

/**
 * 当前诉求优先级（§8）。不结算、不修改状态，host 在 settle 之后调用。
 * @returns {{need:(string|null), priority:number, needs:Array}}
 */
export function resolveNeeds(state, nowMs, cfg = {}) {
  assertState(state);
  if (!Number.isFinite(nowMs)) {
    throw engineError('INVALID_ARGUMENT', 'nowMs must be a finite number', { field: 'nowMs' });
  }
  if (state.lifecycle === 'deceased' || state.mode === 'boarding') {
    return { need: null, priority: 0, needs: [] };
  }
  const needs = [];
  const sinceWaterMs = nowMs - state.lastWaterAtMs;

  // 1) 休息（精力不足由引擎自动休息，但仍可作为最高优先诉求表达）
  if (state.E < AUTO_REST_RULES.triggerBelow) {
    needs.push({
      key: 'rest',
      label: NEED_LABELS.rest,
      priority: NEED_PRIORITIES.rest,
      triggeredAtMs: nowMs,
    });
  }

  // 2) 饥饿：H<15 高优先，H<=35 普通
  if (state.H < 15) {
    needs.push({
      key: 'hunger',
      label: NEED_LABELS.hunger,
      priority: NEED_PRIORITIES.hungerCritical,
      triggeredAtMs: nowMs,
    });
  } else if (state.H <= 35) {
    needs.push({
      key: 'hunger',
      label: NEED_LABELS.hunger,
      priority: NEED_PRIORITIES.hunger,
      triggeredAtMs: nowMs,
    });
  }

  // 3) 饮水：>24h 高优先，>18h 普通
  if (sinceWaterMs >= WATER_RULES.highPriorityAfterHours * HOUR_MS) {
    needs.push({
      key: 'water',
      label: NEED_LABELS.water,
      priority: NEED_PRIORITIES.waterCritical,
      triggeredAtMs: state.lastWaterAtMs + WATER_RULES.highPriorityAfterHours * HOUR_MS,
    });
  } else if (sinceWaterMs >= WATER_RULES.needAfterHours * HOUR_MS) {
    needs.push({
      key: 'water',
      label: NEED_LABELS.water,
      priority: NEED_PRIORITIES.water,
      triggeredAtMs: state.lastWaterAtMs + WATER_RULES.needAfterHours * HOUR_MS,
    });
  }

  // 4) 排泄：已出现的排泄优先处理（按最早出现时间）
  const presentWaste = (Array.isArray(state.pendingWaste) ? state.pendingWaste : [])
    .filter((item) => Number.isFinite(item.atMs) && item.atMs <= nowMs)
    .sort((a, b) => a.atMs - b.atMs);
  if (presentWaste.length > 0) {
    needs.push({
      key: 'waste',
      label: NEED_LABELS.waste,
      priority: NEED_PRIORITIES.waste,
      triggeredAtMs: presentWaste[0].atMs,
    });
  }

  // 5) 清洁：C<=50 洗澡
  if (state.C <= BATHE_RULES.needAtC) {
    needs.push({
      key: 'bathe',
      label: NEED_LABELS.bathe,
      priority: NEED_PRIORITIES.bathe,
      triggeredAtMs: nowMs,
    });
  }

  // 6) 逛街：心情 <=45 且距上次逛街 >=20h
  if (
    state.M <= WALK_RULES.needMoodAt &&
    nowMs - state.lastWalkAtMs >= WALK_RULES.needSinceWalkHours * HOUR_MS
  ) {
    needs.push({
      key: 'walk',
      label: NEED_LABELS.walk,
      priority: NEED_PRIORITIES.walk,
      triggeredAtMs: state.lastWalkAtMs + WALK_RULES.needSinceWalkHours * HOUR_MS,
    });
  }

  // 7) 护理：距上次护理 >=72h
  if (nowMs - state.lastGroomAtMs >= GROOM_RULES.needAfterHours * HOUR_MS) {
    needs.push({
      key: 'groom',
      label: NEED_LABELS.groom,
      priority: NEED_PRIORITIES.groom,
      triggeredAtMs: state.lastGroomAtMs + GROOM_RULES.needAfterHours * HOUR_MS,
    });
  }

  needs.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    if (a.triggeredAtMs !== b.triggeredAtMs) return a.triggeredAtMs - b.triggeredAtMs;
    return NEED_KEYS.indexOf(a.key) - NEED_KEYS.indexOf(b.key);
  });

  const primary = needs.length > 0 ? needs[0] : null;
  return {
    need: primary ? primary.key : null,
    priority: primary ? primary.priority : 0,
    needs,
  };
}

/**
 * 六项操作当前是否可用（与 startAction 的条件校验共用同一实现）。
 * @returns {Array<{type:string, enabled:boolean, reason:(string|null)}>}
 */
export function availableActions(state, nowMs, cfg = {}) {
  assertState(state);
  if (!Number.isFinite(nowMs)) {
    throw engineError('INVALID_ARGUMENT', 'nowMs must be a finite number', { field: 'nowMs' });
  }
  const config = normalizeConfig(cfg, state.tz);
  return ACTION_ORDER.map((type) => {
    const result = checkAction(state, type, nowMs, config);
    return {
      type,
      enabled: result.enabled === true,
      reason: result.reason === null || result.reason === undefined ? null : result.reason,
    };
  });
}

/** 抚摸（§7.1）：M+2，30min 冷却，每日最多 5 次有效。内部先 settle。 */
export function pet(state, nowMs, cfg = {}) {
  assertState(state);
  if (!Number.isFinite(nowMs)) {
    throw engineError('INVALID_ARGUMENT', 'nowMs must be a finite number', { field: 'nowMs' });
  }
  if (state.lifecycle === 'deceased') {
    return { ok: false, state, error: 'PET_DECEASED', events: [] };
  }
  if (state.mode === 'boarding') {
    return { ok: false, state, error: 'BOARDING', events: [] };
  }
  const settled = settle(state, nowMs, cfg);
  const events = [...settled.events];
  if (settled.deceased) {
    return { ok: false, state: settled.state, error: 'PET_DECEASED', events };
  }
  const next = cloneState(settled.state);
  const lastPetAtMs = Number.isFinite(next.lastPetAtMs) ? next.lastPetAtMs : null;
  if (
    lastPetAtMs !== null &&
    nowMs - lastPetAtMs < PET_RULES.cooldownMinutes * MINUTE_MS
  ) {
    return { ok: false, state: next, error: 'ON_COOLDOWN', events };
  }
  next.daily = next.daily || {};
  if (Math.floor(next.daily.pettingRewards || 0) >= PET_RULES.dailyLimit) {
    return { ok: false, state: next, error: 'DAILY_LIMIT', events };
  }
  const moodGain = applyStatusDelta(next, 'M', PET_RULES.moodGain);
  next.lastPetAtMs = nowMs;
  next.daily.pettingRewards = Math.floor(next.daily.pettingRewards || 0) + 1;
  events.push({ type: 'pet.reward', atMs: nowMs, moodGain });
  return { ok: true, state: next, error: null, events };
}

/**
 * 开启/结束“主动托管”（§10.2 手动托管）。
 * 开启：立即维持 >=60、视为已饮水、取消进行中动作（释放预留）；
 * 结束：随时可结束，之后恢复自然衰减。
 */
export function setBoarding(state, enabled, nowMs, cfg = {}) {
  assertState(state);
  if (!Number.isFinite(nowMs)) {
    throw engineError('INVALID_ARGUMENT', 'nowMs must be a finite number', { field: 'nowMs' });
  }
  if (state.lifecycle === 'deceased') {
    return { ok: false, state, error: 'PET_DECEASED', events: [] };
  }
  const settled = settle(state, nowMs, cfg);
  const events = [...settled.events];
  if (settled.deceased) {
    return { ok: false, state: settled.state, error: 'PET_DECEASED', events };
  }
  const config = normalizeConfig(cfg, settled.state.tz);

  if (enabled === true) {
    if (settled.state.mode === 'boarding') {
      return { ok: false, state: settled.state, error: 'ALREADY_BOARDING', events };
    }
    const next = cloneState(settled.state);
    if (next.activeAction) {
      const action = next.activeAction;
      next.activeAction = null;
      events.push({
        type: 'action.cancelled',
        atMs: nowMs,
        actionId: action.id,
        actionType: action.type,
        reason: 'BOARDING_STARTED',
      });
    }
    next.mode = 'boarding';
    next.boardingSinceMs = nowMs;
    for (const key of STATUS_KEYS) {
      next[key] = clampStatus(Math.max(next[key], BOARDING_RULES.floor));
    }
    next.lastWaterAtMs = nowMs;
    next.waterPenaltyM = 0;
    next.waterRewardedAtMs = nowMs;
    next.sleeping = isSleepingAt(nowMs, config);
    next.resting = false;
    next.lastSettledAtMs = Math.max(next.lastSettledAtMs, nowMs);
    events.push({ type: 'boarding.started', atMs: nowMs });
    sortEvents(events);
    return { ok: true, state: next, error: null, events };
  }

  if (settled.state.mode !== 'boarding') {
    return { ok: false, state: settled.state, error: 'NOT_BOARDING', events };
  }
  const next = cloneState(settled.state);
  next.mode = 'normal';
  next.boardingSinceMs = null;
  next.sleeping = isSleepingAt(nowMs, config);
  next.resting = false;
  next.lastSettledAtMs = Math.max(next.lastSettledAtMs, nowMs);
  events.push({ type: 'boarding.ended', atMs: nowMs });
  sortEvents(events);
  return { ok: true, state: next, error: null, events };
}

