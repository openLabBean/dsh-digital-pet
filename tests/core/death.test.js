/**
 * §4.1 寿终归档：#7 死亡优先于动作结算、死亡后一切不可用、月末寿终。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  availableActions,
  pet,
  resolveNeeds,
  settle,
  startAction,
} from '../../src/core/index.js';

import { TZ_SH, eventTypes, makePet } from './helpers.js';

function settleAt(state, atMs, cfg = {}) {
  return settle(state, atMs, cfg);
}

test('寿终时刻：lifeEnd-1ms 活着，lifeEnd 归档', () => {
  const petState = makePet();
  const lifeEnd = petState.lifeEndsAtMs;

  const alive = settleAt(petState, lifeEnd - 1, {});
  assert.equal(alive.deceased, false);
  assert.equal(alive.state.lifecycle, 'alive');
  assert.ok(!eventTypes(alive).includes('pet.deceased'));

  const dead = settleAt(petState, lifeEnd, {});
  assert.equal(dead.deceased, true);
  assert.equal(dead.state.lifecycle, 'deceased');
  assert.equal(dead.state.deceasedAtMs, lifeEnd);
  assert.equal(dead.state.sleeping, false);
  const event = dead.events.find((item) => item.type === 'pet.deceased');
  assert.equal(event.atMs, lifeEnd);
  assert.equal(event.stage, 'elder');
  assert.equal(event.ageMs, lifeEnd - petState.adoptedAtMs);
});

test('死亡与动作完成同秒：死亡优先，动作作废、不扣库存、无收益', () => {
  const petState = makePet({ H: 50, M: 40, C: 30, E: 50 });
  const lifeEnd = petState.lifeEndsAtMs;
  // 刷牙 8s，恰好在 lifeEnd 结束
  const started = startAction(petState, { type: 'bathe' }, lifeEnd - 8000, {});
  assert.equal(started.ok, true);

  const result = settleAt(started.state, lifeEnd + 60 * 60 * 1000, {});
  assert.equal(result.deceased, true);
  const types = eventTypes(result);
  assert.ok(types.includes('pet.deceased'));
  assert.ok(types.includes('action.cancelled'));
  assert.ok(!types.includes('action.completed'));
  const cancelled = result.events.find((item) => item.type === 'action.cancelled');
  assert.equal(cancelled.atMs, lifeEnd);
  assert.equal(cancelled.reason, 'PET_DECEASED');
  // 没有洗澡收益：C 只能因时间衰减，不会 +60
  assert.ok(result.state.C <= 30);
  assert.equal(result.state.careCount, 0);
  assert.equal(result.state.affinity, 0);
  assert.equal(result.state.activeAction, null);
  // 事件都落在寿终时刻之前或等于寿终
  for (const event of result.events) {
    assert.ok(event.atMs <= lifeEnd);
  }
});

test('寿终前先到点的动作正常完成，再归档', () => {
  const base = makePet({ H: 50, M: 40, C: 30, E: 50 });
  const lifeEnd = base.lifeEndsAtMs;
  const started = startAction(base, { type: 'bathe' }, lifeEnd - 12000, {});
  assert.equal(started.ok, true);

  const result = settleAt(started.state, lifeEnd, {});
  assert.equal(result.deceased, true);
  const types = eventTypes(result);
  assert.ok(types.includes('action.completed'));
  assert.ok(types.includes('pet.deceased'));
  const completed = result.events.find((item) => item.type === 'action.completed');
  assert.equal(completed.atMs, lifeEnd - 4000);
  assert.equal(completed.deltas.C, 60);
  assert.equal(result.state.affinity, 1);
  assert.equal(result.state.careCount, 1);
  // 事件按时间排序，完成在死亡之前
  const completedIndex = result.events.indexOf(completed);
  const deceasedIndex = result.events.findIndex((item) => item.type === 'pet.deceased');
  assert.ok(completedIndex < deceasedIndex);
});

test('死亡后：settle 幂等、动作/抚摸/诉求全部不可用', () => {
  const base = makePet();
  const lifeEnd = base.lifeEndsAtMs;
  const dead = settleAt(base, lifeEnd, {}).state;

  const later = settleAt(dead, lifeEnd + 24 * 3600 * 1000, {});
  assert.equal(later.deceased, true);
  assert.deepEqual(later.events, []);
  assert.equal(later.state.H, dead.H);
  assert.equal(later.state.lastSettledAtMs, lifeEnd + 24 * 3600 * 1000);

  assert.equal(startAction(dead, { type: 'feed' }, lifeEnd + 1000, {}).error, 'PET_DECEASED');
  assert.equal(startAction(dead, { type: 'water' }, lifeEnd + 1000, {}).error, 'PET_DECEASED');
  assert.equal(pet(dead, lifeEnd + 1000, {}).ok, false);
  assert.equal(pet(dead, lifeEnd + 1000, {}).error, 'PET_DECEASED');
  const needs = resolveNeeds(dead, lifeEnd + 1000, {});
  assert.equal(needs.need, null);
  assert.equal(needs.priority, 0);
  assert.deepEqual(needs.needs, []);
  for (const action of availableActions(dead, lifeEnd + 1000, {})) {
    assert.equal(action.reason, 'PET_DECEASED');
  }
});

test('月末领养：1/31 + 6 个月 = 7/31 寿终，寿终点精确', () => {
  const adopted = Date.UTC(2026, 0, 30, 16, 0); // 2026-01-31 00:00 Asia/Shanghai
  const petState = makePet({}, { adoptedAtMs: adopted, tz: TZ_SH });
  assert.equal(petState.lifeEndsAtMs, Date.UTC(2026, 6, 30, 16, 0)); // 2026-07-31 00:00

  const before = settleAt(petState, petState.lifeEndsAtMs - 1, {});
  assert.equal(before.deceased, false);
  const after = settleAt(petState, petState.lifeEndsAtMs, {});
  assert.equal(after.deceased, true);
  assert.equal(after.state.lifecycle, 'deceased');
});

test('寿终归档后保留照护数据（不清零 pendingWaste/羁绊）', () => {
  const base = makePet({
    affinity: 7,
    careCount: 3,
    pendingWaste: [{ id: 'w1', atMs: 0, plannedAtMs: 0, penalized: true }],
  });
  const lifeEnd = base.lifeEndsAtMs;
  const dead = settleAt(base, lifeEnd, {}).state;
  assert.equal(dead.affinity, 7);
  assert.equal(dead.careCount, 3);
  assert.equal(dead.pendingWaste.length, 1);
  assert.equal(dead.deceasedAtMs, lifeEnd);
});
