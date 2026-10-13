# sheet.py <start_idx> [n=16] [cell=400]: 4x4 contact sheet of thumbs, cells labelled with idx; prints a legend.
import json, sys, os
from PIL import Image, ImageDraw, ImageFont
D = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
inv = json.load(open(f"{D}/inventory.json"))
# "r<page>" pages over distinct pictures (groups.json reps); "i<a>,<b>,..." shows chosen idx; else a start idx.
n = int(sys.argv[2]) if len(sys.argv) > 2 else 16
cell = int(sys.argv[3]) if len(sys.argv) > 3 else 400
arg = sys.argv[1]
if arg.startswith("r"):
    g = json.load(open(f"{D}/groups.json")); reps = sorted({int(v) for v in g.values()})
    page = int(arg[1:]); items = [inv[i] for i in reps[page*n:(page+1)*n]]; start = arg
elif arg.startswith("i"):
    items = [inv[int(i)] for i in arg[1:].split(",")]; start = "i" + str(items[0]["idx"])
else:
    start = int(arg); items = inv[start:start+n]
cols = 4; rows = (len(items) + 3) // 4
sheet = Image.new("RGB", (cols*cell, rows*cell), (255, 0, 255))
font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 34) if os.path.exists("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf") else ImageFont.load_default()
d = ImageDraw.Draw(sheet)
for k, c in enumerate(items):
    x, y = (k % cols)*cell, (k // cols)*cell
    try:
        im = Image.open(f"{D}/thumbs/{c['idx']}.img"); im.load()
        if im.mode in ("RGBA", "LA", "P"):
            im = im.convert("RGBA"); bg = Image.new("RGBA", im.size, (255, 0, 255, 255)); bg.alpha_composite(im); im = bg
        im = im.convert("RGB"); im.thumbnail((cell-8, cell-8))
        sheet.paste(im, (x + (cell-im.width)//2, y + (cell-im.height)//2))
    except Exception as e:
        d.text((x+10, y+60), f"ERR {e}"[:30], fill=(0,0,0))
    d.rectangle([x, y, x+cell-1, y+cell-1], outline=(0,0,0), width=3)
    d.rectangle([x+3, y+3, x+110, y+46], fill=(255,255,0)); d.text((x+8, y+6), str(c["idx"]), fill=(0,0,0), font=font)
out = f"{D}/sheets/s{start}.jpg"; sheet.save(out, quality=85); print(out)
for c in items:
    src = c.get("product_title") or c.get("source_title") or ""
    print(c["idx"], c["kind"], f'{c["width"]}x{c["height"]}', c["url"].split("?")[0].rsplit("/",1)[-1][:55], "|", src[:45])
