/**
 * Host 层集成测试：不经 HTTP，直接调用 internals 覆盖「领养 → 照顾 → 经济 → 设置 → 离线 → 寿终」全链路。
 * 运行：node --test tests/host.integration.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { internals, emptyStore, readStore, mutateStore } from '../index.js'

const T0 = Date.UTC(2026, 9, 27, 15, 42, 0) // 2026-10-27T23:42+08:00
const DAY = 24 * 3600 * 1000

const withStore = async (fn) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-digital-pet-host-'))
  const file = join(dir, 'state.json')
  try {
    return await fn(file)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// 保证每次 settle 之后 lastSeenAtMs 跟得上，避免测试里被判成离线。
const settleAt = (store, at) => {
  internals.settleStore(store, at)
  store.profile.lastSeenAtMs = at
}

test('领养与首次赠礼', async () => {
  await withStore(async (file) => {
    const snap = await mutateStore(file, (store) => {
      internals.adoptPet(store, { speciesId: 'whale', nickname: '泡泡' }, T0)
      return internals.snapshotOf(store, T0)
    })
    assert.equal(snap.hasPet, true)
    assert.equal(snap.wallet.balance, 60)
    assert.equal(snap.inventory.basic, 6)
    assert.equal(snap.pet.speciesId, 'whale')
    assert.equal(snap.pet.nickname, '泡泡')

    // 牛牛已开放领养；同一存档不能再领第二只
    const cowStore = emptyStore()
    internals.adoptPet(cowStore, { speciesId: 'cow', nickname: '奶糖' }, T0)
    assert.equal(cowStore.pet.speciesId, 'cow')
    assert.throws(() => internals.adoptPet(readStore(file), { speciesId: 'cat', nickname: 'x' }, T0), /已经|ALREADY/)
  })
})

test('喂食：开始 → 完成、库存与亲密度', async () => {
  await withStore(async (file) => {
    await mutateStore(file, (store) => internals.adoptPet(store, { speciesId: 'whale', nickname: '泡泡' }, T0))
    const started = await mutateStore(file, (store) => {
      store.profile.lastSeenAtMs = T0
      return internals.carePet(store, { action: 'feed' }, T0 + 1000)
    })
    assert.equal(started.type, 'feed')
    assert.equal(started.endsAtMs, T0 + 6000)

    // 串行动作限制
    assert.throws(() => internals.carePet(readStore(file), { action: 'water' }, T0 + 2000), /正在照顾|BUSY/)

    const snap = await mutateStore(file, (store) => {
      settleAt(store, T0 + 7000)
      return internals.snapshotOf(store, T0 + 7000)
    })
    assert.equal(snap.inventory.basic, 4)
    assert.ok(snap.pet.H > 80)
    assert.equal(snap.pet.activeAction, null)
    assert.equal(snap.pet.careCount, 1)
  })
})

test('购买与救济：扣币、库存、冷却与库存规则', async () => {
  await withStore(async (file) => {
    await mutateStore(file, (store) => internals.adoptPet(store, { speciesId: 'whale', nickname: '泡泡' }, T0))
    const bought = await mutateStore(file, (store) => {
      store.profile.lastSeenAtMs = T0
      internals.buyFood(store, { itemId: 'favorite', halfUnits: 2 }, T0 + 1000)
      return internals.snapshotOf(store, T0 + 1000)
    })
    assert.equal(bought.wallet.balance, 42)
    assert.equal(bought.inventory.favorite, 2)

    assert.throws(() => {
      const store = readStore(file)
      store.wallet.balance = 1
      internals.buyFood(store, { itemId: 'favorite', halfUnits: 2 }, T0 + 2000)
    }, /金币不够|NOT_ENOUGH_COINS/)

    const relief = await mutateStore(file, (store) => {
      store.profile.lastSeenAtMs = T0 + 2000
      internals.claimReliefFood(store, T0 + 3000)
      return internals.snapshotOf(store, T0 + 3000)
    })
    assert.equal(relief.inventory.relief, 2)
    // 库存够一整份时优先提示 RELIEF_IN_STOCK（比冷却更早拦住）
    assert.equal(relief.relief.claimable, false)
    assert.equal(relief.relief.reason, 'RELIEF_IN_STOCK')
  })
})

test('设置：大小、免打扰、作息、托管', async () => {
  await withStore(async (file) => {
    await mutateStore(file, (store) => internals.adoptPet(store, { speciesId: 'whale', nickname: '泡泡' }, T0))
    const snap = await mutateStore(file, (store) => {
      store.profile.lastSeenAtMs = T0
      internals.updateSettings(store, { size: 128, quiet: true, sleepStart: '22:30', sleepEnd: '06:30' }, T0 + 1000)
      internals.updateSettings(store, { boarding: true }, T0 + 2000)
      return internals.snapshotOf(store, T0 + 2000)
    })
    assert.equal(snap.settings.size, 128)
    assert.equal(snap.settings.quiet, true)
    assert.equal(snap.settings.sleepStart, '22:30')
    assert.equal(snap.settings.sleepEnd, '06:30')
    assert.equal(snap.settings.boarding, true)
    assert.equal(snap.pet.mode, 'boarding')

    const unboarded = await mutateStore(file, (store) => {
      store.profile.lastSeenAtMs = T0 + 2000
      internals.updateSettings(store, { boarding: false }, T0 + 3000)
      return internals.snapshotOf(store, T0 + 3000)
    })
    assert.equal(unboarded.settings.boarding, false)
  })
})

test('离线保护：两天不打开也不低于下限、不提前死亡', async () => {
  await withStore(async (file) => {
    await mutateStore(file, (store) => internals.adoptPet(store, { speciesId: 'whale', nickname: '泡泡' }, T0))
    const snap = await mutateStore(file, (store) => {
      store.profile.lastSeenAtMs = T0
      const at = T0 + 2 * DAY
      internals.settleStore(store, at)
      return internals.snapshotOf(store, at)
    })
    assert.equal(snap.hasPet, true)
    assert.ok(snap.pet.H >= 30 - 1e-6, `H=${snap.pet.H}`)
    assert.ok(snap.pet.M >= 40 - 1e-6, `M=${snap.pet.M}`)
  })
})

test('寿终归档与再次领养', async () => {
  await withStore(async (file) => {
    const adopted = await mutateStore(file, (store) => {
      internals.adoptPet(store, { speciesId: 'whale', nickname: '泡泡' }, T0)
      return internals.snapshotOf(store, T0)
    })
    const deceased = await mutateStore(file, (store) => {
      store.profile.lastSeenAtMs = T0
      const at = T0 + 200 * DAY
      internals.settleStore(store, at)
      return internals.snapshotOf(store, at)
    })
    assert.equal(deceased.hasPet, false)
    assert.equal(deceased.memorial.length, 1)
    assert.equal(deceased.memorial[0].petId, adopted.pet.petId)
    assert.equal(deceased.memorial[0].nickname, '泡泡')

    const readopted = await mutateStore(file, (store) => {
      store.profile.lastSeenAtMs = T0 + 200 * DAY
      internals.adoptPet(store, { speciesId: 'cat', nickname: '糯糯' }, T0 + 200 * DAY + 1000)
      return internals.snapshotOf(store, T0 + 200 * DAY + 1000)
    })
    assert.equal(readopted.hasPet, true)
    assert.equal(readopted.pet.speciesId, 'cat')
    // 首次赠礼是 profile 级：换宠物不重复发放
    assert.equal(readopted.wallet.balance, 60)
  })
})

test('快照形状：客户端依赖字段齐全', async () => {
  await withStore(async (file) => {
    const snap = await mutateStore(file, (store) => {
      internals.adoptPet(store, { speciesId: 'whale', nickname: '泡泡' }, T0)
      return internals.snapshotOf(store, T0)
    })
    for (const key of ['hasPet', 'pet', 'wallet', 'inventory', 'daily', 'settings', 'memorial', 'species', 'foods', 'economy', 'relief', 'serverNowMs']) {
      assert.ok(key in snap, `missing snapshot.${key}`)
    }
    for (const key of ['nickname', 'stage', 'stageLabel', 'ageMs', 'H', 'M', 'E', 'C', 'need', 'needs', 'availableActions', 'activeAction', 'pendingWaste']) {
      assert.ok(key in snap.pet, `missing pet.${key}`)
    }
    assert.equal(snap.species.length, 9)
    assert.deepEqual(snap.foods.map((item) => item.id), ['basic', 'favorite', 'snack', 'relief'])
    assert.equal(snap.foods.find((item) => item.id === 'basic').price, 12)
  })
})

test('A08 并发购买：串行事务，只成功一单、不超扣', async () => {
  await withStore(async (file) => {
    await mutateStore(file, (store) => internals.adoptPet(store, { speciesId: 'whale', nickname: '泡泡' }, T0))
    // 花到只剩 12 币：60 - 18(喜爱) - 12(基础) - 18(喜爱) = 12
    const now = T0 + 1000
    await mutateStore(file, (store) => { store.profile.lastSeenAtMs = now; return internals.buyFood(store, { itemId: 'favorite', quantity: 1 }, now) })
    await mutateStore(file, (store) => { store.profile.lastSeenAtMs = now; return internals.buyFood(store, { itemId: 'basic', quantity: 1 }, now) })
    await mutateStore(file, (store) => { store.profile.lastSeenAtMs = now; return internals.buyFood(store, { itemId: 'favorite', quantity: 1 }, now) })
    const before = await mutateStore(file, (store) => internals.snapshotOf(store, now))
    assert.equal(before.wallet.balance, 12)

    const results = await Promise.allSettled([
      mutateStore(file, (store) => { store.profile.lastSeenAtMs = now; return internals.buyFood(store, { itemId: 'basic', quantity: 1 }, now) }),
      mutateStore(file, (store) => { store.profile.lastSeenAtMs = now; return internals.buyFood(store, { itemId: 'basic', quantity: 1 }, now) }),
    ])
    const fulfilled = results.filter((item) => item.status === 'fulfilled')
    const rejected = results.filter((item) => item.status === 'rejected')
    assert.equal(fulfilled.length, 1, '只应成功一单')
    assert.equal(rejected.length, 1, '另一单应被余额校验拒绝')

    const after = await mutateStore(file, (store) => internals.snapshotOf(store, now))
    assert.equal(after.wallet.balance, 0, '余额恰好扣一单')
    assert.equal(after.inventory.basic, 6 + 2 + 2, '库存只增加一单（首赠 3 份 + 购买 1 份 + 并发成功 1 份，半份单位）')
  })
})

test('送养：需确认、删除宠物数据、保留金币口粮、可重新领养且不重复首赠', async () => {
  await withStore(async (file) => {
    await mutateStore(file, (store) => internals.adoptPet(store, { speciesId: 'whale', nickname: '泡泡' }, T0))
    await mutateStore(file, (store) => { store.profile.lastSeenAtMs = T0 + 1000; return internals.buyFood(store, { itemId: 'snack', quantity: 1 }, T0 + 1000) })
    const before = await mutateStore(file, (store) => internals.snapshotOf(store, T0 + 2000))
    assert.equal(before.hasPet, true)
    const wallet = before.wallet.balance
    const inventory = { ...before.inventory }

    // 未带确认 → 拒绝，且宠物仍在
    await assert.rejects(() => mutateStore(file, (store) => internals.surrenderPet(store, {}, T0 + 3000)), /确认|CONFIRM/)
    const still = await mutateStore(file, (store) => internals.snapshotOf(store, T0 + 3000))
    assert.equal(still.hasPet, true)

    // 确认送养 → 宠物数据删除
    const result = await mutateStore(file, (store) => {
      store.profile.lastSeenAtMs = T0 + 4000
      const out = internals.surrenderPet(store, { confirm: true }, T0 + 4000)
      return { out, snap: internals.snapshotOf(store, T0 + 4000) }
    })
    assert.equal(result.out.surrendered, true)
    assert.equal(result.out.pet.nickname, '泡泡')
    assert.equal(result.snap.hasPet, false)
    assert.equal(result.snap.pet, null)
    // 金币与口粮保留
    assert.equal(result.snap.wallet.balance, wallet)
    assert.deepEqual(result.snap.inventory, inventory)
    // 不写入纪念册（纪念册只记录自然寿终）
    assert.equal(result.snap.memorial.length, 0)

    // 重新领养：不再发首赠，金币不变，宠物可再次出现
    const again = await mutateStore(file, (store) => {
      store.profile.lastSeenAtMs = T0 + 5000
      internals.adoptPet(store, { speciesId: 'cat', nickname: '糯糯' }, T0 + 5000)
      return internals.snapshotOf(store, T0 + 5000)
    })
    assert.equal(again.hasPet, true)
    assert.equal(again.pet.speciesId, 'cat')
    assert.equal(again.wallet.balance, wallet, '首赠只发一次')
    assert.equal(again.pet.nickname, '糯糯')

    // 已经领养后再次送养（确认）仍可用；无宠物时送养报 NO_PET
    const empty = await mutateStore(file, (store) => {
      store.profile.lastSeenAtMs = T0 + 6000
      internals.surrenderPet(store, { confirm: true }, T0 + 6000)
      return internals.snapshotOf(store, T0 + 6000)
    })
    assert.equal(empty.hasPet, false)
    await assert.rejects(() => mutateStore(file, (store) => internals.surrenderPet(store, { confirm: true }, T0 + 7000)), /没有|NO_PET/)
  })
})

test('自动饮水：喂水按钮移除后，到点由 host 自动补水且不产生缺水惩罚', async () => {
  await withStore(async (file) => {
    await mutateStore(file, (store) => internals.adoptPet(store, { speciesId: 'whale', nickname: '泡泡' }, T0))
    // 19 小时后：超过 needAfterHours=18，但还没到 penaltyAfterHours=36
    const at = T0 + 19 * 3600 * 1000
    const snap = await mutateStore(file, (store) => {
      store.profile.lastSeenAtMs = T0 + 18 * 3600 * 1000
      internals.settleStore(store, at)
      return internals.snapshotOf(store, at)
    })
    assert.equal(snap.pet.lastWaterAtMs, at, '到点自动补水，饮水计时重置')
    assert.equal(readStore(file).pet.waterPenaltyM, 0, '不累计缺水惩罚')
    assert.notEqual(snap.pet.need?.key, 'water', '补水后不再出现「想喝水」诉求')
  })
})
