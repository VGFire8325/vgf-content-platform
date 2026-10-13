# Groups visually identical thumbnails (dHash 16x16 + aspect ratio); writes groups.json {idx: rep_idx}.
import json, os
from PIL import Image
D = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
inv = json.load(open(f"{D}/inventory.json"))
def dhash(p):
    im = Image.open(p); im.load()
    if im.mode in ("RGBA","LA","P"):
        im = im.convert("RGBA"); bg = Image.new("RGBA", im.size, (255,0,255,255)); bg.alpha_composite(im); im = bg
    g = im.convert("L").resize((17,16)); px = list(g.getdata())
    return sum(1 << i for i in range(256) if px[(i//16)*17 + i%16] > px[(i//16)*17 + i%16 + 1]), im.width/im.height
hs = {}
for c in inv: hs[c["idx"]] = dhash(f"{D}/thumbs/{c['idx']}.img")
rep = {}; reps = []
for c in inv:
    h, ar = hs[c["idx"]]
    for r in reps:
        rh, rar = hs[r]
        if abs(ar-rar) < 0.03 and bin(h ^ rh).count("1") <= 12: rep[c["idx"]] = r; break
    else: reps.append(c["idx"]); rep[c["idx"]] = c["idx"]
json.dump(rep, open(f"{D}/groups.json","w"))
print("unique pictures:", len(reps), "of", len(inv))
