/**
 * 六项操作合同（§7）：开始（预留资源/串行/冷却/条件）→ 到点完成结算效果 → 取消释放预留。
 *
 * 设计：
 * - 开始动作只“预留”资源，不扣库存/不立刻加状态；效果统一在完成时刻结算
 *   （由 settle 的时间轴驱动，或 host 在动作结束后来一次 settle）。
 * - 动作在开始后即占用 activeAction（串行），同一时刻只有一个动作。
 * - 完成/取消都由本模块导出，care.js 的时间轴按“动作结束时刻”调用。
 */

import {
  ACTION_DURATION_MS,
  ACTION_ORDER,
  BATHE_RULES,
  FEED_RULES,
  FOOD_CATALOG,
  GROOM_RULES,
  HOUR_MS,
  WALK_RULES,
  WASTE_RULES,
  WATER_RULES,
} from './constants.js';
import { effectsForHalfUnits, getFood, portionError } from './economy.js';
import {
  applyStatusDelta,
  cloneState,
  grantAffinity,
  normalizeConfig,
  rollDailyCounters,
} from './state.js';
import { isSleepingAt, localDayKey, nextBoundaryMs } from './time.js';
import { engineError } from './errors.js';

/** 冷却是否已就绪；从未执行过（last <= adoptedAtMs）视为就绪。 */
export function cooldownReady(lastAtMs, nowMs, cooldownHours, adoptedAtMs = null) {
  const threshold = cooldownHours * HOUR_MS;
  if (!Number.isFinite(lastAtMs)) return true;
  if (Number.isFinite(adoptedAtMs) && lastAtMs <= adoptedAtMs) return true;
  return nowMs - lastAtMs >= threshold;
}

/** 距冷却结束还有多少毫秒（0 表示就绪）。 */
export function cooldownRemainingMs(lastAtMs, nowMs, cooldownHours, adoptedAtMs = null) {
  const threshold = cooldownHours * HOUR_MS;
  if (!Number.isFinite(lastAtMs)) return 0;
  if (Number.isFinite(adoptedAtMs) && lastAtMs <= adoptedAtMs) return 0;
  return Math.max(0, threshold - (nowMs - lastAtMs));
}

/** 喂水是否会产生“有效效果”（6h 冷却内仍可喝，只是不加心情）。 */
export function waterEffective(state, nowMs) {
  const rewardedAtMs = Number.isFinite(state.waterRewardedAtMs)
    ? state.waterRewardedAtMs
    : null;
  if (rewardedAtMs === null) return true;
  return nowMs - rewardedAtMs >= WATER_RULES.cooldownHours * HOUR_MS;
}

function pickUsableFeedItem(state) {
  const inventory = state.inventory && typeof state.inventory === 'object' ? state.inventory : {};
  let blockedReason = 'ITEM_MISSING';
  for (const food of Object.values(FOOD_CATALOG)) {
    if (food.inventory !== true) continue;
    const stock = Math.floor(inventory[food.id] || 0);
    if (stock < 1) continue;
    if (food.dailyLimit && (state.daily ? state.daily.snacksUsed || 0 : 0) >= food.dailyLimit) {
      blockedReason = 'DAILY_LIMIT';
      continue;
    }
    const halfUnits = food.splittable ? Math.min(stock, food.unitHalfUnits) : food.unitHalfUnits;
    if (stock < halfUnits) continue;
    if (portionError(food, halfUnits) !== null) continue;
    return { itemId: food.id, halfUnits };
  }
  return { itemId: null, halfUnits: null, reason: blockedReason };
}

/**
 * 单项操作的条件校验。startAction 与 availableActions 共用，保证两者永远一致。
 * @returns {{enabled:boolean, reason:(string|null), itemId?, halfUnits?, effective?}}
 */
export function checkAction(state, type, nowMs, cfg = {}, options = {}) {
  if (!state || typeof state !== 'object') {
    throw engineError('INVALID_ARGUMENT', 'state is required');
  }
  if (state.lifecycle === 'deceased') return { enabled: false, reason: 'PET_DECEASED' };
  if (state.mode === 'boarding') return { enabled: false, reason: 'BOARDING' };
  if (!ACTION_ORDER.includes(type)) return { enabled: false, reason: 'UNKNOWN_ACTION' };
  if (state.activeAction) return { enabled: false, reason: 'BUSY' };

  switch (type) {
    case 'feed': {
      let itemId = options.itemId;
      let halfUnits = options.halfUnits;
      if (itemId === undefined || itemId === null) {
        const picked = pickUsableFeedItem(state);
        if (!picked.itemId) return { enabled: false, reason: picked.reason };
        itemId = picked.itemId;
        halfUnits = halfUnits === undefined || halfUnits === null ? picked.halfUnits : halfUnits;
      }
      const food = getFood(itemId);
      if (!food || food.inventory !== true) return { enabled: false, reason: 'ITEM_MISSING' };
      const requested =
        halfUnits === undefined || halfUnits === null ? food.unitHalfUnits : halfUnits;
      const invalidPortion = portionError(food, requested);
      if (invalidPortion !== null) return { enabled: false, reason: invalidPortion };
      const stock = Math.floor(
        state.inventory && state.inventory[food.id] ? state.inventory[food.id] : 0,
      );
      if (stock < requested) return { enabled: false, reason: 'ITEM_MISSING' };
      if (state.H > 100 - FEED_RULES.minHungerDeficit) {
        return { enabled: false, reason: 'NOT_HUNGRY' };
      }
      if (
        food.dailyLimit &&
        (state.daily ? state.daily.snacksUsed || 0 : 0) >= food.dailyLimit
      ) {
        return { enabled: false, reason: 'DAILY_LIMIT' };
      }
      return { enabled: true, reason: null, itemId: food.id, halfUnits: requested };
    }
    case 'water':
      return { enabled: true, reason: null, effective: waterEffective(state, nowMs) };
    case 'walk': {
      if (state.H < WALK_RULES.minHunger) return { enabled: false, reason: 'TOO_HUNGRY' };
      if (state.E < WALK_RULES.minEnergy) return { enabled: false, reason: 'LOW_ENERGY' };
      if (!cooldownReady(state.lastWalkAtMs, nowMs, WALK_RULES.cooldownHours, state.adoptedAtMs)) {
        return { enabled: false, reason: 'ON_COOLDOWN' };
      }
      return { enabled: true, reason: null };
    }
    case 'bathe': {
      if (state.C >= BATHE_RULES.tooCleanAtC) return { enabled: false, reason: 'TOO_CLEAN' };
      if (state.E < BATHE_RULES.minEnergy) return { enabled: false, reason: 'LOW_ENERGY' };
      if (!cooldownReady(state.lastBatheAtMs, nowMs, BATHE_RULES.cooldownHours, state.adoptedAtMs)) {
        return { enabled: false, reason: 'ON_COOLDOWN' };
      }
      return { enabled: true, reason: null };
    }
    case 'groom': {
      if (state.E < GROOM_RULES.minEnergy) return { enabled: false, reason: 'LOW_ENERGY' };
      if (!cooldownReady(state.lastGroomAtMs, nowMs, GROOM_RULES.cooldownHours, state.adoptedAtMs)) {
        return { enabled: false, reason: 'ON_COOLDOWN' };
      }
      return { enabled: true, reason: null };
    }
    case 'cleanWaste': {
      const pending = Array.isArray(state.pendingWaste) ? state.pendingWaste : [];
      if (!pending.some((item) => Number.isFinite(item.atMs) && item.atMs <= nowMs)) {
        return { enabled: false, reason: 'NO_WASTE' };
      }
      return { enabled: true, reason: null };
    }
    default:
      return { enabled: false, reason: 'UNKNOWN_ACTION' };
  }
}

/**
 * 开始一个操怍。
 * @param {object} state
 * @param {{type:string,itemId?:string,halfUnits?:number}} cmd
 * @param {number} nowMs 由 host 传入，引擎不读时钟
 * @param {object} cfg {sleepStart,sleepEnd,offline}
 * @returns {{ok:boolean, state:object, error:(string|null)}}
 */
export function startAction(state, cmd = {}, nowMs, cfg = {}) {
  if (!state || typeof state !== 'object') {
    throw engineError('INVALID_ARGUMENT', 'state is required');
  }
  if (!Number.isFinite(nowMs)) return { ok: false, state, error: 'INVALID_ARGUMENT' };
  const type = cmd && cmd.type;
  const config = normalizeConfig(cfg, state.tz);
  const check = checkAction(state, type, nowMs, config, {
    itemId: cmd && cmd.itemId,
    halfUnits: cmd && cmd.halfUnits,
  });
  if (!check.enabled) return { ok: false, state, error: check.reason };
  if (!ACTION_ORDER.includes(type)) return { ok: false, state, error: 'UNKNOWN_ACTION' };

  const next = cloneState(state);
  rollDailyCounters(next, localDayKey(nowMs, state.tz));
  const durationMs = ACTION_DURATION_MS[type];

  let itemId = null;
  let halfUnits = null;
  let reserved = null;
  let effective = true;
  if (type === 'feed') {
    itemId = check.itemId;
    halfUnits = check.halfUnits;
    reserved = { itemId, halfUnits };
  } else if (type === 'water') {
    itemId = 'water';
    effective = check.effective === true;
  }

  next.activeAction = {
    id: `act-${type}-${nowMs}`,
    type,
    startedAtMs: nowMs,
    endsAtMs: nowMs + durationMs,
    itemId,
    halfUnits,
    reserved,
    effective,
  };
  return { ok: true, state: next, error: null };
}

/**
 * 取消进行中的动作：释放预留（库存从未扣除，无需返还），不影响状态。
 */
export function cancelAction(state, nowMs, cfg = {}) {
  if (!state || typeof state !== 'object') {
    throw engineError('INVALID_ARGUMENT', 'state is required');
  }
  if (state.lifecycle === 'deceased') {
    return { ok: false, state, error: 'PET_DECEASED', events: [] };
  }
  if (!state.activeAction) {
    return { ok: false, state, error: 'NO_ACTIVE_ACTION', events: [] };
  }
  const next = cloneState(state);
  const action = next.activeAction;
  next.activeAction = null;
  return {
    ok: true,
    state: next,
    error: null,
    events: [
      {
        type: 'action.cancelled',
        atMs: nowMs,
        actionId: action.id,
        actionType: action.type,
        reason: 'CANCELLED',
      },
    ],
  };
}

/**
 * 排泄规划：有效主食累计恢复 H>=20（本地日近似）→ 延迟 2h 出现；
 * 若出现时刻在睡眠中则顺延到醒来；同一本地日最多规划一份，场上最多 2 份。
 * 返回是否新增。
 */
export function planWasteIfNeeded(state, atMs, cfg, events) {
  const config = normalizeConfig(cfg, state.tz);
  const dayKey = localDayKey(atMs, state.tz);
  if (state.lastWastePlannedDayKey === dayKey) return false;
  const pending = Array.isArray(state.pendingWaste) ? state.pendingWaste : [];
  if (pending.length >= WASTE_RULES.maxCount) return false;

  const dueAtMs = atMs + WASTE_RULES.delayMs;
  let appearAtMs = dueAtMs;
  if (isSleepingAt(dueAtMs, config)) {
    const wakeBoundary = nextBoundaryMs(dueAtMs, config);
    if (wakeBoundary !== null && wakeBoundary > dueAtMs) appearAtMs = wakeBoundary;
  }
  const seq = Math.max(0, Math.floor(state.wasteSeq || 0)) + 1;
  const waste = { id: `w${seq}`, atMs: appearAtMs, plannedAtMs: atMs, penalized: false };
  state.wasteSeq = seq;
  state.pendingWaste = [...pending, waste];
  state.lastWastePlannedDayKey = dayKey;
  if (Array.isArray(events)) {
    events.push({
      type: 'waste.planned',
      atMs,
      wasteId: waste.id,
      appearAtMs,
    });
  }
  return true;
}

/**
 * 动作到点完成：结算效果、扣库存、加羁绊/照护数、必要时安排排泄。
 * 内部使用：直接修改传入的 state（调用方负责 clone 与事件排序）。
 * @returns {{effective:boolean, deltas:object, affinityGained:number}}
 */
export function applyActionCompletion(state, action, atMs, cfg = {}, events = []) {
  const config = normalizeConfig(cfg, state.tz);
  rollDailyCounters(state, localDayKey(atMs, state.tz));
  const type = action.type;
  const deltas = { H: 0, M: 0, E: 0, C: 0 };
  let effective = false;
  let affinityGained = 0;
  let staplePlanPending = false;

  const addStatus = (key, delta) => {
    deltas[key] = applyStatusDelta(state, key, delta);
  };
  const markEffect = () => {
    effective = true;
    affinityGained = grantAffinity(state, FEED_RULES.affinity);
    state.careCount = Math.max(0, Math.floor(state.careCount || 0)) + 1;
  };

  switch (type) {
    case 'feed': {
      const food = getFood(action.itemId);
      if (!food || food.inventory !== true) {
        state.activeAction = null;
        events.push({
          type: 'action.failed',
          atMs,
          actionId: action.id,
          actionType: type,
          reason: 'ITEM_MISSING',
        });
        return { effective: false, deltas, affinityGained: 0 };
      }
      const halfUnits = Number.isInteger(action.halfUnits) ? action.halfUnits : food.unitHalfUnits;
      const inventory = state.inventory && typeof state.inventory === 'object' ? state.inventory : {};
      const stock = Math.floor(inventory[food.id] || 0);
      if (stock < halfUnits || portionError(food, halfUnits) !== null) {
        state.activeAction = null;
        events.push({
          type: 'action.failed',
          atMs,
          actionId: action.id,
          actionType: type,
          reason: 'ITEM_MISSING',
        });
        return { effective: false, deltas, affinityGained: 0 };
      }
      const inventoryNext = { ...inventory };
      inventoryNext[food.id] = stock - halfUnits;
      if (inventoryNext[food.id] <= 0) delete inventoryNext[food.id];
      state.inventory = inventoryNext;

      const effects = effectsForHalfUnits(food.id, halfUnits) || { H: 0, M: 0, E: 0, C: 0 };
      for (const key of Object.keys(deltas)) addStatus(key, effects[key] || 0);

      if (food.staple === true) {
        state.foodRecoveredToday = Math.max(0, Math.floor(state.foodRecoveredToday || 0)) +
          Math.max(0, deltas.H);
        if (state.foodRecoveredToday >= WASTE_RULES.foodRecoverThresholdH) staplePlanPending = true;
      }
      if (food.dailyLimit) {
        state.daily = state.daily || {};
        state.daily.snacksUsed = Math.max(0, Math.floor(state.daily.snacksUsed || 0)) + 1;
      }
      if (deltas.H > 0 || deltas.M > 0) markEffect();
      break;
    }
    case 'water': {
      // 喝水本身永远解渴（重置口渴计时与惩罚累计），但心情加成受 6h 冷却限制。
      state.lastWaterAtMs = atMs;
      state.waterPenaltyM = 0;
      if (action.effective === true) {
        addStatus('M', WATER_RULES.moodGain);
        state.waterRewardedAtMs = atMs;
        if (deltas.M > 0) markEffect();
      }
      break;
    }
    case 'bathe': {
      addStatus('C', BATHE_RULES.cleanGain);
      addStatus('M', BATHE_RULES.moodGain);
      addStatus('E', -BATHE_RULES.energyCost);
      state.lastBatheAtMs = atMs;
      if (deltas.C > 0 || deltas.M > 0) markEffect();
      break;
    }
    case 'groom': {
      addStatus('C', GROOM_RULES.cleanGain);
      addStatus('M', GROOM_RULES.moodGain);
      addStatus('E', -GROOM_RULES.energyCost);
      state.lastGroomAtMs = atMs;
      if (deltas.C > 0 || deltas.M > 0) markEffect();
      break;
    }
    case 'walk': {
      addStatus('M', WALK_RULES.moodGain);
      addStatus('E', -WALK_RULES.energyCost);
      addStatus('C', -WALK_RULES.cleanCost);
      state.lastWalkAtMs = atMs;
      if (deltas.M > 0 || deltas.E < 0 || deltas.C < 0) {
        effective = true;
        affinityGained = grantAffinity(state, WALK_RULES.affinity);
        state.careCount = Math.max(0, Math.floor(state.careCount || 0)) + 1;
      }
      break;
    }
    case 'cleanWaste': {
      const pending = Array.isArray(state.pendingWaste) ? state.pendingWaste : [];
      const present = pending.filter((item) => Number.isFinite(item.atMs) && item.atMs <= atMs);
      if (present.length > 0) {
        state.pendingWaste = pending.filter(
          (item) => !(Number.isFinite(item.atMs) && item.atMs <= atMs),
        );
        addStatus('M', WASTE_RULES.cleanMoodBonus);
        effective = true;
        affinityGained = grantAffinity(state, WASTE_RULES.affinity);
        state.careCount = Math.max(0, Math.floor(state.careCount || 0)) + 1;
        events.push({
          type: 'waste.cleaned',
          atMs,
          actionId: action.id,
          count: present.length,
          moodGain: deltas.M,
        });
      }
      break;
    }
    default:
      break;
  }

  state.activeAction = null;
  events.push({
    type: 'action.completed',
    atMs,
    actionId: action.id,
    actionType: type,
    itemId: action.itemId,
    halfUnits: action.halfUnits,
    effective,
    deltas,
    affinityGained,
  });

  if (staplePlanPending) {
    planWasteIfNeeded(state, atMs, config, events);
  }
  return { effective, deltas, affinityGained };
}
