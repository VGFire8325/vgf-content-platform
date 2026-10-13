# Rebuilds the in-scope image inventory from saved Shopify connector pages,
# mirroring src/lib/image-sync.ts collectCandidates(). Writes inventory.json.
import json, glob, re, sys, os
D = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
R = D + "/raw"
def nodes(pat, key):
    out = []
    for f in sorted(glob.glob(f"{R}/{pat}"), key=lambda p: int(re.search(r"_(\d+)\.json", p).group(1))):
        out += json.load(open(f))["data"][key]["nodes"]
    return out
num = lambda g: g.rsplit("/", 1)[-1] if g else None
norm = lambda u: (("https:" + u) if u.startswith("//") else u).split("?")[0].split("#")[0]
EXV = {"Extend", "Route"}; EXT = {"OPTIONS_HIDDEN_PRODUCT", "Extend Service Contract"}
NONPHOTO = re.compile(r"logo|wordmark|usp-\d|banner|shop_now|screen_?shot|screenshot|dimension|drawing|dall_e|chatgpt_image|blackfriday|_off\.png|buy_more|add_a_heading|financing|christmas_20|pre_?order|alexa_turn|more_heat|cast_iron_stove_ad|onlinepngtools|hqdefault|page-0001|disclai?mer|\.heic|\.gif|\.svg|icon|removebg", re.I)
AI = re.compile(r"dall[-_ ]?e|chatgpt", re.I)
out, ids, urls = [], set(), set()
skipped = []
def add(c):
    u = norm(c["url"])
    if AI.search(u.rsplit("/",1)[-1]): skipped.append((c["url"], "AI-generated filename")); return
    if c["image_id"] and c["image_id"] in ids: return
    if u in urls: return
    if c["image_id"]: ids.add(c["image_id"])
    urls.add(u); out.append(c)
for p in nodes("products_*.json", "products"):
    if p["vendor"] in EXV or p["productType"] in EXT: continue
    for m in p["media"]["nodes"]:
        im = m.get("image")
        if not im: continue
        add(dict(kind="product", image_id=num(im["id"]), url=im["url"], width=im["width"], height=im["height"],
                 product_id=num(p["id"]), product_title=p["title"], vendor=p["vendor"], product_type=p["productType"],
                 shopify_alt=m.get("alt") or None))
for line in open(f"{R}/collections.tsv"):
    t, i, u, w, h = line.rstrip("\n").split("\t")
    add(dict(kind="collection", image_id=i, url=u, width=int(w), height=int(h), source_title=t))
arts = nodes("articles_*.json", "articles")
for a in arts:
    im = a.get("image")
    if im: add(dict(kind="article", image_id=num(im["id"]), url=im["url"], width=im["width"], height=im["height"], source_title=a["title"], published=a["isPublished"], shopify_alt=im.get("altText")))
inline = []
for a in arts:
    for m in re.finditer(r'<img[^>]+src="([^"]+)"', a.get("body") or ""):
        s = m.group(1); s = "https:" + s if s.startswith("//") else s
        if s.startswith("https://cdn.shopify.com/"):
            inline.append(1); add(dict(kind="article_inline", image_id=None, url=s, width=None, height=None, source_title=a["title"], published=a["isPublished"]))
attached = set()
for p in nodes("allprod_*.json", "products"):
    for m in p["media"]["nodes"]: attached.add(num(m["id"]))
for f in nodes("files_*.json", "files"):
    im = f.get("image")
    if not im: continue
    i = num(im["id"])
    if i in attached: continue
    name = norm(im["url"]).rsplit("/",1)[-1]
    if NONPHOTO.search(name) or (im["width"] or 0) < 600: continue
    add(dict(kind="file", image_id=i, url=im["url"], width=im["width"], height=im["height"], shopify_alt=f.get("alt") or None))
# Inline article images: look up size from Files by URL when possible.
byurl = {norm(f["image"]["url"]): f["image"] for f in nodes("files_*.json","files") if f.get("image")}
for c in out:
    if c["kind"] == "article_inline":
        im = byurl.get(norm(c["url"]))
        if im: c["width"], c["height"], c["image_id"] = im["width"], im["height"], c["image_id"] or num(im["id"])
for n, c in enumerate(out): c["idx"] = n
json.dump(out, open(f"{D}/inventory.json", "w"), indent=0)
from collections import Counter
print(len(out), Counter(c["kind"] for c in out), "inline refs", len(inline), "AI skipped", len(skipped))
print("no size:", sum(1 for c in out if not c["width"]), "no id:", sum(1 for c in out if not c["image_id"]))
