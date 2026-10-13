# Expands progress.json over all inventory rows (copies inherit their group's tags) -> final.json, prints counts.
import json, os
from collections import Counter
D = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
inv = json.load(open(f"{D}/inventory.json")); g = json.load(open(f"{D}/groups.json")); p = json.load(open(f"{D}/progress.json"))
out = []
for c in inv:
    r = str(g[str(c["idx"])]); s = p["pass1"][r]; t = p["pass2"].get(r, {}) if s == "installed" else {}
    row = dict(idx=c["idx"], kind=c["kind"], shopify_image_id=c["image_id"], url=c["url"], width_px=c["width"], height_px=c["height"],
               shopify_product_id=c.get("product_id"), setting=s, note=p["notes"].get(r),
               brand=c.get("vendor") if c["kind"] == "product" else None,
               product_name=c.get("product_title") if c["kind"] == "product" else None,
               source_title=c.get("source_title") or c.get("product_title"))
    if s == "installed":
        row.update(room=t["room"], mounting=t["mounting"], style=t["style"], colors=t["colors"], quality=t["quality"],
                   confidence=t["confidence"], alt_text=t["alt_text"])
    else:
        row.update(room=None, mounting=None, style=None, colors=None, quality=None, confidence=None, alt_text=None)
    row["featured_ok"] = bool(s == "installed" and row["quality"] >= 4 and (row["width_px"] or 0) >= 800)
    out.append(row)
json.dump(out, open(f"{D}/final.json", "w"), indent=0)
C = Counter
print("setting:", dict(C(r["setting"] for r in out)))
inst = [r for r in out if r["setting"] == "installed"]
print("installed by room:", dict(C(r["room"] for r in inst)))
fo = [r for r in inst if r["featured_ok"]]
print("featured_ok:", len(fo), dict(C(r["room"] for r in fo)))
print("confidence:", dict(C(r["confidence"] for r in inst)))
print("by kind x setting:", dict(C((r["kind"], r["setting"]) for r in out)))
