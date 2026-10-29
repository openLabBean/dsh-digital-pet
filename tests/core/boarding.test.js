/**
 * §10.2 托管：开启即托底 + 饮水、期间不衰减/不排泄/无诉求、不暂停寿命、可结束。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  availableActions,
  resolveNeeds,
  setBoarding,
  settle,
  startAction,
} from '../../src/core/index.js';

import { ADOPTED, DAY, HOUR, TZ_SH, eventTypes, makePet } from './helpers.js';

test('开启托管：四项状态托底到 60、视为已饮水、事件 boarding.started', () => {
  const pet = makePet({ H: 30, M: 20, E: 10, C: 20 });
  const result = setBoarding(pet, true, ADOPTED, {});
  assert.equal(result.ok, true);
  assert.equal(result.state.mode, 'boarding');
  assert.equal(result.state.boardingSinceMs, ADOPTED);
  assert.equal(result.state.H, 60);
  assert.equal(result.state.M, 60);
  assert.equal(result.state.E, 60);
  assert.equal(result.state.C, 60);
  assert.equal(result.state.lastWaterAtMs, ADOPTED);
  assert.equal(result.state.waterRewardedAtMs, ADOPTED);
  assert.equal(result.state.waterPenaltyM, 0);
  assert.deepEqual(eventTypes(result), ['boarding.started']);
});

test('开启托管不会降低本来更高的状态', () => {
  const pet = makePet({ H: 95, M: 90, E: 100, C: 99 });
  const result = setBoarding(pet, true, ADOPTED, {});
  assert.equal(result.state.H, 95);
  assert.equal(result.state.M, 90);
  assert.equal(result.state.E, 100);
  assert.equal(result.state.C, 99);
});

test('托管期间：不衰减、不产生排泄、无主动诉求、不消耗库存、不加羁绊', () => {
  const started = setBoarding(makePet({ H: 30 }), true, ADOPTED, {});
  const result = settle(started.state, ADOPTED + 2 * DAY, {});
  assert.equal(result.state.mode, 'boarding');
  assert.equal(result.state.H, 60); // 唯一低于下限的状态被托底
  assert.equal(result.state.M, 80); // 本来更高的状态不会被降低
  assert.equal(result.state.E, 100);
  assert.equal(result.state.C, 90);
  assert.deepEqual(result.state.pendingWaste, []);
  assert.deepEqual(result.state.wallet, { balance: 60 });
  assert.deepEqual(result.state.inventory, { basic: 6 });
  assert.equal(result.state.affinity, 0);
  assert.equal(result.state.careCount, 0);
  assert.deepEqual(resolveNeeds(result.state, ADOPTED + 2 * DAY, {}).needs, []);
  assert.ok(!eventTypes(result).includes('waste.appeared'));
});

test('托管不暂停寿命：寿终时刻仍然归档', () => {
  const started = setBoarding(makePet(), true, ADOPTED, {});
  assert.equal(started.state.lifeEndsAtMs, makePet().lifeEndsAtMs); // 寿命固定
  const result = settle(started.state, started.state.lifeEndsAtMs + HOUR, {});
  assert.equal(result.deceased, true);
  assert.equal(result.state.lifecycle, 'deceased');
  assert.equal(result.state.deceasedAtMs, started.state.lifeEndsAtMs);
  assert.equal(result.events.find((event) => event.type === 'pet.deceased').atMs, started.state.lifeEndsAtMs);
});

test('结束托管：恢复自由活动，之后按正常规则衰减', () => {
  const started = setBoarding(makePet({ H: 30 }), true, ADOPTED, {});
  const ended = setBoarding(started.state, false, ADOPTED + HOUR, {});
  assert.equal(ended.ok, true);
  assert.equal(ended.state.mode, 'normal');
  assert.equal(ended.state.boardingSinceMs, null);
  assert.deepEqual(eventTypes(ended), ['boarding.ended']);

  const later = settle(ended.state, ADOPTED + 2 * HOUR, {});
  assert.ok(later.state.H < 60); // 恢复自然衰减
  assert.equal(later.state.mode, 'normal');
});

test('重复开启 / 未托管时结束：结构化错误', () => {
  const started = setBoarding(makePet(), true, ADOPTED, {});
  assert.equal(setBoarding(started.state, true, ADOPTED + HOUR, {}).error, 'ALREADY_BOARDING');
  assert.equal(setBoarding(makePet(), false, ADOPTED, {}).error, 'NOT_BOARDING');
});

test('开启托管会取消进行中的动作并释放预留，不扣库存', () => {
  const pet = makePet({ H: 20 });
  const started = startAction(pet, { type: 'feed', itemId: 'basic', halfUnits: 2 }, ADOPTED, {});
  const boarding = setBoarding(started.state, true, ADOPTED + 1000, {});
  assert.equal(boarding.ok, true);
  assert.equal(boarding.state.activeAction, null);
  assert.deepEqual(boarding.state.inventory, { basic: 6 }); // 没有扣货
  const cancelled = boarding.events.find((event) => event.type === 'action.cancelled');
  assert.equal(cancelled.reason, 'BOARDING_STARTED');
  assert.equal(cancelled.atMs, ADOPTED + 1000);

  // 动作不会在托管中“完成”
  const later = settle(boarding.state, ADOPTED + 60000, {});
  assert.ok(!eventTypes(later).includes('action.completed'));
  assert.equal(later.state.affinity, 0);
});

test('托管中所有动作不可用、抚摸不可用', () => {
  const started = setBoarding(makePet(), true, ADOPTED, {});
  for (const action of availableActions(started.state, ADOPTED + HOUR, {})) {
    assert.equal(action.enabled, false);
    assert.equal(action.reason, 'BOARDING');
  }
  assert.equal(startAction(started.state, { type: 'water' }, ADOPTED + HOUR, {}).error, 'BOARDING');
});

test('死亡宠物不能托管', () => {
  const dead = makePet({ lifecycle: 'deceased', deceasedAtMs: ADOPTED, activeAction: null });
  const result = setBoarding(dead, true, ADOPTED + HOUR, {});
  assert.equal(result.ok, false);
  assert.equal(result.error, 'PET_DECEASED');
});
