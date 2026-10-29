/**
 * 金币经济与食品目录校验（§9）。纯函数：不读时钟、不碰存储。
 *
 * 金币规则：每 1000 token = 1 金币，日封顶 100，只发差额、不结转。
 * 食品一律以“半份”为库存单位：basic/favorite/relief 可拆半份，snack 必须整份。
 */

import {
  ECONOMY_RULES,
  FOOD_CATALOG,
  HOUR_MS,
} from './constants.js';
import { engineError } from './errors.js';

function cloneState(state) {
  if (typeof structuredClone === 'function') return structuredClone(state);
  return JSON.parse(JSON.stringify(state));
}

/** 当日 token 对应的总金币档位（0..100）。 */
export function tokensToCoins(tokens) {
  const value = typeof tokens === 'number' && Number.isFinite(tokens) ? Math.floor(tokens) : 0;
  if (value <= 0) return 0;
  const coins = Math.floor(value / ECONOMY_RULES.tokensPerCoin);
  return Math.max(0, Math.min(ECONOMY_RULES.dailyCoinCap, coins));
}

function bucketTokens(bucket) {
  if (typeof bucket === 'number') {
    return bucket > 0 ? Math.floor(bucket) : 0;
  }
  if (bucket && typeof bucket === 'object') {
    if (bucket.eligible === false) return 0;
    for (const key of ['tokens', 'eligibleTokens', 'totalTokens', 'tokenCount']) {
      const value = bucket[key];
      if (typeof value === 'number' && Number.isFinite(value)) {
        return value > 0 ? Math.floor(value) : 0;
      }
    }
  }
  return 0;
}

/**
 * 按天结算金币差额。
 * @param {{dayKey:string, eligibleTokens:number, grantedCoins:number}} dayRecord 前一日累计（已被 host 持久化）
 * @param {Array<number|{tokens:number, eligible?:boolean}>} usageBuckets 本次新增的 token 用量（已由 host 去重）
 * @returns {{dayKey, eligibleTokens, grantedCoins, grantedDelta, addedTokens, capped}}
 */
export function grantForDay(dayRecord, usageBuckets = []) {
  const base = dayRecord && typeof dayRecord === 'object' ? dayRecord : {};
  const dayKey = typeof base.dayKey === 'string' ? base.dayKey : null;
  const eligibleBefore =
    typeof base.eligibleTokens === 'number' && Number.isFinite(base.eligibleTokens)
      ? Math.max(0, Math.floor(base.eligibleTokens))
      : 0;
  const grantedBefore =
    typeof base.grantedCoins === 'number' && Number.isFinite(base.grantedCoins)
      ? Math.max(0, Math.floor(base.grantedCoins))
      : 0;
  const buckets = Array.isArray(usageBuckets)
    ? usageBuckets
    : usageBuckets === undefined || usageBuckets === null
      ? []
      : [usageBuckets];
  let addedTokens = 0;
  for (const bucket of buckets) {
    addedTokens += bucketTokens(bucket);
  }
  const eligibleTokens = eligibleBefore + addedTokens;
  const targetGranted = tokensToCoins(eligibleTokens);
  const grantedDelta = Math.max(0, targetGranted - grantedBefore);
  return {
    dayKey,
    eligibleTokens,
    grantedCoins: grantedBefore + grantedDelta,
    grantedDelta,
    addedTokens,
    capped: targetGranted >= ECONOMY_RULES.dailyCoinCap,
  };
}

/** 查食品定义；未知 id 返回 null。 */
export function getFood(itemId) {
  if (typeof itemId !== 'string') return null;
  return Object.prototype.hasOwnProperty.call(FOOD_CATALOG, itemId)
    ? FOOD_CATALOG[itemId]
    : null;
}

/** 半份数合法性校验，返回错误码或 null。 */
export function portionError(food, halfUnits) {
  if (!food || food.inventory !== true) return 'ITEM_MISSING';
  if (typeof halfUnits !== 'number' || !Number.isInteger(halfUnits) || halfUnits <= 0) {
    return 'INVALID_PORTION';
  }
  if (food.splittable === true) {
    if (halfUnits > food.unitHalfUnits) return 'INVALID_PORTION';
    return null;
  }
  if (halfUnits !== food.unitHalfUnits) return 'INVALID_PORTION';
  return null;
}

/** 半份数 -> 价格；非法返回 null。 */
export function priceForHalfUnits(itemId, halfUnits) {
  const food = getFood(itemId);
  if (!food || food.inventory !== true) return null;
  if (portionError(food, halfUnits) !== null) return null;
  const cost = (food.price * halfUnits) / food.unitHalfUnits;
  return Number.isInteger(cost) ? cost : Math.round(cost);
}

/** 半份数 -> 四状态增量（未 clamp）；非法返回 null。 */
export function effectsForHalfUnits(itemId, halfUnits) {
  const food = getFood(itemId);
  if (!food || food.inventory !== true) return null;
  if (portionError(food, halfUnits) !== null) return null;
  const ratio = halfUnits / food.unitHalfUnits;
  const effects = {};
  for (const key of ['H', 'M', 'E', 'C']) {
    effects[key] = (food.effectsPerWhole[key] || 0) * ratio;
  }
  return effects;
}

/** 当前库存可用的食品/份量（host 买/喂 UI 用）。 */
export function availableFoods(state) {
  const inventory = state && typeof state.inventory === 'object' ? state.inventory : {};
  const result = [];
  for (const food of Object.values(FOOD_CATALOG)) {
    if (food.inventory !== true) continue;
    const stock = Math.max(0, Math.floor(inventory[food.id] || 0));
    const portions = [];
    if (food.splittable === true) {
      if (stock >= 1) portions.push(1);
      if (food.unitHalfUnits >= 2 && stock >= food.unitHalfUnits) portions.push(food.unitHalfUnits);
    } else if (stock >= food.unitHalfUnits) {
      portions.push(food.unitHalfUnits);
    }
    result.push({
      itemId: food.id,
      name: food.name,
      stock,
      unitHalfUnits: food.unitHalfUnits,
      splittable: food.splittable === true,
      portions,
      staple: food.staple === true,
      pricePerHalfUnit: food.price / food.unitHalfUnits,
    });
  }
  return result;
}

/**
 * 购买食品（半份计价）。成功时返回新 state（wallet 扣款、inventory 增加）。
 */
export function buyItem(state, cmd = {}, nowMs, cfg = {}) {
  if (!state || typeof state !== 'object') {
    throw engineError('INVALID_ARGUMENT', 'state is required');
  }
  if (state.lifecycle === 'deceased') {
    return { ok: false, state, error: 'PET_DECEASED', cost: 0 };
  }
  const food = getFood(cmd.itemId);
  if (!food || food.inventory !== true) {
    return { ok: false, state, error: 'ITEM_MISSING', cost: 0 };
  }
  if (!(food.price > 0)) {
    return { ok: false, state, error: 'NOT_PURCHASABLE', cost: 0 };
  }
  const halfUnits =
    cmd.halfUnits === undefined || cmd.halfUnits === null ? food.unitHalfUnits : cmd.halfUnits;
  const invalid = portionError(food, halfUnits);
  if (invalid !== null) return { ok: false, state, error: invalid, cost: 0 };
  const cost = priceForHalfUnits(food.id, halfUnits);
  const balance = Number.isFinite(state.wallet && state.wallet.balance)
    ? state.wallet.balance
    : 0;
  if (balance < cost) {
    return { ok: false, state, error: 'NOT_ENOUGH_COINS', cost };
  }
  const next = cloneState(state);
  next.wallet = { ...(next.wallet || {}), balance: balance - cost };
  next.inventory = { ...(next.inventory || {}) };
  next.inventory[food.id] = Math.floor((next.inventory[food.id] || 0) + halfUnits);
  return { ok: true, state: next, error: null, cost };
}

/**
 * 领取救济口粮（免费）：库存已有整份时不可领；24h 内只能领一次。
 * 冷却时间戳持久化在 state.daily.reliefLastClaimedAtMs。
 */
export function claimRelief(state, nowMs, cfg = {}) {
  if (!state || typeof state !== 'object') {
    throw engineError('INVALID_ARGUMENT', 'state is required');
  }
  if (state.lifecycle === 'deceased') {
    return { ok: false, state, error: 'PET_DECEASED', claim: null };
  }
  const food = FOOD_CATALOG.relief;
  const inventory = state.inventory && typeof state.inventory === 'object' ? state.inventory : {};
  if (Math.floor(inventory.relief || 0) >= food.unitHalfUnits) {
    return { ok: false, state, error: 'RELIEF_IN_STOCK', claim: null };
  }
  const lastClaimedAtMs =
    state.daily && Number.isFinite(state.daily.reliefLastClaimedAtMs)
      ? state.daily.reliefLastClaimedAtMs
      : null;
  if (
    lastClaimedAtMs !== null &&
    nowMs - lastClaimedAtMs < food.claimCooldownHours * HOUR_MS
  ) {
    return { ok: false, state, error: 'RELIEF_COOLDOWN', claim: null };
  }
  const next = cloneState(state);
  next.inventory = { ...(next.inventory || {}) };
  next.inventory.relief = Math.floor((next.inventory.relief || 0) + food.unitHalfUnits);
  next.daily = { ...(next.daily || {}), reliefLastClaimedAtMs: nowMs };
  return {
    ok: true,
    state: next,
    error: null,
    claim: { itemId: 'relief', halfUnits: food.unitHalfUnits, atMs: nowMs },
  };
}

/** 首次领养赠礼：60 金币 + 3 份基础口粮（=6 半份），profile 级只发一次。 */
export function grantFirstGift(state) {
  if (!state || typeof state !== 'object') {
    throw engineError('INVALID_ARGUMENT', 'state is required');
  }
  if (state.firstGiftGranted === true) {
    return { ok: false, state, error: 'GIFT_ALREADY_GRANTED', gift: null };
  }
  const basic = FOOD_CATALOG.basic;
  const basicHalfUnits = ECONOMY_RULES.firstGiftBasicWholeUnits * basic.unitHalfUnits;
  const next = cloneState(state);
  next.wallet = {
    ...(next.wallet || {}),
    balance: (Number.isFinite(next.wallet && next.wallet.balance) ? next.wallet.balance : 0) +
      ECONOMY_RULES.firstGiftCoins,
  };
  next.inventory = { ...(next.inventory || {}) };
  next.inventory.basic = Math.floor((next.inventory.basic || 0) + basicHalfUnits);
  next.firstGiftGranted = true;
  return {
    ok: true,
    state: next,
    error: null,
    gift: { coins: ECONOMY_RULES.firstGiftCoins, basicHalfUnits },
  };
}
