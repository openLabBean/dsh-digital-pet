/**
 * 成长阶段 / 生命周期。纯函数：只接受毫秒数与显式时区。
 *
 * 阶段（半开区间，天粒度）：
 *   D0-3 婴儿 / D3-14 幼儿 / D14-45 少儿 / D45-90 青年 / D90-150 壮年 / D150-寿终 老年
 * 寿终：领养时刻在本地日历 +6 个月、同时分秒（月末 clamp），在领养时确定。
 */

import { DAY_MS, LIFE_MONTHS, STAGE_BOUNDARY_DAYS, STAGE_DEFS } from './constants.js';
import { addCalendarMonthsInZone } from './time.js';
import { assertFiniteMs, assertTimeZone } from './errors.js';

/**
 * 寿终时刻：领养时刻在本地日历 +6 个月，保持墙钟时分秒毫秒不变，
 * 目标月份无同日时夹到月末（如 8/31 +6 个月 -> 次年 2/28）。
 */
export function lifeEndsAtMs(adoptedAtMs, timeZone) {
  assertFiniteMs(adoptedAtMs, 'adoptedAtMs');
  assertTimeZone(timeZone);
  return addCalendarMonthsInZone(adoptedAtMs, LIFE_MONTHS, timeZone);
}

/** 六阶段边界表（天 / 毫秒两种单位）。 */
export function stageBoundaries() {
  return STAGE_DEFS.map((def) => ({
    key: def.key,
    label: def.label,
    startDay: def.startDay,
    endDay: def.endDay,
    startAgeMs: def.startDay * DAY_MS,
    endAgeMs: def.endDay === null ? null : def.endDay * DAY_MS,
  }));
}

function safeAgeMs(ageMs) {
  if (typeof ageMs !== 'number' || !Number.isFinite(ageMs) || ageMs < 0) return 0;
  return ageMs;
}

/** 阶段下标（0..5），半开区间；无效/负数年龄视为 0（婴儿）。 */
export function stageIndexForAgeMs(ageMs) {
  const age = safeAgeMs(ageMs);
  const days = age / DAY_MS;
  for (let index = STAGE_DEFS.length - 1; index >= 0; index -= 1) {
    if (days >= STAGE_DEFS[index].startDay) return index;
  }
  return 0;
}

/** 年龄 -> 阶段描述。 */
export function stageAt(ageMs) {
  const age = safeAgeMs(ageMs);
  const stageIndex = stageIndexForAgeMs(age);
  const def = STAGE_DEFS[stageIndex];
  const startAgeMs = def.startDay * DAY_MS;
  const endAgeMs = def.endDay === null ? null : def.endDay * DAY_MS;
  const progress =
    endAgeMs === null
      ? null
      : Math.min(1, Math.max(0, (age - startAgeMs) / (endAgeMs - startAgeMs)));
  return {
    key: def.key,
    label: def.label,
    ageMs: age,
    stageIndex,
    startDay: def.startDay,
    endDay: def.endDay,
    startAgeMs,
    endAgeMs,
    progress,
  };
}

/** 某阶段的开始时刻（年龄天 * 24h，与日历无关）。 */
export function stageStartAtMs(adoptedAtMs, stageKey) {
  assertFiniteMs(adoptedAtMs, 'adoptedAtMs');
  const def = STAGE_DEFS.find((item) => item.key === stageKey);
  if (!def) return null;
  return adoptedAtMs + def.startDay * DAY_MS;
}

/** 年龄 -> 领养后绝对时刻。 */
export function ageMsAt(adoptedAtMs, nowMs) {
  assertFiniteMs(adoptedAtMs, 'adoptedAtMs');
  assertFiniteMs(nowMs, 'nowMs');
  return Math.max(0, nowMs - adoptedAtMs);
}

/** 严格晚于 fromMs 的下一个阶段切换时刻；没有则返回 null。 */
export function nextStageBoundaryMs(adoptedAtMs, fromMs) {
  assertFiniteMs(adoptedAtMs, 'adoptedAtMs');
  assertFiniteMs(fromMs, 'fromMs');
  for (const day of STAGE_BOUNDARY_DAYS) {
    const instant = adoptedAtMs + day * DAY_MS;
    if (instant > fromMs) return instant;
  }
  return null;
}

/** 某状态在 nowMs 的年龄。 */
export function ageMsOfState(state, nowMs) {
  return ageMsAt(state.adoptedAtMs, nowMs);
}

/** 某状态在 nowMs 的阶段。 */
export function stageAtNow(state, nowMs) {
  return stageAt(ageMsOfState(state, nowMs));
}
