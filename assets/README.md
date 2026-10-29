# v3 高清逐张重绘（2026-10-29）

当前 `sprites/` 内 9 种宠物共 135 张透明 PNG 均为 imagegen 独立重绘。每张宽和高精确为旧文件的 2 倍，路径和文件名未变。原始高清绘图保存在 `source/redraw-2x/<species>/<slot>.png`，尺寸和校验值见 manifest.json。

旧素材已备份到 `~/Documents/Program/whalecloud/output/imagegen/pet-redraw-2x-20261028/original-assets.zip`。可复现的拟合与验收脚本保存在 `~/Documents/Program/whalecloud/output/imagegen/pet-redraw-2x-20261028`。以下 v1/v2 历史说明和切图脚本仅供历史参考，不应重新覆盖当前 v3 素材。应用使用不可变图片缓存，完成替换后请重新加载插件以更新素材版本。

---

# dsh-digital-pet 静态素材（精灵图 + 清单）

由 `pet-family-v2` 的 9 张 1254×1254 透明整图（每张 4 列 × 4 行、14 个形象；恐龙来自 `assets/source/dinosaur-original.webp`）切出的插件静态素材。

- **9 物种 × 14 形象 = 126 张 slot 图**（另有 9 张 `adult-with-poop.png` 核对图，合计 135 张 PNG），全部透明背景 PNG-32，合计 7,055,598 B。
- **v2（当前产物，2026-10-28）**：按 manifest 的 crop 直接取源图**原始分辨率**（约 100×90 ~ 231×223），去除白色衬底晕圈后按 alpha bbox 裁紧 + 2px 透明边，不再缩小到 96px。客户端按**高度**等比平滑缩放显示（`image-rendering: auto`），在高分屏上也不糊、不留白边。见下方「v2 高清重导出」。
- `manifest.json`：机器可读清单 v2.0.0（尺寸 / scale / 裁切框 / 源文件 / sha256 / 字节数）。
- `preview-sheet.png`：8 行（物种）× 14 列（slot）人工核对拼版，棋盘格 = 透明（v1 时期生成，仅用于核对内容归属）。
- `tools/optimize_sprites.py`：**v2 重导出/校验脚本**（当前推荐）。
- `tools/slice.py`：v1 切图脚本（连通域切格 + 96px 输出，保留作历史与重新切格的参考）。

## v2 高清重导出（当前产物）

```bash
cd plugins/dsh-digital-pet/assets
python3 tools/prep_dinosaur.py               # 恐龙专用：从 assets/source/dinosaur-original.webp 切格 + 拆分宠物/便便
python3 tools/optimize_sprites.py            # 原生分辨率重导出全部 135 张
python3 tools/optimize_sprites.py --verify   # 只校验（尺寸/manifest 一致/无空图）
python3 tools/optimize_sprites.py --scale 2  # 需要整数倍大图时可加
```

处理步骤（针对「模糊 + 白色锯齿」问题）：
1. 按 `manifest.json` 里每个 slot 的 `crop` 取源图**原始像素**，不再 NEAREST 缩小到 96px（v1 缩小后再被浏览器放大 = 双重插值变糊）；
2. **去白色衬底（alpha decontamination）**：对 `0<a<1` 的像素反解 `C_true = (C_obs − 255×(1−a)) / a`，去掉 AI 出图残留的白色半透明晕圈；
3. **alpha 清理**：`a < 128` 的边缘视为衬底残留直接清零（A/B 实测 8/48/96 仍留一圈灰白光晕，128 干净；臭气线、泡泡、剪刀等细件不受影响）；
4. 按 alpha bbox 裁紧 + 四周 2px 透明边；
5. 覆盖 `sprites/<species>/<slot>.png` 并重写 `manifest.json`（记录 `width/height/crop/scale/bytes`）。

> 为什么不是越大越好：源图里每个形象本身只有约 100~230px 高，属于**原生低分辨率像素画**；把它插值放大到 288/512px 只是「更大的糊」，不会增加信息。正确做法是保留原生像素、由浏览器按显示尺寸一次性平滑缩放，并去掉边缘白晕。

## 单图规格 / client 接入注意（v2）

- 每张图为**原始分辨率**（高度约 90~230px 不等，随物种/姿态变化），四周 2px 透明留白；具体尺寸见 `manifest.json` 的 `width/height`。
- **client 必须按高度约束、宽度自适应**，不要写死宽高：
  ```css
  .pet-sprite { height: 72px; width: auto; image-rendering: auto; }
  img.pet-sprite { display: block; object-fit: contain; }  /* 容器固定大小时 */
  ```
- **不要再用 `image-rendering: pixelated`**：素材已是原生分辨率，pixelated 在非整数倍缩放（72/96/128 逻辑像素 × DPR 1/2）下会丢行/重行，反而出现锯齿；平滑缩放（`auto`）更干净。
- 如需 Retina 2x 整数倍显示，可用 `--scale 2` 生成 ×2 版本并自行切换 srcset（当前插件未使用）。

## 历史：v1 切图流程（保留说明）

> 这里是**静态单帧素材**，不含任何动画帧。呼吸、眨眼、位移等动效需要 client 侧用 CSS/JS 实现。


## species.enhance（单物种清晰度增强，v2 起支持）

manifest 的某个 species 条目可以带 `enhance`，`optimize_sprites.py` 会对该物种的每个 slot 额外处理：

```json
"enhance": { "unsharp": [1.4, 220], "contrast": 1.08, "saturate": 1.06, "hard_alpha": 200, "supersample": 2 }
```

- `unsharp`: `[radius, percent]`，`UnsharpMask(threshold=1)`。
- `contrast` / `saturate`: `ImageEnhance` 倍数。
- `hard_alpha`: alpha ≥ 该值置 255、其余置 0（去半透明灰边）；`0` 表示不处理。
- `supersample`: 输出前 LANCZOS 放大倍数，放大后再硬一次 alpha（≥96）。DPR2 屏幕上让浏览器做缩小采样，观感更锐利。

当前只有 **恐龙（dinosaur）** 启用（源图是低对比 AI 平滑插画，1× 在 DPR2 下被放大而显糊）：14 slot + 1 核对图均为 2×（baby 412×274、adult 502×520、poop 140×238 等），manifest 里 `scale: 2`。其余 8 物种仍为 1×，需要时在 `prep_dinosaur.py` 或 manifest 里加同样字段再跑 `python3 tools/optimize_sprites.py` 即可。

## 目录结构

```
plugins/dsh-digital-pet/assets/
├── README.md
├── manifest.json
├── preview-sheet.png
├── tools/
│   ├── optimize_sprites.py   # v2 高清重导出 + 校验（当前推荐）
│   └── slice.py              # v1 切图 + 校验脚本（历史）
└── sprites/
    ├── whale/                # 物种 id
    │   ├── baby.png          # slot id
    │   ├── toddler.png
    │   ├── child.png
    │   ├── teen.png
    │   ├── adult.png
    │   ├── elder.png
    │   ├── poop.png
    │   ├── grave.png
    │   ├── cleanWaste.png
    │   ├── bathe.png
    │   ├── groom.png
    │   ├── feed.png
    │   ├── water.png
    │   ├── walk.png
    │   └── adult-with-poop.png   # 核对用，非 slot
    ├── monkey/ … goat/           # 同上，共 8 个物种
```

## 命名规范

### 物种（`speciesId`）

| id | nameZh | nameEn | 备注 |
| --- | --- | --- | --- |
| whale | 泡泡 | Bubbles | 首发 |
| monkey | 桃桃 | Peaches | 首发 |
| duck | 嘎嘎 | Waddles | 首发 |
| chick | 啾啾 | Chirpy | 首发 |
| cat | 糯糯 | Mochi | 首发 |
| dog | 豆豆 | Biscuit | 首发 |
| cow | 奶糖 | Toffee | 开放领养 |
| goat | 咩咩 | Clover | 开放领养 |
| dinosaur | 迪诺 | Dinosaur | 开放领养（2026-10-28 新增） |

### 形象 slot（`slotId`，按源 sheet 行优先顺序）

| # | id | nameZh | nameEn | category | 源位置 |
| --- | --- | --- | --- | --- | --- |
| 1 | baby | 婴儿 | Baby | stage | 行1列1 |
| 2 | toddler | 幼儿 | Toddler | stage | 行1列2 |
| 3 | child | 少儿 | Child | stage | 行1列3 |
| 4 | teen | 青年 | Teen | stage | 行1列4 |
| 5 | adult | 壮年 | Adult | stage | 行2列1 |
| 6 | elder | 老年 | Elder | stage | 行2列2 |
| 7 | poop | 便便 | Poop | need | 行2列3（拆分，见下） |
| 8 | grave | 坟墓 | Grave | status | 行2列4 |
| 9 | cleanWaste | 铲屎 | Clean waste | care | 行3列1 |
| 10 | bathe | 洗澡 | Bathe | care | 行3列2 |
| 11 | groom | 梳理 | Groom | care | 行3列3 |
| 12 | feed | 喂食 | Feed | care | 行3列4 |
| 13 | water | 喂水 | Water | care | 行4列1 |
| 14 | walk | 逛街 | Walk | fun | 行4列2 |

## 切图规则（`tools/slice.py`）

整图网格**不是**精确四等分（各物种内容有偏移，cow 整组明显上移/压缩），所以不做固定格切，按内容聚类：

1. **连通域标注**：`alpha >= 16` 的像素做四连通标注（源图 alpha 有大量 1/2 级噪点，不能直接用 `getbbox()`；`>=16` 是稳定阈值）。
2. **主形象判定**：按像素面积降序，取前 14 个连通域 = 14 个形象；并断言「第 14 名 ≥ 2.0 × 第 15 名」（实测 3.1–6.3 倍）以防误判。
3. **行/列聚类**：14 个主形象的 bbox 中心按 y 聚类成 4 行（期望 4/4/4/2），行内按 x 排序得 4 列 → 得到 14 个格子的 (行, 列) 顺序。
4. **配件归属**：气泡、星星、铲子、购物袋、臭气线等小连通域，按 bbox 间距归到最近的**主形象**，与主形象合并进同一张图（保留原插画完整度）。最大间距出现在「宠物+便便」格的臭气线（whale 39 / chick 41 / cow 48 / goat 35px），已人工核对归属正确。
5. **第 7 格拆分（宠物 + 便便）**：该格主连通域 = 宠物本体；归到该格的配件（便便堆 + 臭气线）= 便便。输出 `poop.png`（含臭气线），并把宠物本体另存 `adult-with-poop.png` 供核对。拆出的 pet 图绝不包含便便像素——裁剪时用 labelmap 掩码把非同组连通域 alpha 清零，从根上避免串格。
6. ~~**裁切 + 缩放**：…缩放到高 96px~~ → **v2 已改为原生分辨率输出**，见「v2 高清重导出」；v1 的 NEAREST 缩放到 96px 是被浏览器二次放大后「模糊 + 白边」的主因。
7. **落盘**（v1）：PNG-32 + `manifest.json` + `preview-sheet.png` 自检（存在、非空、RGBA、高 96、…）。v2 由 `optimize_sprites.py` 重新生成并做同类自检（尺寸与 manifest 一致、非空、白晕统计）。

## 单图规格（v1，历史）

- 每张图 **高度固定 96px**，宽度按比例 70–157px（宽高比随形象姿态变化，例如躺姿的 baby 明显更宽）。
- **接入时必须按高度约束**：
  ```css
  .pet-sprite { height: 96px; width: auto; }      /* 推荐 */
  img.pet-sprite { display: block; object-fit: contain; }  /* 容器固定大小时 */
  ```
  **不要**写 `width: 96px; height: 96px`（会横向压扁宽形象）。若容器是 96×96 方框，请 `object-fit: contain` + `width/height:100%`。
- 图内四周 2px 透明留白；内容即 alpha bbox，所以不存在「四肢被裁」的问题。
- 若后续需要 Retina / 2x 或统一方形画布，可把 `TARGET_H` 调成 192 后 `--out` 到新目录再生成，不影响本目录约定。

## manifest.json

```
{
  "version": "1.0.0",
  "cellSize": 313.5,                 // 名义格宽（1254/4，仅参考，实际按连通域切）
  "grid": { "cols": 4, "rows": 4, "imageSize": [1254,1254], "slotOrder": [...] },
  "slotMeta": { "<slot>": { "nameZh", "nameEn", "category" } },
  "pipeline": { "alphaThreshold": 16, "padding": 2, "targetHeight": 96,
                "resample": "NEAREST", "splitCell": { "slot": "poop", "rowCol": [1,2] } },
  "preview": "preview-sheet.png",
  "sourceImages": [ { "file": "whale.png", "sha256": "...", "width": 1254, "height": 1254 }, ... ],
  "species": [
    {
      "id": "whale", "nameZh": "泡泡", "nameEn": "Bubbles",
      "sourceFile": "whale.png", "sourceSha256": "...",     // 每物种源图 sha256
      "sprites": {
        "baby": {
          "file": "sprites/whale/baby.png",
          "width": 112, "height": 96,
          "crop": { "x": 110, "y": 184, "w": 140, "h": 120 },  // 含 2px padding 的裁切框
          "sourceFile": "whale.png"
        },
        ...
      },
      "extras": { "adultWithPoop": { "file": "sprites/whale/adult-with-poop.png", ... } },
      "notes": [ ... ]                  // 该物种的切图备注（拆分/配件合并情况）
    }
  ]
}
```

- **sourceImage sha256**：8 张源图的 sha256 在顶层 `sourceImages[]` 与每物种 `sourceSha256` 中各存一份，可直接用于溯源/比对上游素材是否更新。
- `crop` 是「原图像素坐标」的裁切框（已含 2px padding）；`width/height` 是最终 PNG 尺寸。

## 如何再生成

```bash
cd plugins/dsh-digital-pet/assets
python3 tools/slice.py                  # 重新切图 + 写 manifest + preview + 自检（约数秒）
python3 tools/slice.py --verify         # 只校验磁盘上已有产物（不重新切图）
python3 tools/slice.py --src /path/to/pet-family-v2   # 指定素材目录
PET_SRC=/path/to/pet-family-v2 python3 tools/slice.py # 同上（环境变量）
```

- 依赖：python3（本机 3.9）、Pillow 11、numpy；不装包、不联网、不使用 node。
- 产物会**覆盖** `sprites/`、`manifest.json`、`preview-sheet.png`；`--verify` 失败时返回码非 0 并列出问题。
- 源素材更新后：重跑 `python3 tools/slice.py`，然后 `python3 tools/slice.py --verify`，再肉眼过一遍 `preview-sheet.png`。

## 人工核对

- `preview-sheet.png`：行 = 物种，列 = slot（顶部竖排标注 `01 baby` … `14 walk`），棋盘格底 = 透明，灰色格线。用于检查有没有串格、有没有把邻格内容切进来。
- 本次切图已逐张核对：8 物种 × 14 slot 全部内容正确，poop 列只有便便+臭气线、无宠物像素；`adult-with-poop.png` 只有宠物、无便便像素；cow 因源图整组偏移，行/列由聚类还原，结果正确。

## 注意事项

- **静态素材 ≠ 动画**：每个 slot 只有 1 帧，没有多帧序列、没有 spritesheet 动画帧。做动效时请在 client 侧叠加 CSS/JS（如轻微缩放呼吸、上下浮动、眨眼用遮罩/替换），不要假设这些 PNG 自带帧。
- 道具/点缀（泡泡、星星、铲子、便便、十字架、花、购物袋等）已按原插画就近合并进对应 slot 图，属于完整画面的一部分；如果 client 需要「纯宠物」图，请使用 `adult-with-poop.png` 的同类思路另切（需扩充脚本）。
- 源素材是 AI 生成的像素风（并非严格整数网格像素画）。v1 用 NEAREST 缩到 96px 再被浏览器放大，会出现模糊与白色锯齿；v2 保留原生分辨率 + 去白晕 + 平滑缩放后已消除，若回归 v1 素材会重新出现。
- 不要用 `image-rendering: pixelated` 渲染 v2 素材（非整数倍缩放下会丢行/重行，看起来反而更锯齿）。

## 睡觉精灵（sleep-<stage>.png）

- 9 物种 × 6 阶段 = 54 张 `sprites/<species>/sleep-<stage>.png`，供睡觉状态使用；客户端在 `mood === 'sleep'` 时优先加载，失败自动回退普通阶段图。
- 生成：`python3 tools/make_sleep_sprites.py`（约 8s；`--report` 只校验不写文件，`--only whale/elder` 单张重做）。脚本内置硬校验：只允许改眼睛区域、alpha 通道必须逐像素不变。
- 其中 18 张原图本来就是闭眼（多为 baby/部分 teen/elder），脚本按字节级复制；其余 36 张擦除瞳孔/眼白后补肤色并画下弯闭眼弧。
- 对照图：`docs/sleep-sprites-qa.png`（9 行 × 6 列，绿=复制原图、橙=合成闭眼并标注改动像素数）。
