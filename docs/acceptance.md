# 验收映射（设计稿 §14 · A01–A23）

> 结论先行：自动化测试 **144 例全绿**（内核 131 + Host 集成 8 + Token 记账 5），关键界面用真实 ui-test 实例截图验证。下表逐条映射，**明确标注未自动化覆盖的部分**——这些项依赖真实桌面窗口/多窗口并发/系统级交互，首版只做了手工验证或留待 v1.1。
>
> 复跑：`cd plugins/dsh-digital-pet && npm test`（约 0.5s）。

## 覆盖总览

| 用例 | 结论 | 证据 |
|---|---|---|
| A01 首次领取/取消/重复点击 | ⚠️ 部分 | `host.integration`: 领养+首赠（60 金币 / 3 份口粮）、重复领养 409、再领养不重复赠礼；取消由客户端不提交保证（未点「领取」不会创建宠物，无自动化断言的“取消”路径） |
| A02 D3/D14/D45/D90/D150 阶段切换 | ✅ 自动化 | `tests/core/growth.test.js`（9）阶段边界左闭右开、重启不重复阶段事件 |
| A03 月末领取与换时区 | ✅ 自动化 | `tests/core/time.test.js`（10）1/31→7/31、8/31→2/28、闰年、DST；`lifeEndsAtMs` 固定不可变 |
| A04 24h 标准作息衰减 | ✅ 自动化 | `tests/core/settle.test.js`（11）睡眠分段、E 自动休息、封顶 100 |
| A05 整餐/两次半餐 | ✅ 自动化 | `tests/core/actions.test.js` 喂食整份/半份、库存半份单位、截断 |
| A06 喂水冷却与超 36h 惩罚 | ✅ 自动化 | `tests/core/water.test.js`（7）首次不受冷却、6h 冷却、-2/6h 封顶 -8；UI 已无「喂水」按钮（按反馈移除），host 到 18h 自动补水，接口仍支持手动喂水 |
| A07 连续喂食/满状态/越界 | ✅ 自动化 | `actions.test.js` NOT_HUNGRY、INVENTORY 不足、不刷亲密度；`state.test.js` 夹紧 |
| A08 双窗口并发购买 | ⚠️ 基本 | Host 用串行 `mutateStore`（进程内写链 + tmp rename 原子提交）；新增 `tests/host.integration.test.mjs` 并发用例：两笔并发购买只成功一单、余额与库存不超扣；**跨进程双窗口真实压测未做** |
| A09 动作中途退出、完成时间后重启 | ✅ 自动化 | `settle` 按 `activeAction.endsAtMs` 补结算；`host.integration` 重启路径用 `lastSeenAtMs` 补算（未做真实进程崩溃注入） |
| A10 Token 流式/最终/汇总去重 | ✅ 自动化 | `tests/accountant.test.mjs`（5）message.usage 优先、stream chunk 兜底、assistant/attempt 不重复计 |
| A11 金币阶梯（1,000,000 Token = 1 金币） | ✅ 自动化 | `accountant.test.mjs` 999,999→0、1,000,000→1、累加→3、日上限 100、跨日重置；比例调整当天不回退已发金币 |
| A12 跨午夜/历史回放不发币 | ✅ 自动化 | 记账日按完成时间；无 `seq` 事件跳过（历史回放/安装前用量） |
| A13 余额不足/事务故障/重试 | ⚠️ 部分 | `host.integration` 覆盖 NOT_ENOUGH_COINS 与原子落盘（tmp+rename 后 rename，失败不落半成品）；**请求级 idempotency key 未实现**，重试同一请求若条件仍满足会再执行一次（读操作幂等，写操作依赖前置条件） |
| A14 0 Token/0 金币/无食品 | ✅ 自动化 | `claimRelief` → H+60；`host.integration` 救济库存规则、RELIEF_IN_STOCK |
| A15 隐藏/免打扰/睡眠/托管 | ✅ 自动化 + 截图 | `boarding.test.js`（9）+ `sleep` 分段；截图 `v1-settings-growth.png`。隐藏（`visible:false`）手工验证：9s 内 overlay 从 DOM 消失 |
| A16 离线 8h/24h/7 天 | ✅ 自动化 | `offline.test.js`（10）+ `settle.test.js`：≤24h 保护下限 30/40/30/40、>24h 自动托管 ≥60、便便不积压 |
| A17 离线跨越寿终 | ✅ 自动化 | `death.test.js`（6）寿终优先于动作、归档一次、死后动作全 disabled |
| A18 改系统时间/改时区 | ✅ 自动化 | 时间回拨返回原状态、不倒退年龄/冷却；大跳变由 Host 侧 `lastSeenAtMs` 判断（本地时间无强防作弊，设计稿已接受） |
| A19 多屏/缩放/边缘菜单 | ⚠️ 手工 | 操作盘固定贴宠物左侧，宠物贴近屏幕左边（x<220）自动翻到右侧；1280×800 实测不裁切；**未测多屏拔插与 4K 缩放** |
| A20 Esc/方向键/读屏/减少动态 | ✅ 基本覆盖 | 操作盘 `role=menu`+按钮 `role=menuitem`/`aria-label="N. 喂食"`；Esc 关闭并回焦爪印、←/→ 同行、↑/↓ 上下排移动焦点、Enter/Space 触发、数字 1–6 快捷触发；精灵 `role=button`+Enter 抚摸；爪印 `aria-expanded`；错误 `role=alert`、诉求/错误经 live region 播报；`prefers-reduced-motion` 关闭浮动动画。实测见 `docs/v1-action-panel.png`；操作盘现为 5 项（梳理已移除） |
| A21 禁用/卸载/热更新 | ⚠️ 手工 | 禁用插件后路由 404、无残留 polling 错误；**未做热更新/重装存档保留的自动化验证** |
| A22 送进宠物救助站 | ✅ 已实现 | 设置页最下方两步确认 → `POST /surrender {confirm:true}` 删除宠物数据（在途动作一起失效）；金币与口粮保留；重新领养不再发首赠；纪念册不写入；未带 confirm 返回 400 CONFIRM_REQUIRED；无宠物时 409 NO_PET。测试 `tests/host.integration.test.mjs`「送养」+ 截图 `docs/v1-surrender*.png` |
| A23 照护动作动态反馈 | ✅ 自动化 + 截图 | 动作期间两处精灵 `data-action` 驱动 CSS 动作动画（喂食低头咀嚼/洗澡搓洗/逛街走动转身/铲屎扫尘）+ 程序化道具（粮粒、泡沫水珠、尘土、扫帚）；`tools/action-fx/capture.mjs` 用 CDP 对真实实例逐帧取图并断言 `animationName`、道具节点、8 帧差异、`prefers-reduced-motion` 关闭与恢复，`verify.json` 16 项全绿；证据 `docs/v1-action-{feed,bathe,walk}.gif`、`v1-action-strips.png` |

## 手工验证记录（用于回归）

1. **安装与加载**：`dsh ui-test --from-default-profile web --dump-config` → `dsh plugin --profile ui-test add <abs>` → 启动 → `/dsh-digital-pet/api/ping` 返回 `{ok:true,name:'dsh-digital-pet',version:'0.1.0',dataFile:'<profile>/dsh-digital-pet/pet-state.json'}`。
2. **领养**：设置 → 电子宠物 → 选鲸鱼 → 昵称「泡泡」→ 领取；钱包 60、库存基础口粮 2 份 + 0 半份；扩展物种（牛牛·奶糖 · Toffee / 山羊·咩咩 · Clover）卡片灰显、文案不带 v1.1。
3. **照顾**：操作盘点「喂食」→ 宠物上方「喂食中 · 5s」倒计时 → 完成 H 变化；喂食在 H=100 时返回「它还不饿」红 pill，4 秒消失（喂水入口已移除，饮水由 host 自动补给）。
4. **商品与救济**：买半份口粮扣 6 金币、库存 +1 半份；救济口粮 24h 一次，库存 ≥1 整份时返回 `RELIEF_IN_STOCK`。
5. **偏好**：大小 72/96/128（默认 128 实测）、睡眠窗口保存、免费托管开启后四项托底 60。
6. **隐藏**：`POST /settings {visible:false}` → 9s 内 overlay 消失；恢复后出现。
7. **纪念册**：种子存档内已离世宠物显示「糯糯 · 2025-09-23 → 2026-03-22 · 陪伴 180 天 · 照顾 268 次」。
8. **多宠物隔离**：`DSH_PET_DATA_FILE` 指向另一文件时是独立宠物；默认按 profile 目录隔离（desktop 与 ui-test 不共享）。
9. **照护动作动效（A23）**：`node tools/action-fx/capture.mjs <dsh web URL>` 连真实 ui-test 实例，自动领养/送养、串行动作、CDP 暂停动画时间轴逐帧截图；`verify.json` 断言：喂食 `dsh-digital-pet-act-eat`/洗澡 `act-bathe`/逛街 `act-walk`、道具节点数、每条 8 帧、`prefers-reduced-motion` 下 `animationName=none` 且 `fxVisible=none`、恢复后动画回来。

## 已知未覆盖 / v1.1 待办

- A08 跨进程双窗口真实并发、A09 真实崩溃注入、A19 多屏、A21 热更新为手工或未覆盖（A08 已有进程内并发单测）。A20 已做 Web 层键盘/读屏标签/减少动效实现与实测（真实读屏软件播报未验证）。
- 原生桌面透明窗口（设计稿 §11.3）未接入：当前宠物是 Web 界面内 `shell.overlay` 悬浮层。
- 时间模拟器已提供：`tools/simulate.mjs`（181 天 × 9 策略，`node tools/simulate.mjs` ≈1.8s 自动生成 `docs/balance-report.md`）。数值收敛结论见该报告与 `docs/design-doc-revisions.md` §6；V1 未按建议改常数（属设计变更）。
- 深色主题（desktop profile 默认）：已把全部 CSS 改为 DSH 真实设计令牌并实测，见 `docs/v1-dark-overlay.png` / `docs/v1-dark-settings.png`。
- 动画：待机呼吸浮动与动作动效（§4.20：单帧姿态 + CSS 形变 + 程序化道具）已做，未做逐帧序列（眨眼/连续行走帧）；真实序列帧需重新出图。
