# 共享到 GitHub：仓库描述与项目描述（可直接复制）

> 面向 DSH 插件仓库 `dsh-digital-pet`。以下文案按「仓库 About 短描述 → 项目描述（README 顶部）→ 英文版 → Topics → 发布清单」排列，可直接粘贴。

---

## 1. GitHub About（仓库简介，单行）

**中文（推荐，40 字内，GitHub 会截断超长部分）**

```text
DSH 电子宠物：用 DeepSeek Harness 的 Token 换金币，养一只陪你工作六个月的小宠物。
```

**中文（更短，适合窄布局）**

```text
住在 DeepSeek Harness 里的桌面宠物：Token 换金币，照顾它长大。
```

**English**

```text
A desktop pet living inside DeepSeek Harness: turn your token usage into coins, raise it for six months.
```

**Website / 主页字段（可选）**

```text
https://github.com/<your-name>/dsh-digital-pet#readme
```

---

## 2. 项目描述（README 顶部，中文完整版）

> 建议放在 README 最前面（现有 README 的标题与简介可以保留，把这段作为「一句话 + 亮点 + 截图墙」）。

```markdown
# dsh-digital-pet · DeepSeek Harness 电子宠物

[![tests](https://img.shields.io/badge/tests-148%20passing-brightgreen)]()
[![node](https://img.shields.io/badge/node-%E2%89%A522-blue)]()
[![license](https://img.shields.io/badge/license-MIT-lightgrey)]()

> 一只住在 DeepSeek Harness 里的桌面宠物：用你本来就在用的 Token 换金币，买食品、照顾它，
> 看它从婴儿长到老年，陪你走完 **六个月**。不额外烧 Token，也不会因为你忙而惩罚你。

## 它是什么

`dsh-digital-pet` 是一个 **DSH 宿主插件**（Host + 浏览器半），安装后：

- **设置 → 电子宠物**：领养一只宠物，看到饱食 / 心情 / 清洁三条状态、四项照顾动作、食品与背包、成长记录、纪念册；
- **桌面悬浮层**：宠物常驻在页面右下角（可拖动、可隐藏），轻点抚摸，悬停播放逐帧小动作，饿了渴了会冒气泡；
- **真实用量换金币**：每 1,000,000 个已确认 Token 换 1 金币（单日封顶 100），按响应级唯一键去重，不重复计算缓存/推理细分。

## 亮点

| | |
|---|---|
| **不惩罚忙碌** | 每天一顿主餐即可维持；离线 ≤24h 有下限保护、>24h 自动免费托管，不会因为漏养提前离开 |
| **Token → 金币** | 直接消费 DSH 的 `session/event` 用量事件；不发起模型请求，不读取聊天正文 |
| **九款物种** | 鲸鱼 / 猴子 / 鸭子 / 小鸡 / 猫 / 狗 / 牛 / 山羊 / 恐龙，共用同一套数值与六个月生命周期，形象与动作各自不同 |
| **会动的像素宠物** | 9 物种 × 6 年龄阶段 × 悬停逐帧动作（54 套图集 / 432 关键帧）+ 闭眼睡觉精灵 + 喂食/洗澡/逛街/铲屎动作表现 |
| **权威结算** | 所有数值由 Host 纯函数内核结算（睡眠边界 / 动作完成 / 阶段切换 / 离线分段），浏览器只渲染与发命令，崩溃重启按原结束时间补算 |
| **本地优先** | 每个 DSH profile 一只宠物，存档在该 profile 目录；无账号体系、无跨设备同步、无遥测 |
| **像素级打磨** | 深/浅色主题设计令牌、键盘可操作（方向键/Enter/数字键/Esc）、读屏标签、`prefers-reduced-motion`、DPR2 高清精灵（2× 超采样） |

## 截图

| 设置页 | 桌面悬浮层 |
|---|---|
| ![仪表盘](docs/v1-settings-dashboard.png) | ![操作盘](docs/v1-action-panel.png) |
| ![领养](docs/v1-adoption.png) | ![睡觉](docs/v1-sleep.png) |
| ![金币明细](docs/v1-coin-detail.png) | ![诉求与便便](docs/v1-need-and-waste.png) |

（完整 32 张截图 + 5 个动图见 `docs/`。）

## 快速开始

```bash
# 1) 把插件安装进某个 DSH profile（会自动写入 bundle patch）
dsh plugin --profile <profile> add /absolute/path/to/dsh-digital-pet

# 2) 启动
dsh --profile <profile> --port 0 --no-open
```

打开打印出的 URL → 设置 → 左侧「电子宠物」→ 领养。桌面上会出现悬浮宠物。

> 想先隔离试用：`dsh ui-test --from-default-profile web --dump-config` 会创建临时 `ui-test` profile（实例退出后会被清理）。

## 技术一览

```text
Host（index.js）          路由 / 按 profile 存档 / Token 记账 / 素材服务 / 状态机接线
  └─ src/core/            与 UI、IO 无关的确定性内核（时间、成长、动作、照护、经济、错误码）
Client（client.js）        __ModuleLoader__ 注册 settings.section + shell.overlay，纯渲染 + 命令
Assets（assets/）          9 物种 × (15 静态 + 6 睡觉) 精灵、54 套悬停图集、manifest、生成脚本
Tests（tests/）            148 例：内核 131 + Host 集成 8 + Token 记账 5
```

- 零运行时依赖（Node 内置 + 原生 Web），无构建步骤，`client.js` 为可直接加载的 ESM 包装；
- 内核是纯函数：`settle(state, nowMs, cfg)` 是唯一时间推进入口，时间回拨不变更状态；
- 支持 Node ≥22（`node --test` 用法见测试脚本）。

## 范围与边界

- 九款物种全部可领养；包含送养（两步确认）、纪念册、免费救济口粮、主动托管；
- **不做**：繁殖、交易、战斗、排行榜、付费复活、多人共养、宠物自主调用模型；
- 桌面宠物目前以 DSH Web 界面内的 `shell.overlay` 悬浮层实现，尚未接入原生桌面透明窗口。

## 开发

```bash
npm test                 # 148 tests / 148 pass
npm run test:core        # 131 例内核
node --check index.js && node --check client.js
node tools/simulate.mjs  # 181 天 × 9 策略时间模拟，生成平衡报告
```

设计与实现记录：`docs/implementation-report.md`（实施报告）、`docs/acceptance.md`（验收映射）、
`docs/balance-report.md`（数值平衡）、`docs/design-doc-revisions.md`（与设计稿的偏差与修订建议）。

## License

MIT
```

---

## 3. 项目描述（English / 国际版）

```markdown
# dsh-digital-pet · a desktop pet for DeepSeek Harness

A plugin that puts a small pixel pet inside DeepSeek Harness. Your own token usage becomes coins;
coins buy food; food keeps the pet happy while it grows from baby to elder over **six months**.
No extra model calls, no chat content is read, and being busy is never punished.

**Highlights**

- **Token → coins**: 1,000,000 confirmed tokens = 1 coin (daily cap 100), deduplicated per response.
- **9 species** (whale, monkey, duck, chick, cat, dog, cow, goat, dinosaur) sharing one 6-month lifecycle.
- **Living pixel art**: 9 species × 6 stages of hover frame animation (54 atlases / 432 keyframes), closed-eye sleep sprites, feeding/bathing/walking/cleaning poses.
- **Host-authoritative**: all numbers settle in a pure deterministic core; the browser only renders and sends commands.
- **Local-first**: one pet per DSH profile, stored under that profile directory. No account, no sync, no telemetry.
- **Accessible**: keyboard operable, ARIA labels, reduced-motion support, dark/light theme tokens, 2× supersampled sprites.

```bash
dsh plugin --profile <profile> add /absolute/path/to/dsh-digital-pet
dsh --profile <profile> --port 0 --no-open
```

Install → Settings → "Digital pet" → adopt. A floating pet appears on the page (draggable, hideable).

Tests: `npm test` (148 passing, Node ≥22). Docs and screenshots live in `docs/`.

MIT licensed.
```

---

## 4. GitHub Topics（仓库标签，建议按此勾选）

```text
deepseek-harness  dsh-plugin  desktop-pet  pixel-art  virtual-pet  tamagotchi
plugin  javascript  nodejs  gamification  productivity  local-first
```

---

## 5. 发布前清单（建议）

| 项 | 说明 |
|---|---|
| `LICENSE` | 已补 MIT（`package.json` 原本就声明 MIT）。若想换协议直接替换该文件 |
| `.gitignore` | 已补：`.DS_Store`、`.tmp/`、`node_modules/`、`assets/source/redraw-2x/`、`*.log` |
| 仓库体积 | 当前素材约 60 MB（`assets/source/redraw-2x` 131 MB 是中间稿，已忽略）。若希望更小，可把 `assets/hover-v1/atlases` 与 `assets/sprites` 走 Git LFS |
| 包名 | 保留 `@local/dsh-digital-pet` 可直接用路径/git 安装；若要发 npm，改成无 scope 的 `dsh-digital-pet` 并去掉 `private: true` |
| 演示素材 | 建议把 `docs/v1-action-feed.gif` 放在 README 靠前位置（GitHub 支持 GIF），比静态截图更能体现「它会动」 |
| 回归检查 | 推之前跑一遍 `npm test`、`node --check index.js client.js`、`python3 assets/tools/optimize_sprites.py --verify` |
| 隐私检查 | 确认没有把个人路径/存档带进仓库：`git grep -n "/Users/"` 应为 0 命中（`index.js` 的默认路径来自 `$DSH_HOME`，不含硬编码用户名） |
