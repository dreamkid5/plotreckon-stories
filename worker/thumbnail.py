#!/usr/bin/env python3
"""
Generate a storytime YouTube thumbnail (1280x720) in the dark editorial style:
a near-black left panel with a bold uppercase hook (mostly white, the meatiest
clause in magenta), a bright yellow "kicker" banner along the bottom-left, and the
presenter photo on the right. All free, drawn with Pillow.

Usage:
  python3 thumbnail.py <portrait_jpg> <hook_text> <out_path> <width> <height> <font_path>
"""
import sys, re

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:
    sys.exit("Pillow not installed. Run: pip install pillow")

# Palette sampled to match the reference thumbnail.
BG      = (12, 12, 14)     # near-black panel
WHITE   = (255, 255, 255)
MAGENTA = (232, 33, 143)   # the emphasised clause
YELLOW  = (247, 202, 24)   # the kicker banner
BLACK   = (10, 10, 10)     # kicker text on yellow


def clauses(text):
    """Split the hook into clause-level pieces at sentence enders and commas."""
    text = re.sub(r"\s+", " ", text).strip()
    parts = re.split(r'(?<=[.!?,;:…])\s+', text)
    return [p.strip() for p in parts if p.strip()]


def wrap(words, font, max_w):
    """Greedy word-wrap a list of (word, colour) into lines that fit max_w."""
    lines, cur, cur_w = [], [], 0
    space = font.getlength(" ")
    for w, col in words:
        ww = font.getlength(w)
        add = ww if not cur else cur_w + space + ww
        if cur and add > max_w:
            lines.append(cur)
            cur, cur_w = [(w, col)], ww
        else:
            cur.append((w, col))
            cur_w = add
    if cur:
        lines.append(cur)
    return lines


def main():
    portrait, hook, out_path = sys.argv[1], sys.argv[2], sys.argv[3]
    W = int(sys.argv[4]) if len(sys.argv) > 4 else 1280
    H = int(sys.argv[5]) if len(sys.argv) > 5 else 720
    font_path = sys.argv[6]

    canvas = Image.new("RGB", (W, H), BG)

    # --- presenter on the right, cover-cropped from the top so the head is kept ---
    panel_w = int(W * 0.40)
    try:
        p = Image.open(portrait).convert("RGB")
        pw, ph = p.size
        scale = max(panel_w / pw, H / ph)
        p = p.resize((int(pw * scale), int(ph * scale)), Image.LANCZOS)
        left = (p.width - panel_w) // 2
        p = p.crop((left, 0, left + panel_w, H))
        # feather the leftmost slice so the photo melts into the dark panel
        feather = int(panel_w * 0.22)
        mask = Image.new("L", (panel_w, H), 255)
        mpx = mask.load()
        for x in range(feather):
            a = int(255 * (x / feather))
            for y in range(H):
                mpx[x, y] = a
        canvas.paste(p, (W - panel_w, 0), mask)
    except Exception as e:
        sys.stderr.write("thumbnail: portrait skipped (%s)\n" % e)

    draw = ImageDraw.Draw(canvas)
    cls = clauses(hook)
    if not cls:
        canvas.save(out_path, quality=92)
        return

    # The last clause becomes the yellow kicker banner (kept short and punchy). The
    # single meatiest of the remaining clauses is drawn in magenta; the rest white.
    kicker = cls[-1]
    kwords = kicker.split()
    if len(kwords) > 6:
        kicker = " ".join(kwords[-6:])
    main_cls = cls[:-1] if len(cls) > 1 else cls
    magenta_idx = max(range(len(main_cls)), key=lambda i: len(main_cls[i])) if main_cls else -1

    words = []
    for i, c in enumerate(main_cls):
        colour = MAGENTA if i == magenta_idx else WHITE
        for w in c.split():
            words.append((w.upper(), colour))

    pad = int(W * 0.03)
    text_w = W - panel_w - pad - int(W * 0.02)   # left of the presenter
    banner_h = int(H * 0.17)
    top_h = H - banner_h - pad

    # --- auto-fit the main hook into the area above the banner ---
    size = int(H * 0.115)
    while size >= 24:
        font = ImageFont.truetype(font_path, size)
        lines = wrap(words, font, text_w)
        line_h = int(size * 1.12)
        if len(lines) * line_h <= top_h - pad:
            break
        size -= 2
    font = ImageFont.truetype(font_path, size)
    lines = wrap(words, font, text_w)
    line_h = int(size * 1.12)
    space = font.getlength(" ")

    y = pad + max(0, (top_h - pad - len(lines) * line_h) // 2)
    for ln in lines:
        x = pad
        for w, colour in ln:
            draw.text((x, y), w, font=font, fill=colour)
            x += font.getlength(w) + space
        y += line_h

    # --- yellow kicker banner along the bottom-left ---
    if kicker:
        bsize = int(banner_h * 0.5)
        bfont = ImageFont.truetype(font_path, bsize)
        ktext = kicker.upper()
        while bfont.getlength(ktext) > text_w and bsize > 20:
            bsize -= 2
            bfont = ImageFont.truetype(font_path, bsize)
        tw = bfont.getlength(ktext)
        by0 = H - banner_h
        pad_b = int(bsize * 0.4)
        draw.rectangle((pad - pad_b // 2, by0, pad + tw + pad_b, by0 + banner_h - pad // 2), fill=YELLOW)
        draw.text((pad + pad_b // 2, by0 + (banner_h - pad // 2 - bsize) // 2 - int(bsize * 0.05)),
                  ktext, font=bfont, fill=BLACK)

    canvas.save(out_path, quality=92)
    sys.stderr.write("thumbnail: wrote %s (font %dpx, %d lines)\n" % (out_path, size, len(lines)))


main()
