/**
 * §9 金币经济：token 换算、日封顶只发差额、食品价格/半份、首礼、救济口粮。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  claimRelief,
  effectsForHalfUnits,
  getFood,
  grantFirstGift,
  grantForDay,
  priceForHalfUnits,
  tokensToCoins,
} from '../../src/core/index.js';

import { ADOPTED, HOUR, makePet } from './helpers.js';

test('tokensToCoins：每 1000 token 1 币，日封顶 100', () => {
  assert.equal(tokensToCoins(0), 0);
  assert.equal(tokensToCoins(999), 0);
  assert.equal(tokensToCoins(1000), 1);
  assert.equal(tokensToCoins(1999), 1);
  assert.equal(tokensToCoins(50000), 50);
  assert.equal(tokensToCoins(100000), 100);
  assert.equal(tokensToCoins(150000), 100); // 超额封顶
  assert.equal(tokensToCoins(-1000), 0);
  assert.equal(tokensToCoins(Number.NaN), 0);
  assert.equal(tokensToCoins(undefined), 0);
});

test('grantForDay：只发差额，可跨多次上报累加', () => {
  const first = grantForDay({ dayKey: '2026-01-01', eligibleTokens: 0, grantedCoins: 0 }, [{ tokens: 999 }]);
  assert.equal(first.eligibleTokens, 999);
  assert.equal(first.grantedCoins, 0);
  assert.equal(first.grantedDelta, 0);

  const at1000 = grantForDay({ dayKey: '2026-01-01', eligibleTokens: 0, grantedCoins: 0 }, [{ tokens: 1000 }]);
  assert.equal(at1000.grantedCoins, 1);
  assert.equal(at1000.grantedDelta, 1);

  const again = grantForDay(at1000, [{ tokens: 2500 }]);
  assert.equal(again.eligibleTokens, 3500);
  assert.equal(again.grantedCoins, 3);
  assert.equal(again.grantedDelta, 2); // 只补差额
});

test('grantForDay：100000 封顶 100、超额不补发、不回溯', () => {
  const capped = grantForDay({ dayKey: '2026-01-01', eligibleTokens: 0, grantedCoins: 0 }, [{ tokens: 100000 }]);
  assert.equal(capped.grantedCoins, 100);
  assert.equal(capped.grantedDelta, 100);
  assert.equal(capped.capped, true);

  const excess = grantForDay({ dayKey: '2026-01-01', eligibleTokens: 150000, grantedCoins: 100 }, [{ tokens: 200000 }]);
  assert.equal(excess.grantedCoins, 100);
  assert.equal(excess.grantedDelta, 0);
  assert.equal(excess.capped, true);

  const noDouble = grantForDay({ dayKey: '2026-01-01', eligibleTokens: 5000, grantedCoins: 5 }, []);
  assert.equal(noDouble.grantedCoins, 5);
  assert.equal(noDouble.grantedDelta, 0);
});

test('grantForDay：支持数字或对象桶，新的一天从头计', () => {
  const merged = grantForDay({ dayKey: '2026-01-01', eligibleTokens: 0, grantedCoins: 0 }, [500, { tokens: 1500 }]);
  assert.equal(merged.eligibleTokens, 2000);
  assert.equal(merged.grantedCoins, 2);

  const nextDay = grantForDay({ dayKey: '2026-01-02', eligibleTokens: 0, grantedCoins: 0 }, [{ tokens: 4000 }]);
  assert.equal(nextDay.dayKey, '2026-01-02');
  assert.equal(nextDay.grantedCoins, 4);
});

test('食品目录：价格与效果（整份）', () => {
  const basic = getFood('basic');
  assert.equal(basic.price, 12);
  assert.equal(basic.splittable, true);
  assert.equal(basic.staple, true);
  assert.deepEqual(basic.effectsPerWhole, { H: 60, M: 0, E: 0, C: 0 });

  const favorite = getFood('favorite');
  assert.equal(favorite.price, 18);
  assert.equal(favorite.splittable, true);
  assert.deepEqual(favorite.effectsPerWhole, { H: 60, M: 6, E: 0, C: 0 });

  const snack = getFood('snack');
  assert.equal(snack.price, 5);
  assert.equal(snack.splittable, false);
  assert.equal(snack.staple, false);
  assert.equal(snack.dailyLimit, 2);

  const relief = getFood('relief');
  assert.equal(relief.price, 0);
  assert.equal(getFood('gold'), null);
});

test('半份价格与效果换算', () => {
  assert.equal(priceForHalfUnits('basic', 1), 6);
  assert.equal(priceForHalfUnits('basic', 2), 12);
  assert.equal(priceForHalfUnits('favorite', 1), 9);
  assert.equal(priceForHalfUnits('favorite', 2), 18);
  assert.equal(priceForHalfUnits('snack', 2), 5);
  assert.equal(priceForHalfUnits('snack', 1), null); // 零食不可拆
  assert.equal(priceForHalfUnits('basic', 3), null);
  assert.equal(priceForHalfUnits('gold', 2), null);

  assert.deepEqual(effectsForHalfUnits('basic', 1), { H: 30, M: 0, E: 0, C: 0 });
  assert.deepEqual(effectsForHalfUnits('basic', 2), { H: 60, M: 0, E: 0, C: 0 });
  assert.deepEqual(effectsForHalfUnits('favorite', 2), { H: 60, M: 6, E: 0, C: 0 });
  assert.deepEqual(effectsForHalfUnits('snack', 2), { H: 8, M: 5, E: 0, C: 0 });
  assert.equal(effectsForHalfUnits('snack', 1), null);
});

test('购买：整份基础口粮 12 币 -> 库存 +2 半份', () => {
  const pet = makePet();
  const result = buyItemCompat(pet, { itemId: 'basic', halfUnits: 2 }, ADOPTED);
  assert.equal(result.ok, true);
  assert.equal(result.cost, 12);
  assert.deepEqual(result.state.wallet, { balance: 48 });
  assert.deepEqual(result.state.inventory, { basic: 8 });
});

test('购买：半份 6 币、喜爱主食 18 币、小零食 5 币', () => {
  const half = buyItemCompat(makePet(), { itemId: 'basic', halfUnits: 1 }, ADOPTED);
  assert.equal(half.cost, 6);
  assert.deepEqual(half.state.inventory, { basic: 7 });

  const favorite = buyItemCompat(makePet(), { itemId: 'favorite', halfUnits: 2 }, ADOPTED);
  assert.equal(favorite.cost, 18);
  assert.deepEqual(favorite.state.wallet, { balance: 42 });
  assert.deepEqual(favorite.state.inventory, { basic: 6, favorite: 2 });

  const snack = buyItemCompat(makePet(), { itemId: 'snack', halfUnits: 2 }, ADOPTED);
  assert.equal(snack.cost, 5);
  assert.deepEqual(snack.state.wallet, { balance: 55 });
});

test('购买错误码：币不够 / 物品不存在 / 不可拆分 / 已死亡', () => {
  assert.equal(buyItemCompat(makePet({ wallet: { balance: 5 } }), { itemId: 'basic', halfUnits: 2 }, ADOPTED).error, 'NOT_ENOUGH_COINS');
  assert.equal(buyItemCompat(makePet(), { itemId: 'gold', halfUnits: 2 }, ADOPTED).error, 'ITEM_MISSING');
  assert.equal(buyItemCompat(makePet(), { itemId: 'water', halfUnits: 2 }, ADOPTED).error, 'ITEM_MISSING');
  assert.equal(buyItemCompat(makePet(), { itemId: 'basic', halfUnits: 3 }, ADOPTED).error, 'INVALID_PORTION');
  assert.equal(buyItemCompat(makePet(), { itemId: 'snack', halfUnits: 1 }, ADOPTED).error, 'INVALID_PORTION');
  const dead = makePet({ lifecycle: 'deceased', deceasedAtMs: ADOPTED, activeAction: null });
  assert.equal(buyItemCompat(dead, { itemId: 'basic', halfUnits: 2 }, ADOPTED).error, 'PET_DECEASED');
});

test('救济口粮：免费 +2 半份、每日 24h 一次、有库存不可领', () => {
  const pet = makePet({ inventory: {} });
  const first = claimRelief(pet, ADOPTED, {});
  assert.equal(first.ok, true);
  assert.equal(first.state.wallet.balance, 60); // 免费
  assert.deepEqual(first.state.inventory, { relief: 2 });
  assert.equal(first.state.daily.reliefLastClaimedAtMs, ADOPTED);

  // 库存里已有整份（2 半份）时不可再领
  assert.equal(claimRelief(first.state, ADOPTED + 5 * HOUR, {}).error, 'RELIEF_IN_STOCK');

  // 24h 冷却：同一份空库存状态在 24h-1ms 被拒，恰好 24h 可领
  const cooling = makePet({
    inventory: {},
    daily: { ...makePet().daily, reliefLastClaimedAtMs: ADOPTED - 24 * HOUR + 1 },
  });
  assert.equal(claimRelief(cooling, ADOPTED, {}).error, 'RELIEF_COOLDOWN');
  const ready = makePet({
    inventory: {},
    daily: { ...makePet().daily, reliefLastClaimedAtMs: ADOPTED - 24 * HOUR },
  });
  assert.equal(claimRelief(ready, ADOPTED, {}).ok, true);
});

test('救济口粮：只剩半份时可以补领到 3 半份', () => {
  const pet = makePet({ inventory: { relief: 1 } });
  const result = claimRelief(pet, ADOPTED, {});
  assert.equal(result.ok, true);
  assert.deepEqual(result.state.inventory, { relief: 3 });
});

test('救济口粮：死亡宠物不可领取', () => {
  const dead = makePet({ lifecycle: 'deceased', deceasedAtMs: ADOPTED, activeAction: null });
  assert.equal(claimRelief(dead, ADOPTED, {}).error, 'PET_DECEASED');
});

test('首次领养赠礼：60 金币 + 3 整份基础口粮，且 profile 级一次性', () => {
  const fresh = makePet();
  assert.equal(fresh.wallet.balance, 60);
  assert.deepEqual(fresh.inventory, { basic: 6 });
  assert.equal(fresh.firstGiftGranted, true);

  const again = grantFirstGift(fresh);
  assert.equal(again.ok, false);
  assert.equal(again.error, 'GIFT_ALREADY_GRANTED');
});

// buyItem 需要显式传入 nowMs/cfg（合同：纯函数），这里包一层减少重复。
import { buyItem } from '../../src/core/index.js';

function buyItemCompat(state, cmd, nowMs) {
  return buyItem(state, cmd, nowMs, {});
}
