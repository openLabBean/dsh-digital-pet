/**
 * 时区 / 日历工具。全部纯函数：时区经参数传入，绝不读取 Date.now() 或进程环境。
 *
 * 实现要点：
 * - 用 Intl.DateTimeFormat 做「UTC 毫秒 -> 地方日历字段」的正向换算；
 * - 反向换算用“猜测偏移量 + 迭代校正”，对夏令时跳变/回拨都给出确定结果；
 * - 所有时间均为毫秒数（Unix epoch ms）。
 */

import {
  DEFAULT_SLEEP_END_MIN,
  DEFAULT_SLEEP_START_MIN,
  HOUR_MS,
} from './constants.js';
import { assertFiniteMs, assertTimeZone, engineError } from './errors.js';

const MINUTES_PER_DAY = 24 * 60;

const formatterCache = new Map();

function getFormatter(timeZone) {
  let formatter = formatterCache.get(timeZone);
  if (formatter) return formatter;
  assertTimeZone(timeZone);
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      fractionalSecondDigits: 3,
    });
  } catch (err) {
    throw engineError('INVALID_ARGUMENT', `invalid time zone: ${timeZone}`, {
      field: 'tz',
      cause: err,
    });
  }
  formatterCache.set(timeZone, formatter);
  return formatter;
}

function pad2(value) {
  return value < 10 ? `0${value}` : `${value}`;
}

function pad4(value) {
  if (value >= 1000) return `${value}`;
  if (value >= 100) return `0${value}`;
  if (value >= 10) return `00${value}`;
  return `000${value}`;
}

/** 取某时刻在指定时区的地方日历字段。 */
export function zonedParts(ms, timeZone) {
  assertFiniteMs(ms, 'ms');
  const formatter = getFormatter(timeZone);
  const parts = formatter.formatToParts(new Date(ms));
  const out = { year: 1970, month: 1, day: 1, hour: 0, minute: 0, second: 0, ms: 0 };
  for (const part of parts) {
    switch (part.type) {
      case 'year':
        out.year = Number(part.value);
        break;
      case 'month':
        out.month = Number(part.value);
        break;
      case 'day':
        out.day = Number(part.value);
        break;
      case 'hour':
        out.hour = Number(part.value) % 24;
        break;
      case 'minute':
        out.minute = Number(part.value);
        break;
      case 'second':
        out.second = Number(part.value);
        break;
      case 'fractionalSecond':
        out.ms = Number(part.value);
        break;
      default:
        break;
    }
  }
  return out;
}

function wallMsOf(parts) {
  return Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour || 0,
    parts.minute || 0,
    parts.second || 0,
    parts.ms || 0,
  );
}

/**
 * 地方日历时间 -> UTC 毫秒。对夏令时空缺/重复时间给出确定映射：
 * - 空缺（spring forward）：落到跳变后的时刻（墙钟时间被顺延）；
 * - 重复（fall back）：取较早的实例。
 */
export function zonedTimeToUtc(parts, timeZone) {
  assertTimeZone(timeZone);
  const wallMs = wallMsOf(parts);
  const offsetAt = (instantMs) => {
    const local = zonedParts(instantMs, timeZone);
    return wallMsOf(local) - instantMs;
  };
  let instant = wallMs - offsetAt(wallMs);
  // 两次校正足以覆盖任意一次时区偏移变化；多算一次保证收敛。
  instant = wallMs - offsetAt(instant);
  instant = wallMs - offsetAt(instant);
  return instant;
}

function daysInMonth(year, month) {
  // month: 1-12
  const date = new Date(Date.UTC(2000, 0, 1));
  date.setUTCFullYear(year, month, 0);
  return date.getUTCDate();
}

/**
 * 在指定时区做“加 N 个自然月”，保持地方墙钟时分秒毫秒不变；
 * 目标月份没有同一天时夹到该月最后一天（月末 clamp）。
 * 例：2026-01-31 +6 个月 -> 2026-07-31；2026-08-31 +6 个月 -> 2027-02-28。
 */
export function addCalendarMonthsInZone(ms, months, timeZone) {
  assertFiniteMs(ms, 'ms');
  assertTimeZone(timeZone);
  if (!Number.isInteger(months)) {
    throw engineError('INVALID_ARGUMENT', 'months must be an integer', { field: 'months' });
  }
  const parts = zonedParts(ms, timeZone);
  const monthIndex = parts.year * 12 + (parts.month - 1) + months;
  const year = Math.floor(monthIndex / 12);
  const month = monthIndex - year * 12 + 1;
  const day = Math.min(parts.day, daysInMonth(year, month));
  return zonedTimeToUtc({ ...parts, year, month, day }, timeZone);
}

/** 地方日历日 key：YYYY-MM-DD。 */
export function localDayKey(ms, timeZone) {
  const parts = zonedParts(ms, timeZone);
  return `${pad4(parts.year)}-${pad2(parts.month)}-${pad2(parts.day)}`;
}

/** 地方日历日 00:00:00.000 对应的 UTC 毫秒。 */
export function localDayStartMs(ms, timeZone) {
  const parts = zonedParts(ms, timeZone);
  return zonedTimeToUtc(
    { year: parts.year, month: parts.month, day: parts.day, hour: 0, minute: 0, second: 0, ms: 0 },
    timeZone,
  );
}

/** 下一个地方日历日 00:00 对应的 UTC 毫秒（严格晚于 ms）。 */
export function nextLocalMidnightMs(ms, timeZone) {
  const parts = zonedParts(ms, timeZone);
  for (let add = 1; add <= 3; add += 1) {
    const base = new Date(Date.UTC(2000, 0, 1));
    base.setUTCFullYear(parts.year, parts.month - 1, parts.day + add);
    const start = zonedTimeToUtc(
      {
        year: base.getUTCFullYear(),
        month: base.getUTCMonth() + 1,
        day: base.getUTCDate(),
        hour: 0,
        minute: 0,
        second: 0,
        ms: 0,
      },
      timeZone,
    );
    if (start > ms) return start;
  }
  // 理论上不可达；保证单调推进避免死循环。
  return ms + HOUR_MS * 24;
}

function normalizeMinutes(minutes) {
  const value = Math.round(minutes);
  return ((value % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
}

/**
 * 标准化作息配置：
 * - 缺省用 23:00-07:00；
 * - sleepStart/sleepEnd 为 null / 非法 / 相等时视为“不启用睡眠”。
 * 返回 { tz, sleepStart, sleepEnd }，sleepStart 为 null 表示禁用。
 */
export function normalizeSleepConfig(cfg = {}) {
  const tz = cfg.tz;
  assertTimeZone(tz);
  const rawStart = cfg.sleepStart === undefined ? DEFAULT_SLEEP_START_MIN : cfg.sleepStart;
  const rawEnd = cfg.sleepEnd === undefined ? DEFAULT_SLEEP_END_MIN : cfg.sleepEnd;
  const disabled =
    rawStart === null ||
    rawEnd === null ||
    rawStart === undefined ||
    rawEnd === undefined ||
    !Number.isFinite(rawStart) ||
    !Number.isFinite(rawEnd) ||
    normalizeMinutes(rawStart) === normalizeMinutes(rawEnd);
  if (disabled) return { tz, sleepStart: null, sleepEnd: null };
  return {
    tz,
    sleepStart: normalizeMinutes(rawStart),
    sleepEnd: normalizeMinutes(rawEnd),
  };
}

/**
 * 判断某时刻是否处于作息睡眠窗口（半开区间：起点含、终点不含）。
 * cfg: { tz, sleepStart, sleepEnd }（sleepStart/sleepEnd 为地方时间“分钟数”）。
 */
export function isSleepingAt(ms, cfg = {}) {
  assertFiniteMs(ms, 'ms');
  const { sleepStart, sleepEnd, tz } = normalizeSleepConfig(cfg);
  if (sleepStart === null) return false;
  const parts = zonedParts(ms, tz);
  const minuteOfDay =
    parts.hour * 60 + parts.minute + (parts.second + parts.ms / 1000) / 60;
  if (sleepStart < sleepEnd) {
    return minuteOfDay >= sleepStart && minuteOfDay < sleepEnd;
  }
  return minuteOfDay >= sleepStart || minuteOfDay < sleepEnd;
}

/**
 * 下一个“睡眠窗口切换点”（入睡或醒来边界）的 UTC 毫秒；不启用睡眠时返回 null。
 */
export function nextBoundaryMs(fromMs, cfg = {}) {
  assertFiniteMs(fromMs, 'fromMs');
  const { sleepStart, sleepEnd, tz } = normalizeSleepConfig(cfg);
  if (sleepStart === null) return null;
  const parts = zonedParts(fromMs, tz);
  let best = Infinity;
  for (let dayOffset = -1; dayOffset <= 2; dayOffset += 1) {
    const base = new Date(Date.UTC(2000, 0, 1));
    base.setUTCFullYear(parts.year, parts.month - 1, parts.day + dayOffset);
    const year = base.getUTCFullYear();
    const month = base.getUTCMonth() + 1;
    const day = base.getUTCDate();
    for (const minutes of [sleepStart, sleepEnd]) {
      const instant = zonedTimeToUtc(
        {
          year,
          month,
          day,
          hour: Math.floor(minutes / 60),
          minute: minutes % 60,
          second: 0,
          ms: 0,
        },
        tz,
      );
      if (instant > fromMs && instant < best) best = instant;
    }
  }
  return Number.isFinite(best) ? best : null;
}

/**
 * 把 [fromMs, toMs) 切分为连续的睡眠/清醒段。
 * 返回 [{ startMs, endMs, sleeping }]，首尾相接、覆盖整个区间。
 */
export function segmentsBetween(fromMs, toMs, cfg = {}) {
  assertFiniteMs(fromMs, 'fromMs');
  assertFiniteMs(toMs, 'toMs');
  if (toMs <= fromMs) return [];
  const segments = [];
  let cursor = fromMs;
  let guard = 0;
  while (cursor < toMs) {
    guard += 1;
    if (guard > 100_000) {
      throw engineError('SETTLE_LOOP_GUARD', 'segmentsBetween exceeded iteration guard');
    }
    const sleeping = isSleepingAt(cursor, cfg);
    const boundary = nextBoundaryMs(cursor, cfg);
    let end = toMs;
    if (boundary !== null && boundary > cursor && boundary < toMs) end = boundary;
    segments.push({ startMs: cursor, endMs: end, sleeping });
    cursor = end;
  }
  return segments;
}
