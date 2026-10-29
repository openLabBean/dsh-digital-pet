/**
 * §6.2 排泄：主食恢复 H>=20 触发、延迟 2h、睡眠顺延、同本地日≤1、场上≤2、
 * 新增 C-4、铲屎清空全部 M+2。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { HOUR_MS, resolveNeeds, settle, startAction } from '../../src/core/index.js';

import { ADOPTED, HOUR, approx, eventTypes, makePet } from './helpers.js';

const FEED_MS = 5000;

function feedCompleted(pet, atMs, cmd) {
  const started = startAction(pet, { type: 'feed', ...cmd }, atMs, {});
  assert.equal(started.ok, true, `开始喂食失败: ${started.error}`);
  return settle(started.state, atMs + FEED_MS, {});
}

test('有效主食恢复 H>=20：延迟 2h 规划一份排泄', () => {
  const pet = makePet({ H: 30 });
  const done = feedCompleted(pet, ADOPTED, { itemId: 'basic', halfUnits: 2 });

  assert.equal(done.state.pendingWaste.length, 1);
  const planned = done.events.find((event) => event.type === 'waste.planned');
  assert.ok(planned, '应有 waste.planned 事件');
  const waste = done.state.pendingWaste[0];
  assert.equal(waste.id, 'w1');
  assert.equal(waste.plannedAtMs, ADOPTED + FEED_MS);
  assert.equal(waste.atMs, ADOPTED + FEED_MS + 2 * HOUR);
  assert.equal(waste.penalized, false);
  assert.equal(done.state.lastWastePlannedDayKey, '2026-01-01');
  approx(assert, done.state.foodRecoveredToday, 60, 1e-6, '恢复量'); // 动作到点先结算完成再加效果，增益恰为 60
});

test('排泄到点才出现：出现前不扣 C，出现时只扣一次 -4', () => {
  const pet = makePet({ H: 30 });
  const done = feedCompleted(pet, ADOPTED, { itemId: 'basic', halfUnits: 2 });
  const due = ADOPTED + FEED_MS + 2 * HOUR;

  const before = settle(done.state, due - 1, {});
  assert.equal(before.state.pendingWaste[0].penalized, false);
  assert.ok(!eventTypes(before).includes('waste.appeared'));

  const appeared = settle(before.state, due, {});
  assert.equal(appeared.state.pendingWaste[0].penalized, true);
  assert.ok(eventTypes(appeared).includes('waste.appeared'));
  // 1ms 内衰减可忽略，C 的变化就是 -4
  approx(assert, before.state.C - appeared.state.C, 4, 1e-6, '排泄出现 C-4');
});

test('同一份排泄即使跨很多小时结算也只扣一次 C', () => {
  const pet = makePet({ H: 30 });
  const done = feedCompleted(pet, ADOPTED, { itemId: 'basic', halfUnits: 2 });
  const due = ADOPTED + FEED_MS + 2 * HOUR;

  const far = settle(done.state, due + 10 * HOUR, {});
  assert.equal(far.events.filter((event) => event.type === 'waste.appeared').length, 1);
  const cAfterAppear = far.state.C;
  const more = settle(far.state, due + 20 * HOUR, {});
  assert.equal(more.events.filter((event) => event.type === 'waste.appeared').length, 0);
  // 只随时间衰减：20:00:05 -> 23:00 清醒 2.9986h * 0.75，之后入睡 C 不衰减，没有额外 -4
  approx(assert, cAfterAppear - more.state.C, 2.99861111 * 0.75, 1e-3, '二次结算 C');
});

test('同一本地日最多规划一份排泄（吃两餐只排一次）', () => {
  const pet = makePet({ H: 20 });
  const first = feedCompleted(pet, ADOPTED, { itemId: 'basic', halfUnits: 1 });
  assert.equal(first.state.pendingWaste.length, 1);
  approx(assert, first.state.foodRecoveredToday, 30, 1e-6, '第一餐');

  const second = feedCompleted(first.state, ADOPTED + FEED_MS, {
    itemId: 'basic',
    halfUnits: 1,
  });
  assert.equal(second.state.pendingWaste.length, 1);
  assert.equal(second.events.filter((event) => event.type === 'waste.planned').length, 0);
  assert.ok(second.state.foodRecoveredToday >= 60 - 1e-3);
});

test('场上已有 2 份排泄时不再规划新的', () => {
  const pet = makePet({
    H: 20,
    pendingWaste: [
      { id: 'w1', atMs: ADOPTED - HOUR, plannedAtMs: ADOPTED - 3 * HOUR, penalized: true },
      { id: 'w2', atMs: ADOPTED - HOUR, plannedAtMs: ADOPTED - 3 * HOUR, penalized: true },
    ],
    wasteSeq: 2,
  });
  const done = feedCompleted(pet, ADOPTED, { itemId: 'basic', halfUnits: 2 });
  assert.equal(done.state.pendingWaste.length, 2);
  assert.equal(done.events.filter((event) => event.type === 'waste.planned').length, 0);
});

test('睡眠中到点则顺延到醒来时刻出现', () => {
  // 2026-01-01 22:00 Asia/Shanghai 喂食 -> 02:00:05 本应出现，但睡眠中 -> 顺延到 07:00
  const night = Date.UTC(2026, 0, 1, 14, 0);
  const pet = makePet({ H: 30 }, { adoptedAtMs: night });
  const done = feedCompleted(pet, night, { itemId: 'basic', halfUnits: 2 });
  const waste = done.state.pendingWaste[0];
  assert.equal(waste.atMs, night + 9 * HOUR); // 次日 07:00 SH
  approx(assert, (waste.plannedAtMs - night) / HOUR, 5 / 3600, 1e-3, '规划时刻');

  const beforeWake = settle(done.state, night + 9 * HOUR - 1, {});
  assert.deepEqual(eventTypes(beforeWake).filter((type) => type.startsWith('waste')), []);
  const woke = settle(beforeWake.state, night + 9 * HOUR, {});
  assert.ok(eventTypes(woke).includes('waste.appeared'));
});

test('铲屎：清空全部排泄、M+2、羁绊+1、到点完成', () => {
  const pet = makePet({
    M: 70,
    pendingWaste: [
      { id: 'w1', atMs: ADOPTED, plannedAtMs: ADOPTED - 2 * HOUR, penalized: true },
      { id: 'w2', atMs: ADOPTED, plannedAtMs: ADOPTED - 2 * HOUR, penalized: true },
    ],
    wasteSeq: 2,
  });
  const started = startAction(pet, { type: 'cleanWaste' }, ADOPTED + 1000, {});
  assert.equal(started.ok, true);
  assert.equal(started.state.activeAction.endsAtMs, ADOPTED + 4000);
  const result = settle(started.state, ADOPTED + 4000, {});
  assert.equal(result.state.pendingWaste.length, 0);
  const cleaned = result.events.find((event) => event.type === 'waste.cleaned');
  assert.equal(cleaned.count, 2);
  assert.equal(cleaned.moodGain, 2);
  assert.equal(result.state.affinity, 1);
  assert.equal(result.state.careCount, 1);
});

test('没有已出现的排泄时铲屎不可用（未来才出现的也不行）', () => {
  const pet = makePet({
    H: 30,
    pendingWaste: [
      { id: 'w1', atMs: ADOPTED + HOUR, plannedAtMs: ADOPTED, penalized: false },
    ],
  });
  const started = startAction(pet, { type: 'cleanWaste' }, ADOPTED + 1000, {});
  assert.equal(started.ok, false);
  assert.equal(started.error, 'NO_WASTE');
});

test('小零食不计入主食恢复，也不触发排泄', () => {
  const pet = makePet({ H: 30, inventory: { snack: 2 } });
  const done = feedCompleted(pet, ADOPTED, { itemId: 'snack', halfUnits: 2 });
  assert.equal(done.state.pendingWaste.length, 0);
  assert.equal(done.state.foodRecoveredToday, 0);
  assert.equal(done.state.daily.snacksUsed, 1);
  approx(assert, done.state.H, 38 - (FEED_MS / HOUR_MS) * 3, 1e-6, 'H');
});

test('排泄出现后有诉求，优先级 3', () => {
  const pet = makePet({
    H: 100,
    M: 80,
    E: 100,
    C: 90,
    pendingWaste: [
      { id: 'w1', atMs: ADOPTED - HOUR, plannedAtMs: ADOPTED - 3 * HOUR, penalized: true },
    ],
  });
  const needs = resolveNeeds(pet, ADOPTED, {});
  assert.equal(needs.need, 'waste');
  assert.equal(needs.priority, 3);
  assert.equal(needs.needs[0].triggeredAtMs, ADOPTED - HOUR);
});
