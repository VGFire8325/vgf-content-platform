# rec.py "<idx><code> ..." : record pass-1 settings for distinct pictures (copies inherit via groups.json).
# Codes: I installed, P product_only, R render, D detail, G diagram, O other. Optional "!note" suffix: 12O!banner
import json, sys, os, re, datetime
D = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
P = f"{D}/progress.json"
prog = json.load(open(P)) if os.path.exists(P) else {"pass1": {}, "pass2": {}, "notes": {}}
M = dict(I="installed", P="product_only", R="render", D="detail", G="diagram", O="other")
for tok in " ".join(sys.argv[1:]).split():
    m = re.fullmatch(r"(\d+)([IPRDGO])(?:!(.+))?", tok)
    if not m: sys.exit(f"bad token {tok}")
    prog["pass1"][m.group(1)] = M[m.group(2)]
    if m.group(3): prog["notes"][m.group(1)] = m.group(3).replace("_", " ")
prog["updated"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
json.dump(prog, open(P + ".tmp", "w"), indent=0, sort_keys=True); os.replace(P + ".tmp", P)
g = json.load(open(f"{D}/groups.json")); reps = {int(v) for v in g.values()}
print("pass1 distinct done:", len(prog["pass1"]), "/", len(reps))
