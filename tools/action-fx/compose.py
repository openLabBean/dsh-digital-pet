#!/usr/bin/env python3
"""把 capture.mjs 采到的动作帧合成为 docs/ 里的 GIF 与拼图。

用法：
  node tools/action-fx/capture.mjs <dsh-web-url> --out .tmp/action-fx
  python3 tools/action-fx/compose.py --src .tmp/action-fx --docs docs

产物（与既有 docs/v1-*.gif 同一命名风格）：
  docs/v1-action-feed.gif   喂食：低头咀嚼 + 粮粒/星星
  docs/v1-action-bathe.gif  洗澡：左右搓洗 + 泡沫/水珠/海绵
  docs/v1-action-walk.gif   逛街：左右走动/转身 + 尘土
  docs/v1-action-strips.png 三行动作帧拼图（每行 8 帧，缩小 50%）

帧时长取自动画周期 / 帧数：eat 1.8s、bathe 1.5s、walk 2.8s。
"""

import argparse
import json
from pathlib import Path

from PIL import Image

ACTIONS = [
    ("feed", "v1-action-feed.gif", 1800),
    ("bathe", "v1-action-bathe.gif", 1500),
    ("walk", "v1-action-walk.gif", 2800),
]


def load_frames(src: Path, action: str) -> list[Image.Image]:
    frames = sorted((src / "frames").glob(f"{action}-*.png"))
    if not frames:
        raise SystemExit(f"missing frames for {action} under {src}/frames")
    return [Image.open(path).convert("RGBA") for path in frames]


def save_gif(frames: list[Image.Image], cycle_ms: int, out: Path) -> None:
    step = max(20, round(cycle_ms / len(frames)))
    # GIF 不支持完整 alpha：垫白底，与文档截图背景一致
    canvas = []
    for frame in frames:
        background = Image.new("RGBA", frame.size, (255, 255, 255, 255))
        background.alpha_composite(frame)
        canvas.append(background.convert("RGB"))
    canvas[0].save(
        out,
        save_all=True,
        append_images=canvas[1:],
        duration=step,
        loop=0,
        optimize=True,
    )
    print(f"{out.name}: {len(canvas)} frames, {step}ms/frame, {out.stat().st_size // 1024}KB")


def save_strip(rows: list[tuple[str, list[Image.Image]]], out: Path) -> None:
    width = min(len(frames) for _, frames in rows)
    cell = rows[0][1][0].size
    scale = 0.5
    cell = (round(cell[0] * scale), round(cell[1] * scale))
    sheet = Image.new("RGB", (cell[0] * width, cell[1] * len(rows)), (250, 250, 248))
    for row, (_, frames) in enumerate(rows):
        for col in range(width):
            frame = frames[col].resize(cell, Image.LANCZOS)
            background = Image.new("RGBA", frame.size, (250, 250, 248, 255))
            background.alpha_composite(frame)
            sheet.paste(background.convert("RGB"), (col * cell[0], row * cell[1]))
    sheet.save(out, optimize=True)
    print(f"{out.name}: {sheet.width}x{sheet.height}, {out.stat().st_size // 1024}KB")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--src", default=".tmp/action-fx")
    parser.add_argument("--docs", default="docs")
    args = parser.parse_args()

    src = Path(args.src)
    docs = Path(args.docs)
    docs.mkdir(parents=True, exist_ok=True)

    verify_path = src / "verify.json"
    if not verify_path.exists():
        raise SystemExit(f"missing {verify_path}，先跑 capture.mjs")
    verify = json.loads(verify_path.read_text(encoding="utf-8"))
    failed = [check for check in verify.get("checks", []) if check.get("ok") is not True]
    if failed:
        raise SystemExit(f"capture 断言未通过：{failed}")

    rows = []
    for action, gif_name, cycle_ms in ACTIONS:
        frames = load_frames(src, action)
        save_gif(frames, cycle_ms, docs / gif_name)
        rows.append((action, frames))

    save_strip(rows, docs / "v1-action-strips.png")


if __name__ == "__main__":
    main()
