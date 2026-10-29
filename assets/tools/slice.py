#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把 pet-family-v2 的 4x4 透明素材整图切成插件可用的静态精灵图。

源素材：每物种一张 1254x1254 RGBA sheet，4 列 x 4 行（最后两格空白），
行序：婴儿/幼儿/少儿/青年 | 壮年/老年/宠物+便便/十字架坟墓 |
      铲屎/洗澡/修剪梳理/喂食 | 喂水/逛街/(空)/(空)

本脚本不做「固定四等分」硬切，而是：
  1. alpha >= 16 的像素做连通域标注；
  2. 面积最大的 14 个连通域 = 14 个形象（其余为配件/便便/气泡等碎片）；
  3. 按行、列聚类排序得出 14 个格子，避免个别物种整图网格偏移（如 cow）时切错；
  4. 配件（scooper/泡泡/星星/便便…）按 bbox 距离归属到最近的主形象；
  5. 第 7 格（宠物+便便）单独拆开：主连通域=宠物 -> adult-with-poop.png（仅核对），
     配件的并集=便便 -> poop.png；
  6. 每张图按 alpha bbox 裁紧 + 四周 2px，等比缩放到高 96px（NEAREST，不模糊）；
  7. 输出 sprites/<species>/<slot>.png、manifest.json、preview-sheet.png 并自检。

用法：
    python3 tools/slice.py                    # 默认源目录（见 DEFAULT_SRC）
    python3 tools/slice.py --src /path/to/pet-family-v2
    PET_SRC=/path/to/pet-family-v2 python3 tools/slice.py

依赖：python3 + Pillow + numpy（本机已安装 11.x / numpy）。
不联网、不装包、不使用 node。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

# ---------------------------------------------------------------- constants

# 源素材默认位置（可用 --src / PET_SRC 覆盖）
DEFAULT_SRC = str(Path.home() / "Documents/Program/whalecloud/output/imagegen/pet-family-v2")

SPECIES = [
    {"id": "whale", "nameZh": "泡泡", "nameEn": "Bubbles"},
    {"id": "monkey", "nameZh": "桃桃", "nameEn": "Peaches"},
    {"id": "duck", "nameZh": "嘎嘎", "nameEn": "Waddles"},
    {"id": "chick", "nameZh": "啾啾", "nameEn": "Chirpy"},
    {"id": "cat", "nameZh": "糯糯", "nameEn": "Mochi"},
    {"id": "dog", "nameZh": "豆豆", "nameEn": "Biscuit"},
    {"id": "cow", "nameZh": "奶糖", "nameEn": "Toffee"},
    {"id": "goat", "nameZh": "咩咩", "nameEn": "Clover"},
]

# 14 个格子，按行优先顺序（与素材 README 一致）
SLOTS = [
    "baby",
    "toddler",
    "child",
    "teen",
    "adult",
    "elder",
    "poop",
    "grave",
    "cleanWaste",
    "bathe",
    "groom",
    "feed",
    "water",
    "walk",
]

SLOT_META = {
    "baby": {"nameZh": "婴儿", "nameEn": "Baby", "category": "stage"},
    "toddler": {"nameZh": "幼儿", "nameEn": "Toddler", "category": "stage"},
    "child": {"nameZh": "少儿", "nameEn": "Child", "category": "stage"},
    "teen": {"nameZh": "青年", "nameEn": "Teen", "category": "stage"},
    "adult": {"nameZh": "壮年", "nameEn": "Adult", "category": "stage"},
    "elder": {"nameZh": "老年", "nameEn": "Elder", "category": "stage"},
    "poop": {"nameZh": "便便", "nameEn": "Poop", "category": "need"},
    "grave": {"nameZh": "坟墓", "nameEn": "Grave", "category": "status"},
    "cleanWaste": {"nameZh": "铲屎", "nameEn": "Clean waste", "category": "care"},
    "bathe": {"nameZh": "洗澡", "nameEn": "Bathe", "category": "care"},
    "groom": {"nameZh": "梳理", "nameEn": "Groom", "category": "care"},
    "feed": {"nameZh": "喂食", "nameEn": "Feed", "category": "care"},
    "water": {"nameZh": "喂水", "nameEn": "Water", "category": "care"},
    "walk": {"nameZh": "逛街", "nameEn": "Walk", "category": "fun"},
}

# 素材图 4x4 网格（1254 / 4 = 313.5，素材本身并非严格等分，实际切图按连通域）
GRID_COLS = 4
GRID_ROWS = 4
CELL_SIZE = 313.5

ALPHA_THRESHOLD = 16  # 低于此 alpha 视为不可见噪点/描边拖尾
MIN_PART_AREA = 8  # 像素数少于此的连通域直接丢弃（1~3px 噪点）
MAIN_COUNT = 14  # 每个物种 14 个形象
PAD = 2  # 裁切后四周留白（源图像素）
TARGET_H = 96  # 输出高度（宽按比例取整）
POOP_SLOT = "poop"
POOP_SLOT_INDEX = SLOTS.index(POOP_SLOT)  # 6 => 第 2 行第 3 格
POOP_SLOT_ROWCOL = (POOP_SLOT_INDEX // GRID_COLS, POOP_SLOT_INDEX % GRID_COLS)

ASSETS_DIR = Path(__file__).resolve().parent.parent  # .../plugins/dsh-pet/assets


# ---------------------------------------------------------------- utilities


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def find_font(size: int, cjk: bool = True) -> ImageFont.FreeTypeFont:
    """尽量找一个可用字体（用于 preview-sheet；缺失时退回 Pillow 内置位图字体）。"""
    candidates = []
    if cjk:
        candidates += [
            "/System/Library/Fonts/Hiragino Sans GB.ttc",
            "/System/Library/Fonts/STHeiti Light.ttc",
            "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
            "/System/Library/Fonts/PingFang.ttc",
        ]
    candidates += [
        "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/System/Library/Fonts/HelveticaNeue.ttc",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ]
    for path in candidates:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except OSError:
                continue
    try:
        return ImageFont.load_default(size=size)
    except TypeError:  # Pillow < 10.1
        return ImageFont.load_default()


# ---------------------------------------------------------------- detection


def label_components(alpha: np.ndarray, threshold: int):
    """alpha>=threshold 的 8 邻接连通域（按行 run 合并实现，等价 4 邻接）。

    返回 (labelmap, comps)：
      labelmap : int32[h, w]，0=背景，1..N=连通域 id
      comps    : {id: {"bbox": (x0, y0, x1, y1) 含端点, "area": 像素数}}
    """
    h, w = alpha.shape
    mask = alpha >= threshold

    parent: list[int] = []
    runs_by_row: list[list[tuple[int, int, int]]] = []
    nid = 0
    for y in range(h):
        xs = np.flatnonzero(mask[y])
        runs: list[tuple[int, int, int]] = []
        if xs.size:
            brk = np.flatnonzero(np.diff(xs) > 1)
            starts = np.concatenate((np.array([0], dtype=np.int64), brk + 1))
            ends = np.concatenate((brk, np.array([xs.size - 1], dtype=np.int64)))
            for s, e in zip(starts.tolist(), ends.tolist()):
                x0, x1 = int(xs[s]), int(xs[e])
                parent.append(nid)
                runs.append((x0, x1, nid))
                nid += 1
        runs_by_row.append(runs)

    def find(i: int) -> int:
        root = i
        while parent[root] != root:
            root = parent[root]
        while parent[i] != root:
            parent[i], i = root, parent[i]
        return root

    def union(a: int, b: int) -> None:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[rb] = ra

    for y in range(1, h):
        prev = runs_by_row[y - 1]
        cur = runs_by_row[y]
        i = j = 0
        while i < len(prev) and j < len(cur):
            p, c = prev[i], cur[j]
            if p[1] >= c[0] and c[1] >= p[0]:
                union(p[2], c[2])
                if p[1] < c[1]:
                    i += 1
                else:
                    j += 1
            elif p[1] < c[0]:
                i += 1
            else:
                j += 1

    # 归一化 id 并累计 bbox / area
    root_to_id: dict[int, int] = {}
    comps: dict[int, dict] = {}
    for y, runs in enumerate(runs_by_row):
        for x0, x1, n in runs:
            root = find(n)
            cid = root_to_id.get(root)
            if cid is None:
                cid = len(root_to_id) + 1
                root_to_id[root] = cid
                comps[cid] = {"bbox": [x0, y, x1, y], "area": 0}
            c = comps[cid]
            b = c["bbox"]
            b[0] = min(b[0], x0)
            b[1] = min(b[1], y)
            b[2] = max(b[2], x1)
            b[3] = max(b[3], y)
            c["area"] += x1 - x0 + 1

    labelmap = np.zeros((h, w), dtype=np.int32)
    for y, runs in enumerate(runs_by_row):
        for x0, x1, n in runs:
            labelmap[y, x0 : x1 + 1] = root_to_id[find(n)]

    return labelmap, comps


def bbox_gap(a, b) -> float:
    """两个 bbox（x0,y0,x1,y1 含端点）之间的最小 gap 距离（重叠=0）。"""
    dx = max(0, a[0] - b[2] - 1, b[0] - a[2] - 1)
    dy = max(0, a[1] - b[3] - 1, b[1] - a[3] - 1)
    return math.hypot(dx, dy)


def union_bbox(bboxes):
    xs0 = min(b[0] for b in bboxes)
    ys0 = min(b[1] for b in bboxes)
    xs1 = max(b[2] for b in bboxes)
    ys1 = max(b[3] for b in bboxes)
    return [xs0, ys0, xs1, ys1]


# ---------------------------------------------------------------- slicing


def analyze_sheet(alpha: np.ndarray):
    """检测一张 sheet 的 14 个主形象 + 碎片配件，返回结构化结果。"""
    labelmap, comps = label_components(alpha, ALPHA_THRESHOLD)
    parts = [(cid, c) for cid, c in comps.items() if c["area"] >= MIN_PART_AREA]
    if len(parts) < MAIN_COUNT:
        raise RuntimeError(
            f"连通域不足：{len(parts)} 个 >= {MIN_PART_AREA}px（期望至少 {MAIN_COUNT} 个主形象）"
        )

    parts.sort(key=lambda kv: -kv[1]["area"])
    mains = parts[:MAIN_COUNT]
    accessories = parts[MAIN_COUNT:]
    if accessories and mains[-1][1]["area"] < 2.0 * accessories[0][1]["area"]:
        raise RuntimeError(
            "主形象/配件面积区分度不足：主最小 %d px, 配件最大 %d px"
            % (mains[-1][1]["area"], accessories[0][1]["area"])
        )

    # 按 y 聚类成 4 行（取 3 个最大行间隙）
    def cy(item):
        b = item[1]["bbox"]
        return (b[1] + b[3]) / 2.0

    def cx(item):
        b = item[1]["bbox"]
        return (b[0] + b[2]) / 2.0

    ordered = sorted(mains, key=cy)
    gaps = [(cy(ordered[i + 1]) - cy(ordered[i]), i) for i in range(len(ordered) - 1)]
    split_at = sorted(i for _, i in sorted(gaps)[-3:])
    groups, start = [], 0
    for idx in split_at + [len(ordered) - 1]:
        groups.append(ordered[start : idx + 1])
        start = idx + 1
    row_sizes = [len(g) for g in groups]
    expected = [GRID_COLS] * (GRID_ROWS - 1) + [MAIN_COUNT - GRID_COLS * (GRID_ROWS - 1)]
    if row_sizes != expected:
        raise RuntimeError(f"行聚类异常：{row_sizes}，期望 {expected}")

    cells = []  # 14 个格子，行优先
    for row in groups:
        row = sorted(row, key=cx)
        cells.extend(row)

    # 配件归属：bbox gap 最近的格子
    assign: dict[int, list[int]] = {cid: [] for cid, _ in cells}
    max_gap = 0.0
    accessory_report = []
    for cid, comp in accessories:
        best = min(
            cells,
            key=lambda kv: bbox_gap(comp["bbox"], kv[1]["bbox"]),
        )
        gap = bbox_gap(comp["bbox"], best[1]["bbox"])
        max_gap = max(max_gap, gap)
        assign[best[0]].append(cid)
        accessory_report.append(
            {"id": cid, "bbox": tuple(comp["bbox"]), "area": comp["area"],
             "to": best[0], "gap": round(gap, 1)}
        )

    return {
        "labelmap": labelmap,
        "comps": comps,
        "cells": [cid for cid, _ in cells],
        "mains": {cid: comp for cid, comp in cells},
        "accessories": assign,
        "max_accessory_gap": max_gap,
        "accessory_report": accessory_report,
        "row_sizes": row_sizes,
    }


def sprite_ids_for_slot(analysis, slot_index: int):
    """返回 (要渲染的连通域 id 列表, 备注, 是否拆分格)。"""
    cid = analysis["cells"][slot_index]
    main_comp = analysis["mains"][cid]
    acc = analysis["accessories"][cid]
    if slot_index == POOP_SLOT_INDEX:
        if not acc:
            raise RuntimeError("第 7 格（宠物+便便）未检测到便便配件，拆分失败")
        # 主连通域=宠物，配件=便便（含臭味线）
        poop_bbox = union_bbox([analysis["comps"][a]["bbox"] for a in acc])
        pet_bbox = main_comp["bbox"]
        note = (
            "拆分：宠物 bbox=%s，便便 bbox=%s（%d 个连通域），"
            "便便尺寸 %dx%d"
            % (
                tuple(pet_bbox),
                tuple(poop_bbox),
                len(acc),
                poop_bbox[2] - poop_bbox[0] + 1,
                poop_bbox[3] - poop_bbox[1] + 1,
            )
        )
        return acc, note, True
    note = ""
    if acc:
        note = "合并 %d 个配件连通域" % len(acc)
    return [cid] + acc, note, False


def crop_and_scale(src_img: Image.Image, labelmap, ids, bbox):
    """按 bbox 裁紧 + 四周 PAD，再用 NEAREST 等比缩放到高 TARGET_H。"""
    x0, y0, x1, y1 = bbox
    left = max(0, x0 - PAD)
    top = max(0, y0 - PAD)
    right = min(src_img.width, x1 + 1 + PAD)
    bottom = min(src_img.height, y1 + 1 + PAD)
    cw, ch = right - left, bottom - top

    arr = np.array(src_img.crop((left, top, right, bottom)), dtype=np.uint8)
    # 只保留本形象（含归属配件）的像素，防止相邻格子/便便串入裁切框
    labels = labelmap[top:bottom, left:right]
    keep = np.isin(labels, np.fromiter(ids, dtype=np.int32))
    arr[:, :, 3] = np.where(keep, arr[:, :, 3], 0)

    out_w = max(1, int(round(cw * TARGET_H / ch)))
    img = Image.fromarray(arr)  # (h, w, 4) uint8 -> RGBA
    img = img.resize((out_w, TARGET_H), Image.NEAREST)
    return img, {"x": int(left), "y": int(top), "w": int(cw), "h": int(ch)}


def validate_sprite_file(path: Path, expect_w: int | None = None):
    if not path.exists():
        raise RuntimeError(f"缺少文件：{path}")
    if path.stat().st_size <= 0:
        raise RuntimeError(f"空文件：{path}")
    with Image.open(path) as im:
        if im.mode != "RGBA":
            raise RuntimeError(f"{path.name} mode={im.mode}，期望 RGBA")
        if im.height != TARGET_H:
            raise RuntimeError(f"{path.name} height={im.height}，期望 {TARGET_H}")
        if expect_w is not None and im.width != expect_w:
            raise RuntimeError(f"{path.name} width={im.width}，manifest 记录 {expect_w}")
        a = np.array(im.getchannel("A"))
        visible = int((a >= ALPHA_THRESHOLD).sum())
        if visible == 0:
            raise RuntimeError(f"{path.name} 全透明")
        if im.getchannel("A").getbbox() is None:
            raise RuntimeError(f"{path.name} bbox 为空")
    return {"width": im.width, "height": im.height, "visible_px": visible,
            "bytes": path.stat().st_size}


# ---------------------------------------------------------------- preview


def make_preview(sprites_by_species, out_path: Path):
    """物种(行) x 14 slot(列) 拼版；每格高 96px，灰底+格线，顶部 slot 名，左侧物种。"""
    slot_count = len(SLOTS)
    max_w = max(
        rec["img"].width
        for recs in sprites_by_species.values()
        for rec in recs.values()
    )
    cell_w = max(TARGET_H, max_w)
    cell_h = TARGET_H
    pad = 12
    header_h = 122
    left_w = 176

    sheet_w = pad + left_w + slot_count * cell_w + pad
    sheet_h = pad + header_h + len(species_by_id()) * cell_h + pad
    sheet = Image.new("RGBA", (sheet_w, sheet_h), (214, 214, 214, 255))
    draw = ImageDraw.Draw(sheet)

    f_slot = find_font(14)
    f_species_zh = find_font(17)
    f_species_en = find_font(12)
    f_small = find_font(11)

    def checker(cw, ch, size=8):
        img = Image.new("RGBA", (cw, ch), (255, 255, 255, 255))
        px = img.load()
        for y in range(ch):
            for x in range(cw):
                if ((x // size) + (y // size)) % 2:
                    px[x, y] = (240, 240, 240, 255)
        return img

    x_grid0 = pad + left_w
    y_grid0 = pad + header_h

    # 顶部 slot 名（竖排，自下而上）
    for j, slot in enumerate(SLOTS):
        cx = x_grid0 + j * cell_w + cell_w // 2
        txt = "%02d %s" % (j + 1, slot)
        bbox = draw.textbbox((0, 0), txt, font=f_slot)
        tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
        layer = Image.new("RGBA", (tw + 4, th + 8), (0, 0, 0, 0))
        ImageDraw.Draw(layer).text((2, 2), txt, font=f_slot, fill=(40, 40, 40, 255))
        rot = layer.rotate(90, expand=True)
        sheet.alpha_composite(rot, (cx - rot.width // 2, pad + header_h - 8 - rot.height))

    # 左上角说明
    draw.text((pad + 8, pad + 6), "species \\ slot", font=f_small, fill=(60, 60, 60, 255))

    # 每行物种
    for i, sp in enumerate(SPECIES):
        row_y = y_grid0 + i * cell_h
        recs = sprites_by_species[sp["id"]]
        # 左侧物种标签
        draw.text((pad + 10, row_y + 28), sp["nameZh"], font=f_species_zh,
                  fill=(30, 30, 30, 255))
        draw.text((pad + 10, row_y + 56), "%s  %s" % (sp["nameEn"], sp["id"]),
                  font=f_species_en, fill=(70, 70, 70, 255))
        # 14 个格子
        for j, slot in enumerate(SLOTS):
            cell_x = x_grid0 + j * cell_w
            img = recs[slot]["img"]
            bg = checker(cell_w, cell_h)
            dx = (cell_w - img.width) // 2
            bg.alpha_composite(img, (dx, 0))
            sheet.paste(bg, (cell_x, row_y), bg)
            # 灰底格线
            draw.rectangle([cell_x, row_y, cell_x + cell_w - 1, row_y + cell_h - 1],
                           outline=(150, 150, 150, 255))

    # 外框
    draw.rectangle([pad, pad, sheet_w - pad - 1, sheet_h - pad - 1],
                   outline=(110, 110, 110, 255), width=2)
    sheet.convert("RGB").save(out_path, format="PNG", optimize=True)
    return out_path, (sheet_w, sheet_h)


def species_by_id():
    return {s["id"]: s for s in SPECIES}



# ---------------------------------------------------------------- verify


def verify_assets(assets_dir: Path) -> int:
    """独立校验已落盘产物：不重新切图，只读 manifest + 磁盘文件做一致性检查。"""
    assets_dir = Path(assets_dir)
    manifest_path = assets_dir / "manifest.json"
    problems: list[str] = []
    if not manifest_path.exists():
        print(f"[FATAL] 缺少 manifest：{manifest_path}", file=sys.stderr)
        return 2
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))

    sha_map = {it["file"]: it["sha256"] for it in manifest.get("sourceImages", [])}
    src_dir = Path(DEFAULT_SRC)
    if src_dir.is_dir():
        for name, want in sha_map.items():
            src = src_dir / name
            if not src.exists():
                problems.append(f"源图缺失：{src}")
            elif sha256_file(src) != want:
                problems.append(f"源图 sha256 不匹配：{name}")
    else:
        print(f"[WARN] 源目录不存在，跳过源图 sha256 比对：{src_dir}")

    total_files = total_bytes = 0
    widths_by_species: dict[str, list[int]] = {}
    sizes_kb: dict[str, float] = {}
    for rec in manifest["species"]:
        sid = rec["id"]
        widths: list[int] = []
        for slot in SLOTS:
            entry = rec["sprites"].get(slot)
            if entry is None:
                problems.append(f"{sid}/{slot}: manifest 缺少条目")
                continue
            path = assets_dir / entry["file"]
            if not path.exists():
                problems.append(f"{sid}/{slot}: 文件不存在 {path}")
                continue
            if path.stat().st_size == 0:
                problems.append(f"{sid}/{slot}: 空文件")
                continue
            total_files += 1
            total_bytes += path.stat().st_size
            with Image.open(path) as im:
                if im.mode != "RGBA":
                    problems.append(f"{sid}/{slot}: 不是 RGBA（{im.mode}）")
                w, h = im.size
                a = np.array(im.getchannel("A"))
            visible = int((a >= ALPHA_THRESHOLD).sum())
            if visible == 0:
                problems.append(f"{sid}/{slot}: 全透明")
            if h != TARGET_H:
                problems.append(f"{sid}/{slot}: 高度 {h} != {TARGET_H}")
            if w != entry["width"] or h != entry["height"]:
                problems.append(f"{sid}/{slot}: 尺寸 {w}x{h} 与 manifest {entry['width']}x{entry['height']} 不符")
            crop = entry["crop"]
            expect_w = max(1, int(round(crop["w"] * TARGET_H / crop["h"])))
            if abs(w - expect_w) > 1:
                problems.append(f"{sid}/{slot}: 宽度 {w} 与 crop 推导值 {expect_w} 不符")
            bbox = Image.open(path).getbbox()
            if bbox is None:
                problems.append(f"{sid}/{slot}: alpha bbox 为空")
            widths.append(w)
        extras = rec.get("extras", {}).get("adultWithPoop")
        if extras:
            epath = assets_dir / extras["file"]
            if not epath.exists() or epath.stat().st_size == 0:
                problems.append(f"{sid}/adult-with-poop: 缺失或空文件")
            else:
                total_files += 1
                total_bytes += epath.stat().st_size
        widths_by_species[sid] = widths
        sizes_kb[sid] = sum(
            (assets_dir / rec["sprites"][s]["file"]).stat().st_size for s in SLOTS
        ) / 1024.0

    print("\n==== 校验：物种 x slot 宽度（高度均为 96）====")
    print("species".ljust(9) + "".join(s.ljust(13) for s in SLOTS))
    for sid, widths in widths_by_species.items():
        print(sid.ljust(9) + "".join(f"{w}".ljust(13) for w in widths))
    print("\n==== 校验：每物种 14 张合计体积（KB）====")
    for sid, kb in sizes_kb.items():
        print(f"  {sid:<8s} {kb:6.1f} KB")
    print(f"\nPNG 总数 {total_files}，合计 {total_bytes/1024:.1f} KB，"
          f"manifest {manifest_path.stat().st_size/1024:.1f} KB，"
          f"preview {(assets_dir/'preview-sheet.png').stat().st_size/1024:.1f} KB")
    if problems:
        print(f"\n[FAIL] {len(problems)} 个问题：", file=sys.stderr)
        for item in problems:
            print("  -", item, file=sys.stderr)
        return 1
    print("\n[OK] 校验通过：8 物种 x 14 slot 全部存在、RGBA、高度 96、bbox 非空、尺寸与 manifest 一致。")
    return 0


# ---------------------------------------------------------------- main


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="切宠物静态素材为插件精灵图（96px 高）")
    ap.add_argument("--src", default=os.environ.get("PET_SRC", DEFAULT_SRC),
                    help="素材目录（含 <species>.png），默认 %s" % DEFAULT_SRC)
    ap.add_argument("--out", default=str(ASSETS_DIR / "sprites"),
                    help="精灵图输出目录（默认 assets/sprites）")
    ap.add_argument("--manifest", default=str(ASSETS_DIR / "manifest.json"))
    ap.add_argument("--preview", default=str(ASSETS_DIR / "preview-sheet.png"))
    ap.add_argument("--quiet", action="store_true", help="只打印最终汇总")
    ap.add_argument("--verify", action="store_true",
                    help="只校验已生成的产物（读 manifest + 磁盘文件），不重新切图")
    args = ap.parse_args(argv)

    if args.verify:
        return verify_assets(ASSETS_DIR)

    src_dir = Path(args.src)
    out_root = Path(args.out)
    if not src_dir.is_dir():
        print(f"[FATAL] 素材目录不存在：{src_dir}\n可用 --src 或环境变量 PET_SRC 指定", file=sys.stderr)
        return 2

    warnings: list[str] = []
    species_records = []
    sprites_by_species: dict[str, dict] = {}
    total_png = 0
    total_bytes = 0
    report_lines: list[str] = []

    for sp in SPECIES:
        sid = sp["id"]
        src_path = src_dir / f"{sid}.png"
        if not src_path.exists():
            print(f"[FATAL] 缺少素材：{src_path}", file=sys.stderr)
            return 2
        src_img = Image.open(src_path).convert("RGBA")
        alpha = np.array(src_img.getchannel("A"))
        analysis = analyze_sheet(alpha)
        sha = sha256_file(src_path)

        sprites: dict[str, dict] = {}
        recs_for_preview: dict[str, dict] = {}
        notes: list[str] = []
        for idx, slot in enumerate(SLOTS):
            ids, note, _is_split = sprite_ids_for_slot(analysis, idx)
            bbox = union_bbox([analysis["comps"][i]["bbox"] for i in ids])
            img, crop = crop_and_scale(src_img, analysis["labelmap"], ids, bbox)
            rel = f"sprites/{sid}/{slot}.png"
            path = out_root / sid / f"{slot}.png"
            path.parent.mkdir(parents=True, exist_ok=True)
            img.save(path, format="PNG", optimize=True)
            info = validate_sprite_file(path, img.width)
            total_png += 1
            total_bytes += info["bytes"]
            sprites[slot] = {
                "file": rel,
                "width": img.width,
                "height": img.height,
                "crop": crop,
                "sourceFile": f"{sid}.png",
            }
            recs_for_preview[slot] = {"img": img, "info": info}
            if note:
                notes.append(f"{slot}: {note}")

        # 「宠物+便便」拆出的宠物本体，仅供核对（非实际 slot）
        poop_main_id = analysis["cells"][POOP_SLOT_INDEX]
        pet_bbox = analysis["comps"][poop_main_id]["bbox"]
        pet_img, pet_crop = crop_and_scale(
            src_img, analysis["labelmap"], [poop_main_id], pet_bbox
        )
        pet_path = out_root / sid / "adult-with-poop.png"
        pet_img.save(pet_path, format="PNG", optimize=True)
        pet_info = validate_sprite_file(pet_path, pet_img.width)
        total_json_extra = {
            "file": f"sprites/{sid}/adult-with-poop.png",
            "width": pet_img.width,
            "height": pet_img.height,
            "crop": pet_crop,
            "sourceFile": f"{sid}.png",
        }
        notes.append(
            "adult-with-poop.png: 宠物本体（与便便拆分核对用，非 slot）"
        )

        row_sizes = analysis["row_sizes"]
        notes.append(f"行聚类 {row_sizes}，配件最大间距 {analysis['max_accessory_gap']:.1f}px")
        # 主形象最小/最大尺寸提示
        sizes = [
            (analysis["comps"][c]["bbox"][2] - analysis["comps"][c]["bbox"][0] + 1,
             analysis["comps"][c]["bbox"][3] - analysis["comps"][c]["bbox"][1] + 1)
            for c in analysis["cells"]
        ]
        notes.append("主形象源尺寸 " + ", ".join(f"{w}x{h}" for w, h in sizes))
        if analysis["max_accessory_gap"] > 30:
            warnings.append(
                f"{sid}: 配件归属最大间距 {analysis['max_accessory_gap']:.1f}px 偏大，请目检"
            )

        species_records.append({
            "id": sid,
            "nameZh": sp["nameZh"],
            "nameEn": sp["nameEn"],
            "sourceFile": f"{sid}.png",
            "sourceSha256": sha,
            "sprites": sprites,
            "extras": {"adultWithPoop": total_json_extra},
            "notes": notes,
        })
        sprites_by_species[sid] = recs_for_preview

    # ---------------- manifest
    manifest = {
        "version": "1.0.0",
        "description": "dsh-pet 静态精灵图：8 物种 x 14 形象，源为 pet-family-v2 4x4 透明 sheet",
        "cellSize": CELL_SIZE,
        "grid": {
            "cols": GRID_COLS,
            "rows": GRID_ROWS,
            "imageSize": [1254, 1254],
            "slotOrder": SLOTS,
        },
        "slotMeta": SLOT_META,
        "pipeline": {
            "alphaThreshold": ALPHA_THRESHOLD,
            "minPartArea": MIN_PART_AREA,
            "padding": PAD,
            "targetHeight": TARGET_H,
            "resample": "NEAREST",
            "splitCell": {"slot": POOP_SLOT, "rowCol": list(POOP_SLOT_ROWCOL)},
        },
        "preview": "preview-sheet.png",
        "sourceImages": [
            {
                "file": rec["sourceFile"],
                "sha256": rec["sourceSha256"],
                "width": 1254,
                "height": 1254,
            }
            for rec in species_records
        ],
        "generatedBy": "plugins/dsh-pet/assets/tools/slice.py",
        "species": species_records,
    }
    manifest_path = Path(args.manifest)
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
        f.write("\n")
    manifest_bytes = manifest_path.stat().st_size

    # ---------------- preview
    preview_path, sheet_size = make_preview(sprites_by_species, Path(args.preview))

    # ---------------- 汇总
    print("\n================ 切图结果 ================")
    print(f"源目录     : {src_dir}")
    print(f"输出目录   : {out_root}")
    print(f"manifest   : {manifest_path} ({manifest_bytes/1024:.1f} KB)")
    print(f"preview    : {preview_path} ({sheet_size[0]}x{sheet_size[1]})")
    print(f"PNG 总数   : {total_png + len(SPECIES)} "
          f"（{len(SPECIES)}x{len(SLOTS)} slots + {len(SPECIES)} 张 adult-with-poop 核对图）")
    print(f"PNG 体积   : {total_bytes/1024:.1f} KB")
    if warnings:
        print("\n[WARN]")
        for w in warnings:
            print("  -", w)

    print("\n==== 物种 x slot 尺寸清单（WxH）====")
    print("species".ljust(9) + "".join(s.ljust(13) for s in SLOTS))
    for rec in species_records:
        sid = rec["id"]
        row = sid.ljust(9)
        for slot in SLOTS:
            sp = rec["sprites"][slot]
            row += f"{sp['width']}x{sp['height']}".ljust(13)
        print(row)

    print("\n==== 每物种备注 ====")
    for rec in species_records:
        print(f"[{rec['id']}] {rec['nameZh']} {rec['nameEn']}  sha256={rec['sourceSha256'][:16]}…")
        for note in rec["notes"]:
            print("   -", note)

    print("\n==== 逐文件大小（KB）====")
    for rec in species_records:
        sid = rec["id"]
        parts = []
        for slot in SLOTS:
            info = sprites_by_species[sid][slot]["info"]
            parts.append(f"{slot}={info['bytes']/1024:.1f}")
        print(f"[{sid}] " + " ".join(parts))

    print("\n[OK] 全部校验通过：8 物种 x 14 slot，高度 96px，非空、alpha bbox 非空。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
