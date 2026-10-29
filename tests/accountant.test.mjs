/**
 * Token → 金币记账测试：覆盖用量提取、去重、每日上限与跨日重置（§9.1）。
 * 运行：node --test tests/accountant.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { internals } from '../index.js'

const messageEvent = (seq, totalTokens) => ({
  seq,
  type: 'assistant/message',
  data: { usage: { inputTokens: totalTokens - 200, outputTokens: 200 } },
})

const withAccountant = async (fn) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-digital-pet-acc-'))
  const file = join(dir, 'state.json')
  const accountant = internals.createUsageAccountant({ dataFile: file, config: { tokensPerCoin: 1000, dailyCoinCap: 100 } })
  try {
    return await fn({ file, accountant })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('默认兑换比例：1,000,000 Token = 1 金币（配置缺省时用常量 TOKENS_PER_COIN）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-digital-pet-acc-default-'))
  const file = join(dir, 'state.json')
  const accountant = internals.createUsageAccountant({ dataFile: file, config: {} })
  try {
    assert.equal(accountant.tokensPerCoin, 1000000)
    assert.equal(internals.TOKENS_PER_COIN, 1000000)
    // 999,999 → 0 币；再 +1 → 1 币
    const r1 = await accountant.handle({ id: 's1' }, messageEvent(1, 999999))
    assert.equal(r1.awarded, 0)
    const r2 = await accountant.handle({ id: 's1' }, messageEvent(2, 1))
    assert.equal(r2.awarded, 1)
    // 2,500,000 → 2 币（已发 1，补 2... 实际目标 floor(3.5M/1M)=3 → +2）
    const r3 = await accountant.handle({ id: 's1' }, messageEvent(3, 2500000))
    assert.equal(r3.awarded, 2)
    assert.equal(r3.grantedCoins, 3)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('调整兑换比例当天不回退已发金币，也不会因 target 变小而重复补发', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-digital-pet-acc-rate-'))
  const file = join(dir, 'state.json')
  // 当天已按旧比例发满 100
  const oldRate = internals.createUsageAccountant({ dataFile: file, config: { tokensPerCoin: 1000, dailyCoinCap: 100 } })
  await oldRate.handle({ id: 'rate' }, messageEvent(1, 500000))
  // 换成新比例（1,000,000:1）：当日目标值骤降到 0，但已发 100 不能被回收，也不能再发
  const newRate = internals.createUsageAccountant({ dataFile: file, config: { tokensPerCoin: 1000000, dailyCoinCap: 100 } })
  const r = await newRate.handle({ id: 'rate' }, messageEvent(2, 3000000))
  assert.equal(r.grantedCoins, 100)
  assert.equal(r.awarded, 0)
  const store = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(store.usage.grantedCoins, 100)
  try { rmSync(dir, { recursive: true, force: true }) } catch {}
})

test('用量提取：message.data.usage 优先，stream 里的 usage chunk 兜底', () => {
  assert.equal(internals.usageTokensOf(internals.usageOfEvent(messageEvent(1, 12295))), 12295)
  const streamed = {
    seq: 2,
    type: 'assistant/message',
    data: { stream: [{ type: 'chunk', chunk: { type: 'text', text: 'x' } }, { type: 'chunk', chunk: { type: 'usage', usage: { inputTokens: 1400, outputTokens: 100 } } }] },
  }
  assert.equal(internals.usageTokensOf(internals.usageOfEvent(streamed)), 1500)
  // 同一响应若同时出现在 attempt 事件里，attempt 不参与，避免重复计数
  assert.equal(internals.usageOfEvent({ seq: 3, type: 'assistant/attempt', data: { usage: { inputTokens: 9000, outputTokens: 1000 } } }), undefined)
  assert.equal(internals.usageOfEvent({ seq: 4, type: 'user/message', data: {} }), undefined)
})

test('12,295 tokens → 12 金币，并按 session:seq 去重', async () => {
  await withAccountant(async ({ accountant }) => {
    const session = { id: 'sess-A' }
    const first = await accountant.handle(session, messageEvent(1, 12295))
    assert.equal(first.awarded, 12)
    const duplicate = await accountant.handle(session, messageEvent(1, 12295))
    assert.equal(duplicate.skipped, 'duplicate')
    // 另一个 session 的同一 seq 视为独立响应
    const other = await accountant.handle({ id: 'sess-B' }, messageEvent(1, 2500))
    assert.equal(other.awarded, 2)
  })
})

test('无用量 / 无 seq 的事件不计入（历史回放、安装前用量）', async () => {
  await withAccountant(async ({ accountant }) => {
    assert.equal((await accountant.handle({ id: 's' }, { seq: 1, type: 'assistant/message', data: {} })).skipped, 'no-usage')
    assert.equal((await accountant.handle({ id: 's' }, { type: 'assistant/message', data: { usage: { inputTokens: 5000, outputTokens: 0 } } })).skipped, 'no-seq')
  })
})

test('每日上限 100 金币，超出不再发放', async () => {
  await withAccountant(async ({ file, accountant }) => {
    const session = { id: 'sess-cap' }
    for (let seq = 1; seq <= 20; seq += 1) {
      await accountant.handle(session, messageEvent(seq, 50000))
    }
    const store = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(store.wallet.balance, 100)
    assert.equal(store.usage.grantedCoins, 100)
    assert.equal((await accountant.handle(session, messageEvent(21, 50000))).awarded, 0)
  })
})

test('跨日重置当日额度（直接驱动 awardUsageTokens）', async () => {
  await withAccountant(async ({ file }) => {
    const { readStore, mutateStore } = await import('../index.js')
    const at = Date.UTC(2026, 9, 27, 4, 0, 0)
    const tz = 'Asia/Shanghai'
    // 前一记账日已发满 100
    await mutateStore(file, (store) => {
      const yesterday = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(at - 24 * 3600 * 1000))
      store.profile.rewardTimezone = tz
      store.usage = { dayKey: yesterday, eligibleTokens: 100000, grantedCoins: 100, awardedKeys: [] }
      store.wallet.balance = 100
    })
    const awarded = await mutateStore(file, (store) => {
      store.profile.rewardTimezone = tz
      return internals.awardUsageTokens(store, 5000, { nowMs: at, tz, tokensPerCoin: 1000, dailyCap: 100 })
    })
    const store = readStore(file)
    assert.equal(awarded.awarded, 5)
    assert.equal(store.usage.grantedCoins, 5)
    assert.equal(store.usage.eligibleTokens, 5000)
  })
})
