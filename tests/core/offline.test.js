/**
 * §10.2 离线结算：24h 保护下限、超过 24h 自动托管、睡眠跨段、寿终、无新排泄。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveNeeds, settle, startAction } from '../../src/core/index.js';

import { ADOPTED, DAY, HOUR, MINUTE, TZ_SH, approx, eventTypes, makePet } from './helpers.js';

test('离线 8h：正常衰减 + 保护事件，不进入托管', () => {
  const pet = makePet();
  const result = settle(pet, ADOPTED + 8 * HOUR, { offline: true });
  assert.equal(result.deceased, false);
  assert.equal(result.state.mode, 'normal');
  assert.equal(result.state.H, 56);
  assert.equal(result.state.M, 72);
  assert.equal(result.state.E, 88);
  assert.equal(result.state.C, 84);
  assert.ok(eventTypes(result).includes('offline.protected'));
  assert.ok(!eventTypes(result).includes('boarding.auto'));
  const protectedEvent = result.events.find((event) => event.type === 'offline.protected');
  assert.deepEqual(protectedEvent.floors, { H: 30, M: 40, E: 30, C: 40 });
  assert.deepEqual(protectedEvent.applied, []);
});

test('离线 24h：衰减后由保护下限抬回 30/40/30/40 下限', () => {
  const pet = makePet();
  const result = settle(pet, ADOPTED + 24 * HOUR, { offline: true });
  assert.equal(result.state.H, 30); // 正常衰减 26，保护到 30
  assert.equal(result.state.M, 62);
  assert.equal(result.state.E, 98.5);
  assert.equal(result.state.C, 78);
  assert.ok(!eventTypes(result).includes('boarding.auto'));
  const applied = result.events.find((event) => event.type === 'offline.protected').applied;
  assert.deepEqual(applied, [{ stat: 'H', before: 26, after: 30 }]);
});

test('离线 24h+1h：保护结束后自动托管，状态回到 ≥60', () => {
  const pet = makePet();
  const result = settle(pet, ADOPTED + 25 * HOUR, { offline: true });
  assert.equal(result.state.mode, 'normal'); // 托管是离线期间临时态
  assert.equal(result.state.H, 60); // 26 -> 保护 30 -> 托管 60
  assert.equal(result.state.M, 62);
  assert.equal(result.state.C, 78);
  const types = eventTypes(result);
  assert.ok(types.includes('offline.protected'));
  assert.ok(types.includes('boarding.auto'));
  assert.equal(result.state.lastWaterAtMs, ADOPTED + 25 * HOUR);
  assert.ok(result.state.waterPenaltyM === 0);
});

test('离线 7d：托管期间不饿死，回到正常态、已自动饮水、阶段仍在成长', () => {
  const pet = makePet();
  const result = settle(pet, ADOPTED + 7 * DAY, { offline: true });
  assert.equal(result.deceased, false);
  assert.equal(result.state.mode, 'normal');
  assert.equal(result.state.H, 60);
  assert.equal(result.state.M, 62);
  assert.equal(result.state.E, 98.5);
  assert.equal(result.state.C, 78);
  assert.equal(result.state.lastWaterAtMs, ADOPTED + 7 * DAY);
  assert.deepEqual(result.state.wallet, { balance: 60 });
  assert.deepEqual(result.state.inventory, { basic: 6 }); // 托管不消耗库存
  const types = eventTypes(result);
  assert.ok(types.includes('boarding.auto'));
  assert.ok(types.includes('offline.protected'));
  assert.ok(types.includes('stage.changed'));
  // 7 天 -> 幼年（D3 起）
  assert.equal(result.state.stage, 'toddler');
  // 回来后没有饥饿/口渴/排泄等主动诉求（护理类长周期诉求仍可能出现）
  const needs = resolveNeeds(result.state, ADOPTED + 7 * DAY, {}).needs;
  assert.ok(needs.every((need) => need.priority >= 6));
  assert.ok(!needs.some((need) => need.key === 'hunger' || need.key === 'water' || need.key === 'waste'));

  // 已结算到 now 后再次 settle 不产生事件
  const again = settle(result.state, ADOPTED + 7 * DAY, { offline: true });
  assert.deepEqual(again.events, []);
});

test('离线跨午夜与睡眠：20:00 领养、离线 12h', () => {
  const night = makePet({}, { adoptedAtMs: Date.UTC(2026, 0, 1, 12, 0) }); // 20:00 Asia/Shanghai
  const result = settle(night, night.adoptedAtMs + 12 * HOUR, { offline: true });
  // 3h 清醒 + 8h 睡眠 + 1h 清醒
  assert.equal(result.state.H, 62);
  assert.equal(result.state.M, 74);
  assert.equal(result.state.E, 98.5); // 睡眠补满后最后 1h 清醒 -1.5
  assert.equal(result.state.C, 87);
  assert.equal(result.state.mode, 'normal');
});

test('离线保护不抬高本来就更低的状态（只防恶化）', () => {
  const pet = makePet({ H: 10, M: 20, E: 90, C: 20 });
  const result = settle(pet, ADOPTED + 5 * HOUR, { offline: true });
  // 5h 清醒：H-15 -> 0，保护下限目标=min(初始10, 30)=10
  assert.equal(result.state.H, 10);
  assert.equal(result.state.M, 20); // min(20,40)=20
  assert.equal(result.state.E, 82.5);
  assert.equal(result.state.C, 20); // min(20,40)=20
});

test('离线超过 24h：既有排泄保留但不产生新排泄，并计联动衰减', () => {
  const pet = makePet({ H: 30 });
  const started = startAction(pet, { type: 'feed', itemId: 'basic', halfUnits: 2 }, ADOPTED, {});
  const fed = settle(started.state, ADOPTED + 5000, {});
  assert.equal(fed.state.pendingWaste.length, 1);
  const wasteId = fed.state.pendingWaste[0].id;

  const result = settle(fed.state, ADOPTED + 7 * DAY, { offline: true });
  assert.equal(result.state.pendingWaste.length, 1); // 没有新排泄
  assert.equal(result.state.pendingWaste[0].id, wasteId);
  assert.equal(result.state.pendingWaste[0].penalized, true); // 出现时扣 C 一次且只一次
  approx(assert, result.state.C, 74, 0.01); // 78 - 4
  assert.equal(result.state.M, 60); // 排泄在清醒时 >4h 的联动衰减后由托管托底到 60
  assert.ok(eventTypes(result).includes('waste.appeared'));
});

test('离线期间寿终：按寿终时刻归档，寿终后不再更新状态', () => {
  const pet = makePet();
  const result = settle(pet, pet.lifeEndsAtMs + DAY, { offline: true });
  assert.equal(result.deceased, true);
  assert.equal(result.state.deceasedAtMs, pet.lifeEndsAtMs);
  assert.equal(result.state.lifecycle, 'deceased');
  // 事件按时间有序，最后一条死亡事件在寿终时刻
  const deceasedEvent = result.events.find((event) => event.type === 'pet.deceased');
  assert.equal(deceasedEvent.atMs, pet.lifeEndsAtMs);
  for (const event of result.events) {
    assert.ok(event.atMs <= pet.lifeEndsAtMs);
  }
  // 再 settle 不再变化
  const again = settle(result.state, pet.lifeEndsAtMs + 2 * DAY, { offline: true });
  assert.deepEqual(again.events, []);
  assert.equal(again.state.deceasedAtMs, pet.lifeEndsAtMs);
});

test('离线事件按时间有序，且事件时间不晚于 now', () => {
  const pet = makePet({ H: 30 });
  const fed = settle(
    startAction(pet, { type: 'feed', itemId: 'basic', halfUnits: 2 }, ADOPTED, {}).state,
    ADOPTED + 5000,
    {},
  );
  const result = settle(fed.state, ADOPTED + 3 * DAY, { offline: true });
  let previous = -Infinity;
  for (const event of result.events) {
    assert.ok(event.atMs >= previous, `event ${event.type} out of order`);
    assert.ok(event.atMs <= ADOPTED + 3 * DAY);
    previous = event.atMs;
  }
});

test('离线后恢复在线：后续按正常衰减结算', () => {
  const pet = makePet();
  const offline = settle(pet, ADOPTED + 7 * DAY, { offline: true });
  const online = settle(offline.state, ADOPTED + 7 * DAY + 4 * HOUR, {});
  // 10:00 -> 14:00 清醒 4h：H-12 / M-4 / E-6 / C-3
  assert.equal(online.state.H, 48);
  assert.equal(online.state.M, 58);
  assert.equal(online.state.E, 92.5);
  approx(assert, online.state.C, 75, 0.01);
  assert.ok(!eventTypes(online).includes('boarding.auto'));
});
