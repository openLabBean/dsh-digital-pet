/**
 * 测试公共夹具：固定时区、固定 nowMs，保证引擎确定性可重放。
 * 注意：本文件不是 *.test.js，不会被 node --test 当作测试用例执行。
 */

import { createInitialState, settle } from '../../src/core/index.js';

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export const TZ_SH = 'Asia/Shanghai';
export const TZ_NY = 'America/New_York';

/** 2026-01-01T00:00:00Z = 2026-01-01 08:00 Asia/Shanghai（清醒起点，便于对齐“24h 标准作息”）。 */
export const ADOPTED = Date.UTC(2026, 0, 1, 0, 0, 0);

/**
 * 造一只测试宠物。默认带首次领养赠礼（60 金币 + 6 半份基础口粮），
 * 可用 overrides 覆盖任意 state 字段，用 options 覆盖创建参数。
 */
export function makePet(overrides = {}, options = {}) {
  const { adoptedAtMs = ADOPTED, tz = TZ_SH, ...rest } = options;
  const base = createInitialState({
    petId: 'pet-1',
    speciesId: 'shiba',
    nickname: '豆豆',
    adoptedAtMs,
    tz,
    configVersion: 1,
    ...rest,
  });
  return { ...base, ...overrides };
}

/** 浮点近似断言（引擎里大量“按秒折算”的衰减，用容差对齐）。 */
export function approx(assert, actual, expected, eps = 1e-6, message = '') {
  if (typeof actual !== 'number' || Number.isNaN(actual)) {
    assert.fail(`${message}：期望 ${expected}，实际不是有效数字 (${actual})`);
  }
  assert.ok(
    Math.abs(actual - expected) <= eps,
    `${message}：期望 ≈${expected}，实际 ${actual}（容差 ${eps}）`,
  );
}

/** 事件类型序列。 */
export function eventTypes(result) {
  return result.events.map((event) => event.type);
}

/** 结算一次并返回结果（语义糖）。 */
export function settleAt(state, atMs, cfg = {}) {
  return settle(state, atMs, cfg);
}

/** 毫秒时间戳换算成“距 adopt 的小时数”，便于断言边界事件。 */
export function hoursSinceAdoption(atMs, adoptedAtMs = ADOPTED) {
  return (atMs - adoptedAtMs) / HOUR;
}
