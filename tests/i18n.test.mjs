/**
 * 中英词典一致性回归测试。
 *
 * 目的：防止新增文案时只补一种语言、或 tx('key') 拼错导致界面回退成 key。
 * 只做静态检查（读 client.js 源码），不启动浏览器。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');

/** 取出 `zh: { ... }` / `en: { ... }` 块内的 key 与 value。 */
function readDict(lang) {
  const block = new RegExp(`${lang}: \\{([\\s\\S]*?)\\n      \\},`).exec(source);
  assert.ok(block, `client.js 中找不到 ${lang} 词典块`);
  const body = block[1];
  const entries = new Map();
  // 一行可能写多个 key，因此不要按行锚定。
  for (const m of body.matchAll(/([A-Za-z0-9_]+):\s*'((?:[^'\\]|\\.)*)'/g)) {
    entries.set(m[1], m[2].replace(/\\'/g, "'"));
  }
  return entries;
}

const zh = readDict('zh');
const en = readDict('en');

test('中英词典 key 集合完全一致', () => {
  assert.ok(zh.size >= 150, `中文 key 数量异常：${zh.size}`);
  assert.deepEqual([...en.keys()].sort(), [...zh.keys()].sort());
});

test('词典 value 均非空', () => {
  for (const [key, value] of zh) assert.ok(value.trim().length > 0, `zh.${key} 为空`);
  for (const [key, value] of en) assert.ok(value.trim().length > 0, `en.${key} 为空`);
});

test('英文词典不应包含中文（除语言名等白名单）', () => {
  const allow = new Set(['lang_zh']);
  const cjk = /[\u4e00-\u9fff]/;
  for (const [key, value] of en) {
    if (allow.has(key)) continue;
    assert.ok(!cjk.test(value), `en.${key} 仍含中文：${value}`);
  }
});

test('代码里 tx(/t( 引用的字面量 key 都存在于词典', () => {
  const used = new Set();
  for (const m of source.matchAll(/\btx\('([A-Za-z0-9_]+)'/g)) used.add(m[1]);
  assert.ok(used.size > 100, `tx() 字面量 key 数量异常：${used.size}`);
  const missing = [...used].filter((key) => !zh.has(key));
  assert.deepEqual(missing, [], `tx() 引用了词典里不存在的 key：${missing.join(', ')}`);
  for (const key of used) assert.ok(en.has(key), `en 词典缺少被引用的 key：${key}`);
});

test('语言卡与宿主 locale 契约的 key 存在', () => {
  for (const key of ['nav_label', 'lang_title', 'lang_zh', 'lang_en']) {
    assert.ok(zh.has(key), `zh 缺少 ${key}`);
    assert.ok(en.has(key), `en 缺少 ${key}`);
  }
  assert.equal(typeof en.get('lang_en'), 'string');
});
