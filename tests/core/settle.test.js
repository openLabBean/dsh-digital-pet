/**
 * care.js settle()：#5 状态衰减 / #10 离线外的常规结算 / #13 状态轴。
 * 固定 nowMs + 固定时区，断言可确定性重放。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DAY_MS,
  HOUR_MS,
  createInitialState,
  settle,
} from '../../src/core/index.js';

import {
  ADOPTED,
  DAY,
  HOUR,
  TZ_NY,
  TZ_SH,
  approx,
  eventTypes,
  makePet,
} from './helpers.js';

test('24h 标准作息衰减：H-54 / M-18 / C-12 / 体力 98.5', () => {
  const pet = makePet();
  const result = settle(pet, ADOPTED + DAY, {});

  // 清醒 16h + 睡眠 8h：H 80-48-6=26；M 80-16-2=62；C 90-12=78
  approx(assert, result.state.H, 26, 1e-6, 'H');
  approx(assert, result.state.M, 62, 1e-6, 'M');
  approx(assert, result.state.C, 78, 1e-6, 'C');
  // E：100 - 22.5(前15h) = 77.5，睡眠 +60 封顶 100，最后 1h -1.5 = 98.5
  approx(assert, result.state.E, 98.5, 1e-6, 'E');

  assert.deepEqual(
    eventTypes(result).filter((type) =>
      ['sleep.start', 'sleep.end', 'day.rolled'].includes(type),
    ),
    ['sleep.start', 'day.rolled', 'sleep.end'],
  );
  for (const event of result.events) {
    assert.ok(Number.isFinite(event.atMs), `事件 ${event.type} 必须有有限 atMs`);
  }
  // 事件按时间排序
  const times = result.events.map((event) => event.atMs);
  assert.deepEqual(times, [...times].sort((a, b) => a - b));

  assert.equal(result.state.sleeping, false);
  assert.equal(result.state.lastSettledAtMs, ADOPTED + DAY);
  assert.equal(result.state.daily.dayKey, '2026-01-02');
  assert.equal(result.deceased, false);
});

test('状态夹紧在 [0,100]：7 天在线也不出现负数', () => {
  const pet = makePet();
  const result = settle(pet, ADOPTED + 7 * DAY, {});
  assert.equal(result.state.H, 0);
  assert.equal(result.state.M, 0);
  approx(assert, result.state.E, 98.5, 1e-6, 'E');
  assert.equal(result.state.C, 6);
  for (const key of ['H', 'M', 'E', 'C']) {
    assert.ok(result.state[key] >= 0 && result.state[key] <= 100, `${key} 越界`);
  }
  assert.equal(result.state.daily.dayKey, '2026-01-08');
  assert.equal(result.state.stage, 'toddler'); // 第 7 天
  assert.equal(result.events.filter((event) => event.type === 'day.rolled').length, 7);
  assert.ok(result.events.some((event) => event.type === 'stage.changed'));
});

test('睡眠时体力恢复封顶 100', () => {
  // 2026-01-01 23:30 Asia/Shanghai 入睡，E=99，睡 1h
  const pet = makePet(
    { E: 99 },
    { adoptedAtMs: Date.UTC(2026, 0, 1, 15, 30) },
  );
  assert.equal(pet.sleeping, true);
  const result = settle(pet, Date.UTC(2026, 0, 1, 16, 30), {});
  assert.equal(result.state.E, 100);
});

test('时钟回拨：nowMs <= lastSettledAtMs 时原样返回', () => {
  const pet = makePet();
  const settled = settle(pet, ADOPTED + DAY, {}).state;
  const rewound = settle(settled, ADOPTED + HOUR, {});
  assert.deepEqual(rewound.state, settled);
  assert.deepEqual(rewound.events, []);
});

test('不修改入参 state（纯函数）', () => {
  const pet = makePet();
  const snapshot = structuredClone(pet);
  const result = settle(pet, ADOPTED + 3 * DAY, {});
  assert.deepEqual(pet, snapshot);
  assert.notDeepEqual(result.state, pet);
});

test('可见性只影响渲染，不改变成长/照护结算', () => {
  const visible = makePet({ visible: true });
  const hidden = makePet({ visible: false });
  const a = settle(visible, ADOPTED + DAY, {});
  const b = settle(hidden, ADOPTED + DAY, {});
  assert.deepEqual(
    { H: a.state.H, M: a.state.M, E: a.state.E, C: a.state.C },
    { H: b.state.H, M: b.state.M, E: b.state.E, C: b.state.C },
  );
  assert.deepEqual(eventTypes(b), eventTypes(a));
});

test('E<20 自动休息：E+10/h 替代清醒衰减，到 40 结束', () => {
  const pet = makePet({ E: 19 });
  const noSleep = { sleepStart: null, sleepEnd: null };
  const rested = settle(pet, ADOPTED + 2 * HOUR, noSleep);
  approx(assert, rested.state.E, 39, 1e-6, '休息 2h 后 E');
  assert.equal(rested.state.resting, true);
  // 白天休息不减缓 H/M
  approx(assert, rested.state.H, 74, 1e-6, '休息 H');
  approx(assert, rested.state.M, 78, 1e-6, '休息 M');

  const fully = settle(rested.state, ADOPTED + 2 * HOUR + 6 * 60 * 1000, noSleep);
  approx(assert, fully.state.E, 40, 1e-6, '恢复满 E');
  assert.equal(fully.state.resting, false);
});

test('首次领养赠礼：60 金币 + 6 半份基础口粮；已领取时不再发', () => {
  const granted = createInitialState({
    petId: 'gift-pet',
    speciesId: 'shiba',
    adoptedAtMs: ADOPTED,
    tz: TZ_SH,
  });
  assert.equal(granted.firstGiftGranted, true);
  assert.equal(granted.wallet.balance, 60);
  assert.equal(granted.inventory.basic, 6);

  const plain = createInitialState({
    petId: 'plain-pet',
    speciesId: 'shiba',
    adoptedAtMs: ADOPTED,
    tz: TZ_SH,
    firstGiftGranted: true,
  });
  assert.equal(plain.wallet.balance, 0);
  assert.equal(plain.inventory.basic, undefined);
});

test('跨午夜：本地 00:00 触发一次 day.rolled', () => {
  const pet = makePet();
  // 08:00 -> 次日 00:30，跨过一次本地午夜
  const result = settle(pet, ADOPTED + 16.5 * HOUR, {});
  const rolled = result.events.filter((event) => event.type === 'day.rolled');
  assert.equal(rolled.length, 1);
  assert.equal(rolled[0].atMs, Date.UTC(2026, 0, 1, 16, 0)); // 2026-01-02 00:00 SH
  assert.equal(result.state.daily.dayKey, '2026-01-02');
});

test('阶段切换在 D3 边界触发 stage.changed', () => {
  const pet = makePet();
  const result = settle(pet, ADOPTED + 3 * DAY, {});
  const changed = result.events.filter((event) => event.type === 'stage.changed');
  assert.equal(changed.length, 1);
  assert.equal(changed[0].atMs, ADOPTED + 3 * DAY);
  assert.equal(changed[0].previous, 'baby');
  assert.equal(changed[0].stage, 'toddler');
  assert.equal(result.state.stage, 'toddler');
});

test('夏令时：纽约 2026-03-08 春令时睡眠夜按真实 7h 结算', () => {
  // 2026-03-07 23:00 EST 入睡 -> 2026-03-08 08:00 EDT（真实 8h：睡眠 7h + 清醒 1h）
  const adopted = Date.UTC(2026, 2, 8, 4, 0); // 23:00 EST
  const pet = createInitialState({
    petId: 'ny-pet',
    speciesId: 'shiba',
    adoptedAtMs: adopted,
    tz: TZ_NY,
    configVersion: 1,
  });
  assert.equal(pet.sleeping, true);
  const result = settle(pet, Date.UTC(2026, 2, 8, 12, 0), {}); // 08:00 EDT
  approx(assert, result.state.H, 71.75, 1e-6, 'DST H');
  approx(assert, result.state.M, 77.25, 1e-6, 'DST M');
  approx(assert, result.state.E, 98.5, 1e-6, 'DST E');
  approx(assert, result.state.C, 89.25, 1e-6, 'DST C');
  assert.equal(result.state.sleeping, false);
  assert.ok(result.events.some((event) => event.type === 'sleep.end'));
});
