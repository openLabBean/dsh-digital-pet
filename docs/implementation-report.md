# dsh-digital-pet 实施报告（V1 原型交付）

日期：2026-10-28｜范围：把《DSH 电子宠物插件开发设计方案》V1.0 落成可运行的本地插件原型，并在真实 ui-test 实例中完成界面验收。

## 1. 交付物

| 路径 | 内容 |
|---|---|
| `plugins/dsh-digital-pet/index.js` | Host 半（1018 行）：路由、按 profile 存档、Token→金币记账、素材服务、托管/隐藏等设置 |
| `plugins/dsh-digital-pet/tools/simulate.mjs` | 180 天时间模拟器（零依赖，9 策略，`node tools/simulate.mjs` ≈1.8s 自动生成平衡报告） |
| `plugins/dsh-digital-pet/docs/balance-report.md` | 数值平衡报告：§16 五问结论、9 策略结果表、常数建议与局限 |
| `plugins/dsh-digital-pet/client.js` | 浏览器半（968 行）：`settings.section` 设置页 + `shell.overlay` 悬浮宠物 + 左侧操作盘 + 键盘/读屏/动效 |
| `plugins/dsh-digital-pet/src/core/` | 确定性内核（9 模块，96 导出，零外部依赖）：时间/成长/状态/动作/照护/经济/错误 |
| `plugins/dsh-digital-pet/assets/` | **9 物种 × 14 slot + 9 张核对图 = 135 张**原始分辨率精灵图（v2，去白晕）+ manifest v2 + `preview-sheet.png` + 脚本（`optimize_sprites.py` 重导出、`prep_dinosaur.py` 恐龙专用管线、`slice.py` v1 切格，`--verify` 均通过） |
| `plugins/dsh-digital-pet/tests/` | 144 例测试全绿：内核 131 + Host 集成 8 + Token 记账 5 |
| `plugins/dsh-digital-pet/docs/` | 16 张真机截图、`acceptance.md`（A01–A21 映射）、本报告、`design-doc-revisions.md` |
| `plugins/dsh-digital-pet/README.md` | 安装、界面、接口、目录、内核摘要、测试命令、范围 |

规模：约 5,300 行代码/脚本，素材 3.5 MB，文档与截图 1.2 MB。

## 2. 架构与边界

```
浏览器半 (client.js)                     Host 半 (index.js)                    纯逻辑内核 (src/core)
settings.section → 设置页          →   POST /dsh-digital-pet/api/*                 →  settle / startAction / resolveNeeds
shell.overlay   → 悬浮宠物/操作盘    ←   GET  /state（权威快照）              ←  growth / economy / time
                                          ↓
                                   $DSH_HOME/profiles/<profile>/dsh-digital-pet/pet-state.json（原子写）
```

- **单一权威**：所有数值、冷却、经济结算只在 Host + 内核；浏览器半不发时间、不算金币、不做乐观扣减。
- **确定性内核**：`settle(state, nowMs, cfg)` 是唯一时间推进入口，按睡眠边界/动作完成/阶段切换/排泄到点/托管起点分段；无 `Date.now()`/`process.env`/fs/timer，时间回拨不变更状态。
- **存档隔离**：从 `ctx.baseUrl` 解析 `<profileDir>`，存档落在该 profile 下，desktop / ui-test 各自独立；`DSH_PET_DATA_FILE` 可覆盖（演示/测试用）。旧全局存档首次启动时自动迁移。
- **Token 记账**：Host 监听 `session/event`，从 `assistant/message` 的 `usage`（流式回退最后一个 usage chunk）取用量，`(session.id, seq)` 去重后按 `min(100, floor(T/1000))` 只发差额；缓存/推理细分不重复相加。
- **素材服务**：`GET /assets/sprites/{species}/{slot}.png`，带 etag + immutable，路径穿越防护。

## 3. 验证结果

**自动化**：`npm test` → 146/146 通过（≈0.5s；本轮无内核改动）。覆盖：时区/月末/DST、六阶段边界、四状态衰减与联动、六项动作合同（预留/串行/冷却/条件/截断）、排泄计划、离线保护与托管、跨寿终归档、金币阶梯与去重、救济规则、Host 路由与存档事务。

**真实实例（ui-test profile，1280×800，截图见 `docs/`）**：
- 插件加载：`/ping` 返回 `{ok:true,name:'dsh-digital-pet',version:'0.1.0',dataFile:'<profile>/dsh-digital-pet/pet-state.json'}`；`settings.section` 与 `shell.overlay` 两个 slot 都真实存在并渲染。
- 领养 → 悬浮宠物出现（婴儿鲸鱼，可拖动）；设置页显示仪表盘/商店/成长/偏好/纪念册。
- 照顾：操作盘「喂水」→「喂水中 · 2s」倒计时 → 完成 M+2；H=100 时喂食返回「它还不饿」红 pill（4s 自动消失）。
- 商店/救济/设置/隐藏/托管/便便配件/诉求气泡均按规则工作；壮年宠物 + 便便 + 「需要铲屎」气泡见 `v1-need-and-waste.png`。
- 隐藏开关：`visible:false` 后 9s 内 overlay 从 DOM 移除，恢复后重新出现。
- 存档隔离：ui-test 与演示实例（`DSH_PET_DATA_FILE=/tmp/pet-demo/state.json`）互不影响。
- **全新安装冒烟（最终证据）**：删除临时 profile 后重新 `dsh ui-test … --dump-config` + `dsh plugin --profile ui-test add <plugin>` → `/state` 返回 `hasPet:false`、**9 物种（全部 `extension:false`）**、4 类食品 → 设置页显示领养向导（9 张真实精灵，全部可点）→ 领养恐龙「迪诺」→ 钱包 60、库存 3 份口粮、悬浮宠物出现（`dinosaur/baby.png`，206×137 原生，`idle-awake` 动效）→ 成年姿态下便便配件与诉求气泡正常。见 `docs/v1-adoption.png`、`docs/v1-dinosaur.png`。

- **照护动作动效（第 19 轮）**：CDP 驱动真实 ui-test 实例，对喂食/洗澡/逛街逐帧取图并断言（16 项全绿，`tools/action-fx/capture.mjs` 产出的 `verify.json`）；`prefers-reduced-motion` 下动画与道具关闭、恢复后动画回来；见 `docs/v1-action-feed.gif` / `v1-action-bathe.gif` / `v1-action-walk.gif` 与 `v1-action-strips.png`。

- **真实 Token→金币链路（desktop profile 实测）**：插件装进 desktop profile 后，Host 的 `session/event` 钩子按响应级去重键（`sessionId:seq`）记账。实测该 profile 的存档已累计 `usage.eligibleTokens = 37,035,854`、`usage.grantedCoins = 100`（当日封顶 100 生效），`awardedKeys` 记录了真实会话事件（含本会话 `session-4394cc65…` 的多条 seq），证明「只发差额 + 每日封顶 + 去重」在真实 DSH 会话里成立；因当前 profile 尚未领养，金币记在 profile 钱包（100），领养时会继承并可叠加首赠 60。
- **A20 键盘/读屏（本轮补）**：操作盘打开后焦点落到「1. 喂食」；→ 到「2. 喂水」；Enter 触发喂水（pill「喂水中 · 4s」）；Esc 关闭且焦点回爪印（`aria-expanded=false`）；数字 4 直达「皮肤刷洗」（C 90→100、M+4）；精灵 Enter 抚摸 M+2。截图 `v1-action-panel.png`（旧版圆环截图 `v1-a11y-keyboard.png` 保留作历史）。

## 4. 与设计文档的偏差（均已测，Host 可见）

1. **离线判定**由 Host 传 `cfg.offline`：内核只认"上次可信运行时间 → now"的缺口，无法纯靠时间推断进程退出。
2. **排泄计划**用"本地日"门槛替代严格滚动 24h 累计：每本地日 ≤1 份、并发 ≤2、生成时 C−4 一次；更易理解且不随点击次数膨胀。
3. **小零食**按 2 半份入库存且不可拆；主食（基础/喜爱/救济）可半份。
4. **睡眠中允许开始动作**：引擎不因睡眠拒绝，洗澡的显式唤醒由 Host/UI 负责；唤醒不重置夜间恢复额度。
5. **用户发起托管会取消在途动作并释放预留**（设计稿未定义该交互）。
6. **阶段函数**返回 6 个阶段定义（非 5 个切点），字段 `{key,label,startDay,endDay,startAgeMs}`。
7. **首次喂水不受 6h 冷却影响**（`waterRewardedAtMs=null` 视为首次有效），避免领养即惩罚；之后严格 6h。
8. **离线保护下限只防跌破、不抬高**：目标取 `min(离线开始值, 30/40/30/40)`；托管才用 `max(value, 60)` 抬升。
9. **寿终**=领养时本地日历 +6 月同墙钟，月末 clamp（1/31→7/31、8/31→2/28、闰年已测）。
10. **桌面形态**：设计稿 §11.3 的原生透明窗口未接入，当前用 Web 内 `shell.overlay` 悬浮层替代；拖动/点击/操作盘交互完整。

另：设计要求"每个 profile 一只宠物"，实现上存档按 profile 目录隔离（不是全局单文件）；这是实现期修正，已写入 README。

## 4.5 持续开发（V1 之后，已装进 desktop profile）

插件已用 `dsh plugin --profile desktop add <插件目录>` 安装到用户的 desktop profile（`dependencies["@local/dsh-digital-pet"]` + `dsh.profile.bundles` 均含该插件，`node_modules/@local/dsh-digital-pet` 为 symlink），运行中的应用热加载后 `GET /dsh-digital-pet/api/ping` 返回 200 且 `dataFile` 指向 `~/.dsh/profiles/desktop/dsh-digital-pet/pet-state.json`。

本轮新增（均在真实 ui-test 实例中验证）：

| 能力 | 说明 | 证据 |
|---|---|---|
| 动作姿态 | 护理进行中把舞台精灵换成对应动作图（feed/water/walk/groom/bathe/cleanWaste），不再只有洗澡特判 | `docs/v1-action-pose.png` |
| 待机动效 | 3.4s 呼吸浮动（`@keyframes dsh-digital-pet-bob`）；`prefers-reduced-motion: reduce` 下一律关闭 | — |
| 抚摸反馈 | 轻点/键盘 Enter 抚摸成功飘爱心（0.95s 上飘淡出） | `docs/v1-pet-heart.png` |
| 诉求可点击 | 诉求气泡变成按钮，点击直接执行对应护理（休息类无动作则不可点） | `docs/v1-need-and-waste.png` |
| 状态 chip | 睡眠/托管文字 chip（后按用户反馈移除，见 §4.7） | 已移除 |
| 成长播报 | 轮询发现阶段变化时弹出「长大啦：进入幼儿期」Toast（5.2s 淡出） | 代码逻辑，未截到跨阶段瞬间 |
| 键盘/读屏 | 操作盘 `role=menu`、按钮 `role=menuitem` + `aria-label="N. 名称"`；Esc 关闭并回焦爪印、←/→ 同行 + ↑/↓ 换排、Enter/Space 触发、数字 1–6 快捷；精灵 `role=button` + Enter 抚摸；错误 `role=alert` + live region 播报 | `docs/v1-action-panel.png` |
| 前置校验 | 点击前用 `availableActions` 判断是否可用，禁用时直接显示原因（少一次请求失败） | 实测 H=100 时点喂食显示「它还不饿」 |
| 深色主题适配 | 全部 CSS 改用 DSH 真实设计令牌（`--dsw-alias-label-primary/secondary`、`border-l1`、`bg-layer-1/2`、`brand-primary`、`state-error/warn`）；此前用的 `text-primary/bg-elevated/accent` 等名字在宿主里不存在，深色下会退化成硬编码浅色 | `docs/v1-dark-overlay.png`、`docs/v1-dark-settings.png`（dark 主题 ui-test 实例） |
| A08 并发购买 | 进程内并发两笔购买 `Promise.allSettled`：仅一单成功、余额与库存不超扣 | `tests/host.integration.test.mjs`「A08 并发购买」 |

## 4.6 数值模拟与平衡结论（`tools/simulate.mjs` + `docs/balance-report.md`）

按设计稿 §16 的问题跑 181 天（Asia/Shanghai，2026-01-01 领养 → 2026-07-01 寿终），9 个策略全部存活至寿终：

| 问题 | 结论 |
|---|---|
| ① 每天一餐整份够吗 | 够，但只有 11% 余量：日 H 流失 54 vs 整份恢复 60；最低 H 44.0，从未进入饥饿诉求 |
| ② 只靠免费救济能活吗 | 能，且与花金币喂养**完全无差别**（最低 H 均为 44.0）——救济 60H/24h ≈ 每日流失的 111% |
| ③ 100 币/天上限合理吗 | 严重过剩：每天有用支出仅 12 币（8.3×）；高 Token 六个月结余 16024 币无处可花 |
| ④ 离线会被惩罚吗 | 不会，反而更舒服：≥24h 自动托管托底 60；存在 24h 分界悬崖（恰好 24h H=30，24h+1ms H=60） |
| ⑤ 建议改的常数 | `FOOD_CATALOG.relief.effectsPerWhole.H` 60→36~42（或 24h→36h 冷却）；次选日上限 100→20~30 |


设计取向（为什么 V1 不改）：设计稿 §9.2 把救济与上限当成产品承诺（无 Token 用户也能养活），V1 保持与文档一致；上述偏差记入 `docs/design-doc-revisions.md` 供 v1.1 决策。另发现亲密度约 20 天刷满、体力/自动休息路径几乎不触发、「完全不管」也能慢性存活。

## 4.7 更名与交互精简（用户反馈后的改动）

用户反馈 4 项，已全部落地并通过 144 例测试 + ui-test 真机截图复验：

| 反馈 | 处理 |
|---|---|
| 插件名 `dsh-pet` → `dsh-digital-pet` | 目录改名 `plugins/dsh-digital-pet/`；包名 `@local/dsh-digital-pet`；Host 导出 `name='dsh-digital-pet'`；路由前缀 `/dsh-digital-pet/api`；client bundle 注册 id 同步；bundle patch 行 `- id: digital-pet`；存档目录改为 `<profileDir>/dsh-digital-pet/pet-state.json`，并对旧 `<profileDir>/dsh-pet/` 与全局 `$DSH_HOME/dsh-pet/` 做一次性迁移；desktop profile 已重挂（旧依赖项与 `dsh.profile.bundles` 条目移除、symlink 重建），运行中的应用自动热加载，旧路由 404、新路由 200 |
| 领养后默认 72px | `emptyStore().settings.size = 72`；`sanitize` 回退值 72；`adoptPet()` 领养时显式把 size 置 72（已有存档的用户不受影响，可在偏好里改 96/128）；client 兜底 72 |
| 状态卡底部提示行删除 | 移除 `… · 打开「设置 → 电子宠物」看完整面板。` 整行及对应 CSS |
| 睡眠/托管文字删除 | 移除悬浮层的状态 chip（`💤 睡觉中` / `🏠 托管中`）；睡眠由精灵/行为表达，不再显示文字 |

截图：`docs/v1-dark-overlay.png`、`docs/v1-dark-settings.png` 已重拍（当时的 `v1-mini-72.png` 在后续「点击不再弹数值卡」轮次中归档删除）。



## 4.8 第 5 轮 UI 调整（用户反馈）

用户反馈（m02030）：「宠物下面的按钮，大小减少30%；点击这个按钮后，弹出的六个操作按钮的位置调整为宠物左侧以一行2个按钮，展示三排按钮的方式展示操作盘，按钮不需要卡通形象只需要展示文字；点击其他区域则收起操作盘」。

| 改动 | 实现 |
|---|---|
| 爪印按钮缩小 30% | `.dsh-digital-pet-paw` 30×30 → **21×21**（字号 15→11，圆形/阴影/hover 不变） |
| 六项操作从圆环改为左侧操作盘 | 删除圆环（`RING_RADIUS`/`ringCenterFor`/`dsh-digital-pet-sector`），新增 `.dsh-digital-pet-panel`：绝对定位在宠物左侧（`right: calc(100% + 8px)`）、垂直居中，`grid-template-columns: repeat(2, …)` = **3 排 × 2 列**；按钮纯文字（`.dsh-digital-pet-panel-btn`），无卡通图标；宠物贴近屏幕左边（x<220）时自动翻到右侧（`.right`）避免出屏 |
| 点击其他区域收起 | 操作盘打开时挂 `document` pointerdown 捕获：点击既不在操作盘、也不在爪印上 → 收起；爪印再点/执行动作/Esc 同样收起 |
| 键盘与读屏 | 保留 `role="menu"` + `role="menuitem"` + `aria-label="N. 名称"`；←/→ 同行移动、↑/↓ 换排、数字 1–6 直达、Enter/Space 执行、Esc 关闭并回焦爪印；打开时焦点落到第一个按钮 |

实测（web 模板 ui-test 实例，72px）：爪印 21×21；操作盘 `140×122`、网格列 `58px 58px`、按钮 `喂食/喂水/逛街/皮肤刷洗/洗澡/铲屎`（whale）；点空白 → 收起；点「喂水」→ 动作执行、操作盘收起、焦点回爪印、状态卡打开；键盘 → 喂水 → 皮肤刷洗；Esc → 收起并回焦。
截图：`docs/v1-action-panel.png`（浅色）、`docs/v1-action-panel-dark.png`（深色，desktop 默认主题）。

## 4.9 第 6 轮反馈：待机微动 / 饥饿表达 / 去掉体力 / 动作结束立即复位

用户反馈（m02121）：「宠物日常醒着还是睡着保持小动作循环（速度不要太快），这样更能体现'活着'的感觉。在缺少食物或者缺少水时，会体现饥饿的动作表情，饱食低于20时；删除体力的值没什么用；图1动作结束没有自动隐藏箭头位置和回复操作可以点击」。

| 反馈 | 实现 |
|---|---|
| 醒着/睡着都有小动作循环 | 由 `moodOf(pet, activeAction)` 得出 `acting > sleep > hungry > thirsty > awake`，只驱动 CSS 动画、不改数值：<br>· `awake` → `dsh-digital-pet-idle-awake` **9s** 循环（缓慢呼吸 + ±1° 轻摆 + 每周期一次极小跳跃）<br>· `sleep` → `dsh-digital-pet-idle-sleep` **6.8s**（只有 1px 起伏 + 1.4% 呼吸缩放）<br>· `hungry`/`thirsty` → `dsh-digital-pet-idle-hungry` **5.6s**（左右无力摆动 + 轻微降饱和）<br>· `acting` → 不叠加待机动画，动作姿态保持静止<br>桌面悬浮宠物与设置页大头像共用同一套关键帧；`prefers-reduced-motion` 下全部关闭 |
| 缺食物/缺水时表达饥饿 | `飽食 H<20` → `mood=hungry`，宠物上方周期性浮出 🍖 气泡（5.6s 循环，只显示一瞬）；距上次饮水 ≥18h（宿主 `need.key='water'`）→ `mood=thirsty` + 💧 气泡；诉求 pill（「想吃饭」「想喝水」）照旧可点击直接喂食/喂水 |
| 删除体力 | 状态条由 4 条改为 **3 条**（饱食 / 心情 / 清洁），桌面状态卡与设置页仪表盘同步移除体力；引擎里的 E 仍保留（睡眠恢复、体力门槛等规则不变），只是不再展示 |
| 动作结束自动隐藏 + 操作恢复可点 | 新增「动作进行中每秒刷新快照」（`refreshRef` + `setInterval(1000)`，仅在 `activeAction !== null` 时启用）：<br>· 仪表盘倒计时文案在 `countdown<=0` 时立即消失，不再出现「约 0 秒后完成」<br>· 仪表盘按钮 disabled 条件改为 `busy || (activeAction && countdown>0)`，倒计时归零即可再次点击<br>· 桌面倒计时 pill 在 0 秒时显示「完成」并在下一次轮询（≤1s）内消失 |

实测（ui-test 真机，72px whale）：`data-mood=awake` 动画 `idle-awake 9s`；睡眠存档下 `data-mood=sleep` 动画 `idle-sleep 6.8s`；H=12 时 `data-mood=hungry` + 🍖 气泡 + 「想吃饭」；仪表盘只剩 3 条状态条；仪表盘点「喂水」→ 提示「约 3 秒后完成」→ 6s 后文案消失且 6 个按钮全部恢复可点；桌面操作盘点「喂食」→ pill「喂食中 · 5s」→ 完成后 pill 自动消失、无「0s」残留。
截图：`docs/v1-idle-hungry.png`（饥饿气泡）、`docs/v1-settings-dashboard.png`（3 条状态条）。

## 4.10 第 7 轮反馈：送进宠物救助站

用户反馈（m02227）：「在设置》电子宠物 ，领养宠物后，最下面增加操作「送进宠物救助站」，点击后删除宠物数据，可重新选择宠物」。

| 层 | 实现 |
|---|---|
| Host | 新增命令 `surrenderPet(store, body, nowMs)` 与路由 `POST /dsh-digital-pet/api/surrender`：先 `settleStore` 结算，再校验 `body.confirm === true`（否则 400 `CONFIRM_REQUIRED`）、宠物存在且在养（否则 409 `NO_PET` / `PET_DECEASED`）；结算已把 wallet/inventory/daily 同步到 profile 级存档，随后只清空 `store.pet`，因此金币、口粮、每日计数保留；在途动作随宠物一起失效；**不写纪念册**（纪念册只记录自然寿终） |
| Client | 设置页最下方新增「送养」卡片（仅领养后显示）：一段说明 + 「送进宠物救助站」按钮；第一次点击进入两步确认（红字「确定要送走「昵称」吗？」+「确认送走」/「取消」），确认后 `POST /surrender {confirm:true}` 并刷新快照 → 页面回到领养页，悬浮宠物在下一次轮询内消失（实测 <9s，实测重领养后重新出现） |
| 重新领养 | 沿用 `store.profile.firstGiftGranted`：首赠只发一次，送养后再领养金币不变 |
| 测试 | `tests/host.integration.test.mjs` 新增「送养」用例：未带 confirm 拒绝且宠物仍在 → 确认后 `hasPet=false`、`pet=null`、wallet/inventory 不变、纪念册为空 → 重新领养成功且金币不变 → 无宠物时送养 409。**全量 145 例通过** |
| 截图 | `docs/v1-surrender.png`（送养卡片）、`docs/v1-surrender-confirm.png`（两步确认） |

实测（HTTP + 真机）：`POST /surrender` 无 confirm → 400 `CONFIRM_REQUIRED`；确认后 `hasPet=false`、`pet=null`，wallet 55 / snack 2 / basic 6 全部保留；设置页回到「领养一只小宠物」+ 纪念册；重新领养猫「糯糯」后 wallet 仍 55（未重复发 60 金币首赠）。

## 4.11 第 8 轮反馈：移除「梳理 / 皮肤刷洗」按钮

用户反馈（m02324）：「皮肤刷洗 按钮操作去掉」。

| 层 | 处理 |
|---|---|
| 客户端 | 从 `CARE_ACTIONS` 移除 `groom` 项 → 左侧操作盘与设置页仪表盘的照护按钮都变为 **5 项**（喂食 / 喂水 / 逛街 / 洗澡 / 铲屎）；操作盘仍是 3 排 × 2 列，最后一行只剩「铲屎」 |
| 诉求 | `NEED_ACTION` 去掉 `groom → groom` 映射；新增 `HIDDEN_NEEDS = new Set(['groom'])`，宿主若仍报告「想梳理」诉求则不再展示（避免没有对应按钮的死胡同提示） |
| 引擎 / 接口 | **不改**：`src/core` 的 grooming 规则、`POST /care {action:'groom'}`、状态字段与测试全部保留（老存档、外部调用与后续恢复入口都不受影响）；素材中的 groom 精灵也保留 |
| 测试 | 全量 145 例仍通过（引擎未动） |

截图：`docs/v1-action-panel.png`、`docs/v1-action-panel-dark.png` 已按 5 项操作盘重拍。

## 4.12 第 9 轮反馈：移除「喂水」按钮 + 饮水自动补给

| 项 | 改动 |
|---|---|
| 客户端 | `CARE_ACTIONS` 移除 `water` 项 → 左侧操作盘与设置页仪表盘照护按钮变为 **4 项**（喂食 / 逛街 / 洗澡 / 铲屎），操作盘 2 排 × 2 列；`NEED_ACTION` 去掉 water；`HIDDEN_NEEDS = new Set(['groom', 'water'])`，宿主再报「想喝水」也不再显示死胡同提示 |
| 引擎/接口 | 保留 `water` 动作（`POST /care {action:'water'}` 仍可用，老存档与自动化不受影响），核心规则与 131 例测试不变 |
| 自动饮水（host） | 新增 `maybeAutoDrink(state, nowMs)`：`settleStore` 每次推进时间后，若距上次饮水 ≥ `WATER_RULES.needAfterHours`（18h）→ 自动把 `lastWaterAtMs` 置为当前、`waterPenaltyM=0`、`waterRewardedAtMs=null`。不发手动喂水的心情 +2 与亲密度；超过 36h 的长间隔会在结算时先按规则扣一次水分惩罚（封顶 -8）再补水，避免「离线越久越渴」的死循环 |
| 验证 | 单测 `自动饮水：喂水按钮移除后，到点由 host 自动补水且不产生缺水惩罚`（19h 间隔 → `lastWaterAtMs` 刷新、`waterPenaltyM=0`、`need.key !== 'water'`）；`npm test` **146/146**；ui-test 实测面板按钮 `["喂食","逛街","洗澡","铲屎"]`、仪表盘 4 按钮、状态卡 3 条；手工把存档 `lastWaterAtMs` 改到 19h 前 → 一次 `/state` 后年龄回到 0 分钟且无「想喝水」诉求 |
| 截图 | 新增 `v1-sprite-quality.png`（A/B 对比）；重拍 `v1-overlay-idle.png`、`v1-action-panel.png`、`v1-action-panel-dark.png`、`v1-settings-dashboard.png`、`v1-dark-settings.png` |
| 文档 | 本节；`design-doc-revisions.md` §11；README 操作盘/截图表同步 |

## 4.13 第 10 轮反馈：精灵图高清化（去掉模糊与白色锯齿）

用户反馈（附图）：「展示的宠物图片和动作的图片像素质量太低，模糊且边缘有白色锯齿，请所有宠物的图片都有优化一遍」。

| 项 | 改动 |
|---|---|
| 根因 1：双重插值 | v1 把源图里本身只有约 100~230px 高的形象 **NEAREST 缩小到高 96px**，客户端再按 72/96/128 逻辑像素显示；在 Retina（DPR 2）上等于把 96px 素材放大到 144 设备像素 → 模糊 |
| 根因 2：白色衬底晕圈 | 源图为 AI 出图，alpha 边缘带大量白色半透明像素（实测半透明像素中纯白 (255,255,255) 大量存在）→ 深色背景上形成一圈「白色锯齿」 |
| 根因 3：pixelated + 非整数缩放 | 客户端对 96px 素材用 `image-rendering: pixelated`，在 0.75×/1.5× 等非整数倍下丢行/重行，边缘更锯齿 |
| 素材（v2） | 新增 `assets/tools/optimize_sprites.py`：按 manifest crop 取**原始分辨率**（不缩小）→ 去白色衬底（`C=(C−255(1−a))/a`）→ alpha 阈值 128 清边缘白晕 → bbox 裁紧 + 2px 透明边 → 覆盖 `sprites/` 并重写 `manifest.json` v2.0.0（120 张，约 4.0 MB） |
| 客户端 | 6 处 `image-rendering: pixelated` → `auto`（精灵/便便/物种卡/大图/动作图标/纪念册）；仍是 `height: size; width: auto`，平滑缩放 |
| 验证 | A/B 截图对比（同一 128px 显示：旧图有明显白色晕圈与模糊，新图轮廓干净）；`--verify` 通过；`npm test` 146/146；浅色+深色实例实测 4 项操作盘、迷你卡、仪表盘、饥饿态、动作姿态、纪念册均正常；docs 截图全部重拍 |
| 截图 | 新增 `v1-sprite-quality.png`（A/B 对比）；重拍 `v1-overlay-idle.png`、`v1-action-panel.png`、`v1-action-panel-dark.png`、`v1-dark-overlay.png`、`v1-dark-settings.png`、`v1-settings-dashboard.png`、`v1-adoption.png`、`v1-idle-hungry.png`、`v1-action-pose.png`、`v1-care-running.png`、`v1-mini-72.png`、`v1-pet-heart.png`、`v1-a11y-keyboard.png`、`v1-error-feedback.png`、`v1-need-and-waste.png`、`v1-settings-growth.png`、`v1-settings-memorial.png`、`v1-surrender.png`、`v1-surrender-confirm.png` |

## 4.14 待机小动作循环（第 11 轮）

用户反馈：设置页仪表盘大图与桌面悬浮宠物「醒着/睡着都要保持小动作循环」。

- 机制：精灵 `data-mood` 驱动 CSS 动画 —— `awake`（4.8s 呼吸+轻浮动+±0.6° 微转，位移 3px/缩放 1.012）、`sleep`（6.4s 更慢更浅的呼吸，位移 2px/缩放 1.018）、`hungry`/`thirsty`（4.6s 小幅摇晃）。两处共用同一组 keyframes 与 `data-mood`。
- 两处生效点：`shell.overlay` 的 `.dsh-digital-pet-sprite` 与设置页 `.dsh-digital-pet-hero img`；均加 `transform-origin: 50% 100%`、`will-change: transform`。
- 无障碍：`prefers-reduced-motion: reduce` 时两处动画与过渡全部关闭（系统「减弱动态效果」开启时保持静止）。
- 验证：ui-test 实例读 `getComputedStyle` —— hero/sprite 在 awake 与 sleep 两种状态下 `animationName` 分别为 `dsh-digital-pet-idle-awake`(4.8s)/`idle-sleep`(6.4s)，间隔 0.9s 采样 `transform` 矩阵均变化；6 帧 GIF（420ms/帧）逐帧差异 hero 8.6k–20k px、宠物 1.8k–11k px。
- 证据：`docs/v1-idle-loop-awake.gif`、`docs/v1-idle-loop-sleep.gif`。

## 4.15 领养页补充英文名与 v1.1 徽标（第 12 轮）

用户反馈：领养页里牛牛、山羊两张卡片缺少英文名（设计稿 §2 的「宠物/中文名/英文名」对应 牛牛→奶糖→Toffee、山羊→咩咩→Clover）。

- 物种目录 `SPECIES`：`cow.speciesZh` 由「牛」改为「牛牛」，与设计稿及卡片文案统一（`goat` 仍为「山羊」）。
- 领养卡片（`SpeciesPicker`）：第二行统一渲染「角色名 · 英文名」（如「奶糖 · Toffee」「咩咩 · Clover」），扩展物种的可见文案**不再出现 v1.1**，仅靠卡片灰显 + `title` 提示（悬停显示「…（v1.1 开放）」）+ `aria-disabled` 表达未开放。
- 覆盖范围：8 张卡片全部为「物种中文名 / 角色中文名 · 英文名」，文案完全同构。
- 验证：ui-test 新档实例卡片文案 `鲸鱼 泡泡 · Bubbles … 牛牛 奶糖 · Toffee / 山羊 咩咩 · Clover`（无 v1.1 可见文字，卡片灰显）；`npm test` 146/146；截图 `docs/v1-adoption.png` 重拍。
- 生效条件：物种目录在 Host 半，需重启桌面应用（或关/开插件）后生效；客户端布局刷新页面即可。

## 4.16 设置页布局微调：桌面显示移到页头（第 14 轮）

用户反馈：「电子宠物设置中的『桌面显示』设置项，放到最上面的『电子宠物』标题右侧」。

- 页头改为两列 grid（`minmax(0,1fr) auto`）：左侧标题 + 说明文案，右侧「桌面显示」标签 + 开关按钮（`aria-pressed` 反映当前可见性，`title` 说明隐藏后仍可在设置页照护）；标题与开关同一行，窄屏下说明文案自行换行、开关不被挤走。
- 偏好设置卡移除「桌面显示」一行，保留免打扰/大小/睡眠窗口/免费托管。
- 切换行为不变：`POST /settings {visible}`，隐藏后桌面悬浮宠物在下次轮询（≤6s）内消失，设置页仍可完整照护。
- 验证：ui-test 实例读 DOM 位置 —— h1 y=98/开关 y=100（同一行）、开关 x=806 位于标题右侧；点开关后 `settings.visible=false`、悬浮 sprite 从 DOM 消失，再点恢复 `true` 且重新出现；`npm test` 146/146；截图 `docs/v1-settings-dashboard.png` 重拍。

## 4.17 点击宠物不再弹数值窗（第 16 轮）

用户反馈：「点击宠物不要弹出饱食等数值的弹窗」。

- 移除桌面悬浮层的数值卡（`.dsh-digital-pet-mini`）及其状态与全部交互入口：轻点/键盘 Enter = 只做抚摸（飘爱心 + 心情奖励，30 分钟冷却由 Host 控制），不再打开任何弹窗；爪印仍打开操作盘，Esc 只收操作盘。
- 数值查看路径收敛为唯一入口：设置 → 电子宠物 仪表盘（三条状态条 + 陪伴/亲密度/照顾次数）；桌面保留诉求气泡（可点击直接照顾）、动作倒计时、错误红条、便便配件。
- 代码上删除 `open` state、`setOpen` 引用、mini 卡 JSX 与 `.dsh-digital-pet-mini*` CSS；`aria-label` 改为「昵称：Enter 抚摸」。
- 验证：ui-test 实测点击后 `.dsh-digital-pet-mini` 数量 0、爱心 1、诉求气泡仍在、`/pet` 调用成功；重拍 `v1-pet-heart.png`、`v1-action-pose.png`、`v1-care-running.png`、`v1-need-and-waste.png`、`v1-error-feedback.png`、`v1-dark-overlay.png`；`npm test` 146/146。
- 说明：曾用于展示 72px 尺寸与状态卡的 `v1-mini-72.png` 已删除，README 截图清单同步为 22 张。

## 4.18 成长记录隐藏寿终日期与剩余寿命（第 17 轮）

用户反馈：「成长记录不要显示寿终日期、剩余寿命，隐藏掉」。

- `GrowthCard` 删除两行：`寿终日期`（`fmtDate(pet.lifeEndsAtMs)`）与 `剩余寿命`（`fmtDuration(lifeRemaining)`），同时移除不再使用的 `lifeRemaining` 局部变量；`fmtDuration` 仍被悬浮层「陪伴 X」使用，保留。
- 保留字段：物种（含中英名）、出生日期、当前阶段（第 N 天）、距离下一阶段、亲密度、主动照顾次数，以及阶段进度条与六阶段说明。
- 设计意图：不把「离世倒计时」常驻展示，减少焦虑；生命周期规则、寿终归档与纪念册逻辑均不变（`lifeEndsAtMs` 仍在存档与 Host 计算中）。
- 验证：ui-test 实测成长记录卡片 `innerText` 不含「寿终日期」「剩余寿命」；重拍 `docs/v1-settings-growth.png`；`npm test` 146/146。

## 4.19 成长记录去掉阶段进度条与六阶段说明（第 18 轮）

用户反馈：「删除『六阶段：婴儿 0–3 天 · … · 老年 150 天起』和上面的进度条」。

- `GrowthCard` 删除阶段进度条 `.dsh-digital-pet-progress` 与六阶段说明 `.dsh-digital-pet-hint` 两段 JSX，并删除仅供进度条使用的 `startDays` / `progress` 计算。
- 同步删除已无引用的 `.dsh-digital-pet-progress` / `> i` 两条 CSS（`.dsh-digital-pet-hint` 仍被领养卡、悬浮层等使用，保留）。
- 成长记录现在只保留一个字段列表：物种（中英名）、出生日期、当前阶段（第 N 天）、距离下一阶段、亲密度、主动照顾次数——卡片更紧凑，无装饰性进度条。
- 验证：ui-test 实测 `dialog.innerText` 不含「六阶段」、`.dsh-digital-pet-progress` 节点数 0，成长记录字段完整；重拍 `docs/v1-settings-growth.png`；`npm test` 146/146。

## 4.20 照护动作动态反馈（第 19 轮）

用户反馈：「喂食、洗澡、逛街等操作执行时，需要宠物有动态的动画的动作反馈，比如喂食的动画和帮它擦身洗澡的动画效果」。

- 约束：动作素材是**单帧姿态图**（每物种 14 槽，无序列帧），因此动效用「姿态变形 + 程序化小道具/粒子」在客户端合成——不改 Host、不加新资产、不需要重新出图。
- 机制：动作期间，设置页大图（`.dsh-digital-pet-hero img`）与桌面悬浮精灵（`.dsh-digital-pet-sprite`）同时带 `data-mood="acting"` 和 `data-action="<type>"`；`data-action` 选择器在待机动画之后声明，覆盖 `awake/sleep/hungry` 的待机循环：
  - `feed`：1.8s 低头咀嚼 4 次（`dsh-digital-pet-act-eat`）+ 3 粒粮飞向嘴边 + 星星闪烁；
  - `bathe`：1.5s 左右搓洗（`act-bathe`）+ 泡沫/3 气泡/水珠 + 海绵来回擦洗；
  - `walk`：2.8s 左右走动两步后转身（`act-walk`：`translateX ±13%` + `scaleX(-1)`）+ 3 团尘土；
  - `cleanWaste`：`act-sweep` 探身扫尘 + 扫帚摆动 + 便便配件 3s 内淡出；`water`：`act-drink` + 水槽水纹；`groom`：复用搓洗 + 海绵；
  - 未知动作兜底 `act-bob`（1.7s 轻微起伏），保证任何动作都有「在动」的反馈。
- 两处生效点：新增共享组件 `ActionFx`（`ACTION_FX` 映射 under/over 两层：`under` 垫在身体后、`over` 盖在身体上），设置页大图与桌面悬浮层复用同一份 CSS 与组件；设置页大图在动作中会换成**动作姿态图**（此前只显示当前阶段图）。
- 无障碍/交互：`prefers-reduced-motion: reduce` 时两处动作动画、道具动画全部关闭、小道具隐藏，动作姿态与倒计时保留；拖动宠物时（`.dragging`）动作动画暂停，避免干扰拖拽定位。
- 验证（ui-test 实例，`tools/action-fx/capture.mjs` 用 CDP 暂停动画时间轴逐帧取图，`verify.json` 16 项断言全绿）：
  - 设置页/悬浮层 `animationName`：`dsh-digital-pet-act-eat`(1.8s) / `act-bathe`(1.5s) / `act-walk`(2.8s)；
  - 道具节点：喂食 = 3 粮粒 + 星星；洗澡 = 泡沫 + 3 气泡 + 水珠 + 海绵；逛街 = 3 尘土；
  - 每条动作 8 帧逐帧不同（位移/形变肉眼可辨）；`prefers-reduced-motion` 下 `animationName=none`、`fxVisible=none`，恢复后回到 `act-walk`；
  - `npm test` 146/146；`node --check client.js index.js` 通过。
- 证据：`docs/v1-action-feed.gif`、`docs/v1-action-bathe.gif`、`docs/v1-action-walk.gif`（8 帧/动作，帧时长取自动画周期）、`docs/v1-action-strips.png`（三行 × 8 帧拼图）。
- 生效条件：纯客户端改动，刷新页面即可；Host 未改动（动作状态取自快照里的 `activeAction.type`）。

## 4.20 新增恐龙物种 + 九款全部开放（第 19 轮）

用户原话：「中文名：迪诺；英文名 Dinosaur，种类恐龙，帮我增加创建一套这个宠物领养；并且目前的所有宠物都能开放领取；并且需要跟现在其他宠物一样有动画效果。画质需要优化一下」。

### 素材管线（`assets/tools/prep_dinosaur.py`）
- 源图：用户提供的 1254×1254 RGBA webp（真透明，alpha 0 占 64%），存为 `assets/source/dinosaur-original.webp`。
- 流程：alpha<16 清零 → 写 `pet-family-v2/dinosaur.png` → 复用 `slice.py` 的连通域切格（行聚类 `[4,4,4,2]`、14 个主形象、18 个配件）→ 计算 14 个 slot 的 crop（+2px margin）→ 追加 manifest 条目与 `sourceImages` sha256。
- **宠物/便便拆分**：恐龙尾巴尖与便便堆在源图里像素相连。做法：棕色色域 `(R>G+8)&(G>=B-5)&(R>45)&(B<170)` 取最大连通域作便便 core → 膨胀 4px 后从主连通域扣除得到宠物 mask → 臭味线用真实连通域像素（不是 bbox）。
- **prebuilt 机制**：`poop.png`（仅便便+臭味线）与 `adult-with-poop.png`（仅宠物）由 prep 按 mask 直接产出、manifest 标 `prebuilt:true`；`optimize_sprites.py` 对 prebuilt 条目跳过重算只补字节数，`--verify` 照常校验。
- 边界白点：mask 之后额外清掉「alpha<250 且 RGB 最小通道≥228」的像素。
- 终态：**135 张 / 5,075.8 KB**，`--verify` 通过；恐龙原生尺寸 baby 206×137、adult 251×260、elder 247×245、poop 70×119（第 20 轮又做了 2× 清晰度增强，见 §4.21，最终 7,055,598 B）。

### 全部开放
- `index.js` SPECIES：`cow`/`goat` 的 `extension` 由 `true` 改为 `false`；新增 `{ id:'dinosaur', speciesZh:'恐龙', speciesEn:'Dinosaur', nameZh:'迪诺', nameEn:'Dinosaur', grooming:'鳞片护理', extension:false }`，共 **9 款全部可领**。
- `tests/host.integration.test.mjs`：物种数 8→9；原来「扩展物种拒绝」用例改为「牛牛可领养成功 + 同存档二次领养报错」；`npm test` **146/146**。
- 客户端无需改动：动画由 `data-mood` + 同一组 CSS keyframes 驱动，9 款配置只要有精灵即自动获得待机/睡眠/饥饿/动作动效。

### 验证
- `/state`：9 个 species，`extension` 全 false；领养页 9 张卡全部可点（文案 `… 恐龙 迪诺 · Dinosaur`）。
- 领养恐龙「迪诺」：`dinosaur/baby.png` 206×137、`data-mood=awake`、`animation-name=dsh-digital-pet-idle-awake`；
- 成年态 + 便便：`dinosaur/adult.png` + `.dsh-digital-pet-poop`（`dinosaur/poop.png`）+ 诉求气泡「想吃饭」；`mood=hungry` 时动画为 `dsh-digital-pet-idle-hungry`。
- 动作姿态：点「喂食」→ 精灵切 `dinosaur/feed.png`、`mood=acting`、动画 `dsh-digital-pet-act-eat`。
- 全部 9×14 slot 精灵 `GET /dsh-digital-pet/api/assets/sprites/<species>/<slot>.png` 均 200；`optimize_sprites.py --verify` OK。

### 说明
- 新增物种属于 **Host 半改动**，桌面应用需重启（不是 ⌘R）才能看到第九款；ui-test 新实例可直接验证。
- 其余物种的旧 poop 素材存在同类「相邻形象像素混入」的轻微瑕疵（如 whale 便便左侧有一条青色尾尖），属 v1 切图历史问题，本次只修了恐龙；如需要可后续用同一 mask 方案统一重切。

## 4.21 恐龙形象清晰度增强（第 20 轮）

用户原话：「这个恐龙的形象图片画质太差很模糊，请增加清晰度」。

### 定位
- 恐龙源图是 AI 平滑插画：平均相邻像素差 `mean|dRGB|` 恐龙 14.9–18.6，鲸鱼 32.7、小鸡 20.6；`flat2x2` 比例（2×2 同色块）恐龙 0.06 vs 鲸鱼 0.01 —— 线条本身低对比、渐变多。
- DPR2 屏幕下 72 CSS px = 144 设备像素，而恐龙 baby 原生仅 137–139px 高 → **被轻微放大**；平滑插画放大后比硬像素画更显糊。
- 单用锐化/量化/加深描边改善有限，最终采用「增强 + 2× 超采样」：让浏览器始终做**缩小**而不是放大。

### 实现（`assets/tools/optimize_sprites.py`）
- 新增 `enhance_sprite(image, options)`：`UnsharpMask(radius=1.4, percent=220)` → `Contrast 1.08` → `Color 1.06` → `hard_alpha`（alpha≥200 置 255、其余 0，去掉半透明灰边）→ `supersample=2` 用 LANCZOS 放大 2× 后再次硬 alpha（≥96→255）。
- 主循环对 `species.get("enhance")` 生效；manifest `entry.scale` 记录实际倍率（恐龙=2）。
- `assets/tools/prep_dinosaur.py` 写入该物种的 enhance 配置，重跑两条命令即可再生。

### 结果
- 恐龙 14 slot + 1 核对图全部 2×：baby 412×274、toddler 436×432、adult 502×520、elder 494×490、poop 140×238、feed 484×448、bathe 510×516。
- 全库：**135 张 / 7,055,598 B（约 7.05 MB）**，`optimize_sprites.py --verify` 通过；其余 8 物种未改（保持用户此前确认的观感），需要时可对任意物种加同样配置。
- 实机：DPR1 下 `natural 412×274 → CSS 102×73`；DPR2 下 412→144 设备像素，为缩小采样，边缘清晰无白边。截图 `docs/v1-dinosaur.png` 已重拍。

### 缓存破坏（配套修复）
- 素材路由带 `cache-control: immutable`，浏览器会长期用旧图 → 重出精灵后用户看不到变化。
- Host 在 `/state` 新增 `assetsVersion`（manifest 大小/mtime/总量 sha1 前 10 位）；客户端所有素材 URL 统一走 `assetUrl(snap, path)` 追加 `?v=<assetsVersion>`，Host 未重启时兜底 `ASSET_QUERY_FALLBACK = '2'` 也保证破一次缓存。

## 4.22 金币图标改为金色硬币（第 21 轮）

用户原话：「这个金币的图标要改成金色的，看着像金币才行」。

- 原因：原实现用系统 emoji `🪙`，在 macOS 字体里渲染偏银色/金属灰，不像金币。
- 改为 **内联 SVG** `CoinIcon({ size })`（`client.js`）：外圈 `#E7A93A` + 深金描边 `#9A6A14`、内圈 `#F7CB61`、左上高光 `#FFF2C0`、中间 ¥ 符号 `#8A5C10`。固定色值，不随浅色/深色主题变化，两套主题下都呈金色。
- 使用位置：仪表盘页头金币 chip（`60`）、「食品与背包」金币 chip（`60 金币`）、商店每个食品价格（`基础口粮 · 🪙12 金币`）。CSS 增加 `.dsh-digital-pet-coin`（`vertical-align:-2px`）与 `.dsh-digital-pet-shop-price`（inline-flex 对齐）。
- 验证：设置页 `.dsh-digital-pet-coin` 共 5 处（1 页头 + 1 背包 + 3 商品），文本仍为纯数字/`N 金币`（无 emoji）；截图 `docs/v1-coin-icon.png`；`npm test` 146/146。

## 4.23 「金币明细」：把 Token→金币 的兑换进度显性化（第 22 轮）

用户反馈：「我一直在使用 deepseek 的 token，为什么好像金币没有增加，帮我查下这个金币通过 token 逻辑」。

### 排查结论（逻辑本身正常）
- 读取 desktop profile 存档：`usage.dayKey=2026-10-28`、`eligibleTokens=348,696,138`、`grantedCoins=100`、`wallet.balance=150`；ledger 只有一条 `+100`（当日 00:52 首次发放）。
- 即：当日 3.48 亿有效 Token 按 1,000:1 折算约 34.8 万金币，但**每日上限 100 金币**早已发满；此后所有调用都只累计 Token、不再发币，所以界面看起来「不涨」。
- 钱包 150 = 首赠 60 + 当日兑换 100 − 消费 10。

### 补的 UI（设计稿 §9.1 本就要求「明确显示今日兑换进度、已获金币和上限」，此前未实现）
- 新增 `TokenExchangeCard`（`client.js`）：标题「金币明细」，显示
  - 今日已获 `granted / dailyCap` 金币（封顶时追加「今日已封顶」chip）；
  - 今日有效 Token 数 + 折算规则；
  - 封顶时提示「按 Token 折算本应 N 金币，但每日上限 100，超出部分不再发放，次日 0 点重置」；未封顶时提示「再累计 X Token 可再换 1 金币」；
  - 一段来源说明（模型调用用量、输入+输出、缓存命中不额外计算、按 profile 时区 0 点重置）。
- 位置：「食品与背包」下方、成长记录上方。
- 验证：用 desktop 存档副本在 ui-test 实测两种状态——封顶（100/100，提示 351,042 金币）与未封顶（37/100，提示「再累计 500 Token 可再换 1 金币」）；截图 `docs/v1-coin-detail.png`；`npm test` 146/146。

## 4.24 宠物右键菜单：快捷隐藏（第 23 轮）

用户原话：「加一个效果，当鼠标悬停在宠物上方点击右键时，弹出选项'隐藏+具体宠物名称'按钮，点击后可快捷隐藏宠物」。

### 实现（`client.js` 的 `PetOverlay`）
- 状态：`ctxMenu`（null | `{x,y}`）+ `ctxMenuRef`；打开时把焦点交给菜单项，键盘可直接 Enter/空格执行。
- 触发器：宠物精灵 `onContextMenu`（`preventDefault + stopPropagation`）；键盘 `ContextMenu` 键或 `Shift+F10` 同样打开（基于精灵 `getBoundingClientRect` 定位）。
- 菜单：`role="menu"` + `role="menuitem"`，文案 `隐藏「${nickname}」`；点击等价于设置页「桌面显示」关 → `POST /settings {visible:false}` → 下一轮快照刷新后整个悬浮层消失。
- 关闭：`Esc`、点击菜单以外的任意区域（`pointerdown` capture 监听）。
- 摆放：`openCtxMenu` 以光标为锚点偏移 6px，靠右/靠下自动向左/上展开并夹进视口（不会出屏）。
- `hidePet` 失败（如 host 不可用）走统一错误 pill，不静默失败。

### 验证（ui-test + Playwright headless）
- 右键精灵 → 菜单出现且文案为 `隐藏「迪诺」`；点击后 `settings.visible=false`、`.dsh-digital-pet-overlay` 数量 0；
- `Esc` / 点击空白 均能关闭；`Shift+F10` 可键盘打开并把焦点放到菜单项；
- 恢复路径：设置 → 电子宠物 → 页头「已隐藏（点击显示）」→ 点击后 `visible=true`，约一个轮询周期（≤5s）后悬浮宠物重新出现；
- 截图 `docs/v1-context-menu.png`；`node --check` OK、`npm test` 146/146。

## 4.25 睡觉状态：头顶 ZZZ 符号（第 24 轮）

用户原话：「宠物顶部加ZZZ以前的符号表示睡觉，不加文字」。

### 实现（`client.js`）
- 新组件 `SleepZzz`：三个 `Z` 字符（8/11/14 → 10/13/17px，逐字增大），各自错开 0.42s 做「上浮 + 淡出」循环（`@keyframes dsh-digital-pet-zzz-float`），`aria-hidden="true"`，纯符号不出现任何文字。
- 触发条件：`moodOf(pet, activeAction) === 'sleep'`（即 `pet.sleeping === true` 且无在途动作）；醒着 / 饥饿 / 口渴 / 动作进行中都不显示。
- 位置：包住精灵图的 `.dsh-digital-pet-pet-wrap`（相对定位）内，`top: calc(var(--pet-size) * -0.27)`、水平居中 → 悬浮宠物任意尺寸（72/96/128）都贴在头顶上方；设置页 132px 大图用 `.dsh-digital-pet-hero-stage .dsh-digital-pet-zzz { top: -14px }` 微调避免越出卡片。
- 颜色用 `--dsw-alias-label-primary`（浅色主题近黑、深色主题近白），不抢宠物主色；`prefers-reduced-motion` 下关闭动画但保持可见。
- 读屏：ZZZ 本身 aria-hidden，同一状态通过既有 `.dsh-digital-pet-sr` live region 播报「睡觉中」（视觉上仍无文字）。

### 验证（ui-test + Playwright headless，浅色/深色两个实例）
- 睡眠中：`.dsh-digital-pet-zzz` 存在、`data-mood="sleep"`、深色主题取到 `rgb(249,250,251)`；设置页大图同样有 ZZZ；
- 醒着（睡眠窗口改到不覆盖当前时间）：`data-mood="awake"`、ZZZ 数量 0；
- 截图 `docs/v1-sleep-zzz.png`（浅色/深色并排）；`node --check` OK、`npm test` 146/146。

## 4.26 金币兑换比例调整为 1,000,000 Token = 1 金币（第 25 轮）

用户指令：「金币获取规则改为 1000000 Token = 1 金币」。

### 改动
- `index.js`：`TOKENS_PER_COIN` 1,000 → **1,000,000**；`awardUsageTokens` 与 `createUsageAccountant` 的缺省值改为引用该常量（不再散落字面量 1000）；`internals` 导出常量供测试锁定。
- `cordis.patch.yml`：`config.tokensPerCoin: 1000000`（每 profile bundle patch 生效）。
- `client.js` 的「金币明细」卡不再写死比例：`perCoinText = perCoin.toLocaleString()`，标题/说明/来源提示全部用 `economy.tokensPerCoin`（Host 下发），以后改配置 UI 自动跟随。
- **当日已发金币只增不减**（`awardUsageTokens` 增加 `nextGranted = max(已发, target)`）：调整比例当天，旧已发金币（如 100）不会被回收到更低 target，也不会因为 target 变小后重新补发而造成超发。
- 「金币明细」新增「按当前 Token 折算可换 N 金币，下一次模型调用后到账」一行，避免状态切换瞬间出现「再累计 0 Token」的怪文案。

### 验证
- `npm test` **148/148**：新增「默认兑换比例 1,000,000」用例（999,999→0、+1→1、再 +2.5M→再发 2）与「调整比例当天不回退已发金币，也不重复补发」回归用例；
- ui-test 实测：`/state.economy = {tokensPerCoin: 1000000, dailyCap: 100}`，客户端文案显示「1,000,000 Token = 1 金币」「按当前 Token 折算可换 16 金币…」；
- 截图 `docs/v1-coin-detail.png` 已按新比例重拍；README 经济段同步。
- 注意：desktop 运行中的应用需**重启**才能加载新的 Host 常量/配置（客户端半 ⌘R 即可）。

## 4.27 睡眠状态：闭眼睡觉精灵 + 睡眠时间设置可靠性（第 26 轮）

用户反馈：「为什么我设置宠物睡眠时间到中午12点，现在增开眼睛没睡觉，睡觉的图片需要区分出来闭上眼睛同时顶部加 ZZZ 以前的符号。现有的除了睡觉任何状态都不要改动已经满意了。」

### 根因
- 用户 desktop 存档里 `settings.sleepEnd = "00:00"`（不是 `12:00`）：原生 `<input type="time">` 在 12 小时制区域显示 `12:00 AM / PM`，把「中午 12:00」选成 `12:00 AM`（= 00:00）后，11 点自然判为清醒；且旧 UI 还需要再点一次「保存作息」，容易以为已生效。
- 睡觉态此前直接复用普通阶段精灵（多为睁眼），只有 ZZZ 符号，缺少「闭眼」的视觉区分。

### 改动
- **睡眠时间输入**：改用 24 小时制文本输入（`SleepTimeInput`，`placeholder 23:00`、正则 `^([01]\d|2[0-3]):[0-5]\d$`），**改动即保存**（去掉「保存作息」按钮），非法输入自动回退；输入框下方显示人类可读窗口，例如「每天 23:00 至 次日 12:00，共 13 小时；改动即保存。当前：睡眠中」，起止相同则提示「视为不启用睡眠」。
- **睡觉精灵**：新增 9 物种 × 6 阶段 = 54 张 `sprites/<species>/sleep-<stage>.png`（`assets/tools/make_sleep_sprites.py` 生成：36 张合成闭眼 + 18 张原图本就闭眼直接复制；alpha 与尺寸逐像素保持）。客户端 `usePetSprite()` 在 `mood === 'sleep'` 时优先用 `sleep-<stage>`，**加载失败自动回退普通阶段图**，因此素材缺失也不会白屏。
- **睡眠期间不跑 hover 图集**：`FramePet` 在 `data-mood="sleep"` 时走静态图路径，避免睡觉时出现眨眼/打招呼帧。
- **睡眠呼吸**：`@keyframes dsh-digital-pet-sleep-breathe`（5.2s，translateY 2px→1px + 轻微 scale）常驻生效；宿主默认策略是「非 hover 状态禁用所有动画」，这里只对 sleep 追加 `!important` 例外，其它状态完全不动。
- **其它状态零改动**：awake/hungry/thirsty/acting 的精灵、动画、hover 图集保持原样（按用户要求）。

### 验证
- ui-test（whale adult）：醒着 `eyes open`；睡着 `src = .../sleep-adult.png`、`data-mood=sleep`、`animation-name=dsh-digital-pet-sleep-breathe`、ZZZ 1 个；
- ui-test（dinosaur baby，用户当前宠物）：睡着 `src = .../sleep-baby.png`，ZZZ 出现、呼吸动画生效；设置页大图同样切到 sleep 精灵；
- 24 小时制输入实测：填 `12:00` → 存档 `sleepEnd=12:00`、`sleeping=true`；填 `25:99` → 不写入、自动回退；
- 截图 `docs/v1-sleep.png`（whale/dino 各一组「awake vs sleeping」）。
- `npm test` **148/148**、`node --check client.js index.js`、`python3 assets/tools/make_sleep_sprites.py --report` 54/54。

## 4.28 动作不可用时给出原因提示（第 27 轮）

用户反馈：「我刚喂食了一次，为什么食品没少，检查下」。

### 排查结论（不是扣减 bug）
- desktop 存档现状：`H = 99.9`（接近满）、`inventory = { snack: 4 半份, relief: 2 半份 }`、`foodRecoveredToday = 42`、`careCount = 4`。
- 后端规则：`FEED_RULES.minHungerDeficit = 10`，即 **`H > 90` 时喂食一律拒绝（`NOT_HUNGRY`）**，包括零食；拒绝发生在“开始动作”之前，不进入动作、不扣任何食品。
- 用户当天确实成功喂过一顿：`foodRecoveredToday = 42` 说明那顿实际补了 42 点饱食（从约 58 → 99.9），消耗掉的是最后 1 份基础口粮，所以现在背包里基础口粮为 0 份；`relief` 的 1 份是 13:33 单独领取的免费救济。
- 对照实验（用该存档副本 + 临时实例）：`H=20` 时 POST `/care {action:'feed'}` → 4s 后 `basic` 由 6 半份 → 4 半份（−1 份）、`H` 20 → 80、`careCount` +1 → 扣减/恢复链路正常。

### 改进
- 客户端新增 `ACTION_REASON_TEXT` 与 `actionReasonText()`：把 Host 的结构化 reason（`NOT_HUNGRY` / `TOO_CLEAN` / `LOW_ENERGY` / `ON_COOLDOWN` / `NO_WASTE` / `ITEM_MISSING` / `DAILY_LIMIT` …）翻成一句人话。
- 桌面操作盘的每个按钮、设置页仪表盘的每个动作按钮都加了 `title`（悬停提示）与 `aria-label` 说明，例如：
  - `喂食 · 它还不饿（饱食低于 90 才能喂）`
  - `洗澡 · 已经很干净了`
  - `铲屎 · 地面很干净`
- 这样即使点击被条件拦下、或按钮处于禁用态，也能直接看到“为什么不能做”，不会再误以为“喂了但没扣”。

### 原因文案中文化（用户第四轮反馈）
用户截图反馈：设置页点「喂食」时错误行显示的是原始枚举 `NOT_HUNGRY`，要求翻成中文。
- 原因：仪表盘 `care()` 的前置校验直接把 Host 的 `reason`（枚举 code）塞进错误行；此前只有悬浮层按钮 title 做了映射。
- 修复：新增 `actionReasonMessage(entry)`（`ACTION_REASON_TEXT[entry.reason] ?? '现在还不能做这个动作'`），仪表盘前置校验改用它；未知 code 不再直接暴露枚举。Host 侧 `actionErrorMessage()` 的兜底也从 `?? code` 改为 `?? '这个操作暂时不能进行'`。
- 验证：ui-test（H=95 点喂食）→ 错误行显示「它还不饿（饱食低于 90 才能喂）」，不再出现 `NOT_HUNGRY`；`node --check client.js index.js`；`npm test` 148/148。

### 提示不推动物（用户第三轮反馈）
用户反馈：「当顶部产生提示时，宠物不要出现下移，应该宠物保持不动，上方出现提示」。
- 原因：悬浮层是 `flex column`，诉求/错误/动作倒计时三个气泡是列首元素，出现时把下方宠物整体往下挤（实测位移 41px）。
- 修复：新增 `.dsh-digital-pet-hints` 绝对定位容器（`position:absolute; bottom:calc(100% + 6px); left:50%; transform:translateX(-50%); width:max-content`），把三条提示移出文档流；`toast`（成长播报）同样改为绝对定位在爪印下方，避免同类位移；`.dsh-digital-pet-hints` 设 `pointer-events:none`、子元素 `pointer-events:auto`，保证可点的诉求气泡仍能点击。
- 验证：Playwright 量测同一实例——无提示时 sprite y=607、有 1 条提示 y=607、叠加 2 条提示（需要铲屎 + 它还不饿）y=607，`dy = 0`；`node --check client.js`；`npm test` 148/148。截图 `docs/v1-hint-above.png`。

### 气泡样式统一（用户第二轮反馈）
用户反馈：「‘它还不饿’的提示需要跟‘需要铲屎’的样式一致」。
- 原因：`.dsh-digital-pet-pill-error` 在 CSS 里其实**没有对应规则**，只是一段裸文本，和诉求气泡 `.dsh-digital-pet-need` 的圆角卡片完全不同。
- 修复：把两者合并为同一套规则——`.dsh-digital-pet-need, .dsh-digital-pet-pill-error { max-width:190px; padding:4px 10px; border-radius:99px; font-size:11px; line-height:1.4; background:var(--dsw-alias-bg-layer-2); border:1px solid var(--dsw-alias-border-l1); color:var(--dsw-alias-label-primary); box-shadow:0 2px 8px rgba(0,0,0,.1); text-align:center }`；并补 `.dsh-digital-pet-need-btn { appearance:none; font-family:inherit; cursor:pointer }` 与 hover 背景。
- 验证：同屏实测两种气泡 computed style 完全一致（bg rgb(255,255,255)、color rgb(15,17,21)、border rgba(0,0,0,.04)、radius 99px、font 11px、padding 4px 10px、高 25px）；截图 `docs/v1-feedback-pill.png`。

### 验证
- ui-test（H=96）：面板按钮 title = `喂食 · 它还不饿（饱食低于 90 才能喂）`，设置页仪表盘第一个按钮 title 相同、点击后错误文案为「它还不饿」；
- `node --check client.js`；`npm test` **148/148**（仅客户端改动）。

## 4.29 操作盘：不可用动作置灰且不可点击（第 28 轮）

用户反馈：「当左侧操作按键还在冷却时，应该置灰不能点击」。

### 实现
- 操作盘按钮的 `disabled` 由「Host 下发的 `availableActions`」驱动：`disabled = busy !== null || availableActions[type].enabled === false`，同时写 `aria-disabled`，屏幕阅读器可读；`title` 仍写明原因（如「逛街 · 还在冷却中」）。
- CSS：`.dsh-digital-pet-panel-btn:disabled { opacity: .45; cursor: not-allowed }`，hover 高亮改为 `:hover:not(:disabled)`，灰色按钮不再有按下反馈。
- 键盘：方向键只在**可用**按钮之间循环（禁用项跳过）；Enter / 数字键 1–4 命中禁用项时不再触发动作；打开操作盘时把焦点交给第一个可用按钮。
- 点击被禁用的按钮不会发出 `/care` 请求（DOM `disabled` 直接拦住）。

### 验证
- 种子实例（领养 3 天前、逛街/梳理/洗澡均在 1 小时前刚用过、无排泄物）：
  - `/state.availableActions` → `feed:true`、`walk:false(ON_COOLDOWN)`、`groom:false(ON_COOLDOWN)`、`bathe:false(ON_COOLDOWN)`、`cleanWaste:false(NO_WASTE)`；
  - 操作盘实测：喂食 `disabled=false opacity=1`；逛街/洗澡/铲屎 `disabled=true opacity=0.45`、`aria-disabled=true`，title 分别为「逛街 · 还在冷却中」「洗澡 · 还在冷却中」「铲屎 · 地面很干净」；
  - 强制点击禁用按钮 800ms 内 `/care` 请求数 = 0。
- 截图 `docs/v1-panel-disabled.png`；`node --check client.js`；`npm test` 148/148（仅客户端）。

## 4.30 中英双语与界面语言切换（第 31 轮）

**需求**：新增英语，支持语言切换；入口在「设置 → 电子宠物」底部；默认中文。

### 实现

- Host：`settings.locale`（默认 `'zh'`，仅接受 `zh`/`en`；`sanitize` 对旧存档回落 `zh`，`/settings` 新增 `locale` 字段与 `INVALID_LOCALE` 400），快照透传给客户端。
- Client：文件内新增 `I18N` 词典（中/英各 167 个 key：标题、阶段、状态条、动作与原因、金币明细、领养、商店、成长、偏好、纪念册、送养、语言卡、错误码）与 `tx(key, vars)`；`setUiLocale()` 由快照 `settings.locale` 驱动，切换后所有组件重渲染。
- 语言卡 `LanguageCard`：设置页最底部（送养之后），「中文 / English」二选一，`POST /settings {locale}` 后立即生效并持久化。
- 全部写死中文的 UI 字符串改为 `tx`；阶段名/物种名/食品名/诉求名/错误码都走词典；日期与数字按 `en-US`/`zh-CN` 本地化；睡眠提示、倒计时、金币明细等模板变量化。

### 验证

- `npm test` **149/149**（新增 1 条 locale 用例：默认 zh、切换 en、非法值 400 且不改存档、旧存档回落 zh）。
- ui-test 实测：默认中文；点 English 后标题/卡片/按钮/悬浮层/错误文案全部切英文（`Fullness / Mood / Cleanliness / Together / Bond / Care actions / Feed / Walk / Bathe / Clean / Food & bag / Coin details / Growth / Preferences / Memorial / Rehome / Language`），`/state.settings.locale` 同步为 `en` 并持久化；切回中文同样立即生效。
- 截图：`docs/v1-i18n-zh.png`、`docs/v1-i18n-en.png`。
- 已知边界：DSH 自身设置弹窗外壳（左侧导航「账号与余额/通用设置」等）由宿主提供，仍跟随宿主语言；插件内的内容（含「电子宠物」页）全部中英切换。

## 5. 未完成 / 后续

- **原生桌面窗口**（可拖出窗口的桌面宠物）需要宿主原生桥接，V1 未做；当前为应用内悬浮。
- **逐帧动画**：动作动效已用「单帧姿态图 + CSS 形变 + 程序化道具/粒子」补足（§4.20），但仍不是序列帧——呼吸/眨眼/连续行走的逐帧动画需要新的序列帧资产（v2 仍是每槽单张静态图）。
- **数值收敛**：已用 `tools/simulate.mjs` 完成确定性引擎的 9 策略 × 181 天模拟（结论见 `docs/balance-report.md` 与 §4.6），但**尚未根据结论改常数**——设计稿明确写了救济 60/24h 与 100 币/天上限，改动属于设计变更，留待 v1.1 决策。
- **A09 崩溃注入 / 跨进程并发**：目前只有进程内并发（A08）与逻辑级验证；真实崩溃恢复未注入。
- **请求级 idempotency key**：未实现，重试依赖前置条件阻断。
- **animations**：待机呼吸浮动、爱心、照护动作动态（低头咀嚼 / 搓洗 / 走动 / 扫尘）均已做；未做逐帧序列（眨眼、连续走路帧）。

## 6. 复跑方式

```bash
cd plugins/dsh-digital-pet
npm test                                   # 148/148
node --check index.js client.js
python3 assets/tools/optimize_sprites.py --verify   # 135 PNG（9 物种 × 15）/ manifest v2
python3 assets/tools/make_sleep_sprites.py --report  # 54 张睡觉精灵校验
python3 assets/tools/slice.py --verify              # v1 切格自检（历史）
# 动作动效证据重拍（先起临时实例，把打印的 URL 传进来）
node tools/action-fx/capture.mjs "http://127.0.0.1:<port>/?token=..." --out .tmp/action-fx
python3 tools/action-fx/compose.py --src .tmp/action-fx --docs docs
```

真机复验（临时 profile）：

```bash
dsh ui-test --from-default-profile web --dump-config
dsh plugin --profile ui-test add "$(pwd)"
dsh --profile ui-test --port 0 --no-open   # 打开打印的 URL
# 注意：实例退出后 ui-test profile 会被清理，重启前需重复前两步
```
