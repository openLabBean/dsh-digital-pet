/**
 * 状态工厂 / 夹紧 / 日切 / 羁绊 / 联动标记等纯函数。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyStatusDelta,
  clampStatus,
  cloneState,
  createInitialState,
  freshDaily,
  grantAffinity,
  lifeEndsAtMs,
  normalizeConfig,
  normalizeState,
  rollDailyCounters,
  syncLinkageFlags,
  validateState,
} from '../../src/core/index.js';

import { ADOPTED, HOUR, TZ_SH, makePet } from './helpers.js';

test('createInitialState：初始状态字段与默认值完整', () => {
  const state = createInitialState({
    petId: 'pet-1',
    speciesId: 'shiba',
    nickname: '豆豆',
    adoptedAtMs: ADOPTED,
    tz: TZ_SH,
    configVersion: 1,
  });

  assert.equal(state.schemaVersion, 1);
  assert.equal(state.configVersion, 1);
  assert.equal(state.petId, 'pet-1');
  assert.equal(state.speciesId, 'shiba');
  assert.equal(state.nickname, '豆豆');
  assert.equal(state.adoptedAtMs, ADOPTED);
  assert.equal(state.tz, TZ_SH);
  assert.equal(state.lifeEndsAtMs, lifeEndsAtMs(ADOPTED, TZ_SH));
  // 四状态初始值 §5
  assert.equal(state.H, 80);
  assert.equal(state.M, 80);
  assert.equal(state.E, 100);
  assert.equal(state.C, 90);
  // 生命周期 / 形态 / 展示
  assert.equal(state.lifecycle, 'alive');
  assert.equal(state.deceasedAtMs, null);
  assert.equal(state.stage, 'baby');
  assert.equal(state.mode, 'normal');
  assert.equal(state.boardingSinceMs, null);
  assert.equal(state.sleeping, false);
  assert.equal(state.resting, false);
  assert.equal(state.visible, true);
  // 计时器全部从领养时刻起算
  assert.equal(state.lastSettledAtMs, ADOPTED);
  assert.equal(state.lastWaterAtMs, ADOPTED);
  assert.equal(state.lastBatheAtMs, ADOPTED);
  assert.equal(state.lastGroomAtMs, ADOPTED);
  assert.equal(state.lastWalkAtMs, ADOPTED);
  assert.equal(state.lastPetAtMs, null);
  assert.equal(state.waterRewardedAtMs, null);
  assert.equal(state.waterPenaltyM, 0);
  // 诉求 / 动作 / 排泄
  assert.equal(state.activeAction, null);
  assert.deepEqual(state.pendingWaste, []);
  assert.equal(state.wasteSeq, 0);
  assert.equal(state.lastWastePlannedDayKey, null);
  assert.equal(state.foodRecoveredToday, 0);
  // 羁绊 / 照护
  assert.equal(state.affinity, 0);
  assert.equal(state.careCount, 0);
  assert.equal(state.lowH, false);
  assert.equal(state.lowC, false);
  // 经济：首次赠礼
  assert.equal(state.firstGiftGranted, true);
  assert.deepEqual(state.wallet, { balance: 60 });
  assert.deepEqual(state.inventory, { basic: 6 });
  assert.deepEqual(state.daily, {
    dayKey: '2026-01-01', // 领养时刻在 Asia/Shanghai 的本地日
    eligibleTokens: 0,
    grantedCoins: 0,
    snacksUsed: 0,
    pettingRewards: 0,
    affinityGained: 0,
    reliefLastClaimedAtMs: null,
  });
});

test('createInitialState：firstGiftGranted=true 时不发首礼（host 标记已领）', () => {
  const state = createInitialState({
    petId: 'pet-1',
    speciesId: 'shiba',
    nickname: '豆豆',
    adoptedAtMs: ADOPTED,
    tz: TZ_SH,
    configVersion: 1,
    firstGiftGranted: true,
  });
  assert.deepEqual(state.wallet, { balance: 0 });
  assert.deepEqual(state.inventory, {});
  assert.equal(state.firstGiftGranted, true);
});

test('createInitialState：host 注入的 wallet/inventory/daily 被保留', () => {
  const daily = {
    dayKey: '2026-01-01',
    eligibleTokens: 2500,
    grantedCoins: 2,
    snacksUsed: 1,
    pettingRewards: 3,
    affinityGained: 2,
    reliefLastClaimedAtMs: ADOPTED - HOUR,
  };
  const state = createInitialState({
    petId: 'pet-1',
    speciesId: 'shiba',
    nickname: '豆豆',
    adoptedAtMs: ADOPTED,
    tz: TZ_SH,
    configVersion: 1,
    firstGiftGranted: true, // 恢复已存在的宠物：首礼不再补发
    wallet: { balance: 33 },
    inventory: { favorite: 1, relief: 2 },
    daily,
  });
  assert.deepEqual(state.wallet, { balance: 33 });
  assert.deepEqual(state.inventory, { favorite: 1, relief: 2 });
  assert.deepEqual(state.daily, daily);
});

test('createInitialState：非法 adoptedAtMs / 时区抛出结构化错误', () => {
  const base = { petId: 'p', speciesId: 's', nickname: 'n', configVersion: 1 };
  assert.throws(
    () => createInitialState({ ...base, adoptedAtMs: Number.NaN, tz: TZ_SH }),
    (error) => error.code === 'INVALID_ARGUMENT',
  );
  assert.throws(
    () => createInitialState({ ...base, adoptedAtMs: ADOPTED, tz: 'Bad/Zone' }),
    (error) => error.code === 'INVALID_ARGUMENT',
  );
});

test('clampStatus：夹紧到 [0,100]，非数字按 0', () => {
  assert.equal(clampStatus(150), 100);
  assert.equal(clampStatus(-5), 0);
  assert.equal(clampStatus(50), 50);
  assert.equal(clampStatus(Number.NaN), 0);
  assert.equal(clampStatus('x'), 0);
  assert.equal(clampStatus(undefined), 0);
  assert.equal(clampStatus(Infinity), 0);
});

test('applyStatusDelta：返回实际变化量并夹紧', () => {
  const state = makePet();
  state.H = 99;
  assert.equal(applyStatusDelta(state, 'H', 5), 1);
  assert.equal(state.H, 100);
  state.M = 1;
  assert.equal(applyStatusDelta(state, 'M', -5), -1);
  assert.equal(state.M, 0);
  assert.equal(applyStatusDelta(state, 'E', Number.NaN), 0);
});

test('cloneState：深拷贝，不共享引用', () => {
  const state = makePet({ pendingWaste: [{ id: 'w1', atMs: ADOPTED, plannedAtMs: ADOPTED, penalized: true }] });
  const copy = cloneState(state);
  copy.H = 1;
  copy.pendingWaste[0].penalized = false;
  copy.wallet.balance = 0;
  assert.equal(state.H, 80);
  assert.equal(state.pendingWaste[0].penalized, true);
  assert.equal(state.wallet.balance, 60);
});

test('freshDaily：新的一天重置计数但保留跨天救济冷却戳', () => {
  const previous = {
    dayKey: '2026-01-01',
    eligibleTokens: 5000,
    grantedCoins: 5,
    snacksUsed: 2,
    pettingRewards: 3,
    affinityGained: 4,
    reliefLastClaimedAtMs: ADOPTED,
  };
  const next = freshDaily('2026-01-02', previous);
  assert.deepEqual(next, {
    dayKey: '2026-01-02',
    eligibleTokens: 0,
    grantedCoins: 0,
    snacksUsed: 0,
    pettingRewards: 0,
    affinityGained: 0,
    reliefLastClaimedAtMs: ADOPTED,
  });
  const empty = freshDaily('2026-01-02');
  assert.equal(empty.reliefLastClaimedAtMs, null);
});

test('rollDailyCounters：同日不重置，跨日重置且保留羁绊与救济冷却', () => {
  const state = makePet({ affinity: 7, careCount: 2, foodRecoveredToday: 60 });
  state.daily = {
    dayKey: '2026-01-01',
    eligibleTokens: 5000,
    grantedCoins: 5,
    snacksUsed: 2,
    pettingRewards: 3,
    affinityGained: 4,
    reliefLastClaimedAtMs: ADOPTED,
  };
  assert.equal(rollDailyCounters(state, '2026-01-01'), false);
  assert.equal(state.foodRecoveredToday, 60);
  assert.equal(state.daily.grantedCoins, 5);

  assert.equal(rollDailyCounters(state, '2026-01-02'), true);
  assert.equal(state.daily.dayKey, '2026-01-02');
  assert.equal(state.daily.eligibleTokens, 0);
  assert.equal(state.daily.grantedCoins, 0);
  assert.equal(state.daily.snacksUsed, 0);
  assert.equal(state.daily.pettingRewards, 0);
  assert.equal(state.daily.affinityGained, 0);
  assert.equal(state.daily.reliefLastClaimedAtMs, ADOPTED); // 跨天保留
  assert.equal(state.foodRecoveredToday, 0);
  assert.equal(state.affinity, 7); // 羁绊不随日切重置
  assert.equal(state.careCount, 2);
});

test('grantAffinity：日上限 5、终身上限 100', () => {
  const state = makePet();
  state.daily.affinityGained = 4;
  assert.equal(grantAffinity(state, 2), 1); // 日余量 1
  assert.equal(state.affinity, 1);
  assert.equal(state.daily.affinityGained, 5);

  const capped = makePet({ affinity: 99 });
  assert.equal(grantAffinity(capped, 5), 1); // 终身余量 1
  assert.equal(capped.affinity, 100);
  assert.equal(grantAffinity(capped, 1), 0);
});

test('syncLinkageFlags：联动阈值有迟滞（25/35 与 30/40）', () => {
  const state = makePet({ H: 20, C: 20 });
  syncLinkageFlags(state);
  assert.equal(state.lowH, true);
  assert.equal(state.lowC, true);

  state.H = 30; // 介于 25~35，保持
  state.C = 35; // 介于 30~40，保持
  syncLinkageFlags(state);
  assert.equal(state.lowH, true);
  assert.equal(state.lowC, true);

  state.H = 35;
  state.C = 40;
  syncLinkageFlags(state);
  assert.equal(state.lowH, false);
  assert.equal(state.lowC, false);
});

test('normalizeConfig：合并默认作息与离线开关，tz 优先用参数', () => {
  const defaults = normalizeConfig({}, TZ_SH);
  assert.equal(defaults.sleepStart, 23 * 60);
  assert.equal(defaults.sleepEnd, 7 * 60);
  assert.equal(defaults.offline, false);
  assert.equal(defaults.tz, TZ_SH);
  assert.equal(defaults.configVersion, 1);

  const custom = normalizeConfig({ sleepStart: 60, sleepEnd: 360, offline: true }, TZ_SH);
  assert.equal(custom.sleepStart, 60);
  assert.equal(custom.sleepEnd, 360);
  assert.equal(custom.offline, true);

  const disabled = normalizeConfig({ sleepStart: null }, TZ_SH);
  assert.equal(disabled.sleepStart, null);
});

test('normalizeState：夹紧四状态、补齐经济字段、不修改入参', () => {
  const state = makePet({ pendingWaste: [] });
  const dirty = cloneState(state);
  dirty.H = 200;
  dirty.M = -3;
  dirty.E = Number.NaN;
  dirty.C = 'x';
  delete dirty.wallet;
  delete dirty.daily;
  const normalized = normalizeState(dirty);
  assert.equal(normalized.H, 100);
  assert.equal(normalized.M, 0);
  assert.equal(normalized.E, 0);
  assert.equal(normalized.C, 0);
  assert.deepEqual(normalized.wallet, { balance: 0 });
  assert.equal(typeof normalized.daily.dayKey, 'string');
  // 入参未被改动
  assert.equal(dirty.H, 200);
});

test('validateState：合法状态通过，越界/缺失字段报错', () => {
  assert.deepEqual(validateState(makePet()), { ok: true, errors: [] });

  const badH = makePet({ H: 150 });
  const bad = validateState(badH);
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((error) => error.field === 'H'));

  const badWallet = makePet();
  badWallet.wallet = { balance: -1 };
  assert.equal(validateState(badWallet).ok, false);

  const tooMuchWaste = makePet({
    pendingWaste: [
      { id: 'w1', atMs: 0, plannedAtMs: 0, penalized: true },
      { id: 'w2', atMs: 1, plannedAtMs: 1, penalized: true },
      { id: 'w3', atMs: 2, plannedAtMs: 2, penalized: true },
    ],
  });
  assert.equal(validateState(tooMuchWaste).ok, false);
});
