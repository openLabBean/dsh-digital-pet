#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""在 slice.py 的 manifest 基础上重新导出高保真精灵图（v2）。

为什么需要它
------------
v1 把每个形象从源图裁出后**缩小到高度 96px**（NEAREST），而源图里每个形象
本身只有约 100~210px 高，缩到 96 再被浏览器放大到 72/96/128 逻辑像素显示，
在 Retina 屏上等于 96 -> 144 设备像素的再放大；加上源图 alpha 边缘带白色
半透明晕圈（AI 出图的白色衬底残留），桌面宠物看起来就「模糊 + 白色锯齿」。

v2 的做法
--------
1. 按 manifest 里的 crop 直接取源图**原始分辨率**，不再缩小；
2. 去白色衬底（alpha decontamination）：对 0 < a < 1 的像素按
   C_true = (C_obs - 255*(1-a)) / a 反解，去掉白色晕圈；
3. 清除白色衬底残留的低 alpha 边缘（默认 a < 128/255 视为 0）——A/B 实测
4. 可选 --scale 2/3：把清理后的像素图按 NEAREST 整数倍放大，供
   image-rendering: pixelated 在整数倍场景下使用；
5. 按 alpha bbox 裁紧 + 四周 2px 透明 padding，写入 sprites/，并生成 manifest v2
   （记录 width/height/scale/crop，供 client 按高度等比显示）。

用法
----
    python3 tools/optimize_sprites.py                 # 原生分辨率（推荐）
    python3 tools/optimize_sprites.py --scale 2       # 2 倍整数放大
    python3 tools/optimize_sprites.py --verify        # 只校验当前产物

依赖：python3 + Pillow + numpy。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageEnhance, ImageFilter

ROOT = Path(__file__).resolve().parents[1]  # plugins/dsh-digital-pet/assets
SRC_DEFAULT = Path.home() / "Documents/Program/whalecloud/output/imagegen/pet-family-v2"
PAD = 2
ALPHA_FLOOR = 128  # 低于该 alpha 的边缘视为白色衬底残留（实测 8~48 仍会留一圈灰白光晕）
MANIFEST_VERSION = "2.0.0"


def log(*args: object) -> None:
    print(*args, flush=True)


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def decontaminate_white(rgba: np.ndarray) -> np.ndarray:
    """把「白底半透明衬底」残留去掉：反解 C = (C_obs - 255*(1-a)) / a。"""
    out = rgba.astype(np.float32)
    rgb = out[..., :3]
    a = out[..., 3:4] / 255.0
    safe = a > (1.0 / 255.0)
    rgb_true = np.where(safe, (rgb - 255.0 * (1.0 - a)) / np.maximum(a, 1e-6), rgb)
    out[..., :3] = np.clip(rgb_true, 0.0, 255.0)
    return out


def enhance_sprite(image: Image.Image, options: dict) -> Image.Image:
    """按 species.enhance 配置增强清晰度：锐化 → 对比/饱和 → 硬 alpha → 超采样。

    options:
      unsharp: [radius, percent]  (默认 [1.4, 220])
      contrast / saturate: float  (默认 1.0)
      hard_alpha: int             (0=不处理；默认 200，边缘二值化)
      supersample: int            (默认 1；输出前 LANCZOS 放大该倍数)
    """
    unsharp = options.get("unsharp") or [1.4, 220]
    out = image.filter(ImageFilter.UnsharpMask(radius=float(unsharp[0]), percent=int(unsharp[1]), threshold=1))

    contrast = float(options.get("contrast", 1.0))
    saturate = float(options.get("saturate", 1.0))
    if contrast != 1.0:
        out = ImageEnhance.Contrast(out).enhance(contrast)
    if saturate != 1.0:
        out = ImageEnhance.Color(out).enhance(saturate)

    hard = int(options.get("hard_alpha", 0) or 0)
    if hard > 0:
        import numpy as _np
        arr = _np.array(out.convert("RGBA"))
        arr[..., 3] = _np.where(arr[..., 3] >= hard, 255, 0).astype(_np.uint8)
        out = Image.fromarray(arr, "RGBA")

    ss = int(options.get("supersample", 1) or 1)
    if ss != 1:
        size = (out.width * ss, out.height * ss)
        arr = _np.array(out.convert("RGBA"))
        arr[..., 3] = _np.where(arr[..., 3] >= hard if hard else arr[..., 3] > 0, arr[..., 3], 0).astype(_np.uint8) if False else arr[..., 3]
        out = out.resize(size, Image.LANCZOS)
        # 放大后把透明/不透明交界重新硬一遍，避免出现一圈灰边
        if hard > 0:
            arr = _np.array(out.convert("RGBA"))
            arr[..., 3] = _np.where(arr[..., 3] >= 96, 255, 0).astype(_np.uint8)
            out = Image.fromarray(arr, "RGBA")
    return out


def clean_sprite(image: Image.Image, scale: int) -> Image.Image:
    rgba = np.array(image.convert("RGBA"))
    rgba = np.rint(decontaminate_white(rgba)).astype(np.int16)
    rgba = np.clip(rgba, 0, 255).astype(np.uint8)

    alpha = rgba[..., 3]
    alpha[alpha < ALPHA_FLOOR] = 0
    rgba[..., 3] = alpha

    # 按 alpha bbox 裁紧（留 PAD 透明边）
    ys, xs = np.nonzero(alpha > 0)
    if len(xs) == 0:
        raise ValueError("empty sprite after alpha cleanup")
    x0, x1 = int(xs.min()), int(xs.max()) + 1
    y0, y1 = int(ys.min()), int(ys.max()) + 1
    tight = rgba[y0:y1, x0:x1]

    canvas = np.zeros((tight.shape[0] + PAD * 2, tight.shape[1] + PAD * 2, 4), dtype=np.uint8)
    canvas[PAD : PAD + tight.shape[0], PAD : PAD + tight.shape[1]] = tight

    out = Image.fromarray(canvas, mode="RGBA")
    if scale != 1:
        out = out.resize((out.width * scale, out.height * scale), Image.NEAREST)
    return out


def iter_sprites(manifest: dict):
    for species in manifest["species"]:
        for slot, meta in species["sprites"].items():
            yield species, slot, meta
        extra = (species.get("extras") or {}).get("adultWithPoop")
        if extra:
            yield species, "adult-with-poop", extra


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--src", default=str(SRC_DEFAULT), help="pet-family-v2 源目录")
    parser.add_argument("--manifest", default=str(ROOT / "manifest.json"))
    parser.add_argument("--scale", type=int, default=1, choices=(1, 2, 3))
    parser.add_argument("--verify", action="store_true", help="只校验现有产物")
    args = parser.parse_args()

    src_dir = Path(args.src)
    manifest_path = Path(args.manifest)
    manifest = json.loads(manifest_path.read_text())

    if args.verify:
        return verify(manifest, ROOT)

    sources: dict[str, Image.Image] = {}
    new_species = []
    total_bytes = 0

    for species in manifest["species"]:
        source_name = species["sourceFile"]
        if source_name not in sources:
            sources[source_name] = Image.open(src_dir / source_name).convert("RGBA")
        sheet = sources[source_name]

        sprites: dict[str, dict] = {}
        jobs = [(slot, meta) for slot, meta in species["sprites"].items()]
        extra = (species.get("extras") or {}).get("adultWithPoop")
        if extra:
            jobs.append(("adult-with-poop", extra))

        for slot, meta in jobs:
            crop = meta["crop"]
            box = (crop["x"], crop["y"], crop["x"] + crop["w"], crop["y"] + crop["h"])
            out_path = ROOT / "sprites" / species["id"] / f"{slot}.png"
            out_path.parent.mkdir(parents=True, exist_ok=True)
            if meta.get("prebuilt"):
                # 该格与相邻形象像素粘连（例如恐龙尾巴尖/便便），prep 脚本已按 mask 直接产出成品
                if not out_path.exists():
                    raise SystemExit(f"prebuilt 精灵缺失：{out_path}")
                sprite = Image.open(out_path).convert("RGBA")
            else:
                sprite = clean_sprite(sheet.crop(box), args.scale)
            enhance = species.get("enhance")
            if enhance:
                sprite = enhance_sprite(sprite, enhance)
            sprite.save(out_path, "PNG", optimize=True)
            size = out_path.stat().st_size
            total_bytes += size
            entry = {
                "file": f"sprites/{species['id']}/{slot}.png",
                "width": sprite.width,
                "height": sprite.height,
                "scale": int(meta.get("scale", args.scale)) * int(((species.get("enhance") or {}).get("supersample", 1) or 1)),
                "padding": PAD,
                "crop": crop,
                "sourceFile": source_name,
                "bytes": size,
            }
            if meta.get("prebuilt"):
                entry["prebuilt"] = True
            if slot == "adult-with-poop":
                species.setdefault("extras", {})["adultWithPoop"] = entry
            else:
                sprites[slot] = entry

        ns = dict(species)
        ns["sprites"] = sprites
        ns["sourceSha256"] = sha256(src_dir / source_name)
        new_species.append(ns)

    manifest["version"] = MANIFEST_VERSION
    manifest["description"] = (
        "pet-family-v2 静态精灵（v2）：按 manifest crop 取源图原始分辨率、"
        "去除白色衬底晕圈、alpha 清理后按 bbox 裁紧 + 2px padding；"
        "不再缩小到 96px，交由客户端按高度等比平滑缩放显示。"
    )
    manifest["pipeline"] = {
        "tool": "assets/tools/optimize_sprites.py",
        "method": "native-resolution crop + white-matte decontamination + alpha floor 128 + tight bbox + 2px pad"
        + (f" + nearest x{args.scale}" if args.scale != 1 else ""),
        "scale": args.scale,
        "padding": PAD,
        "alphaFloor": ALPHA_FLOOR,
    }
    manifest["species"] = new_species
    manifest["totals"] = {
        "files": sum(len(s["sprites"]) for s in new_species)
        + sum(1 for s in new_species if (s.get("extras") or {}).get("adultWithPoop")),
        "bytes": total_bytes,
    }
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")

    log(f"OK  {manifest['totals']['files']} 张精灵，{total_bytes / 1024:.1f} KB，scale={args.scale}")
    return verify(manifest, ROOT)


def verify(manifest: dict, root: Path) -> int:
    errors: list[str] = []
    semi_white = 0
    for species in manifest["species"]:
        entries = [(slot, meta) for slot, meta in species["sprites"].items()]
        extra = (species.get("extras") or {}).get("adultWithPoop")
        if extra:
            entries.append(("adult-with-poop", extra))
        for slot, meta in entries:
            path = root / meta["file"]
            if not path.exists():
                errors.append(f"missing {meta['file']}")
                continue
            image = Image.open(path)
            if image.mode != "RGBA":
                errors.append(f"{meta['file']} mode={image.mode}")
            if (image.width, image.height) != (meta["width"], meta["height"]):
                errors.append(f"{meta['file']} size 与 manifest 不符 {image.size}")
            arr = np.array(image)
            if int((arr[..., 3] > 0).sum()) == 0:
                errors.append(f"{meta['file']} 完全透明")
            # 白晕检查：半透明像素里仍接近纯白的数量
            a = arr[..., 3]
            semi = (a > 8) & (a < 248)
            if semi.any():
                rgb = arr[..., :3][semi]
                semi_white += int(((rgb > 250).all(axis=1)).sum())
    if errors:
        for e in errors[:10]:
            log("FAIL", e)
        return 1
    log(f"verify OK：{manifest['totals']['files']} 张，白晕残留半透明近白像素 {semi_white} 个")
    return 0


if __name__ == "__main__":
    sys.exit(main())
