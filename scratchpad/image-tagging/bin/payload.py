# payload.py existing|insert [start] [n]: compact JSON rows for jsonb_to_recordset (keys: i=shopify_image_id, s,r,m,b,p,y=style,c=colors,q,w,h,f,a=alt,k=confidence, plus id / u,n,pid for inserts).
import json, os, re, sys
D = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
fin = json.load(open(f"{D}/final.json")); ex = json.load(open(f"{D}/existing.json"))
by = {r["url"].split("?")[0]: r for r in fin}
def tags(r):
    d = dict(i=r["shopify_image_id"], s=r["setting"], w=r["width_px"], h=r["height_px"])
    if r["setting"] == "installed":
        d.update(r=r["room"], m=r["mounting"], y=r["style"], c=r["colors"], q=r["quality"], a=r["alt_text"], k=r["confidence"])
    d["f"] = bool(r["setting"] == "installed" and r["quality"] >= 4 and (r["width_px"] or 0) >= 800)
    return d
SKIP_NOTE = re.compile(r"logo|promo[ _]banner|irrelevant|not[ _]electric|AI-generated|website[ _]screenshot|holiday|trade[ _]show|two[ _]photo|brochure", re.I)
def skip_reason(r):
    if r["setting"] == "diagram": return "diagram"
    if r["setting"] == "other" and r["note"] and SKIP_NOTE.search(r["note"]): return r["note"]
    return None
mode = sys.argv[1]
if mode == "existing":
    a991 = next(r for r in fin if r["idx"] == 991)
    extra = {"9401315557594": dict(shopify_image_id="42726648316122", width_px=2275, height_px=2560, setting="installed", room="living_room",
        mounting="freestanding", style="transitional", colors=["grey stacked stone","natural oak cabinets","cream walls","orange flame"], quality=5,
        confidence="high", alt_text="Brown cast-iron style electric stove in front of a grey stacked-stone chimney between oak cabinets, below a round mirror and two sconces."),
        "8847176663258": dict(a991, shopify_image_id="38049819132122", width_px=1080, height_px=1080)}
    out = []
    for e in ex:
        r = by.get(e["u"]) or extra[e["pid"]]
        m = re.match(r"Imported from Shopify product: (.*) \(([^()]*)\)$", e["notes"] or "")
        d = tags(r); d["id"] = e["id"]
        if m: d["b"], d["p"] = m.group(2), m.group(1)
        out.append(d)
else:
    exu = {e["u"] for e in ex}
    out = []
    for r in fin:
        if r["url"].split("?")[0] in exu or skip_reason(r): continue
        if r["setting"] not in ("installed", "product_only"): continue  # option (b): render/other/detail not inserted
        d = tags(r); d["u"] = r["url"]; d["pid"] = r["shopify_product_id"]
        if r["kind"] == "product": d["b"], d["p"] = r["brand"], r["product_name"]; d["n"] = f"Imported from Shopify product: {r['product_name']} ({r['brand']})"
        elif r["kind"] == "collection": d["n"] = f"Collection image: {r['source_title']}"
        elif r["kind"] in ("article", "article_inline"): d["n"] = f"Article image: {r['source_title']}"
        else: d["n"] = "Shopify Files"
        out.append(d)
    st = int(sys.argv[2]) if len(sys.argv) > 2 else 0; n = int(sys.argv[3]) if len(sys.argv) > 3 else len(out)
    sys.stderr.write(f"total insert rows {len(out)}\n"); out = out[st:st+n]
print(json.dumps([{k: v for k, v in d.items() if v not in (None, False)} for d in out], separators=(",", ":"), ensure_ascii=False))
