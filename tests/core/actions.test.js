/**
 * §7 操作合同：条件校验 / 开始动作（预留、串行、冷却）/ 到点完成 / 取消释放。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ACTION_ORDER,
  availableActions,
  cancelAction,
  settle,
  startAction,
} from '../../src/core/index.js';

import { ADOPTED, HOUR, MINUTE, approx, eventTypes, makePet } from './helpers.js';

const SECOND = 1000;

function startAt(pet, cmd, atMs = ADOPTED) {
  return startAction(pet, cmd, atMs, {});
}

test('六项操作的顺序与初始可用性', () => {
  const pet = makePet(); // H/M/E/C = 80/80/100/90，背包 6 半份基础口粮
  const actions = availableActions(pet, ADOPTED, {});
  assert.deepEqual(
    actions.map((item) => item.type),
    ACTION_ORDER,
  );
  const byType = Object.fromEntries(actions.map((item) => [item.type, item]));
  assert.equal(byType.feed.enabled, true);
  assert.equal(byType.water.enabled, true);
  assert.equal(byType.walk.enabled, true);
  assert.equal(byType.groom.enabled, true);
  assert.equal(byType.bathe.enabled, true);
  assert.equal(byType.cleanWaste.enabled, false);
  assert.equal(byType.cleanWaste.reason, 'NO_WASTE');
});

test('喂食：整份 H+60、扣 2 半份；开始时只预留不扣库存', () => {
  const pet = makePet({ H: 20 });
  const started = startAt(pet, { type: 'feed', itemId: 'basic', halfUnits: 2 });
  assert.equal(started.ok, true);
  assert.deepEqual(started.state.inventory, { basic: 6 }); // 预留不扣
  assert.deepEqual(started.state.activeAction.reserved, { itemId: 'basic', halfUnits: 2 });
  assert.equal(started.state.activeAction.id, `act-feed-${ADOPTED}`);
  assert.equal(started.state.activeAction.endsAtMs, ADOPTED + 5000);

  const done = settle(started.state, ADOPTED + 5000, {});
  const completed = done.events.find((event) => event.type === 'action.completed');
  assert.equal(completed.deltas.H, 60);
  assert.equal(done.state.inventory.basic, 4);
  assert.equal(done.state.activeAction, null);
  assert.equal(done.state.affinity, 1);
  assert.equal(done.state.careCount, 1);
});

test('喂食：半份 H+30、扣 1 半份', () => {
  const pet = makePet({ H: 20 });
  const started = startAt(pet, { type: 'feed', itemId: 'basic', halfUnits: 1 });
  assert.equal(started.ok, true);
  const done = settle(started.state, ADOPTED + 5000, {});
  const completed = done.events.find((event) => event.type === 'action.completed');
  approx(assert, completed.deltas.H, 30, 1e-9);
  assert.equal(done.state.inventory.basic, 5);
});

test('喂食：不指定 itemId 时自动挑一份可用口粮', () => {
  const pet = makePet({ H: 20, inventory: { favorite: 2 } });
  const started = startAt(pet, { type: 'feed' });
  assert.equal(started.ok, true);
  assert.equal(started.state.activeAction.itemId, 'favorite');
  assert.equal(started.state.activeAction.halfUnits, 2);
});

test('喂食条件：太饱 / 没货 / 零食每日上限', () => {
  const full = makePet({ H: 95 });
  assert.equal(startAt(full, { type: 'feed', itemId: 'basic', halfUnits: 2 }).error, 'NOT_HUNGRY');

  const empty = makePet({ H: 20, inventory: {} });
  assert.equal(startAt(empty, { type: 'feed', itemId: 'basic', halfUnits: 2 }).error, 'ITEM_MISSING');

  const snacksFull = makePet({
    H: 20,
    inventory: { snack: 2 },
    daily: {
      dayKey: '2026-01-01',
      eligibleTokens: 0,
      grantedCoins: 0,
      snacksUsed: 2,
      pettingRewards: 0,
      affinityGained: 0,
      reliefLastClaimedAtMs: null,
    },
  });
  assert.equal(startAt(snacksFull, { type: 'feed', itemId: 'snack', halfUnits: 2 }).error, 'DAILY_LIMIT');
});

test('喂水：无条件下可用，完成时 M+2', () => {
  const pet = makePet();
  assert.equal(startAt(pet, { type: 'water' }).ok, true);
  const done = settle(startAt(pet, { type: 'water' }).state, ADOPTED + 4000, {});
  const completed = done.events.find((event) => event.type === 'action.completed');
  assert.equal(completed.deltas.M, 2);
  assert.equal(done.state.lastWaterAtMs, ADOPTED + 4000);
});

test('逛街条件：太饿 / 体力不足 / 6h 冷却', () => {
  assert.equal(startAt(makePet({ H: 19 }), { type: 'walk' }).error, 'TOO_HUNGRY');
  assert.equal(startAt(makePet({ E: 29 }), { type: 'walk' }).error, 'LOW_ENERGY');
  const cooling = makePet({ lastWalkAtMs: ADOPTED - HOUR });
  const restarted = startAt(cooling, { type: 'walk' });
  assert.equal(restarted.ok, true); // lastWalk <= 领养时刻，视为从未做过
  const done = settle(restarted.state, ADOPTED + MINUTE, {});
  assert.equal(done.state.lastWalkAtMs, ADOPTED + MINUTE);
  const again = startAt(done.state, { type: 'walk' }, ADOPTED + HOUR);
  assert.equal(again.error, 'ON_COOLDOWN');
});

test('逛街效果：60s 完成，M+20 / E-15 / C-5、羁绊+2', () => {
  const pet = makePet({ H: 50, M: 40, E: 100, C: 90 });
  const started = startAt(pet, { type: 'walk' });
  assert.equal(started.ok, true);
  assert.equal(started.state.activeAction.endsAtMs, ADOPTED + 60000);
  const done = settle(started.state, ADOPTED + 60000, {});
  const completed = done.events.find((event) => event.type === 'action.completed');
  assert.equal(completed.deltas.M, 20);
  assert.equal(completed.deltas.E, -15);
  assert.equal(completed.deltas.C, -5);
  assert.equal(completed.affinityGained, 2);
  assert.equal(done.state.affinity, 2);
  assert.equal(done.state.lastWalkAtMs, ADOPTED + 60000);
});

test('洗澡条件：太干净 / 体力不足 / 12h 冷却；效果 C+60 M+3 E-5', () => {
  assert.equal(startAt(makePet({ C: 95 }), { type: 'bathe' }).error, 'TOO_CLEAN');
  assert.equal(startAt(makePet({ E: 9 }), { type: 'bathe' }).error, 'LOW_ENERGY');

  const pet = makePet({ C: 30, E: 50, M: 80 });
  const started = startAt(pet, { type: 'bathe' });
  assert.equal(started.ok, true);
  assert.equal(started.state.activeAction.endsAtMs, ADOPTED + 8000);
  const done = settle(started.state, ADOPTED + 8000, {});
  const completed = done.events.find((event) => event.type === 'action.completed');
  assert.equal(completed.deltas.C, 60);
  assert.equal(completed.deltas.M, 3);
  assert.equal(completed.deltas.E, -5);
  assert.equal(done.state.lastBatheAtMs, ADOPTED + 8000);
  assert.equal(startAt(done.state, { type: 'bathe' }, ADOPTED + HOUR).error, 'ON_COOLDOWN');
});

test('梳理条件：体力不足 / 24h 冷却；效果 C+10 M+4 E-2', () => {
  assert.equal(startAt(makePet({ E: 4 }), { type: 'groom' }).error, 'LOW_ENERGY');

  const pet = makePet({ C: 50, M: 80, E: 50 });
  const started = startAt(pet, { type: 'groom' });
  assert.equal(started.ok, true);
  assert.equal(started.state.activeAction.endsAtMs, ADOPTED + 6000);
  const done = settle(started.state, ADOPTED + 6000, {});
  const completed = done.events.find((event) => event.type === 'action.completed');
  assert.equal(completed.deltas.C, 10);
  assert.equal(completed.deltas.M, 4);
  assert.equal(completed.deltas.E, -2);
  assert.equal(startAt(done.state, { type: 'groom' }, ADOPTED + HOUR).error, 'ON_COOLDOWN');
});

test('动作到点才完成：4999ms 时仍在进行，5000ms 完成', () => {
  const pet = makePet({ H: 20 });
  const started = startAt(pet, { type: 'feed', itemId: 'basic', halfUnits: 2 });
  const before = settle(started.state, ADOPTED + 4999, {});
  assert.notEqual(before.state.activeAction, null);
  assert.ok(!eventTypes(before).includes('action.completed'));

  const after = settle(before.state, ADOPTED + 5000, {});
  assert.equal(after.state.activeAction, null);
  assert.ok(eventTypes(after).includes('action.completed'));
});

test('串行：进行中再发动作返回 BUSY', () => {
  const pet = makePet({ H: 20 });
  const started = startAt(pet, { type: 'feed', itemId: 'basic', halfUnits: 2 });
  const busy = startAt(started.state, { type: 'water' }, ADOPTED + 1000);
  assert.equal(busy.ok, false);
  assert.equal(busy.error, 'BUSY');
  assert.equal(availableActions(started.state, ADOPTED + 1000, {})[1].reason, 'BUSY');
});

test('取消动作：释放占用、不扣库存、不产生效果', () => {
  const pet = makePet({ H: 20 });
  const started = startAt(pet, { type: 'feed', itemId: 'basic', halfUnits: 2 });
  const cancelled = cancelAction(started.state, ADOPTED + 1000, {});
  assert.equal(cancelled.ok, true);
  assert.equal(cancelled.state.activeAction, null);
  assert.deepEqual(cancelled.state.inventory, { basic: 6 });
  assert.deepEqual(
    cancelled.events.map((event) => event.type),
    ['action.cancelled'],
  );

  const later = settle(cancelled.state, ADOPTED + 5000, {});
  assert.ok(!eventTypes(later).includes('action.completed'));
  assert.deepEqual(later.state.inventory, { basic: 6 });
  assert.equal(later.state.affinity, 0);

  const nothing = cancelAction(makePet(), ADOPTED, {});
  assert.equal(nothing.ok, false);
  assert.equal(nothing.error, 'NO_ACTIVE_ACTION');
});

test('未知动作与非法参数返回结构化错误', () => {
  const pet = makePet();
  assert.equal(startAt(pet, { type: 'dance' }).error, 'UNKNOWN_ACTION');
  assert.equal(startAt(pet, { type: 'feed', itemId: 'basic', halfUnits: 3 }).error, 'INVALID_PORTION');
  assert.equal(startAt(pet, {}).error, 'UNKNOWN_ACTION');
});

test('已死亡 / 托管时所有动作不可用', () => {
  const deceased = makePet({
    lifecycle: 'deceased',
    deceasedAtMs: ADOPTED,
    activeAction: null,
  });
  for (const action of availableActions(deceased, ADOPTED + HOUR, {})) {
    assert.equal(action.enabled, false);
    assert.equal(action.reason, 'PET_DECEASED');
  }
  assert.equal(startAt(deceased, { type: 'water' }, ADOPTED + HOUR).error, 'PET_DECEASED');

  const boarding = makePet({ mode: 'boarding', boardingSinceMs: ADOPTED });
  for (const action of availableActions(boarding, ADOPTED + HOUR, {})) {
    assert.equal(action.enabled, false);
    assert.equal(action.reason, 'BOARDING');
  }
  assert.equal(startAt(boarding, { type: 'water' }, ADOPTED + HOUR).error, 'BOARDING');
});
