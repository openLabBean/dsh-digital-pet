# dsh-digital-pet · DeepSeek Harness 电子宠物

一只住在 DeepSeek Harness 里的桌面宠物：用 DSH 完成任务产生的 Token 换金币，买食品、照顾它、看着它从婴儿长到老年，陪你走完六个月。

- **不惩罚忙碌**：每天一顿主餐即可维持；离线有保护与免费托管；不会因为漏养提前离开。
- **本地优先**：每个 profile 一只宠物，存档在该 profile 目录 `dsh-digital-pet/pet-state.json`（可用 `DSH_PET_DATA_FILE` 覆盖），不跨设备同步。
- **不额外烧 Token**：成长与金币规则独立于对话；日常互动不发起模型请求。

## 安装

```bash
# 1) 建一个隔离的测试 profile（可选；ui-test profile 会在实例退出时被清理）
dsh ui-test --from-default-profile web --dump-config

# 2) 把插件安装进 profile（bundle patch 自动生效）
dsh plugin --profile ui-test add /absolute/path/to/plugins/dsh-digital-pet

# 3) 启动（Web）
dsh --profile ui-test --port 0 --no-open
#   → 终端打印 http://127.0.0.1:<port>/?token=...
```

> 提示：`ui-test` profile 是临时的，实例被 kill 后目录会被清掉；重启实例前需要重新执行第 1、2 步。装进 `desktop`/`web` 这类常用 profile 则只需执行一次第 2 步（会修改该 profile 的 `package.json` 与 `dsh.profile.bundles`）。

安装后刷新页面：设置 → 左侧栏「电子宠物」即可领养；桌面上会出现悬浮宠物（默认右下角，可拖动）。

## 界面

| 位置 | 内容 |
|---|---|
| 设置 → 电子宠物 | 页头：标题 + 右侧「桌面显示」开关；领养向导、宠物仪表盘（三条状态 + 四项照顾 + 倒计时）、食品与背包（购买/救济）、成长记录、偏好设置（免打扰/大小/睡眠窗口/托管）、纪念册、送养（送进宠物救助站） |
| 桌面悬浮层 | 宠物 sprite（按年龄/动作切换，默认 72px）、拖动换位置、轻点抚摸（飘爱心，不弹数值窗）、便便配件、诉求气泡、动作倒计时 |
| 爪印按钮 → 左侧操作盘 | 宠物左侧 2 排 × 2 列纯文字按钮：喂食 / 逛街 / 洗澡 / 铲屎（「梳理/皮肤刷洗」「喂水」已按反馈移除；饮水改为到点自动补水，引擎与接口仍保留这两个动作）；点击操作盘以外区域收起 |

错误反馈：条件不满足时宠物旁显示红色小药丸（如「它还不饿」「正在照顾中，等这次完成吧」），4 秒后自动消失。

尺寸：新宠默认 **72px**，可在「偏好设置」切到 96 / 128；桌面上轻点宠物只做抚摸反馈（飘爱心），**不再弹出饱食/心情/清洁数值卡**，数值统一在「设置 → 电子宠物」仪表盘查看。

悬停表现（2026-10-29，已按用户确认的逐帧方案替换）：9种宠物×6年龄阶段，共54套、432个重新绘制的关键帧，包含眨眼和真实的手、翅膀、蹄子、脚部动作。默认静止，鼠标移入播放，移出立即停止并恢复首帧。婴幼年、青年和老年使用不同节拍，时序与确认过的预览一致。桌面悬浮层与设置页共用 `FramePet`，通过透明PNG图集选帧显示，已移除原来的整图旋转/伸缩悬停动作。

素材位于 `assets/hover-v1/atlases/<species>/<stage>.png`（8列1行），静态首帧在 `assets/hover-v1/posters/`，清单位于 `assets/hover-v1/manifest.json`。原135张静态/照护PNG保留；照护动作继续优先显示原动作图。图集预加载成功后才切换，图集失效时回退静态首帧。只在鼠标悬停且无照护动作时运行动画帧循环；拖拽、右键、窗口失焦、页面隐藏、切换阶段及卸载时取消循环，系统减弱动态效果关闭播放，触摸不触发悬停。

[查看已安装素材预览](docs/hover-frames/preview.html)。前端重新加载插件后生效；帧素材URL额外包含绘制版本号，避免旧Host缓存版本导致更新不及时。

照护表现：喂食咀嚼 + 粮粒、洗澡左右搓洗 + 泡沫水珠、逛街踏步 + 尘土、铲屎探身 + 扫帚。照护动作优先于成长阶段动作，并同样只在悬停时播放。鼠标移开只停止视觉动画，Host 的照护结算和成长照常继续。睡眠 Z 标记在非悬停时静止显示。

送养：设置页最下方「送进宠物救助站」→ 两步确认 → 删除当前宠物数据、金币与口粮保留、可重新领养（首次赠礼不会重复发放）。

截图见 `docs/`：

| 文件 | 内容 |
|---|---|
| `v1-settings-dashboard.png` | 页头「电子宠物 + 右侧桌面显示开关」+ 仪表盘 + 商店（3 条状态条） |
| `v1-settings-growth.png` | 成长记录（含阶段/寿命/亲密度） |
| `v1-settings-preferences.png` | 偏好设置（免打扰/大小/睡眠窗口/托管）+ 纪念册 + 送养 |
| `v1-settings-memorial.png` | 纪念册（含一只已离世宠物） |
| `v1-action-panel.png` | 桌面悬浮宠物 + 左侧操作盘（2 排 × 2 列纯文字）+ 便便配件 |
| `v1-idle-hungry.png` | 饱食 <20 的饥饿表达（🍖 气泡 + 无力摆动） |
| `v1-surrender.png` | 设置页最下方「送进宠物救助站」 |
| `v1-surrender-confirm.png` | 送养两步确认（明确提示数据删除、金币/口粮保留） |
| `v1-action-panel-dark.png` | 同上，深色主题（desktop 默认） |
| `v1-need-and-waste.png` | 诉求气泡「需要铲屎」（可点击直接照顾）+ 便便配件 |
| `v1-care-running.png` | 动作进行中（倒计时气泡 + 对应动作姿态，不再弹数值卡） |
| `v1-error-feedback.png` | 条件不满足的红色提示 |
| `v1-dinosaur.png` | 恐龙「迪诺」悬浮宠物：成年姿态 + 便便配件 + 诉求气泡 |
| `v1-dinosaur-sharpness.png` | 恐龙 2× 清晰度增强前后对比（按 DPR2 的 144 设备像素模拟） |
| `v1-coin-icon.png` | 金色金币图标（SVG）：设置页页头/仪表盘/商店价格统一使用 |
| `v1-coin-detail.png` | 「金币明细」卡：今日 Token → 金币兑换进度（含封顶说明） |
| `v1-context-menu.png` | 宠物右键菜单：`隐藏「昵称」`（快捷隐藏桌面宠物） |
| `v1-sleep-zzz.png` | 睡觉状态：头顶 ZZZ 符号（只有符号、不加文字；浅色/深色各一） |
| `v1-sleep.png` | 睡觉状态：闭眼睡觉精灵 + ZZZ（鲸鱼/恐龙各一组 awake vs sleeping 对比） |
| `v1-feedback-pill.png` | 悬浮层气泡统一：诉求「需要铲屎」与操作反馈「它还不饿」同一样式 |
| `v1-hint-above.png` | 顶部提示改为绝对定位：出现/消失时宠物不再下移（同一位置对比） |
| `v1-panel-disabled.png` | 操作盘中冷却/暂不可用的动作置灰且不可点击（悬停提示原因） |
| `v1-reason-zh.png` | 不可用原因中文化：仪表盘点击喂食时显示「它还不饿（饱食低于 90 才能喂）」 |
| `v1-adoption.png` | 全新安装后的领养页 + 领养成功（猫糯糯，护理名称为「梳毛」） |
| `v1-overlay-idle.png` | 婴儿期待机悬浮（含呼吸浮动动画） |
| `v1-idle-loop-awake.gif` | 醒着时的待机小动作循环（设置页大图 + 桌面悬浮宠物，6 帧） |
| `v1-idle-loop-sleep.gif` | 睡着时的呼吸循环（设置页大图 + 桌面悬浮宠物，6 帧） |
| `v1-action-feed.gif` | 喂食动作：低头咀嚼 + 粮粒飞向嘴边 + 星星（设置页大图，8 帧） |
| `v1-action-bathe.gif` | 洗澡动作：左右搓洗 + 泡沫/气泡/水珠/海绵（8 帧） |
| `v1-action-walk.gif` | 逛街动作：左右走动转身 + 尘土（8 帧） |
| `v1-action-strips.png` | 三种动作各 8 帧拼图（喂食/洗澡/逛街） |
| `v1-sprite-quality.png` | 精灵图 v1（96px + pixelated）与 v2（原生分辨率 + 去白晕 + 平滑缩放）对比 |
| `v1-action-pose.png` | 动作姿态：喂食中换成进食精灵（各动作有独立姿态） |
| `v1-a11y-keyboard.png` | 键盘操作：操作盘按钮焦点环 + 方向键切换（截图为旧版圆环，行为相同） |
| `v1-pet-heart.png` | 轻点宠物飘爱心反馈 |
| `v1-need-and-waste.png` | 桌面便便配件 + 可点击诉求气泡（点「想吃饭」直接喂食） |
| `v1-dark-overlay.png` | 深色主题下的悬浮宠物 + 诉求气泡（desktop profile 默认深色，已改用 DSH 设计令牌） |
| `v1-dark-settings.png` | 深色主题下的仪表盘 + 商店 |

## 宿主接口

浏览器半只做渲染与命令，所有数值由 Host 权威结算；快照轮询（默认 2.5s，切后台自动退避）。

```
GET  /dsh-digital-pet/api/ping                      健康检查（返回 name/version/dataFile）
GET  /dsh-digital-pet/api/state                     权威快照（宠物、诉求、钱包、库存、商店、救济、设置、服务端时间）
GET  /dsh-digital-pet/api/assets/sprites/{species}/{slot}.png   精灵图（etag + immutable 缓存，客户端加 ?v=<assetsVersion> 破缓存）
POST /dsh-digital-pet/api/adopt                     { speciesId, nickname }
POST /dsh-digital-pet/api/care                      { action: feed|water|walk|groom|bathe|cleanWaste, itemId?, halfUnits? }
POST /dsh-digital-pet/api/pet                       抚摸（30 分钟冷却、每日 5 次有效奖励）
POST /dsh-digital-pet/api/buy                       { itemId, halfUnits? , quantity? }
POST /dsh-digital-pet/api/claim-relief              领取救济口粮
POST /dsh-digital-pet/api/settings                  { visible?, size?, position?, quiet?, sleepStart?, sleepEnd?, boarding? }
POST /dsh-digital-pet/api/surrender                 { confirm: true }  送进救助站：删除当前宠物数据，金币/口粮保留
```

统一响应：`{ ok: true, ... }`；失败返回 `{ ok: false, code, error }`，错误码分两类：业务条件（`BUSY`、`ON_COOLDOWN`、`ITEM_MISSING`、`NOT_HUNGRY`、`LOW_ENERGY`、`TOO_CLEAN`、`NO_WASTE`、`DAILY_LIMIT`、`NOT_ENOUGH_COINS`、`RELIEF_IN_STOCK`、`RELIEF_COOLDOWN`、`PET_DECEASED`、`BOARDING` 等）与请求校验（`UNKNOWN_SPECIES`、`EXTENSION_SPECIES`、`INVALID_NICKNAME`、`ALREADY_HAS_PET`、`NO_PET`）。HTTP 状态码：业务拒绝 400/409，未知异常 500。

## 目录

```text
plugins/dsh-digital-pet/
├── package.json           # name @local/dsh-digital-pet，声明 dsh.bundle.patch 与 dsh.client
├── cordis.patch.yml       # Host 行：- id: digital-pet / name: '@local/dsh-digital-pet'
├── index.js               # Host 半：路由、按 profile 存档、Token 兑换、素材服务
├── client.js              # 浏览器半：__ModuleLoader__ 注册 settings.section + shell.overlay
├── src/core/              # 与 UI/IO 无关的确定性内核（由 tests/core 覆盖）
│   ├── constants.js       # 物种、食品、阶段、数值、冷却、价格
│   ├── time.js            # 时区、自然月寿命、睡眠窗口、分段结算
│   ├── growth.js          # 六阶段与纪念归档
│   ├── state.js           # 新建/规范化/每日计数
│   ├── actions.js         # 六项照护动作合同（预留 → 完成）
│   ├── care.js            # 状态联动、排泄计划、诉求优先级、托管
│   ├── economy.js         # Token→金币、商店、救济、首次赠礼
│   └── errors.js          # 结构化错误码
├── assets/                # 9 物种 × 14 slot 像素图 + manifest.json + 切图脚本
├── tests/core/            # 内核单测（131 例）
├── tests/host.integration.test.mjs   # Host 路由/存档/经济集成（8 例）
├── tests/accountant.test.mjs         # Token 用量记账（5 例）
├── tools/simulate.mjs      # 181 天 × 9 策略时间模拟器（生成平衡报告）
├── tools/action-fx/        # 动作动效证据采集（capture.mjs：CDP 取帧 + 断言；compose.py：GIF/拼图）
└── docs/                  # 截图、验收映射、实施报告、平衡报告、设计修订建议
```

## 开发与测试

```bash
cd plugins/dsh-digital-pet
npm test                 # 全量：148 tests / 148 pass
npm run test:core        # 131 例内核
npm run test:host        # 8 例 Host 集成
npm run test:accountant  # 5 例 Token 记账
node --check index.js
node --check client.js
# 隔离浏览器验证 54 套悬停动作，不读写用户存档；依赖目录需含 React、ReactDOM、Playwright：
node tools/verify-hover-motion.mjs --deps <node_modules路径>
python3 assets/tools/optimize_sprites.py --verify   # 135 PNG + manifest 校验
# 当前素材已逐张重绘，请勿运行旧切图/导出模式覆盖高清 PNG。
# v1 切格脚本（历史）：python3 assets/tools/slice.py --verify
# 动作动效证据（先起临时实例，把打印的 URL 传进来）：
# node tools/action-fx/capture.mjs "http://127.0.0.1:<port>/?token=..." --out .tmp/action-fx
# python3 tools/action-fx/compose.py --src .tmp/action-fx --docs docs
```

> Node v22 的 `node --test <目录>` 不再递归目录，脚本统一用 `"tests/core/*.test.js"`（`tests/core/index.js` 提供目录兼容 shim）。

## 内核设计（摘要）

- **时间**：年龄按真实经过秒数；`lifeEndsAt` 在领养时用 profile 时区按自然月计算并固定（月末 clamp）。结算按「睡眠边界 / 动作完成 / 阶段切换 / 排泄到点 / 托管起点」分段，不逐秒重放；`settle()` 是唯一时间推进入口，纯函数、时间回拨不变更状态。
- **四状态**：饱食、心情、体力、清洁 ∈ [0,100]。清醒与睡眠速率不同；低状态只影响表现与诉求，不触发疾病或提前死亡。
- **动作合同**：同一时刻只允许一个动作；开始预留物品与体力，完成时扣除并应用效果（按剩余空间截断），崩溃重启按原结束时间补结算。
- **经济**：每 1,000,000 个已确认 Token = 1 金币（2026-10-29 调整，原 1,000），单日封顶 100；按响应级唯一键去重；不足一金币所需 Token 不结转。Token 用量来自 DSH 的 `session/event`（`assistant/message` 的 usage，流式回退最后一个 chunk），不重复计算缓存/推理细分。
  已在 desktop profile 实测跑通：真实会话事件按 `sessionId:seq` 去重记账，当日累计到 100 金币封顶后不再增加。
- **诉求**：规则引擎按优先级产出主诉求（休息 → 饮水 → 清理 → 清洁 → 饥饿 → 出门 → 梳理），不读取聊天内容；其中「想梳理」因 UI 已移除该按钮而不再展示。
- **离线**：≤24h 按正常速率补算但下限 30/40/30/40；>24h 转免费托管（≥60、不产便便、不催护理）；托管期间寿命继续推进。

## 与设计稿的偏差

实现与 V1.0 设计稿存在 10 处已确认的工程偏差（离线标志由 Host 传入、排泄按本地日门槛、零食不可拆、睡眠中可开始动作、用户托管会取消在途动作等），完整清单见 `docs/implementation-report.md`「与设计文档的偏差」。

## 范围

九款物种全部开放领养：鲸鱼泡泡、猴子桃桃、鸭子嘎嘎、小鸡啾啾、猫糯糯、狗狗豆豆、牛牛奶糖、山羊咩咩，以及新增的**恐龙迪诺（Dinosaur）**。九个物种共用同一套数值与成长机制，形象、悬停动作路径、动作姿态、文案与食品外观各有区别。

不包含：繁殖、交易、战斗、排行榜、付费复活、多人共养、宠物自主调用模型、后台读取聊天正文。桌面宠物当前以 Web 界面内的悬浮层实现（`shell.overlay`），尚未接入原生桌面透明窗口。
