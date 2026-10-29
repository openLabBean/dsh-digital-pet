/**
 * §8 诉求优先级 + §7.1 抚摸。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { pet, resolveNeeds } from '../../src/core/index.js';

import { ADOPTED, HOUR, MINUTE, approx, eventTypes, makePet } from './helpers.js';

function needsAt(state, nowMs = ADOPTED) {
  return resolveNeeds(state, nowMs, {});
}

test('健康宝宝没有诉求', () => {
  const result = needsAt(makePet());
  assert.equal(result.need, null);
  assert.equal(result.priority, 0);
  assert.deepEqual(result.needs, []);
});

test('休息：E<20 优先级 1', () => {
  assert.equal(needsAt(makePet({ E: 19 })).need, 'rest');
  assert.equal(needsAt(makePet({ E: 19 })).priority, 1);
  assert.equal(needsAt(makePet({ E: 20 })).need, null);
});

test('饥饿：H<15 高优先 2，H<=35 普通 5，H>35 无', () => {
  assert.equal(needsAt(makePet({ H: 14.9 })).priority, 2);
  assert.equal(needsAt(makePet({ H: 15 })).priority, 5);
  assert.equal(needsAt(makePet({ H: 35 })).priority, 5);
  assert.equal(needsAt(makePet({ H: 35.01 })).need, null);
});

test('饮水：>=24h 优先级 2，>=18h 优先级 5，触发时间精确', () => {
  const critical = needsAt(makePet({ lastWaterAtMs: ADOPTED - 24 * HOUR }));
  assert.equal(critical.need, 'water');
  assert.equal(critical.priority, 2);
  assert.equal(critical.needs[0].triggeredAtMs, ADOPTED);

  const normal = needsAt(makePet({ lastWaterAtMs: ADOPTED - 18 * HOUR }));
  assert.equal(normal.priority, 5);
  assert.equal(normal.needs[0].triggeredAtMs, ADOPTED);

  assert.equal(needsAt(makePet({ lastWaterAtMs: ADOPTED - 18 * HOUR + 1 })).need, null);
});

test('排泄：已出现的排泄优先级 3，按最早出现时间触发；未来的不算', () => {
  const present = makePet({
    pendingWaste: [
      { id: 'w2', atMs: ADOPTED - HOUR, plannedAtMs: ADOPTED - 3 * HOUR, penalized: true },
      { id: 'w1', atMs: ADOPTED - 2 * HOUR, plannedAtMs: ADOPTED - 4 * HOUR, penalized: true },
    ],
  });
  const result = needsAt(present);
  assert.equal(result.need, 'waste');
  assert.equal(result.priority, 3);
  assert.equal(result.needs[0].triggeredAtMs, ADOPTED - 2 * HOUR);

  const future = makePet({
    pendingWaste: [{ id: 'w1', atMs: ADOPTED + HOUR, plannedAtMs: ADOPTED - HOUR, penalized: false }],
  });
  assert.equal(needsAt(future).need, null);
});

test('清洁：C<=50 洗澡优先级 4', () => {
  assert.equal(needsAt(makePet({ C: 50 })).need, 'bathe');
  assert.equal(needsAt(makePet({ C: 50 })).priority, 4);
  assert.equal(needsAt(makePet({ C: 50.1 })).need, null);
});

test('逛街：M<=45 且距上次逛街 >=20h，优先级 6', () => {
  const walk = needsAt(makePet({ M: 45, lastWalkAtMs: ADOPTED - 20 * HOUR }));
  assert.equal(walk.need, 'walk');
  assert.equal(walk.priority, 6);
  assert.equal(walk.needs[0].triggeredAtMs, ADOPTED);

  assert.equal(needsAt(makePet({ M: 45, lastWalkAtMs: ADOPTED - 19 * HOUR })).need, null);
  assert.equal(needsAt(makePet({ M: 46, lastWalkAtMs: ADOPTED - 21 * HOUR })).need, null);
});

test('护理：距上次护理 >=72h，优先级 7', () => {
  assert.equal(needsAt(makePet({ lastGroomAtMs: ADOPTED - 72 * HOUR })).need, 'groom');
  assert.equal(needsAt(makePet({ lastGroomAtMs: ADOPTED - 71 * HOUR })).need, null);
});

test('多诉求按优先级排序，同优先级按触发时间', () => {
  const state = makePet({
    E: 19,
    H: 10,
    lastWaterAtMs: ADOPTED - 30 * HOUR,
    pendingWaste: [{ id: 'w1', atMs: ADOPTED - HOUR, plannedAtMs: ADOPTED - 3 * HOUR, penalized: true }],
    C: 50,
    M: 45,
    lastWalkAtMs: ADOPTED - 21 * HOUR,
    lastGroomAtMs: ADOPTED - 73 * HOUR,
  });
  const result = needsAt(state);
  assert.deepEqual(
    result.needs.map((need) => need.key),
    ['rest', 'water', 'hunger', 'waste', 'bathe', 'walk', 'groom'],
  );
  const priorities = result.needs.map((need) => need.priority);
  assert.deepEqual(priorities, [1, 2, 2, 3, 4, 6, 7]);
  assert.equal(result.need, 'rest');
});

test('同优先级同一触发时间时按固定诉求顺序（饥饿先于饮水）', () => {
  const state = makePet({ H: 10, lastWaterAtMs: ADOPTED - 24 * HOUR });
  const result = needsAt(state);
  assert.deepEqual(
    result.needs.map((need) => need.key),
    ['hunger', 'water'],
  );
});

test('可见性不影响引擎：hidden 时诉求照旧', () => {
  const visible = makePet({ C: 45 });
  const hidden = makePet({ C: 45, visible: false });
  assert.deepEqual(needsAt(hidden), needsAt(visible));
});

test('死亡 / 托管没有诉求', () => {
  const dead = makePet({ lifecycle: 'deceased', deceasedAtMs: ADOPTED, H: 0, activeAction: null });
  assert.deepEqual(needsAt(dead), { need: null, priority: 0, needs: [] });
  const boarding = makePet({ mode: 'boarding', boardingSinceMs: ADOPTED });
  assert.deepEqual(needsAt(boarding), { need: null, priority: 0, needs: [] });
});

test('抚摸：M+2、30min 冷却、活动事件 pet.reward', () => {
  const result = pet(makePet(), ADOPTED, {});
  assert.equal(result.ok, true);
  assert.equal(result.state.M, 82);
  assert.equal(result.state.lastPetAtMs, ADOPTED);
  assert.equal(result.state.daily.pettingRewards, 1);
  assert.deepEqual(eventTypes(result), ['pet.reward']);

  assert.equal(pet(result.state, ADOPTED + 29 * MINUTE, {}).error, 'ON_COOLDOWN');
  const later = pet(result.state, ADOPTED + 30 * MINUTE, {});
  assert.equal(later.ok, true);
  // 30min 里 M 自然 -0.5，再 +2
  approx(assert, later.state.M, 83.5, 1e-9);
  assert.equal(later.state.daily.pettingRewards, 2);
});

test('抚摸：每日最多 5 次有效', () => {
  const state = makePet({ daily: { ...makePet().daily, pettingRewards: 5 } });
  assert.equal(pet(state, ADOPTED, {}).error, 'DAILY_LIMIT');
});

test('抚摸：会先结算再奖励（时间推进不留未结算状态）', () => {
  const result = pet(makePet(), ADOPTED + HOUR, {});
  assert.equal(result.ok, true);
  assert.equal(result.state.lastSettledAtMs, ADOPTED + HOUR);
  approx(assert, result.state.M, 81, 1e-9); // -1 (1h 清醒) + 2
});

test('抚摸：死亡 / 托管不可用', () => {
  const dead = makePet({ lifecycle: 'deceased', deceasedAtMs: ADOPTED, activeAction: null });
  assert.equal(pet(dead, ADOPTED, {}).error, 'PET_DECEASED');
  const boarding = makePet({ mode: 'boarding', boardingSinceMs: ADOPTED });
  assert.equal(pet(boarding, ADOPTED, {}).error, 'BOARDING');
});

test('抚摸：M 接近上限时只加到 100', () => {
  const result = pet(makePet({ M: 99 }), ADOPTED, {});
  assert.equal(result.ok, true);
  assert.equal(result.state.M, 100);
  assert.equal(result.events.find((event) => event.type === 'pet.reward').moodGain, 1);
});
