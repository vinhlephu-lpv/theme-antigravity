#!/usr/bin/env python3
"""
Compile themes/themes.json + engine/core.js into dist/theme_payload.js.
Inlines local SVG and raster wallpaper assets (compressing >2560px rasters to WebP
when Pillow is available) so the CDP runtime payload stays self-contained.
"""

from __future__ import annotations

import argparse
import base64
import io
import json
import mimetypes
import sys
import urllib.parse
from pathlib import Path

ASSET_KEYS = ("wallpaper", "sticker", "cornerSvg", "userAvatar", "agentAvatar")
AVATAR_KEYS = {"userAvatar", "agentAvatar"}
AVATAR_MAX_DIM = 256
PLACEHOLDER = "/*__THEMES_PLACEHOLDER__*/{}"
BOOT_ASSETS_PLACEHOLDER = "/*__BOOT_ASSETS_PLACEHOLDER__*/{}"
DEFAULT_MAX_DIM = 2560
WEBP_QUALITY = 88


def encode_binary_data_uri(file_path: Path, default_mime: str = "application/octet-stream") -> str:
    raw = file_path.read_bytes()
    mime, _ = mimetypes.guess_type(str(file_path))
    if not mime:
        mime = default_mime
    return f"data:{mime};base64,{base64.b64encode(raw).decode('ascii')}"


def encode_svg(svg_path: Path) -> str:
    svg_text = svg_path.read_text(encoding="utf-8")
    return "data:image/svg+xml," + urllib.parse.quote(svg_text)


def encode_raster(img_path: Path, max_dim: int) -> str:
    try:
        from PIL import Image, ImageOps
    except ImportError:
        raw = img_path.read_bytes()
        mime, _ = mimetypes.guess_type(str(img_path))
        if not mime:
            mime = "image/png"
        if len(raw) > 2 * 1024 * 1024:
            print(
                f"[build_payload] Warning: Pillow not installed; embedding raw {img_path.name} "
                f"({len(raw) // 1024} KB). Install Pillow to auto-compress to 2K WebP.",
                file=sys.stderr,
            )
        return f"data:{mime};base64,{base64.b64encode(raw).decode('ascii')}"

    with Image.open(img_path) as img:
        img = ImageOps.exif_transpose(img)
        has_alpha = img.mode in ("RGBA", "LA", "PA") or (
            img.mode == "P" and "transparency" in img.info
        )
        img = img.convert("RGBA" if has_alpha else "RGB")

        w, h = img.size
        longest = max(w, h)
        if max_dim > 0 and longest > max_dim:
            scale = max_dim / float(longest)
            new_size = (max(1, int(round(w * scale))), max(1, int(round(h * scale))))
            resample = getattr(getattr(Image, "Resampling", Image), "LANCZOS")
            img = img.resize(new_size, resample)

        # Keep existing small WebP bytes untouched if already within budget and not resized.
        if img_path.suffix.lower() == ".webp" and longest <= max_dim:
            raw = img_path.read_bytes()
            if len(raw) <= 1.2 * 1024 * 1024:
                return f"data:image/webp;base64,{base64.b64encode(raw).decode('ascii')}"

        buf = io.BytesIO()
        img.save(buf, format="WEBP", quality=WEBP_QUALITY, method=4)
        encoded = base64.b64encode(buf.getvalue()).decode("ascii")
        return f"data:image/webp;base64,{encoded}"


def resolve_asset_value(value: object, themes_dir: Path, max_dim: int) -> object:
    if not isinstance(value, str):
        return value
    trimmed = value.strip()
    if (
        not trimmed
        or trimmed.startswith("data:")
        or trimmed.startswith("http://")
        or trimmed.startswith("https://")
    ):
        return trimmed

    asset_path = Path(trimmed)
    if not asset_path.is_absolute():
        asset_path = (themes_dir / asset_path).resolve()
    if not asset_path.is_file():
        raise FileNotFoundError(f"Theme asset not found: {trimmed} (resolved: {asset_path})")

    if asset_path.suffix.lower() == ".svg":
        return encode_svg(asset_path)
    if asset_path.suffix.lower() in (".mp4", ".webm", ".mov", ".m4v"):
        return encode_binary_data_uri(asset_path, "video/mp4")
    return encode_raster(asset_path, max_dim)


def build_payload(themes_path: Path, engine_path: Path, out_path: Path, max_dim: int) -> None:
    if not themes_path.is_file():
        raise FileNotFoundError(f"themes.json not found: {themes_path}")
    if not engine_path.is_file():
        raise FileNotFoundError(f"core.js not found: {engine_path}")

    themes_raw = json.loads(themes_path.read_text(encoding="utf-8"))
    if not isinstance(themes_raw, dict) or not themes_raw:
        raise ValueError("themes.json must be a non-empty JSON object keyed by theme name.")

    themes_dir = themes_path.parent
    resolved_themes: dict[str, dict] = {}
    for name, cfg in themes_raw.items():
        if not isinstance(cfg, dict):
            raise ValueError(f"Theme '{name}' must be a JSON object.")
        copied = dict(cfg)
        for key in ASSET_KEYS:
            if key in copied:
                target_dim = min(max_dim, AVATAR_MAX_DIM) if key in AVATAR_KEYS else max_dim
                copied[key] = resolve_asset_value(copied[key], themes_dir, target_dim)
        resolved_themes[name] = copied

    engine_src = engine_path.read_text(encoding="utf-8")
    count = engine_src.count(PLACEHOLDER)
    if count != 1:
        raise ValueError(
            f"Expected exactly 1 '{PLACEHOLDER}' placeholder in {engine_path}, found {count}."
        )

    themes_json = json.dumps(resolved_themes, ensure_ascii=False)
    compiled = engine_src.replace(PLACEHOLDER, themes_json, 1)

    if BOOT_ASSETS_PLACEHOLDER in compiled:
        assets_dir = themes_dir / "assets"
        boot_assets: dict[str, str] = {}
        candidates = {
            "starfieldBg": assets_dir / "starfield-boot-bg.jpg",
            "agyColorIcon": assets_dir / "agy-icon-color.png",
            "voice1": assets_dir / "voice" / "tawa_voice1.mp3",
            "voice2": assets_dir / "voice" / "tawa_voice2.mp3",
            "voice3": assets_dir / "voice" / "tawa_voice3.mp3",
            "voice4": assets_dir / "voice" / "tawa_voice4.mp3",
            "greetingFontVi": assets_dir / "fonts" / "mali-500-vi.woff2",
            "greetingFontLatinExt": assets_dir / "fonts" / "mali-500-latin-ext.woff2",
            "greetingFontLatin": assets_dir / "fonts" / "mali-500-latin.woff2",
        }
        for key, path in candidates.items():
            if path.is_file():
                suffix = path.suffix.lower()
                if suffix in (".jpg", ".jpeg", ".png", ".webp"):
                    max_d = 1920 if key == "starfieldBg" else 256
                    boot_assets[key] = encode_raster(path, max_d)
                elif suffix == ".woff2":
                    b64 = base64.b64encode(path.read_bytes()).decode("ascii")
                    boot_assets[key] = f"data:font/woff2;base64,{b64}"
                else:
                    boot_assets[key] = encode_binary_data_uri(path, "audio/mpeg")
        compiled = compiled.replace(
            BOOT_ASSETS_PLACEHOLDER,
            json.dumps(boot_assets, ensure_ascii=False),
            1,
        )

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(compiled, encoding="utf-8")

    size_kb = out_path.stat().st_size / 1024.0
    print(
        f"[build_payload] Built {out_path} ({size_kb:.1f} KB) with {len(resolved_themes)} theme(s): "
        + ", ".join(resolved_themes.keys())
    )


def main() -> int:
    repo_root = Path(__file__).resolve().parent.parent
    parser = argparse.ArgumentParser(description="Compile themes.json + engine/core.js -> dist/theme_payload.js")
    parser.add_argument("--themes", type=Path, default=repo_root / "themes" / "themes.json")
    parser.add_argument("--engine", type=Path, default=repo_root / "engine" / "core.js")
    parser.add_argument("--out", type=Path, default=repo_root / "dist" / "theme_payload.js")
    parser.add_argument("--max-dim", type=int, default=DEFAULT_MAX_DIM)
    args = parser.parse_args()

    build_payload(args.themes, args.engine, args.out, args.max_dim)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
