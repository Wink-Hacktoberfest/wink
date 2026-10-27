# Wink app icon: soft-white tile, black glasses, left eye open (sage pupil), right eye winking.
import sys
from PIL import Image, ImageDraw, ImageFilter

S = 2048  # draw at 2x, downsample for smooth edges
out = sys.argv[1]
INK = (23, 25, 24)
SAGE = (84, 130, 107)

# Soft vertical paper gradient (opaque, as iOS requires).
img = Image.new("RGB", (S, S))
top, bottom = (252, 252, 250), (232, 232, 228)
for y in range(S):
    t = y / (S - 1)
    c = tuple(round(top[i] + (bottom[i] - top[i]) * t) for i in range(3))
    ImageDraw.Draw(img).line([(0, y), (S, y)], fill=c)

# Soft shadow under the frames.
shadow = Image.new("L", (S, S), 0)
sd = ImageDraw.Draw(shadow)
cy, r, gap, w = 1060, 380, 150, 92
lx, rx = S // 2 - gap // 2 - r, S // 2 + gap // 2 + r
for x in (lx, rx):
    sd.rounded_rectangle([x - r, cy - r * 0.86 + 60, x + r, cy + r * 0.86 + 60], radius=r * 0.62, fill=90)
shadow = shadow.filter(ImageFilter.GaussianBlur(70))
img.paste(Image.new("RGB", (S, S), (190, 190, 184)), (0, 0), shadow)

d = ImageDraw.Draw(img)
# Lenses: rounded wayfarer-ish frames with a light fill.
for x in (lx, rx):
    box = [x - r, cy - r * 0.86, x + r, cy + r * 0.86]
    d.rounded_rectangle(box, radius=r * 0.62, fill=(247, 247, 245), outline=INK, width=w)
# Bridge and temples.
d.line([(lx + r - 40, cy - r * 0.42), (rx - r + 40, cy - r * 0.42)], fill=INK, width=w - 14)
d.line([(lx - r + 10, cy - r * 0.55), (lx - r - 70, cy - r * 0.66)], fill=INK, width=w - 10)
d.line([(rx + r - 10, cy - r * 0.55), (rx + r + 70, cy - r * 0.66)], fill=INK, width=w - 10)

# Left eye: open, sage iris with a white glint.
d.ellipse([lx - 120, cy - 120, lx + 120, cy + 120], fill=SAGE)
d.ellipse([lx - 52, cy - 52, lx + 52, cy + 52], fill=INK)
d.ellipse([lx + 30, cy - 80, lx + 80, cy - 30], fill=(255, 255, 255))

# Right eye: the wink, a thick downward smile-arc.
d.arc([rx - 175, cy - 150, rx + 175, cy + 120], start=20, end=160, fill=INK, width=72)

# Small sparkle above the winking lens.
sx, sy, k = rx + r - 40, cy - r - 120, 95
d.polygon([(sx, sy - k), (sx + k * 0.28, sy - k * 0.28), (sx + k, sy), (sx + k * 0.28, sy + k * 0.28),
           (sx, sy + k), (sx - k * 0.28, sy + k * 0.28), (sx - k, sy), (sx - k * 0.28, sy - k * 0.28)], fill=SAGE)

img.resize((1024, 1024), Image.LANCZOS).save(out, "PNG")
print("wrote", out)
