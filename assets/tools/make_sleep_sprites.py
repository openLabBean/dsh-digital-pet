#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""为 dsh-digital-pet 生成「闭眼睡觉」精灵（9 物种 x 6 阶段 = 54 张）。

输入：assets/sprites/<species>/<stage>.png（已是裁紧+2px 透明边的成品，RGBA）
输出：
  assets/sprites/<species>/sleep-<stage>.png   与源图同尺寸、同 alpha 的闭眼版
  assets/docs/sleep-sprites-qa.png             9 行 x 6 列对照图（2x 显示尺寸）

做法（只改眼睛，其它像素一律不动）：
  1. 深色掩码 dark = (lum<70) & (alpha>=128)，lum=0.299R+0.587G+0.114B；
     用按行 run 合并的连通域标注（不依赖 scipy）。
  2. 已闭眼的图（baby 横线、部分 teen 笑弧、部分 elder 镜片内看不到瞳孔、
     恐龙 baby）直接**按字节复制**原图，不重画。
  3. 「黑点眼」睁眼：把瞳孔连通域 + 内部高光白洞 + 外围 3~4px AA 一起擦掉，
     用扩散修补（多迭代 4 邻平均，无条纹/无块状）补肤色，再在眼位画一条
     微微向下弯的粗弧线（颜色=该眼睛的瞳孔均值色，非纯黑）。
  4. 「镜片内有眼白+瞳孔」的 elder（whale/chick）：从镜片中心按连通域求出
     镜片内部（passable=近瞳孔色或亮且非镜框；用椭圆夹住防止沿 AA 缝漏出），
     擦掉内部、整片平涂肤色后画弧；镜框/镜腿/镜桥原样保留。
     cow/goat 的镜片内本来就接近肤色，改用实测椭圆整片平涂（mode="ellipse"）。
  5. 恐龙（侧脸单眼）：白眼球 + 黑眼环整体擦掉（径向扫描求环外边界），
     用周围绿色皮肤的二次曲面拟合补色后画黑弧；elder 有棕色单片镜，
     只擦镜片内、保留棕镜框与白云眉。
  6. 所有输出校验：尺寸一致、alpha 通道逐像素不变、改动只发生在擦除/画弧区域。

用法：
    python3 tools/make_sleep_sprites.py            # 全量生成 + 出 QA 图
    python3 tools/make_sleep_sprites.py --only whale/elder
    python3 tools/make_sleep_sprites.py --report   # 只打印分类，不写文件

依赖：python3 + Pillow + numpy（无 scipy / 无网络 / 不装包）。
"""

from __future__ import annotations

import argparse
import math
import os
import shutil
import sys
import time
from collections import deque

import numpy as np
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
ASSETS = os.path.dirname(HERE)
SPRITE_DIR = os.path.join(ASSETS, "sprites")
DOCS_DIR = os.path.join(ASSETS, "docs")
QA_PATH = os.path.join(DOCS_DIR, "sleep-sprites-qa.png")

SPECIES = ["whale", "monkey", "duck", "chick", "cat", "dog", "cow", "goat", "dinosaur"]
STAGES = ["baby", "toddler", "child", "teen", "adult", "elder"]
ZH = {
    "whale": "泡泡", "monkey": "桃桃", "duck": "嘎嘎", "chick": "啾啾",
    "cat": "糯糯", "dog": "豆豆", "cow": "奶糖", "goat": "咩咩", "dinosaur": "小恐龙",
}

ALPHA_THRESHOLD = 128          # 参与分析的不透明阈值
DARK_LUM = 70.0                # 「深色描边/瞳孔」亮度阈值
DARK_TH_MIN_AREA = 120         # 眼睛候选连通域最小面积

# ---------------------------------------------------------------------------
# 需要特殊处理的图：
#   glasses : 镜片内有「眼白+瞳孔」的 elder，需要按镜框求镜片内部再擦除
#              eyes   = [(cx, cy, rx, ry), ...] 镜片内部中心与半径（imagegen 实测）
#              pupil  = 瞳孔颜色（画弧用，也是「镜片内」颜色聚类参考）
#              guard  = 镜框颜色类型：brown=棕色镜框 / black=黑色镜框
#   dinosaur: 侧脸单眼，白眼球+黑眼环；elder 外面还有棕色单片镜
# ---------------------------------------------------------------------------
GLASSES = {
    "whale": {
        "eyes": [(87.5, 242.0, 23.0, 21.5), (201.5, 244.5, 24.0, 21.0)],
        "pupil": (6, 12, 35),
        "guard": "brown",
        "mode": "full",
    },
    "cow": {
        "eyes": [(156.5, 187.5, 21.0, 19.0), (256.0, 189.5, 24.0, 19.0)],
        "pupil": (36, 13, 10),
        "guard": "brown",
        "mode": "ellipse",
    },
    "goat": {
        "eyes": [(172.0, 199.5, 25.0, 21.0), (283.5, 201.0, 25.0, 21.5)],
        "pupil": (33, 14, 10),
        "guard": "brown",
        "mode": "ellipse",
    },
    "chick": {
        "eyes": [(130.0, 185.0, 22.5, 18.0), (233.5, 185.0, 22.5, 18.0)],
        "pupil": (37, 33, 47),
        "guard": "black",
        "mode": "full",
    },
}

DINO_ARC_COLOR = (8, 8, 8)
DINO_RING_PAD = {  # 眼球外的黑眼环（擦除半径在眼白半径上的附加量；elder 是棕色镜框）
    "baby": 0, "toddler": 14, "child": 14, "teen": 14, "adult": 14, "elder": 3,
}


# ---------------------------------------------------------------------------
# 基础工具
# ---------------------------------------------------------------------------
def load_rgba(path: str) -> np.ndarray:
    return np.asarray(Image.open(path).convert("RGBA"), dtype=np.uint8).copy()


def save_rgba(path: str, arr: np.ndarray) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    Image.fromarray(arr, mode="RGBA").save(path, optimize=True)


def luminance(rgb: np.ndarray) -> np.ndarray:
    return 0.299 * rgb[..., 0] + 0.587 * rgb[..., 1] + 0.114 * rgb[..., 2]


def dilate(mask: np.ndarray, radius: int = 1) -> np.ndarray:
    out = mask.copy()
    for _ in range(radius):
        cur = out
        grow = cur.copy()
        grow[1:, :] |= cur[:-1, :]
        grow[:-1, :] |= cur[1:, :]
        grow[:, 1:] |= cur[:, :-1]
        grow[:, :-1] |= cur[:, 1:]
        out = grow
    return out


def label_components(mask: np.ndarray):
    """8 邻接连通域（按行 run 合并 + 并查集，等价 4 邻接），不依赖 scipy。

    返回 (labels int32[h,w], comps {id: {"bbox": [x0,y0,x1,y1] 含端点, "area": n}})
    """
    h, w = mask.shape
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
        prev, cur = runs_by_row[y - 1], runs_by_row[y]
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
            b[2] = max(b[2], x1)
            b[3] = max(b[3], y)
            c["area"] += x1 - x0 + 1

    labels = np.zeros((h, w), dtype=np.int32)
    for y, runs in enumerate(runs_by_row):
        for x0, x1, n in runs:
            labels[y, x0: x1 + 1] = root_to_id[find(n)]
    return labels, comps


def fill_holes(mask: np.ndarray) -> np.ndarray:
    """把被 mask 完全包围的空洞并入 mask（从图像边界 flood 不到的区域）。"""
    h, w = mask.shape
    free = ~mask
    visited = np.zeros((h, w), dtype=bool)
    dq: deque[tuple[int, int]] = deque()
    for x in range(w):
        for y in (0, h - 1):
            if free[y, x] and not visited[y, x]:
                visited[y, x] = True
                dq.append((y, x))
    for y in range(h):
        for x in (0, w - 1):
            if free[y, x] and not visited[y, x]:
                visited[y, x] = True
                dq.append((y, x))
    while dq:
        y, x = dq.popleft()
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            ny, nx = y + dy, x + dx
            if 0 <= ny < h and 0 <= nx < w and free[ny, nx] and not visited[ny, nx]:
                visited[ny, nx] = True
                dq.append((ny, nx))
    return mask | (free & ~visited)


def inpaint_nearest(rgb: np.ndarray, fill: np.ndarray, donors: np.ndarray) -> np.ndarray:
    """用「最近 donor 像素的颜色」填充 fill 区域（多源 BFS，保持四周渐变色）。"""
    h, w = fill.shape
    out = rgb.copy()
    ys, xs = np.nonzero(fill)
    if ys.size == 0:
        return out
    y0, y1 = max(0, ys.min() - 8), min(h, ys.max() + 9)
    x0, x1 = max(0, xs.min() - 8), min(w, xs.max() + 9)
    sub_fill = fill[y0:y1, x0:x1]
    sub_don = donors[y0:y1, x0:x1]
    color = np.full((y1 - y0, x1 - x0, 3), -1, dtype=np.int16)
    dq: deque[tuple[int, int]] = deque()
    for yy, xx in zip(*np.nonzero(sub_don)):
        color[yy, xx] = rgb[y0 + yy, x0 + xx]
        dq.append((int(yy), int(xx)))
    if not dq:
        raise RuntimeError("inpaint: 没有可用 donor 像素")
    while dq:
        yy, xx = dq.popleft()
        cur = color[yy, xx]
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            ny, nx = yy + dy, xx + dx
            if not (0 <= ny < color.shape[0] and 0 <= nx < color.shape[1]):
                continue
            if color[ny, nx, 0] >= 0:
                continue
            color[ny, nx] = cur
            dq.append((ny, nx))
    fy, fx = np.nonzero(sub_fill)
    got = color[fy, fx]
    if np.any(got[:, 0] < 0):
        raise RuntimeError("inpaint: 有部分待填像素未被覆盖")
    out[y0 + fy, x0 + fx] = got.astype(np.uint8)
    return out


def inpaint_diffuse(rgb: np.ndarray, fill: np.ndarray, iters: int = 900) -> np.ndarray:
    """用 Laplace 扩散填洞：边界像素固定，洞内迭代取四邻平均，得到平滑渐变（无 Voronoi 条纹）。"""
    h, w = fill.shape
    ys, xs = np.nonzero(fill)
    if ys.size == 0:
        return rgb
    y0, y1 = max(0, ys.min() - 2), min(h, ys.max() + 3)
    x0, x1 = max(0, xs.min() - 2), min(w, xs.max() + 3)
    sub = rgb[y0:y1, x0:x1].astype(np.float64).copy()
    m = fill[y0:y1, x0:x1]
    known = ~m
    if not np.any(known):
        return rgb
    sub[m] = sub[known].mean(axis=0)  # 初值 = 边界均值
    for _ in range(iters):
        avg = (np.roll(sub, 1, 0) + np.roll(sub, -1, 0) +
               np.roll(sub, 1, 1) + np.roll(sub, -1, 1)) / 4.0
        sub[m] = avg[m]
    out = rgb.copy()
    out[y0:y1, x0:x1] = np.clip(np.rint(sub), 0, 255).astype(np.uint8)
    return out


def draw_arc(rgb: np.ndarray, alpha: np.ndarray, cx: float, cy: float,
             width: float, sag: float, thickness: float, color) -> np.ndarray:
    """画一条「中间下沉、两端微翘」的粗弧线（闭眼）。返回被画到的像素 mask。"""
    h, w = alpha.shape
    mask = np.zeros((h, w), dtype=bool)
    half = max(1.0, width / 2.0)
    r = max(1.0, thickness / 2.0)
    x_start = int(math.floor(cx - half))
    x_end = int(math.ceil(cx + half))
    for xi in range(x_start, x_end + 1):
        if xi < 0 or xi >= w:
            continue
        u = (xi - cx) / half
        u = max(-1.0, min(1.0, u))
        yy = cy + sag / 2.0 - sag * (u * u)
        y_lo = int(round(yy - r))
        y_hi = int(round(yy + r))
        y_lo = max(0, y_lo)
        y_hi = min(h - 1, y_hi)
        if y_lo <= y_hi:
            mask[y_lo: y_hi + 1, xi] = True
    # 两端圆头
    for ex in (x_start, x_end):
        u = -1.0 if ex == x_start else 1.0
        yy = cy + sag / 2.0 - sag * (u * u)
        ri = int(math.ceil(r))
        for py in range(int(math.floor(yy)) - ri, int(math.ceil(yy)) + ri + 1):
            for px in range(ex - ri, ex + ri + 1):
                if 0 <= py < h and 0 <= px < w and (px - ex) ** 2 + (py - yy) ** 2 <= r * r:
                    mask[py, px] = True
    mask &= alpha >= 200
    rgb[mask] = np.asarray(color, dtype=np.uint8)
    return mask


def skin_donors(rgb: np.ndarray, alpha: np.ndarray, lum: np.ndarray,
                exclude: np.ndarray) -> np.ndarray:
    """通用「皮肤/毛色」donor：不透明、不太暗、不是腮红粉、不是高光白。"""
    r = rgb[..., 0].astype(np.int16)
    g = rgb[..., 1].astype(np.int16)
    b = rgb[..., 2].astype(np.int16)
    # 腮红粉：r 明显高于 g/b，但 g≈b（桃色）；橙色/黄色皮肤 g-b 很大，不算腮红
    pink = (r > g + 25) & (np.abs(g - b) <= 40) & (b > 110) & (lum > 140)
    white = rgb.min(axis=2) >= 240
    return (alpha >= 250) & (lum >= 80) & ~pink & ~white & ~exclude


# ---------------------------------------------------------------------------
# 眼睛分类：黑点眼（睁眼）/ 已经闭眼（横线或笑弧）
# ---------------------------------------------------------------------------
def analyze_eyes(dark: np.ndarray):
    """返回 (mode, info)。

    mode : "closed"（原图已闭眼，复制）/ "open"（需要合成闭眼）
    info : {"eyes": [...], "outline_id": id, ...}
    """
    labels, comps = label_components(dark)
    if not comps:
        return "closed", {"reason": "no dark comps"}
    h_img, w_img = dark.shape

    def bbox_area(c):
        x0, y0, x1, y1 = c["bbox"]
        return (x1 - x0 + 1) * (y1 - y0 + 1)

    outline_id = max(comps, key=lambda cid: bbox_area(comps[cid]))
    cands = []
    for cid, c in comps.items():
        if cid == outline_id or c["area"] < DARK_TH_MIN_AREA:
            continue
        x0, y0, x1, y1 = c["bbox"]
        bw, bh = x1 - x0 + 1, y1 - y0 + 1
        if bw > 0.30 * w_img or bh > 0.34 * h_img:
            continue
        if y0 > 0.78 * h_img:
            continue
        fill = c["area"] / float(bw * bh)
        cands.append({
            "id": cid, "bbox": (x0, y0, x1, y1), "w": bw, "h": bh, "area": c["area"],
            "fill": fill, "cx": (x0 + x1) / 2.0, "cy": (y0 + y1) / 2.0,
        })

    best = None
    for i in range(len(cands)):
        for j in range(i + 1, len(cands)):
            a, b = cands[i], cands[j]
            ar = max(a["area"], b["area"]) / min(a["area"], b["area"])
            wr = max(a["w"], b["w"]) / min(a["w"], b["w"])
            hr = max(a["h"], b["h"]) / min(a["h"], b["h"])
            if ar > 1.9 or wr > 1.9 or hr > 1.9:
                continue
            dx = abs(b["cx"] - a["cx"])
            dy = abs(b["cy"] - a["cy"])
            mw = max(a["w"], b["w"])
            mh = max(a["h"], b["h"])
            if dy > max(4.0, 0.5 * mh):
                continue
            if dx < 1.5 * mw or dx > 7.5 * mw:
                continue
            for c in (a, b):
                asp = c["h"] / float(c["w"])
                if not (0.30 <= asp <= 5.0):
                    break
            else:
                score = (ar - 1.0) + (wr - 1.0) + (hr - 1.0) + 2.0 * dy / max(mh, 1.0)
                score -= 0.15 * min(3.0, dx / max(mw, 1.0))
                if best is None or score < best[0]:
                    best = (score, a, b)
    if best is None:
        return "closed", {"reason": "no eye pair candidate", "candidates": len(cands)}

    a, b = best[1], best[2]
    # 眼形判定（asp = 高/宽）：
    #   睁眼黑点：asp 1.0-1.5、fill 0.7-0.9（圆点）；婴儿横线/笑眼弧：asp 0.25-0.70、fill 0.5-1.0。
    #   0.72 < asp < 1.0 属于灰区，保守按「已闭眼」复制。
    asp_a = a["h"] / float(a["w"])
    asp_b = b["h"] / float(b["w"])
    mean_asp = (asp_a + asp_b) / 2.0
    mean_fill = (a["fill"] + b["fill"]) / 2.0
    if mean_asp <= 0.72:
        return "closed", {"reason": f"扁平横线/笑弧眼 asp={mean_asp:.2f}", "eyes": [a, b], "asp": mean_asp}
    if mean_asp >= 1.00 and mean_fill >= 0.68:
        return "open", {"eyes": [a, b], "asp": mean_asp, "labels": labels, "comps": comps,
                        "outline_id": outline_id}
    return "closed", {"reason": f"灰区保守复制 asp={mean_asp:.2f} fill={mean_fill:.2f}", "eyes": [a, b], "asp": mean_asp}


def synth_dot_eyes(rgb, alpha, dark, labels, info, log):
    """黑点眼睁眼 -> 擦瞳孔（含内部高光/边缘 AA）+ 画闭眼弧。"""
    lum = luminance(rgb)
    out = rgb.copy()
    allowed = np.zeros(alpha.shape, dtype=bool)
    min_rgb = rgb.min(axis=2)
    pupil_colors = []
    for eye in info["eyes"]:
        cid = eye["id"]
        pupil = labels == cid
        pupil_colors.append(rgb[pupil].reshape(-1, 3).mean(axis=0))
        solid = fill_holes(pupil)                 # 把瞳孔内部的高光白洞并入
        erase = dilate(solid, 4)
        # 瞳孔边缘的白色高光可能贴边，额外扩大一点擦除范围（只擦亮像素，不伤嘴/腮红）
        for k in (7, 10):
            erase |= dilate(solid, k) & (min_rgb >= 215)
        out = inpaint_diffuse(out, erase)
        allowed |= erase
        cx, cy = eye["cx"], eye["cy"]
        w = eye["w"]
        arc_w = max(6.0, w * 1.16)
        thick = max(3.0, w * 0.20)
        sag = max(3.0, w * 0.26)
        color = tuple(int(round(v)) for v in np.mean(pupil_colors, axis=0))
        drawn = draw_arc(out, alpha, cx, cy, arc_w, sag, thick, color)
        allowed |= drawn
    log.append("dot:2eyes")
    return out, allowed, tuple(int(round(v)) for v in np.mean(pupil_colors, axis=0))


def rim_guard_mask(rgb, kind: str) -> np.ndarray:
    r = rgb[..., 0].astype(np.int16)
    g = rgb[..., 1].astype(np.int16)
    b = rgb[..., 2].astype(np.int16)
    lum = luminance(rgb)
    if kind == "brown":
        ratio = (r - b) / np.maximum(r, 1).astype(np.float64)
        return (ratio > 0.25) & (lum < 190)
    # black / 深色镜框
    return lum < 45


def interior_mask(rgb, alpha, lum, pupil_color, guard) -> np.ndarray:
    r = rgb[..., 0].astype(np.int16)
    g = rgb[..., 1].astype(np.int16)
    b = rgb[..., 2].astype(np.int16)
    d = np.sqrt(((rgb.astype(np.float64) - np.asarray(pupil_color, dtype=np.float64)) ** 2).sum(axis=2))
    bright = lum >= 180
    navy = (b > r + 6) & (b > g + 6) & (lum < 120)   # 深藏蓝瞳孔（whale/chick）
    near_pupil = d <= 30
    return (bright | navy | near_pupil) & ~guard


def lens_region(rgb, alpha, lum, guard, pupil_color, cx, cy, rx, ry):
    """求镜片内部区域：passable=(近瞳孔色或亮且非镜框)，从最近的 passable 种子做连通域填充，
    并用 (rx*1.5, ry*1.5) 椭圆夹住，避免沿镜框 AA 缝漏到脸上。"""
    h, w = alpha.shape
    yy, xx = np.mgrid[0:h, 0:w]
    dist_p = np.sqrt(((rgb.astype(np.float64) - np.asarray(pupil_color, dtype=np.float64)) ** 2).sum(axis=2))
    passable = ((dist_p <= 45) | ((~guard) & (lum >= 150))) & (alpha >= 150)
    rbx, rby = rx * 1.2 + 10.0, ry * 1.2 + 10.0
    e_bound = ((xx - cx) ** 2 / (rbx ** 2) + (yy - cy) ** 2 / (rby ** 2) <= 1.0)
    ys = np.arange(max(0, int(cy - ry * 2)), min(h, int(cy + ry * 2) + 1))
    xs = np.arange(max(0, int(cx - rx * 2)), min(w, int(cx + rx * 2) + 1))
    yy_s, xx_s = np.meshgrid(ys, xs, indexing="ij")
    cand = passable[ys[0]:ys[-1] + 1, xs[0]:xs[-1] + 1] & e_bound[ys[0]:ys[-1] + 1, xs[0]:xs[-1] + 1]
    if not cand.any():
        return None
    d2 = (xx_s - cx) ** 2 + (yy_s - cy) ** 2
    idx = np.argmin(np.where(cand, d2, 1e18))
    sy, sx = np.unravel_index(idx, d2.shape)
    seed = (ys[0] + int(sy), xs[0] + int(sx))
    mask = passable & e_bound
    lab, comps = label_components(mask)
    cid = lab[seed]
    if cid == 0:
        return None
    region = lab == cid
    # 把镜片内的过渡阴影/AA 一路吃干净（只吃非镜框像素，最多 5 圈，且不越出 e_bound）
    for _ in range(5):
        grow = dilate(region.copy(), 1) & ~region & ~guard & (alpha >= 150) & e_bound
        if not grow.any():
            break
        region |= grow
    return region


def synth_glasses_elder(species, rgb, alpha, lum, cfg, log):
    """镜片内眼白+瞳孔 -> 镜片内部整体填肤色 + 画闭眼弧（镜框/镜腿/镜桥原样保留）。"""
    rgb = rgb.copy()
    allowed = np.zeros(alpha.shape, dtype=bool)
    h_img, w_img = alpha.shape
    min_rgb = rgb.min(axis=2)
    r16 = rgb[..., 0].astype(np.int16)
    g16 = rgb[..., 1].astype(np.int16)
    b16 = rgb[..., 2].astype(np.int16)
    pink = (r16 > g16 + 25) & (np.abs(g16 - b16) <= 40) & (b16 > 110) & (lum > 140)
    pupil_color = cfg["pupil"]
    guard = rim_guard_mask(rgb, cfg["guard"])
    for (cx, cy, rx, ry) in cfg["eyes"]:
        if cfg.get("mode", "full") == "ellipse":
            yy, xx = np.mgrid[0:h_img, 0:w_img]
            region = ((xx - cx) ** 2 / ((rx + 3.0) ** 2) + (yy - cy) ** 2 / ((ry + 3.0) ** 2) <= 1.0) & (alpha >= 150)
        else:
            region = lens_region(rgb, alpha, lum, guard, pupil_color, cx, cy, rx, ry)
        n_reg = int(region.sum())
        if n_reg < 100:  # 兜底：连通域失败时用椭圆
            yy, xx = np.mgrid[0:h_img, 0:w_img]
            region = ((xx - cx) ** 2 / ((rx + 0.5) ** 2) + (yy - cy) ** 2 / ((ry + 0.5) ** 2) <= 1.0)
            log.append("glasses:region-fallback")
        ys, xs = np.nonzero(region)
        bx0, bx1, by0, by1 = xs.min(), xs.max(), ys.min(), ys.max()
        bcx, bcy = (bx0 + bx1) / 2.0, (by0 + by1) / 2.0
        brx, bry = (bx1 - bx0) / 2.0, (by1 - by0) / 2.0
        # 肤色 donor：镜框外一圈椭圆环带（只取不透明、不暗、不白、不粉的脸部皮肤）
        ys2 = np.arange(max(0, int(bcy - bry - 30)), min(h_img, int(bcy + bry + 31)))
        xs2 = np.arange(max(0, int(bcx - brx - 30)), min(w_img, int(bcx + brx + 31)))
        yy2, xx2 = np.meshgrid(ys2, xs2, indexing="ij")
        q_in = (xx2 - bcx) ** 2 / ((brx + 8.0) ** 2) + (yy2 - bcy) ** 2 / ((bry + 8.0) ** 2)
        q_out = (xx2 - bcx) ** 2 / ((brx + 24.0) ** 2) + (yy2 - bcy) ** 2 / ((bry + 24.0) ** 2)
        ring = np.zeros(alpha.shape, dtype=bool)
        ring[ys2[0]: ys2[-1] + 1, xs2[0]: xs2[-1] + 1] = (q_in >= 1.0) & (q_out <= 1.0)
        donors = ring & (alpha >= 200) & (lum >= 70) & (min_rgb < 235) & ~pink
        n_don = int(donors.sum())
        if n_don < 30:
            skin = np.array(cfg.get("skin_fallback", (245, 235, 220)), dtype=np.float64)
            log.append(f"glasses:few-donors({n_don})")
        else:
            skin = np.median(rgb[donors].reshape(-1, 3).astype(np.float64), axis=0)
        rgb[region] = np.clip(np.rint(skin), 0, 255).astype(np.uint8)
        # 边界 AA 融合：镜框内侧 2px 的过渡像素按 55% 往肤色靠，压掉锯齿点
        band = dilate(region.copy(), 2) & ~region & ~guard & (lum >= 85) & (alpha >= 150)
        if band.any():
            rgb[band] = np.clip(np.rint(skin), 0, 255).astype(np.uint8)
            allowed |= band
        allowed |= region
        mode = cfg.get("mode", "full")
        arc_w = max(10.0, (bx1 - bx0 + 1) * (0.68 if mode == "ellipse" else 0.84))
        thick = max(3.0, arc_w * 0.20)
        sag = max(3.0, arc_w * 0.22)
        drawn = draw_arc(rgb, alpha, bcx, bcy, arc_w, sag, thick, cfg["pupil"])
        allowed |= drawn
    log.append("glasses:region-flat")
    return rgb, allowed


def dino_erase_region(alpha, lum, cx, cy, rx0, ry0):
    """按径向扫描黑色眼环外边界，得到覆盖「眼白+黑环」的星形擦除区（椭圆归一化坐标）。"""
    h, w = alpha.shape
    yy, xx = np.mgrid[0:h, 0:w]
    dx = (xx - cx) / rx0
    dy = (yy - cy) / ry0
    rr = np.sqrt(dx * dx + dy * dy)
    ang = np.degrees(np.arctan2(dy, dx)) + 360.0
    ang = np.mod(ang, 360.0)
    dark = (lum < 95) & (alpha >= 200)
    nb = 720
    r_lim = np.full(nb, 1.08)
    # 逐角度径向扫描（归一化半径 0.9 ~ 1.55）
    for bi in range(nb):
        phi = math.radians(bi * 0.5)
        cphi, sphi = math.cos(phi), math.sin(phi)
        out = 1.08
        for rn in np.arange(0.85, 1.55, 0.02):
            px = cx + rn * rx0 * cphi
            py = cy + rn * ry0 * sphi
            xi, yi = int(round(px)), int(round(py))
            if 0 <= yi < h and 0 <= xi < w and dark[yi, xi]:
                out = rn
        r_lim[bi] = min(out, 1.52)
    idx = (ang * 2.0).astype(np.int32) % nb
    lim = r_lim[idx] + 2.5 / float(min(rx0, ry0))
    return rr <= lim


def fit_skin_fill(rgb, donors, region, deg=2):
    """用二次多项式拟合皮肤渐变（在本区域附近的 donor 上最小二乘），直接预测区域颜色。"""
    ys, xs = np.nonzero(region)
    if ys.size == 0:
        return rgb
    y0, y1 = ys.min(), ys.max()
    x0, x1 = xs.min(), xs.max()
    h, w = region.shape
    wy = max(40, int((y1 - y0) * 0.9))
    wx = max(40, int((x1 - x0) * 0.9))
    ya0, ya1 = max(0, y0 - wy), min(h, y1 + wy + 1)
    xa0, xa1 = max(0, x0 - wx), min(w, x1 + wx + 1)
    d = donors[ya0:ya1, xa0:xa1]
    if d.sum() < 60:
        return inpaint_diffuse(rgb, region)
    dy, dx = np.nonzero(d)
    cyy = dy + ya0 - 0.5 * (y0 + y1)
    cxx = dx + xa0 - 0.5 * (x0 + x1)
    sy = max(1.0, (y1 - y0) / 2.0)
    sx = max(1.0, (x1 - x0) / 2.0)
    ny, nx = cyy / sy, cxx / sx
    A = np.stack([np.ones_like(ny), nx, ny, nx * nx, ny * ny, nx * ny], axis=1)
    cols = rgb[dy + ya0, dx + xa0].astype(np.float64)
    out = rgb.copy()
    yr, xr = np.nonzero(region)
    ny2 = (yr - 0.5 * (y0 + y1)) / sy
    nx2 = (xr - 0.5 * (x0 + x1)) / sx
    A2 = np.stack([np.ones_like(ny2), nx2, ny2, nx2 * nx2, ny2 * ny2, nx2 * ny2], axis=1)
    try:
        coeff, *_ = np.linalg.lstsq(A, cols, rcond=None)
    except np.linalg.LinAlgError:
        return inpaint_diffuse(rgb, region)
    pred = A2 @ coeff
    out[yr, xr] = np.clip(np.rint(pred), 0, 255).astype(np.uint8)
    return out


def synth_dino(species, stage, rgb, alpha, lum, log):
    """恐龙：白眼球 + 黑眼环整体擦掉，补绿皮肤，画黑弧。elder 保留棕色单片镜。"""
    rgb = rgb.copy()
    allowed = np.zeros(alpha.shape, dtype=bool)
    white = ((rgb.min(axis=2) >= 225) & (alpha >= 200)).astype(np.uint8)
    lab, comps = label_components(white.astype(bool))
    h_img, w_img = alpha.shape
    best = None
    for cid, c in comps.items():
        x0, y0, x1, y1 = c["bbox"]
        bw, bh = x1 - x0 + 1, y1 - y0 + 1
        asp = bh / float(bw)
        if not (0.62 <= asp <= 1.65):
            continue
        if bw < 60 or bh < 60 or bw > 0.35 * w_img or bh > 0.35 * h_img:
            continue
        if c["area"] < 2500:
            continue
        score = abs(asp - 1.0) * 100.0 - c["area"] / 1000.0
        if best is None or score < best[0]:
            best = (score, cid, c)
    if best is None:
        log.append("dino:no-sclera-copy")
        return None, None
    _, cid, c = best
    x0, y0, x1, y1 = c["bbox"]
    bw, bh = x1 - x0 + 1, y1 - y0 + 1
    cx, cy = (x0 + x1) / 2.0, (y0 + y1) / 2.0
    r16 = rgb[..., 0].astype(np.int16)
    g16 = rgb[..., 1].astype(np.int16)
    b16 = rgb[..., 2].astype(np.int16)
    green = (g16 > r16 + 15) & (g16 > b16 + 15) & (lum >= 45) & (alpha >= 250)
    rx0, ry0 = bw / 2.0, bh / 2.0
    if stage == "elder":
        pad = DINO_RING_PAD.get(stage, 3)
        rx, ry = rx0 + pad, ry0 + pad
        ys = np.arange(max(0, int(cy - ry - 2)), min(h_img, int(cy + ry + 3)))
        xs = np.arange(max(0, int(cx - rx - 2)), min(w_img, int(cx + rx + 3)))
        yy, xx = np.meshgrid(ys, xs, indexing="ij")
        erase = np.zeros(alpha.shape, dtype=bool)
        erase[ys[0]: ys[-1] + 1, xs[0]: xs[-1] + 1] = (
            (xx - cx) ** 2 / (rx ** 2) + (yy - cy) ** 2 / (ry ** 2) <= 1.0
        )
        q_in = (xx - cx) ** 2 / ((rx + 6.0) ** 2) + (yy - cy) ** 2 / ((ry + 6.0) ** 2)
        q_out = (xx - cx) ** 2 / ((rx + 26.0) ** 2) + (yy - cy) ** 2 / ((ry + 26.0) ** 2)
        ring = np.zeros(alpha.shape, dtype=bool)
        ring[ys[0]: ys[-1] + 1, xs[0]: xs[-1] + 1] = (q_in >= 1.0) & (q_out <= 1.0)
        don = ring & green
        if int(don.sum()) >= 40:
            skin = np.median(rgb[don].reshape(-1, 3).astype(np.float64), axis=0)
        else:
            skin = np.array([90, 175, 70], dtype=np.float64)
            log.append(f"dino:elder-few-donors({int(don.sum())})")
        rgb[erase] = np.clip(np.rint(skin), 0, 255).astype(np.uint8)
        allowed |= erase
        log.append("dino:elder-flat")
    else:
        erase = dino_erase_region(alpha, lum, cx, cy, rx0, ry0)
        # 只擦眼睛本身：排除红色系（张嘴的嘴内红，避免径向扫描误伤）
        red = (r16 > g16 + 40) & (r16 > b16 + 40)
        erase = erase & ~red
        donors = green & ~erase
        rgb = fit_skin_fill(rgb, donors, erase)
        allowed |= erase
        log.append(f"dino:radial-fit")
    arc_w = max(10.0, 0.84 * bw)
    thick = max(5.0, arc_w * 0.22)
    sag = max(5.0, arc_w * 0.25)
    drawn = draw_arc(rgb, alpha, cx, cy, arc_w, sag, thick, DINO_ARC_COLOR)
    allowed |= drawn
    return rgb, allowed


# ---------------------------------------------------------------------------
# 单张处理
# ---------------------------------------------------------------------------
def process_sprite(species: str, stage: str, report_only: bool):
    src_path = os.path.join(SPRITE_DIR, species, f"{stage}.png")
    dst_path = os.path.join(SPRITE_DIR, species, f"sleep-{stage}.png")
    src = load_rgba(src_path)
    alpha = src[..., 3]
    rgb = src[..., :3]
    lum = luminance(rgb)
    h, w = alpha.shape
    log: list[str] = []
    mode = "copy"
    detail = ""
    out = None
    allowed = None

    if species == "dinosaur":
        if stage == "baby":
            log.append("dino:baby-already-closed")
            detail = "dinosaur baby 原图已是闭眼下弯弧"
        else:
            out, allowed = synth_dino(species, stage, rgb, alpha, lum, log)
            if out is None:
                mode = "copy"
                detail = "恐龙：未找到眼白，保守复制"
            else:
                mode = "synth"
                detail = "恐龙侧脸单眼：擦眼白+黑眼环，补绿皮肤后画黑弧（elder 保留棕色镜框）"
    elif species in GLASSES and stage == "elder":
        out, allowed = synth_glasses_elder(species, rgb, alpha, lum, GLASSES[species], log)
        mode = "synth"
        detail = "镜片内眼白+瞳孔，擦镜片内部后画弧（保留镜框）"
    else:
        dark = (lum < DARK_LUM) & (alpha >= ALPHA_THRESHOLD)
        emode, info = analyze_eyes(dark)
        if emode == "open":
            out, allowed, color = synth_dot_eyes(rgb, alpha, dark, info["labels"], info, log)
            mode = "synth"
            detail = f"黑点眼 -> 擦瞳孔画弧 (弧色{color})"
        else:
            mode = "copy"
            detail = f"原图已闭眼：{info.get('reason', '')}"

    if out is None:
        mode = "copy"
        out = src[..., :3].copy()
    allowed = allowed if allowed is not None else np.zeros((h, w), dtype=bool)
    out_rgba = np.dstack([np.clip(out, 0, 255).astype(np.uint8), alpha])
    changed = np.any(out_rgba[..., :3] != src[..., :3], axis=2)
    outside = changed & ~allowed
    if outside.any():
        raise RuntimeError(f"{species}/{stage}: 改动越界 {int(outside.sum())} px（只允许改擦除/画弧区域）")
    if not np.array_equal(out_rgba[..., 3], src[..., 3]):
        raise RuntimeError(f"{species}/{stage}: alpha 通道被改动")

    if not report_only:
        if mode == "copy":
            shutil.copyfile(src_path, dst_path)
        else:
            save_rgba(dst_path, out_rgba)

    size = os.path.getsize(dst_path) if (not report_only and os.path.exists(dst_path)) else 0
    return {
        "species": species, "stage": stage, "mode": mode, "detail": detail,
        "log": ",".join(log), "w": w, "h": h, "changed": int(changed.sum()),
        "bytes": size, "path": dst_path, "reason": detail,
    }


# ---------------------------------------------------------------------------
# QA 拼版
# ---------------------------------------------------------------------------
def find_font(size: int):
    for path in (
        "/System/Library/Fonts/Hiragino Sans GB.ttc",
        "/System/Library/Fonts/STHeiti Light.ttc",
        "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
    ):
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except OSError:
                continue
    return ImageFont.load_default()


def checker(size, step=12, c1=(238, 238, 238), c2=(214, 214, 214)):
    w, h = size
    tile = np.zeros((h, w, 3), dtype=np.uint8)
    yy, xx = np.mgrid[0:h, 0:w]
    mask = ((yy // step) + (xx // step)) % 2 == 0
    tile[mask] = c1
    tile[~mask] = c2
    return Image.fromarray(tile, mode="RGB")


def make_qa(rows, report_only: bool):
    """9 行 x 6 列对照图：每个格子 = 睡眠版（按显示高度 130px 的 2x 绘制）+ 标签。"""
    cell_w, cell_h = 336, 300
    head_h = 92
    label_h = 52
    left_w = 118
    sheet_w = left_w + 6 * cell_w + 16
    sheet_h = head_h + 9 * (cell_h + label_h) + 14
    sheet = Image.new("RGB", (sheet_w, sheet_h), (247, 247, 249))
    d = ImageDraw.Draw(sheet)
    f_title = find_font(26)
    f_sub = find_font(15)
    f_cell = find_font(16)
    f_small = find_font(13)

    d.text((18, 16), "dsh-digital-pet · 闭眼睡觉精灵对照图（sleep sprites QA）", font=f_title, fill=(20, 20, 24))
    n_synth = sum(1 for r in rows if r["mode"] == "synth")
    n_copy = len(rows) - n_synth
    d.text((18, 52),
           f"共 {len(rows)} 张（9 物种 x 6 阶段）· 合成 {n_synth} · 原图已闭眼复制 {n_copy} · "
           f"每格按客户端 130px 显示高度的 2x 绘制；绿色=复制，橙色=合成",
           font=f_sub, fill=(80, 80, 88))
    d.text((sheet_w - 210, 52), time.strftime("生成于 %Y-%m-%d %H:%M"), font=f_small, fill=(120, 120, 128))

    by_key = {(r["species"], r["stage"]): r for r in rows}
    for si, species in enumerate(SPECIES):
        top = head_h + si * (cell_h + label_h)
        d.rectangle([0, top, left_w - 8, top + cell_h + label_h - 1], fill=(233, 233, 238))
        d.text((14, top + 112), f"{ZH.get(species, '')}", font=f_cell, fill=(28, 28, 34))
        d.text((14, top + 136), species, font=f_small, fill=(90, 90, 100))
        for ti, stage in enumerate(STAGES):
            info = by_key[(species, stage)]
            cx = left_w + ti * cell_w
            d.rectangle([cx, top, cx + cell_w - 1, top + cell_h - 1], fill=(255, 255, 255))
            sprite = Image.open(info["path"]).convert("RGBA")
            target_h = 260.0
            scale = target_h / sprite.height
            disp = sprite.resize((max(1, round(sprite.width * scale)), int(target_h)), Image.LANCZOS)
            bg = checker((cell_w, cell_h), step=10)
            box_x = cx + (cell_w - disp.width) // 2
            box_y = top + (cell_h - disp.height) // 2
            bg.paste(disp, (box_x - cx, box_y - top), disp)
            sheet.paste(bg, (cx, top))
            d.rectangle([cx, top, cx + cell_w - 1, top + cell_h - 1], outline=(205, 205, 212))
            # 标签
            color = (10, 120, 60) if info["mode"] == "copy" else (200, 90, 10)
            tag = "复制(原图已闭眼)" if info["mode"] == "copy" else "合成闭眼"
            d.text((cx + 10, top + cell_h + 6), f"{stage}  {info['w']}x{info['h']}", font=f_cell, fill=(30, 30, 36))
            d.text((cx + 10, top + cell_h + 28), tag, font=f_small, fill=color)
            if info["mode"] != "copy":
                d.text((cx + 150, top + cell_h + 28), f"改动 {info['changed']} px", font=f_small, fill=(120, 120, 128))
    if not report_only:
        os.makedirs(DOCS_DIR, exist_ok=True)
        sheet.save(QA_PATH, optimize=True)
    return sheet


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="生成闭眼睡觉精灵 + QA 拼版")
    ap.add_argument("--only", default=None, help="只处理一个 species/stage，例如 whale/elder")
    ap.add_argument("--report", action="store_true", help="只打印分类结果，不写任何文件")
    args = ap.parse_args(argv)

    targets = []
    if args.only:
        species, stage = args.only.split("/")
        if species not in SPECIES or stage not in STAGES:
            print(f"未知目标：{args.only}", file=sys.stderr)
            return 2
        targets = [(species, stage)]
    else:
        targets = [(s, st) for s in SPECIES for st in STAGES]

    rows = []
    for species, stage in targets:
        rows.append(process_sprite(species, stage, args.report))
    for r in rows:
        print(f"{r['species']:9s} {r['stage']:8s} {r['mode']:5s} {r['w']:4d}x{r['h']:<4d} "
              f"changed={r['changed']:6d}px bytes={r['bytes']:7d}  {r['detail']}")
    if len(rows) == len(SPECIES) * len(STAGES):
        make_qa(rows, args.report)
        if not args.report:
            print(f"\nQA -> {QA_PATH}")
    n_synth = sum(1 for r in rows if r["mode"] == "synth")
    print(f"\n合计 {len(rows)} 张：合成 {n_synth}，复制 {len(rows) - n_synth}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
