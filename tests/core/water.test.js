/**
 * §6.1 喂水：#8 诉求阈值、6h 冷却、>36h 每 6h M-2 累计封顶 -8。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { HOUR_MS, resolveNeeds, settle, startAction } from '../../src/core/index.js';

import { ADOPTED, HOUR, approx, eventTypes, makePet } from './helpers.js';

/** 只留下饮水变量的干净状态：其它诉求都不触发。 */
function cleanPet(overrides = {}) {
  return makePet({ H: 100, M: 80, E: 100, C: 90, ...overrides });
}

test('饮水诉求：>18h 普通、>24h 高优先，触发时刻精确到阈值点', () => {
  const at18h = cleanPet({ lastWaterAtMs: ADOPTED - 18 * HOUR + 1 });
  assert.equal(resolveNeeds(at18h, ADOPTED, {}).need, null);

  const at18 = cleanPet({ lastWaterAtMs: ADOPTED - 18 * HOUR });
  const normal = resolveNeeds(at18, ADOPTED, {});
  assert.equal(normal.need, 'water');
  assert.equal(normal.priority, 5);
  assert.equal(normal.needs[0].triggeredAtMs, ADOPTED - 18 * HOUR + 18 * HOUR);

  const at24 = cleanPet({ lastWaterAtMs: ADOPTED - 24 * HOUR });
  const critical = resolveNeeds(at24, ADOPTED, {});
  assert.equal(critical.need, 'water');
  assert.equal(critical.priority, 2);
  assert.equal(critical.needs[0].triggeredAtMs, ADOPTED - 24 * HOUR + 24 * HOUR);
});

test('第一次喝水有效：M+2、羁绊+1、重置口渴计时', () => {
  const pet = cleanPet();
  const started = startAction(pet, { type: 'water' }, ADOPTED, {});
  assert.equal(started.ok, true);
  const result = settle(started.state, ADOPTED + 4000, {});
  const completed = result.events.find((event) => event.type === 'action.completed');
  assert.equal(completed.effective, true);
  assert.equal(completed.deltas.M, 2);
  assert.equal(completed.affinityGained, 1);
  approx(assert, result.state.M, 82 - 4 / 3600, 1e-9, 'M');
  assert.equal(result.state.waterRewardedAtMs, ADOPTED + 4000);
  assert.equal(result.state.lastWaterAtMs, ADOPTED + 4000);
  assert.equal(result.state.affinity, 1);
});

test('6h 冷却内再喝水：解渴但不加 M、不加羁绊', () => {
  const pet = cleanPet();
  const firstStarted = startAction(pet, { type: 'water' }, ADOPTED, {});
  const firstDone = settle(firstStarted.state, ADOPTED + 4000, {}).state;

  const secondStarted = startAction(firstDone, { type: 'water' }, ADOPTED + 2 * HOUR, {});
  assert.equal(secondStarted.ok, true);
  assert.equal(secondStarted.state.activeAction.effective, false);
  const secondDone = settle(secondStarted.state, ADOPTED + 2 * HOUR + 4000, {});
  const completed = secondDone.events.find((event) => event.type === 'action.completed');
  assert.equal(completed.effective, false);
  assert.equal(completed.deltas.M, 0);
  assert.equal(completed.affinityGained, 0);
  assert.equal(secondDone.state.affinity, 1);
  assert.equal(secondDone.state.waterRewardedAtMs, ADOPTED + 4000); // 没用掉冷却却也不刷新
  assert.equal(secondDone.state.lastWaterAtMs, ADOPTED + 2 * HOUR + 4000); // 解渴计时刷新
});

test('距上次有效喝水满 6h 后，再次喝水恢复 M+2', () => {
  const pet = cleanPet();
  const firstDone = settle(
    startAction(pet, { type: 'water' }, ADOPTED, {}).state,
    ADOPTED + 4000,
    {},
  ).state;
  const laterAt = ADOPTED + 6 * HOUR + 4000;
  const thirdStarted = startAction(firstDone, { type: 'water' }, laterAt, {});
  assert.equal(thirdStarted.state.activeAction.effective, true);
  const thirdDone = settle(thirdStarted.state, laterAt + 4000, {});
  const completed = thirdDone.events.find((event) => event.type === 'action.completed');
  assert.equal(completed.effective, true);
  assert.equal(completed.deltas.M, 2);
  assert.equal(thirdDone.state.affinity, 2);
});

test('>36h 未喝水：从 42h 起每 6h 扣 2 心情，累计封顶 -8', () => {
  const pet = cleanPet();
  const at43h = settle(pet, ADOPTED + 43 * HOUR, {});
  assert.equal(at43h.state.waterPenaltyM, 2);
  const penalties = at43h.events.filter((event) => event.type === 'water.penalty');
  assert.equal(penalties.length, 1);
  assert.equal(penalties[0].atMs, ADOPTED + 42 * HOUR);
  assert.equal(penalties[0].amount, 2);
  assert.equal(penalties[0].totalPenalty, 2);

  const at100h = settle(pet, ADOPTED + 100 * HOUR, {});
  assert.equal(at100h.state.waterPenaltyM, 8);
  const allPenalties = at100h.events.filter((event) => event.type === 'water.penalty');
  assert.deepEqual(
    allPenalties.map((event) => (event.atMs - ADOPTED) / HOUR),
    [42, 48, 54, 60],
  );
  // 达到封顶后不再继续扣
  const later = settle(at100h.state, ADOPTED + 124 * HOUR, {});
  assert.equal(later.state.waterPenaltyM, 8);
  assert.equal(later.events.filter((event) => event.type === 'water.penalty').length, 0);
});

test('喝水会清零累计惩罚，之后重新从 42h 计时', () => {
  const pet = cleanPet();
  const punished = settle(pet, ADOPTED + 100 * HOUR, {}).state;
  assert.equal(punished.waterPenaltyM, 8);

  const started = startAction(punished, { type: 'water' }, ADOPTED + 100 * HOUR, {});
  const drunk = settle(started.state, ADOPTED + 100 * HOUR + 4000, {}).state;
  assert.equal(drunk.waterPenaltyM, 0);

  // 新计时下 40h 内不会再扣
  const near = settle(drunk, ADOPTED + 100 * HOUR + 40 * HOUR, {});
  assert.equal(near.state.waterPenaltyM, 0);
  assert.equal(near.events.filter((event) => event.type === 'water.penalty').length, 0);
  // 到 42h 又扣一次
  const tick = settle(near.state, ADOPTED + 100 * HOUR + 42 * HOUR + 5000, {});
  assert.equal(tick.state.waterPenaltyM, 2);
  assert.equal(tick.events.filter((event) => event.type === 'water.penalty').length, 1);
});

test('饮水惩罚事件出现在事件列表里且时间有序', () => {
  const result = settle(cleanPet(), ADOPTED + 61 * HOUR, {});
  const types = eventTypes(result);
  assert.ok(types.includes('water.penalty'));
  const times = result.events.map((event) => event.atMs);
  assert.deepEqual(times, [...times].sort((a, b) => a - b));
  // 60h 内不超过 4 次（封顶 8 / 每次 2）
  assert.ok(result.events.filter((event) => event.type === 'water.penalty').length <= 4);
});
