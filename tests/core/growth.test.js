/**
 * growth.js：#4.1 生命周期、阶段边界、月末寿终。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DAY_MS,
  HOUR_MS,
  createInitialState,
  lifeEndsAtMs,
  localDayKey,
  stageAt,
  stageBoundaries,
  stageStartAtMs,
  nextStageBoundaryMs,
  zonedParts,
} from '../../src/core/index.js';

import { ADOPTED, TZ_NY, TZ_SH, makePet } from './helpers.js';

test('stageBoundaries 返回六个阶段与 D3/D14/D45/D90/D150 起点', () => {
  const stages = stageBoundaries();
  assert.equal(stages.length, 6);
  assert.deepEqual(
    stages.map((item) => item.key),
    ['baby', 'toddler', 'child', 'teen', 'adult', 'elder'],
  );
  assert.deepEqual(
    stages.map((item) => item.startDay),
    [0, 3, 14, 45, 90, 150],
  );
  assert.deepEqual(
    stages.map((item) => item.endDay),
    [3, 14, 45, 90, 150, null],
  );
  for (const stage of stages) {
    assert.ok(stage.label.length > 0);
    assert.equal(stage.startAgeMs, stage.startDay * DAY_MS);
  }
});

test('stageAt：阶段区间半开，出生 0 天是 baby', () => {
  const cases = [
    [0, 'baby'],
    [3 * DAY_MS - 1, 'baby'],
    [3 * DAY_MS, 'toddler'],
    [14 * DAY_MS - 1, 'toddler'],
    [14 * DAY_MS, 'child'],
    [45 * DAY_MS - 1, 'child'],
    [45 * DAY_MS, 'teen'],
    [90 * DAY_MS - 1, 'teen'],
    [90 * DAY_MS, 'adult'],
    [150 * DAY_MS - 1, 'adult'],
    [150 * DAY_MS, 'elder'],
    [400 * DAY_MS, 'elder'],
  ];
  for (const [ageMs, key] of cases) {
    const stage = stageAt(ageMs);
    assert.equal(stage.key, key, `age=${ageMs / DAY_MS} 天应为 ${key}`);
    assert.equal(stage.ageMs, ageMs);
    assert.equal(typeof stage.label, 'string');
    assert.ok(stage.label.length > 0);
  }
  assert.deepEqual(
    [0, 3, 14, 45, 90, 150, 400].map((days) => stageAt(days * DAY_MS).stageIndex),
    [0, 1, 2, 3, 4, 5, 5],
  );
});

test('stageStartAtMs / nextStageBoundaryMs 与阶段边界一致', () => {
  assert.equal(stageStartAtMs(ADOPTED, 'baby'), ADOPTED);
  assert.equal(stageStartAtMs(ADOPTED, 'toddler'), ADOPTED + 3 * DAY_MS);
  assert.equal(nextStageBoundaryMs(ADOPTED, ADOPTED + HOUR_MS), ADOPTED + 3 * DAY_MS);
  assert.equal(
    nextStageBoundaryMs(ADOPTED, ADOPTED + 3 * DAY_MS),
    ADOPTED + 14 * DAY_MS,
  );
  assert.equal(nextStageBoundaryMs(ADOPTED, ADOPTED + 150 * DAY_MS), null);
});

test('lifeEndsAtMs：1/31 + 6 个月 = 7/31（月末 clamp 不提前）', () => {
  const adopted = Date.UTC(2026, 0, 30, 16, 0); // 2026-01-31 00:00 Asia/Shanghai
  const end = lifeEndsAtMs(adopted, TZ_SH);
  assert.equal(localDayKey(end, TZ_SH), '2026-07-31');
  assert.equal(zonedParts(end, TZ_SH).hour, 0);
  assert.ok(end > adopted);
});

test('lifeEndsAtMs：8/31 + 6 个月 = 次年 2/28（2 月无同日，墙钟时间保留）', () => {
  const adopted = Date.UTC(2026, 7, 31, 4, 34); // 2026-08-31 12:34 Asia/Shanghai
  const end = lifeEndsAtMs(adopted, TZ_SH);
  assert.equal(localDayKey(end, TZ_SH), '2027-02-28');
  const parts = zonedParts(end, TZ_SH);
  assert.equal(parts.hour, 12);
  assert.equal(parts.minute, 34);
});

test('lifeEndsAtMs：闰年 8/31 + 6 个月 = 次年 2/29', () => {
  const adopted = Date.UTC(2027, 7, 30, 16, 0); // 2027-08-31 00:00 Asia/Shanghai
  const end = lifeEndsAtMs(adopted, TZ_SH);
  assert.equal(localDayKey(end, TZ_SH), '2028-02-29');
});

test('lifeEndsAtMs：纽约跨夏令时仍保持本地 09:00', () => {
  const adopted = Date.UTC(2026, 0, 8, 14, 0); // 2026-01-08 09:00 EST
  const end = lifeEndsAtMs(adopted, TZ_NY);
  assert.equal(end, Date.UTC(2026, 6, 8, 13, 0)); // 2026-07-08 09:00 EDT
  assert.equal(zonedParts(end, TZ_NY).hour, 9);
});

test('寿终时刻在领养时固定，之后改 tz 不改变已存字段', () => {
  const pet = makePet();
  const expected = lifeEndsAtMs(ADOPTED, TZ_SH);
  assert.equal(pet.lifeEndsAtMs, expected);
  const migrated = { ...pet, tz: TZ_NY };
  assert.equal(migrated.lifeEndsAtMs, expected);
});

test('createInitialState 写入 lifeEndsAtMs 且首日阶段为 baby', () => {
  const pet = createInitialState({
    petId: 'p1',
    speciesId: 'shiba',
    adoptedAtMs: ADOPTED,
    tz: TZ_SH,
  });
  assert.equal(pet.lifeEndsAtMs, lifeEndsAtMs(ADOPTED, TZ_SH));
  assert.equal(pet.stage, 'baby');
  // 半年约 181~184 天，必然落在 elder（>=150 天）阶段
  const ageAtDeath = pet.lifeEndsAtMs - pet.adoptedAtMs;
  assert.ok(stageAt(ageAtDeath).ageMs === ageAtDeath);
  assert.equal(stageAt(ageAtDeath).key, 'elder');
});
