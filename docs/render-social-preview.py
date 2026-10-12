#!/usr/bin/env python3
"""Render the GitHub card for this repository: docs/github-social-preview.png.

GitHub wants 1280x640 for the image shown when the repo is shared (Settings ->
General -> Social preview), and the only honest way to draw one for Slip is with
Slip's own pieces: the paper palette straight out of public/assets/styles/app.css,
Instrument Serif italic for the wordmark, Inter for the copy, JetBrains Mono for
anything that is a literal URL. Nothing is downloaded and nothing is invented -
the fonts are converted from the WOFF2 files the site already serves.

Needs two libraries that the app itself does not: Pillow and fontTools.

    python3 docs/render-social-preview.py
"""


import sys
import tempfile
from pathlib import Path

from fontTools.ttLib import TTFont
from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parent
FONT_DIR = HERE.parent / "public" / "assets" / "fonts"
# Unpacked into a temporary directory: these are build products, not source.
CACHE = Path(tempfile.mkdtemp(prefix="slip-fonts-"))
SRC = {
    "serif": "instrument-serif-italic-latin",
    "sans": "inter-normal-latin",
    "mono": "jbmono-normal-latin",
}
TT = {}
for key, stem in SRC.items():
    TT[key] = CACHE / f"{stem}.ttf"
    font = TTFont(FONT_DIR / f"{stem}.woff2")
    font.flavor = None
    font.save(TT[key])

CMAP = {k: set(TTFont(v).getBestCmap().keys()) for k, v in TT.items()}


def has(font_key: str, text: str) -> bool:
    return all(ord(c) in CMAP[font_key] for c in text if ord(c) > 32)


def load(font_key: str, size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(TT[font_key], size)


def tracked(draw, xy, text, font, fill, tracking=0):
    """Draw text letter by letter, because the design tracks its small caps."""
    x, y = xy
    for ch in text:
        draw.text((x, y), ch, font=font, fill=fill)
        x += draw.textlength(ch, font=font) + tracking
    return x - tracking


def tracked_width(draw, text, font, tracking=0):
    return sum(draw.textlength(c, font=font) + tracking for c in text) - tracking


BG = (246, 244, 237)
RAISED = (253, 252, 248)
INK = (40, 38, 29)
INK2 = (92, 89, 76)
INK3 = (143, 140, 124)
LINE = (228, 225, 211)
LINE_STRONG = (208, 204, 186)
ACCENT = (62, 105, 73)
ACCENT_INK = (243, 246, 239)

W, H = 1280, 640
M = 72

img = Image.new("RGB", (W, H), BG)
d = ImageDraw.Draw(img)

# --- header band: the wordmark and the tracked tagline, over one hairline -------
word = load("serif", 78)
dot = load("serif", 78)
d.text((M, 40), "Slip", font=word, fill=INK)
word_w = d.textlength("Slip", font=word)
d.text((M + word_w, 40), ".", font=dot, fill=ACCENT)

tag = load("sans", 19)
tag_text = "TEXT & LINKS THAT FADE"
tag_w = tracked_width(d, tag_text, tag, 5)
tracked(d, (W - M - tag_w, 62), tag_text, tag, INK3, 5)

d.line([(M, 148), (W - M, 148)], fill=LINE, width=1)

# --- the composer: three tabs, one real URL, one honest note -------------------
panel = (M, 196, W - M, 452)
d.rounded_rectangle(panel, radius=14, fill=RAISED, outline=LINE, width=1)

tabs = load("sans", 20)
x = panel[0] + 32
for label, active in (("A SLIP", False), ("A LINK", True), ("A FILE", False)):
    w = tracked_width(d, label, tabs, 2)
    box = (x, 232, x + w + 34, 232 + 44)
    if active:
        d.rounded_rectangle(box, radius=9, fill=ACCENT)
        tracked(d, (box[0] + 17, 244), label, tabs, ACCENT_INK, 2)
    else:
        d.rounded_rectangle(box, radius=9, fill=None, outline=LINE_STRONG, width=1)
        tracked(d, (box[0] + 17, 244), label, tabs, INK2, 2)
    x = box[2] + 10

url_font = load("mono", 30)
url = "purepaste.byaislop.workers.dev/l/8fk2mqxv3t"
d.text((panel[0] + 32, 306), url, font=url_font, fill=INK)

ttl = load("sans", 19)
ttl_text = "fades in 7 days"
d.text((panel[2] - 32 - d.textlength(ttl_text, font=ttl), 316), ttl_text, font=ttl, fill=INK3)

note = load("sans", 20)
d.text(
    (panel[0] + 32, 356),
    "short for a long destination, and readers are shown where it goes before anyone hops",
    font=note,
    fill=INK2,
)

d.line([(panel[0] + 32, 400), (panel[2] - 32, 400)], fill=LINE, width=1)

fine = load("sans", 19)
parts = ["no accounts", "nothing listed", "no analytics", "no third-party requests"]
x = panel[0] + 32
for i, part in enumerate(parts):
    x = tracked(d, (x, 416), part.upper(), fine, INK3, 2)
    if i < len(parts) - 1:
        d.text((x + 12, 416), "/", font=fine, fill=LINE_STRONG)
        x += 12 + d.textlength("/", font=fine) + 12

# --- footer band ----------------------------------------------------------------
left = load("sans", 20)
line1 = "Open source under the MIT licence: one Cloudflare Worker, D1 for metadata,"
line2 = "KV or any S3-compatible bucket for bodies, and a cron that sweeps."
d.text((M, 500), line1, font=left, fill=INK2)
d.text((M, 532), line2, font=left, fill=INK2)

repo_font = load("mono", 20)
repo = "github.com/mahimmazidul/PurePaste"
repo_w = d.textlength(repo, font=repo_font)
left_w = d.textlength(line2, font=left)
gap = W - M - repo_w - (M + left_w)
if gap < 48:
    sys.exit(f"footer collides: {gap:.0f}px of clearance")
d.text((W - M - repo_w, 530), repo, font=repo_font, fill=INK)
d.line([(M, 592), (W - M, 592)], fill=LINE, width=1)

copy = [ttl_text, "short for a long destination, and readers are shown where it goes before anyone hops", line1, line2, tag_text]
# The subsets only carry what the site needs, so check the copy against them rather
# than discovering holes in the rendered image.
missing = [t for t in copy if not has("sans", t)] + [t for t in (url, repo) if not has("mono", t)]
if missing:
    sys.exit("the latin subset is missing glyphs for: " + " | ".join(missing))

out = HERE / "github-social-preview.png"
img.save(out, "PNG", optimize=True)
print("wrote", out)
