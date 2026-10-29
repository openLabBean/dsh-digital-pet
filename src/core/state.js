/**
 * 状态工厂 / 校验 / 夹紧 / 通用状态变更辅助。纯函数。
 *
 * state 是 host 持久化的唯一权威对象：
 * - 宠物字段 + wallet/inventory/daily（host 每次调用前注入、调用后拆出单独持久化）；
 * - 引擎返回值一律为新对象，不修改入参（settle/startAction/… 都先 clone）。
 */

import {
  AFFINITY_RULES,
  CONFIG_VERSION,
  DEFAULT_CONFIG,
  INITIAL_STATUS,
  LINKAGE_RULES,
  SCHEMA_VERSION,
  STATUS_KEYS,
  STATUS_MAX,
  STATUS_MIN,
} from './constants.js';
import { isSleepingAt, localDayKey } from './time.js';
import { lifeEndsAtMs, stageAt } from './growth.js';
import { assertFiniteMs, assertTimeZone, engineError } from './errors.js';
import { grantFirstGift } from './economy.js';

export function cloneState(state) {
  if (typeof structuredClone === 'function') return structuredClone(state);
  return JSON.parse(JSON.stringify(state));
}

/** 状态值夹紧到 [0,100]；非数字按 0 处理。 */
export function clampStatus(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return STATUS_MIN;
  if (value < STATUS_MIN) return STATUS_MIN;
  if (value > STATUS_MAX) return STATUS_MAX;
  return value;
}

function clampNumber(value, min, max, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function toInt(value, fallback = 0) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.floor(value);
}

/** 新的一天（保留跨天有效的救济冷却时间戳）。 */
export function freshDaily(dayKey = null, previous = null) {
  return {
    dayKey,
    eligibleTokens: 0,
    grantedCoins: 0,
    snacksUsed: 0,
    pettingRewards: 0,
    affinityGained: 0,
    reliefLastClaimedAtMs:
      previous && Number.isFinite(previous.reliefLastClaimedAtMs)
        ? previous.reliefLastClaimedAtMs
        : null,
  };
}

/**
 * 跨日滚动：dayKey 变化时重置当日计数（foodRecoveredToday 等），
 * 保留 lastWastePlannedDayKey 用于“同一本地日最多规划一份”的判断。
 * @returns {boolean} 是否发生了跨日
 */
export function rollDailyCounters(state, dayKey) {
  if (!state || typeof dayKey !== 'string' || dayKey.length === 0) return false;
  if (state.daily && state.daily.dayKey === dayKey) return false;
  state.daily = freshDaily(dayKey, state.daily);
  state.foodRecoveredToday = 0;
  return true;
}

/** 羁绊值增长（日上限 5、总上限 100），返回实际增加量。 */
export function grantAffinity(state, amount) {
  if (!(amount > 0)) return 0;
  const dailyGained =
    state.daily && Number.isFinite(state.daily.affinityGained) ? state.daily.affinityGained : 0;
  const dailyRoom = Math.max(0, AFFINITY_RULES.dailyCap - dailyGained);
  const lifetimeRoom = Math.max(0, AFFINITY_RULES.max - state.affinity);
  const added = Math.min(amount, dailyRoom, lifetimeRoom);
  if (added > 0) {
    state.affinity = Math.min(AFFINITY_RULES.max, state.affinity + added);
    state.daily.affinityGained = dailyGained + added;
  }
  return added;
}

/** 对单个状态施加增量，返回实际变化量（已夹紧）。 */
export function applyStatusDelta(state, key, delta) {
  const before = Number.isFinite(state[key]) ? state[key] : 0;
  const after = clampStatus(before + (Number.isFinite(delta) ? delta : 0));
  state[key] = after;
  return after - before;
}

/**
 * 联动迟滞标记（§5.1）：
 * - H<=25 置 lowH，H>=35 清除；
 * - C<=30 置 lowC，C>=40 清除；
 * 中间区保持上一次状态，避免阈值抖动。
 */
export function syncLinkageFlags(state) {
  if (state.H >= LINKAGE_RULES.lowHRecover) state.lowH = false;
  else if (state.H <= LINKAGE_RULES.lowHThreshold) state.lowH = true;

  if (state.C >= LINKAGE_RULES.lowCRecover) state.lowC = false;
  else if (state.C <= LINKAGE_RULES.lowCThreshold) state.lowC = true;
}

/** 合并默认运行配置；tz 优先用显式传入。 */
export function normalizeConfig(cfg = {}, tz) {
  const merged = { ...DEFAULT_CONFIG, ...(cfg && typeof cfg === 'object' ? cfg : {}) };
  const zone = typeof tz === 'string' && tz.length > 0 ? tz : merged.tz;
  if (typeof zone === 'string' && zone.length > 0) merged.tz = zone;
  return merged;
}

function normalizeWalletInput(input) {
  if (typeof input === 'number' && Number.isFinite(input)) {
    return { balance: Math.max(0, Math.floor(input)) };
  }
  if (input && typeof input === 'object' && Number.isFinite(input.balance)) {
    return { balance: Math.max(0, Math.floor(input.balance)) };
  }
  return { balance: 0 };
}

function normalizeInventoryInput(input) {
  const out = {};
  if (!input || typeof input !== 'object') return out;
  for (const [itemId, halfUnits] of Object.entries(input)) {
    if (typeof itemId !== 'string' || itemId.length === 0) continue;
    const value = Math.max(0, toInt(halfUnits, 0));
    if (value > 0) out[itemId] = value;
  }
  return out;
}

function normalizeDailyInput(input, fallbackDayKey) {
  const base = freshDaily(fallbackDayKey, input && typeof input === 'object' ? input : null);
  if (!input || typeof input !== 'object') return base;
  return {
    ...base,
    dayKey: typeof input.dayKey === 'string' ? input.dayKey : base.dayKey,
    eligibleTokens: Math.max(0, toInt(input.eligibleTokens, 0)),
    grantedCoins: Math.max(0, toInt(input.grantedCoins, 0)),
    snacksUsed: Math.max(0, toInt(input.snacksUsed, 0)),
    pettingRewards: Math.max(0, toInt(input.pettingRewards, 0)),
    affinityGained: Math.max(0, toInt(input.affinityGained, 0)),
  };
}

/**
 * 初始状态工厂。
 * @param {object} options
 * @param {string} options.petId
 * @param {string} [options.speciesId='whale']
 * @param {string} [options.nickname='']
 * @param {number} options.adoptedAtMs
 * @param {string} options.tz IANA 时区
 * @param {number} [options.configVersion]
 * @param {boolean} [options.firstGiftGranted=false] host 传入 profile 级标志
 * @param {number|{balance:number}} [options.wallet]
 * @param {Object<string,number>} [options.inventory] 半份单位
 * @param {{dayKey?:string}} [options.daily]
 * @param {number|null} [options.sleepStart] 地方时间分钟数
 * @param {number|null} [options.sleepEnd]
 */
export function createInitialState(options = {}) {
  const {
    petId,
    speciesId = 'whale',
    nickname = '',
    adoptedAtMs,
    tz,
    configVersion = CONFIG_VERSION,
  } = options;
  if (typeof petId !== 'string' || petId.length === 0) {
    throw engineError('INVALID_ARGUMENT', 'petId must be a non-empty string', { field: 'petId' });
  }
  if (typeof speciesId !== 'string' || speciesId.length === 0) {
    throw engineError('INVALID_ARGUMENT', 'speciesId must be a non-empty string', {
      field: 'speciesId',
    });
  }
  assertFiniteMs(adoptedAtMs, 'adoptedAtMs');
  assertTimeZone(tz);

  const sleepCfg = normalizeConfig(
    {
      sleepStart:
        options.sleepStart === undefined ? DEFAULT_CONFIG.sleepStart : options.sleepStart,
      sleepEnd: options.sleepEnd === undefined ? DEFAULT_CONFIG.sleepEnd : options.sleepEnd,
    },
    tz,
  );
  const adoptedDayKey = localDayKey(adoptedAtMs, tz);
  const state = {
    schemaVersion: SCHEMA_VERSION,
    configVersion,
    petId,
    speciesId,
    nickname: typeof nickname === 'string' ? nickname : String(nickname ?? ''),
    adoptedAtMs,
    tz,
    lifeEndsAtMs: lifeEndsAtMs(adoptedAtMs, tz),

    H: INITIAL_STATUS.H,
    M: INITIAL_STATUS.M,
    E: INITIAL_STATUS.E,
    C: INITIAL_STATUS.C,

    mode: 'normal',
    boardingSinceMs: null,
    sleeping: isSleepingAt(adoptedAtMs, sleepCfg),
    resting: false,
    lifecycle: 'alive',
    deceasedAtMs: null,
    stage: stageAt(0).key,
    visible: true,

    lastSettledAtMs: adoptedAtMs,
    lastWaterAtMs: adoptedAtMs,
    lastBatheAtMs: adoptedAtMs,
    lastGroomAtMs: adoptedAtMs,
    lastWalkAtMs: adoptedAtMs,
    lastPetAtMs: null,

    pendingWaste: [],
    wasteSeq: 0,
    activeAction: null,
    foodRecoveredToday: 0,
    lastWastePlannedDayKey: null,

    affinity: clampNumber(options.affinity, 0, AFFINITY_RULES.max, 0),
    careCount: Math.max(0, toInt(options.careCount, 0)),

    waterRewardedAtMs: null,
    waterPenaltyM: 0,
    lowH: false,
    lowC: false,

    firstGiftGranted: options.firstGiftGranted === true,

    wallet: normalizeWalletInput(options.wallet),
    inventory: normalizeInventoryInput(options.inventory),
    daily: normalizeDailyInput(options.daily, adoptedDayKey),
  };

  if (!state.firstGiftGranted) {
    const granted = grantFirstGift(state);
    if (granted.ok) return granted.state;
  }
  return state;
}

/**
 * 规整/补全 state（用于 host 注入旧持久化数据时的防御）。
 * 不改变合法数据；缺失字段补默认，越界数值夹紧。
 */
export function normalizeState(input, nowMs) {
  if (!input || typeof input !== 'object') {
    throw engineError('INVALID_ARGUMENT', 'state must be an object');
  }
  const state = cloneState(input);
  assertFiniteMs(state.adoptedAtMs, 'state.adoptedAtMs');
  assertTimeZone(state.tz);

  state.schemaVersion = state.schemaVersion || SCHEMA_VERSION;
  state.configVersion = Number.isInteger(state.configVersion)
    ? state.configVersion
    : CONFIG_VERSION;
  state.petId = String(state.petId ?? '');
  state.speciesId = String(state.speciesId ?? 'whale');
  state.nickname = String(state.nickname ?? '');
  state.lifeEndsAtMs = Number.isFinite(state.lifeEndsAtMs)
    ? state.lifeEndsAtMs
    : lifeEndsAtMs(state.adoptedAtMs, state.tz);

  for (const key of STATUS_KEYS) {
    state[key] = clampStatus(
      state[key] === undefined ? INITIAL_STATUS[key] : state[key],
    );
  }

  state.mode = state.mode === 'boarding' ? 'boarding' : 'normal';
  state.boardingSinceMs = Number.isFinite(state.boardingSinceMs)
    ? state.boardingSinceMs
    : state.mode === 'boarding'
      ? state.adoptedAtMs
      : null;
  state.lifecycle = state.lifecycle === 'deceased' ? 'deceased' : 'alive';
  state.deceasedAtMs = Number.isFinite(state.deceasedAtMs) ? state.deceasedAtMs : null;
  state.stage = typeof state.stage === 'string' ? state.stage : stageAt(0).key;
  state.visible = state.visible !== false;
  state.sleeping = state.sleeping === true;
  state.resting = state.resting === true;

  for (const key of [
    'lastSettledAtMs',
    'lastWaterAtMs',
    'lastBatheAtMs',
    'lastGroomAtMs',
    'lastWalkAtMs',
  ]) {
    state[key] = Number.isFinite(state[key]) ? state[key] : state.adoptedAtMs;
  }
  state.lastPetAtMs = Number.isFinite(state.lastPetAtMs) ? state.lastPetAtMs : null;
  state.waterRewardedAtMs = Number.isFinite(state.waterRewardedAtMs)
    ? state.waterRewardedAtMs
    : null;
  state.waterPenaltyM = clampNumber(state.waterPenaltyM, 0, 8, 0);
  state.lowH = state.lowH === true;
  state.lowC = state.lowC === true;
  state.firstGiftGranted = state.firstGiftGranted === true;
  state.affinity = clampNumber(state.affinity, 0, AFFINITY_RULES.max, 0);
  state.careCount = Math.max(0, toInt(state.careCount, 0));
  state.foodRecoveredToday = Math.max(0, toInt(state.foodRecoveredToday, 0));
  state.lastWastePlannedDayKey =
    typeof state.lastWastePlannedDayKey === 'string' ? state.lastWastePlannedDayKey : null;
  state.wasteSeq = Math.max(0, toInt(state.wasteSeq, 0));
  state.wallet = normalizeWalletInput(state.wallet);
  state.inventory = normalizeInventoryInput(state.inventory);
  state.daily = normalizeDailyInput(
    state.daily,
    localDayKey(Number.isFinite(nowMs) ? nowMs : state.lastSettledAtMs, state.tz),
  );

  state.pendingWaste = Array.isArray(state.pendingWaste)
    ? state.pendingWaste
        .filter((item) => item && Number.isFinite(item.atMs))
        .map((item, index) => ({
          id: typeof item.id === 'string' ? item.id : `w${index + 1}`,
          atMs: item.atMs,
          plannedAtMs: Number.isFinite(item.plannedAtMs) ? item.plannedAtMs : item.atMs,
          penalized: item.penalized === true,
        }))
    : [];
  if (state.pendingWaste.length > 2) {
    state.pendingWaste = state.pendingWaste
      .slice()
      .sort((a, b) => a.atMs - b.atMs)
      .slice(0, 2);
  }
  if (state.pendingWaste.length > 0) {
    state.wasteSeq = Math.max(
      state.wasteSeq,
      ...state.pendingWaste.map((item) => {
        const match = /^w(\d+)$/.exec(item.id || '');
        return match ? Number(match[1]) : 0;
      }),
    );
  }

  state.activeAction = normalizeActiveAction(state.activeAction);
  return state;
}

function normalizeActiveAction(action) {
  if (!action || typeof action !== 'object') return null;
  const type = typeof action.type === 'string' ? action.type : null;
  if (!type) return null;
  const startedAtMs = Number.isFinite(action.startedAtMs) ? action.startedAtMs : null;
  const endsAtMs = Number.isFinite(action.endsAtMs) ? action.endsAtMs : null;
  if (startedAtMs === null || endsAtMs === null) return null;
  return {
    id: typeof action.id === 'string' ? action.id : `act-${type}-${startedAtMs}`,
    type,
    startedAtMs,
    endsAtMs,
    itemId: typeof action.itemId === 'string' ? action.itemId : null,
    halfUnits: Number.isFinite(action.halfUnits) ? action.halfUnits : null,
    reserved: action.reserved && typeof action.reserved === 'object' ? { ...action.reserved } : null,
    effective: action.effective === true,
  };
}

/** 结构校验（只报问题，不做修改）。 */
export function validateState(state) {
  const errors = [];
  if (!state || typeof state !== 'object') {
    return { ok: false, errors: [{ field: 'state', message: 'state must be an object' }] };
  }
  for (const field of ['petId', 'speciesId', 'nickname', 'tz']) {
    if (typeof state[field] !== 'string') {
      errors.push({ field, message: 'must be a string' });
    }
  }
  for (const field of ['adoptedAtMs', 'lifeEndsAtMs', 'lastSettledAtMs']) {
    if (!Number.isFinite(state[field])) errors.push({ field, message: 'must be a finite ms' });
  }
  for (const key of STATUS_KEYS) {
    const value = state[key];
    if (!Number.isFinite(value)) {
      errors.push({ field: key, message: 'must be a finite number' });
    } else if (value < STATUS_MIN || value > STATUS_MAX) {
      errors.push({ field: key, message: 'must be within [0,100]' });
    }
  }
  if (!state.wallet || !Number.isInteger(state.wallet.balance) || state.wallet.balance < 0) {
    errors.push({ field: 'wallet.balance', message: 'must be a non-negative integer' });
  }
  if (!state.inventory || typeof state.inventory !== 'object') {
    errors.push({ field: 'inventory', message: 'must be an object' });
  } else {
    for (const [itemId, halfUnits] of Object.entries(state.inventory)) {
      if (!Number.isInteger(halfUnits) || halfUnits < 0) {
        errors.push({
          field: `inventory.${itemId}`,
          message: 'must be a non-negative integer (half units)',
        });
      }
    }
  }
  if (!state.daily || typeof state.daily.dayKey !== 'string') {
    errors.push({ field: 'daily.dayKey', message: 'must be a string' });
  }
  if (!Array.isArray(state.pendingWaste)) {
    errors.push({ field: 'pendingWaste', message: 'must be an array' });
  } else if (state.pendingWaste.length > 2) {
    errors.push({ field: 'pendingWaste', message: 'must contain at most 2 entries' });
  }
  if (!['normal', 'boarding'].includes(state.mode)) {
    errors.push({ field: 'mode', message: "must be 'normal' or 'boarding'" });
  }
  if (!['alive', 'deceased'].includes(state.lifecycle)) {
    errors.push({ field: 'lifecycle', message: "must be 'alive' or 'deceased'" });
  }
  return { ok: errors.length === 0, errors };
}
