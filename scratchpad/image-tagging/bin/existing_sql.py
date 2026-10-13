# Builds UPDATE statements for the existing asset_library rows: shopify_image_id + tagging columns only.
import json, os, re
D = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
fin = json.load(open(f"{D}/final.json")); ex = json.load(open(f"{D}/existing.json"))
by = {r["url"].split("?")[0]: r for r in fin}
a991 = next(r for r in fin if r["idx"] == 991)
extra = {
  "9401315557594": dict(shopify_image_id="42726648316122", width_px=2275, height_px=2560, setting="installed", room="living_room",
     mounting="freestanding", style="transitional", colors=["grey stacked stone", "natural oak cabinets", "cream walls", "orange flame"],
     quality=5, confidence="high",
     alt_text="Brown cast-iron style electric stove in front of a grey stacked-stone chimney between oak cabinets, below a round mirror and two sconces."),
  "8847176663258": dict({k: a991[k] for k in ("setting","room","mounting","style","colors","quality","confidence","alt_text")},
     shopify_image_id="38049819132122", width_px=1080, height_px=1080),
}
q = lambda v: "null" if v is None else ("'" + str(v).replace("'", "''") + "'")
arr = lambda a: "null" if a is None else "array[" + ",".join(q(x) for x in a) + "]::text[]"
stmts, used, report = [], set(), []
for e in ex:
    r = by.get(e["u"]) or extra.get(e["pid"])
    m = re.match(r"Imported from Shopify product: (.*) \(([^()]*)\)$", e["notes"] or "")
    brand, pname = (m.group(2), m.group(1)) if m else (None, None)
    if r["setting"] != "installed": brand_ok = True
    t = dict(r)
    t["featured_ok"] = bool(t["setting"] == "installed" and (t["quality"] or 0) >= 4 and (t["width_px"] or 0) >= 800)
    assert t["shopify_image_id"] not in used, t["shopify_image_id"]; used.add(t["shopify_image_id"])
    stmts.append(f"""update public.asset_library set shopify_image_id={q(t['shopify_image_id'])}, setting={q(t['setting'])}, room={q(t.get('room'))},
 mounting={q(t.get('mounting'))}, brand={q(brand)}, product_name={q(pname)}, style={q(t.get('style'))}, colors={arr(t.get('colors'))},
 quality={t.get('quality') if t.get('quality') else 'null'}, width_px={t['width_px'] or 'null'}, height_px={t['height_px'] or 'null'},
 featured_ok={'true' if t['featured_ok'] else 'false'}, alt_text={q(t.get('alt_text'))}, confidence={q(t.get('confidence'))}, tagged_at=now()
 where id={q(e['id'])} and shopify_image_id is null;""")
    report.append((e["id"], t["setting"], t.get("room"), t["featured_ok"], t["shopify_image_id"]))
open(f"{D}/update_existing.sql", "w").write("begin;\n" + "\n".join(stmts) + "\ncommit;\n")
json.dump(report, open(f"{D}/existing_report.json", "w"))
from collections import Counter
print(len(stmts), Counter(r[1] for r in report), "featured", sum(r[3] for r in report))
print(os.path.getsize(f"{D}/update_existing.sql"))
