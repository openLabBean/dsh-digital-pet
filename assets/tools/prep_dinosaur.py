#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""为新增物种「恐龙（迪诺 / Dinosaur）」生成源图与切格 crop，并追加进 manifest。

输入：assets/source/dinosaur-original.webp（用户提供的 1254×1254 素材，4×4 网格、14 个形象）
输出：
  1. <PET_SRC>/dinosaur.png —— 透明底源图（alpha<16 清零），供 optimize_sprites.py 复用；
  2. manifest.json 追加上 `dinosaur` 物种条目（crop 由 slicer 的连通域聚类算出）。

用法：python3 tools/prep_dinosaur.py [--src <pet-family-v2 源目录>]
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]          # plugins/dsh-digital-pet/assets
TOOLS = Path(__file__).resolve().parent
SRC_DEFAULT = Path.home() / "Documents/Program/whalecloud/output/imagegen/pet-family-v2"
SOURCE_FILE = ROOT / "source" / "dinosaur-original.webp"
SPECIES_ID = "dinosaur"
MARGIN = 2
ALPHA_THRESHOLD = 16

sys.path.insert(0, str(TOOLS))
import slice as slicer  # noqa: E402
import optimize_sprites as opt  # noqa: E402


def _erode(mask: np.ndarray) -> np.ndarray:
    padded = np.pad(mask, 1)
    return (
        mask
        & padded[:-2, 1:-1]
        & padded[2:, 1:-1]
        & padded[1:-1, :-2]
        & padded[1:-1, 2:]
    ).astype(np.uint8)


def split_cell_pet_and_poop(alpha: np.ndarray, rgba: np.ndarray, labelmap: np.ndarray, main_comp) -> tuple[np.ndarray, np.ndarray]:
    """把「宠物+便便」这一格里像素相连的宠物/便便拆开。

    便便堆是棕色、宠物是绿色：先用「棕色色域 + 最大连通域」定位便便堆，
    再把它向外扩 3px 后从主连通域里扣除，剩余就是宠物本体（连尾巴尖归属正确）。
    """
    x0, y0, x1, y1 = main_comp["bbox"]
    main_cid = main_comp["id"]
    sub_alpha = labelmap[y0 : y1 + 1, x0 : x1 + 1] == main_cid
    rgb = rgba[y0 : y1 + 1, x0 : x1 + 1, :3].astype(np.int32)
    brown = sub_alpha & (rgb[..., 0] > rgb[..., 1] + 8) & (rgb[..., 1] >= rgb[..., 2] - 5) & (rgb[..., 0] > 45) & (rgb[..., 2] < 170)
    labelmap, comps = slicer.label_components((brown * 255).astype(np.uint8), 16)
    candidates = [(comp["area"], cid, comp) for cid, comp in comps.items() if comp["area"] > 100]
    if not candidates:
        raise RuntimeError("未检测到便便堆（棕色连通域）")
    _, _, poop_comp = max(candidates, key=lambda item: item[0])

    core = labelmap == poop_comp[0] if False else (labelmap == max(candidates, key=lambda item: item[0])[1])
    grown = core.copy()
    for _ in range(4):
        padded = np.pad(grown, 1)
        grown = grown | padded[:-2, 1:-1] | padded[2:, 1:-1] | padded[1:-1, :-2] | padded[1:-1, 2:]

    poop_sub = core
    pet_sub = sub_alpha & ~grown
    pet_mask = np.zeros_like(alpha, dtype=bool)
    poop_mask = np.zeros_like(alpha, dtype=bool)
    pet_mask[y0 : y1 + 1, x0 : x1 + 1] = pet_sub
    poop_mask[y0 : y1 + 1, x0 : x1 + 1] = poop_sub
    return pet_mask, poop_mask


def mask_bbox(mask: np.ndarray) -> list[int]:
    ys, xs = np.nonzero(mask)
    return [int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())]



def build_masked_sprite(source_rgba: np.ndarray, masks: list[np.ndarray], bbox: list[int]) -> Image.Image:
    """按 mask 擦除矩形内的无关像素（如宠物尾巴/便便），再走统一的清洗流程。"""
    x0, y0, x1, y1 = bbox
    crop = source_rgba[y0 : y1 + 1, x0 : x1 + 1].copy()
    keep = np.zeros(crop.shape[:2], dtype=bool)
    for mask in masks:
        keep |= mask[y0 : y1 + 1, x0 : x1 + 1]
    crop[..., 3] = np.where(keep, crop[..., 3], 0)
    # mask 边界会留下「半透明近白」的白色衬底残留小点：非完全不透明的近白像素一律清掉
    rgb = crop[..., :3].astype(np.int32)
    near_white = rgb.min(axis=2) >= 228
    speckle = near_white & (crop[..., 3] < 250)
    crop[..., 3] = np.where(speckle, 0, crop[..., 3])
    return opt.clean_sprite(Image.fromarray(crop, "RGBA"), 1)


def union_bbox(boxes):
    x0 = min(b[0] for b in boxes)
    y0 = min(b[1] for b in boxes)
    x1 = max(b[2] for b in boxes)
    y1 = max(b[3] for b in boxes)
    return [x0, y0, x1, y1]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--src", default=str(SRC_DEFAULT))
    parser.add_argument("--manifest", default=str(ROOT / "manifest.json"))
    args = parser.parse_args()
    src_dir = Path(args.src)

    image = Image.open(SOURCE_FILE).convert("RGBA")
    arr = np.array(image)
    alpha = arr[..., 3].copy()
    alpha[alpha < ALPHA_THRESHOLD] = 0
    arr[..., 3] = alpha

    prepared = Image.fromarray(arr, "RGBA")
    src_dir.mkdir(parents=True, exist_ok=True)
    out_sheet = src_dir / "dinosaur.png"
    prepared.save(out_sheet, "PNG", optimize=True)
    print(f"源图已写入 {out_sheet}（{out_sheet.stat().st_size / 1024:.1f} KB）")

    analysis = slicer.analyze_sheet(alpha)
    if analysis["row_sizes"] != [4, 4, 4, 2]:
        raise SystemExit(f"行聚类异常：{analysis['row_sizes']}")
    print("行聚类 [4, 4, 4, 2]，主形象 14 个，配件连通域",
          sum(len(v) for v in analysis["accessories"].values()), "个")

    sprites: dict[str, dict] = {}
    extras: dict[str, dict] = {}
    notes: list[str] = []
    for index, slot in enumerate(slicer.SLOTS):
        cid = analysis["cells"][index]
        main_bbox = analysis["mains"][cid]["bbox"]
        acc = analysis["accessories"][cid]
        if slot == "poop":
            # 该格 = 宠物 + 便便；源图里两者像素相连，需按腐蚀种子 + BFS 拆分
            pet_mask, poop_mask = split_cell_pet_and_poop(alpha, arr, analysis["labelmap"], {**analysis["mains"][cid], "id": cid})
            smoke_mask = np.zeros_like(alpha, dtype=bool)
            for i in acc:
                smoke_mask |= analysis["labelmap"] == i
            poop_all = poop_mask | smoke_mask
            pet_bbox = mask_bbox(pet_mask)
            poop_bbox = mask_bbox(poop_all)
            bbox = poop_bbox
            extras["adultWithPoop"] = {"crop": _crop(pet_bbox), "prebuilt": True}
            notes.append(
                "poop: 色域拆分：宠物 bbox=%s，便便 bbox=%s（含 %d 个臭味线配件）"
                % (tuple(pet_bbox), tuple(bbox), len(acc))
            )
            # 直接导出两份成品（poop 只保留便便+臭味线；adult-with-poop 只保留宠物）
            out_dir = ROOT / "sprites" / SPECIES_ID
            out_dir.mkdir(parents=True, exist_ok=True)
            poop_sprite = build_masked_sprite(arr, [poop_all], bbox)
            poop_sprite.save(out_dir / "poop.png", "PNG", optimize=True)
            pet_sprite = build_masked_sprite(arr, [pet_mask], pet_bbox)
            pet_sprite.save(out_dir / "adult-with-poop.png", "PNG", optimize=True)
            sprites[slot] = _prebuilt_entry("poop", poop_sprite, bbox)
            _prebuilt_extra = _prebuilt_entry("adult-with-poop", pet_sprite, pet_bbox)
            extras["adultWithPoop"] = _prebuilt_extra
            _prebuilt_extra["prebuilt"] = True
        else:
            ids = [cid] + acc
            bbox = union_bbox([main_bbox] + [analysis["comps"][i]["bbox"] for i in acc])
            if acc:
                notes.append(f"{slot}: 合并 {len(acc)} 个配件连通域")
            sprites[slot] = {"file": f"sprites/{SPECIES_ID}/{slot}.png", "crop": _crop(bbox)}

    notes.append("行聚类 [4, 4, 4, 2]，配件最大间距 %.1fpx" % analysis["max_accessory_gap"])
    notes.append("主形象源尺寸 " + ", ".join(
        "%dx%d" % (analysis["mains"][analysis["cells"][i]]["bbox"][2] - analysis["mains"][analysis["cells"][i]]["bbox"][0],
                   analysis["mains"][analysis["cells"][i]]["bbox"][3] - analysis["mains"][analysis["cells"][i]]["bbox"][1])
        for i in range(14)))

    entry = {
        "id": SPECIES_ID,
        # 恐龙源图是 AI 平滑插画（对比度低于其它物种），额外做一次清晰度增强 + 2× 超采样：
        # 锐化 → 对比/饱和 → 边缘 alpha 二值化 → LANCZOS 2×，浏览器按 CSS 尺寸缩小时更锐利
        "enhance": {
            "unsharp": [1.4, 220],
            "contrast": 1.08,
            "saturate": 1.06,
            "hard_alpha": 200,
            "supersample": 2,
        },
        "speciesZh": "恐龙",
        "nameZh": "迪诺",
        "nameEn": "Dinosaur",
        "sourceFile": "dinosaur.png",
        "sprites": sprites,
        "extras": extras,
        "notes": notes,
    }

    manifest_path = Path(args.manifest)
    manifest = json.loads(manifest_path.read_text())
    manifest["species"] = [s for s in manifest["species"] if s["id"] != SPECIES_ID] + [entry]
    manifest.setdefault("sourceImages", [])
    manifest["sourceImages"] = [s for s in manifest["sourceImages"] if s.get("file") != "dinosaur.png"]
    manifest["sourceImages"].append({"file": "dinosaur.png", "speciesId": SPECIES_ID, "original": "source/dinosaur-original.webp"})
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    print(f"manifest 已追加 {SPECIES_ID}：{len(sprites)} 个 slot + extras，写入 {manifest_path}")
    return 0


def _prebuilt_entry(slot: str, sprite: Image.Image, bbox: list[int]) -> dict:
    path = ROOT / "sprites" / SPECIES_ID / f"{slot}.png"
    return {
        "file": f"sprites/{SPECIES_ID}/{slot}.png",
        "width": sprite.width,
        "height": sprite.height,
        "scale": 1,
        "padding": MARGIN,
        "crop": _crop(bbox),
        "sourceFile": "dinosaur.png",
        "bytes": path.stat().st_size,
        "prebuilt": True,
    }


def _crop(bbox):
    x0, y0, x1, y1 = bbox
    x = max(0, x0 - MARGIN)
    y = max(0, y0 - MARGIN)
    return {"x": int(x), "y": int(y), "w": int(x1 - x0 + 1 + MARGIN * 2), "h": int(y1 - y0 + 1 + MARGIN * 2)}


if __name__ == "__main__":
    raise SystemExit(main())
