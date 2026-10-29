/**
 * time.js：#4.1 本地日历 / 作息窗口 / 睡眠分段 / 月末 clamp。
 * 全部用固定 nowMs + 固定时区，跨午夜用 Asia/Shanghai，DST 用 America/New_York。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  HOUR_MS,
  addCalendarMonthsInZone,
  isSleepingAt,
  localDayKey,
  nextBoundaryMs,
  segmentsBetween,
  zonedParts,
} from '../../src/core/index.js';

import { TZ_NY, TZ_SH } from './helpers.js';

const SH = TZ_SH;
const NY = TZ_NY;
const DEFAULT_SLEEP = { sleepStart: 23 * 60, sleepEnd: 7 * 60 };

test('localDayKey 按本地日历日切分（上海跨午夜）', () => {
  // 2026-01-02 00:30 Asia/Shanghai == 2026-01-01T16:30Z
  assert.equal(localDayKey(Date.UTC(2026, 0, 1, 16, 30), SH), '2026-01-02');
  // 2026-01-01 23:59 Asia/Shanghai == 2026-01-01T15:59Z
  assert.equal(localDayKey(Date.UTC(2026, 0, 1, 15, 59), SH), '2026-01-01');
  // 00:00 整属于新的一天
  assert.equal(localDayKey(Date.UTC(2026, 0, 1, 16, 0), SH), '2026-01-02');
});

test('zonedParts 返回本地墙钟字段', () => {
  const parts = zonedParts(Date.UTC(2026, 0, 1, 16, 30), SH);
  assert.deepEqual(parts, {
    year: 2026,
    month: 1,
    day: 2,
    hour: 0,
    minute: 30,
    second: 0,
    ms: 0,
  });
});

test('isSleepingAt 默认 23:00–07:00 半开区间', () => {
  const at = (hour, minute = 0) => Date.UTC(2026, 0, 1, hour - 8, minute);
  assert.equal(isSleepingAt(at(22, 59), { tz: SH, ...DEFAULT_SLEEP }), false);
  assert.equal(isSleepingAt(at(23, 0), { tz: SH, ...DEFAULT_SLEEP }), true);
  assert.equal(isSleepingAt(at(23, 0) + HOUR_MS, { tz: SH, ...DEFAULT_SLEEP }), true); // 00:00
  assert.equal(isSleepingAt(at(6, 59), { tz: SH, ...DEFAULT_SLEEP }), true);
  assert.equal(isSleepingAt(at(7, 0), { tz: SH, ...DEFAULT_SLEEP }), false);
  assert.equal(isSleepingAt(at(12, 0), { tz: SH, ...DEFAULT_SLEEP }), false);
});

test('isSleepingAt 支持自定义作息窗口', () => {
  const custom = { tz: SH, sleepStart: 60, sleepEnd: 300 }; // 01:00–05:00
  const at = (hour, minute = 0) => Date.UTC(2026, 0, 1, hour - 8, minute);
  assert.equal(isSleepingAt(at(0, 59), custom), false);
  assert.equal(isSleepingAt(at(1, 0), custom), true);
  assert.equal(isSleepingAt(at(4, 59), custom), true);
  assert.equal(isSleepingAt(at(5, 0), custom), false);
});

test('nextBoundaryMs 给出下一个清醒/睡眠切换点', () => {
  const cfg = { tz: SH, ...DEFAULT_SLEEP };
  const zoned = (ms) => {
    const p = zonedParts(ms, SH);
    return `${p.day} ${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
  };
  // 08:00 清醒 -> 当天 23:00
  assert.equal(zoned(nextBoundaryMs(Date.UTC(2026, 0, 1, 0, 0), cfg)), '1 23:00');
  // 23:30 睡眠 -> 次日 07:00
  assert.equal(zoned(nextBoundaryMs(Date.UTC(2026, 0, 1, 15, 30), cfg)), '2 07:00');
  // 07:00 整已清醒 -> 当天 23:00
  assert.equal(zoned(nextBoundaryMs(Date.UTC(2026, 0, 1, 23, 0), cfg)), '2 23:00');
  // 关闭睡眠后没有边界
  assert.equal(
    nextBoundaryMs(Date.UTC(2026, 0, 1, 0, 0), { tz: SH, sleepStart: null, sleepEnd: null }),
    null,
  );
});

test('segmentsBetween 把 24h 切成“睡眠 7h + 清醒 16h + 睡眠 1h”（跨午夜）', () => {
  // 从 2026-01-02 00:00 Asia/Shanghai 起 24h
  const from = Date.UTC(2026, 0, 1, 16, 0);
  const to = from + 24 * HOUR_MS;
  const segments = segmentsBetween(from, to, { tz: SH, ...DEFAULT_SLEEP });

  assert.equal(segments.length, 3);
  assert.deepEqual(segments.map((s) => s.sleeping), [true, false, true]);
  assert.deepEqual(
    segments.map((s) => (s.endMs - s.startMs) / HOUR_MS),
    [7, 16, 1],
  );
  // 相邻段首尾相接、无空洞
  assert.equal(segments[0].startMs, from);
  assert.equal(segments[segments.length - 1].endMs, to);
  for (let i = 1; i < segments.length; i += 1) {
    assert.equal(segments[i].startMs, segments[i - 1].endMs);
  }
});

test('segmentsBetween 覆盖夏令时（纽约 2026-03-08 春令时：睡眠夜只有 7 真实小时）', () => {
  // 2026-03-07 00:00 EST == 2026-03-07T05:00Z，跨到 2026-03-09 00:00 EDT
  const from = Date.UTC(2026, 2, 7, 5, 0);
  const to = from + 48 * HOUR_MS;
  const segments = segmentsBetween(from, to, { tz: NY, ...DEFAULT_SLEEP });
  assert.deepEqual(segments.map((s) => s.sleeping), [true, false, true, false, true]);
  assert.deepEqual(
    segments.map((s) => (s.endMs - s.startMs) / HOUR_MS),
    [7, 16, 7, 16, 2],
  );
});

test('addCalendarMonthsInZone：月末 clamp 到当月最后一天', () => {
  // 2026-01-31 00:00 上海 + 6 月 = 2026-07-31 00:00（7 月有 31 日）
  const janEnd = Date.UTC(2026, 0, 30, 16, 0); // 2026-01-31T00:00+08
  const julEnd = addCalendarMonthsInZone(janEnd, 6, SH);
  assert.equal(localDayKey(julEnd, SH), '2026-07-31');
  assert.equal(zonedParts(julEnd, SH).hour, 0);

  // 2026-08-31 12:34 上海 + 6 月 = 2027-02-28 12:34（2 月无 31 日）
  const augEnd = Date.UTC(2026, 7, 31, 4, 34); // 2026-08-31T12:34+08
  const feb = addCalendarMonthsInZone(augEnd, 6, SH);
  assert.equal(localDayKey(feb, SH), '2027-02-28');
  const parts = zonedParts(feb, SH);
  assert.equal(parts.hour, 12);
  assert.equal(parts.minute, 34);
});

test('addCalendarMonthsInZone：闰年 2 月 clamp 到 2/29', () => {
  // 2027-08-31 + 6 月 = 2028-02-29（2028 是闰年）
  const aug = Date.UTC(2027, 7, 30, 16, 0); // 2027-08-31T00:00+08
  const leap = addCalendarMonthsInZone(aug, 6, SH);
  assert.equal(localDayKey(leap, SH), '2028-02-29');
});

test('addCalendarMonthsInZone：跨时区保持本地墙钟（纽约 EST→EDT）', () => {
  // 2026-01-08 09:00 EST == 2026-01-08T14:00Z
  const adopted = Date.UTC(2026, 0, 8, 14, 0);
  const end = addCalendarMonthsInZone(adopted, 6, NY);
  // 2026-07-08 09:00 EDT == 2026-07-08T13:00Z
  assert.equal(end, Date.UTC(2026, 6, 8, 13, 0));
  assert.equal(zonedParts(end, NY).hour, 9);
  assert.equal(localDayKey(end, NY), '2026-07-08');
});
