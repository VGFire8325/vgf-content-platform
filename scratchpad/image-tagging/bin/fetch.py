# fetch.py <width> <outdir> [idx...]: download ?width=N versions of inventory images (skips existing).
import json, sys, os, urllib.request, concurrent.futures as cf
D = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
inv = json.load(open(f"{D}/inventory.json"))
w, outdir = int(sys.argv[1]), sys.argv[2]
want = set(map(int, sys.argv[3:])) if len(sys.argv) > 3 else None
os.makedirs(outdir, exist_ok=True)
def get(c):
    p = f"{outdir}/{c['idx']}.img"
    if os.path.exists(p) and os.path.getsize(p) > 0: return None
    url = c["url"] + ("&" if "?" in c["url"] else "?") + f"width={w}"
    for _ in range(3):
        try:
            data = urllib.request.urlopen(url, timeout=30).read(); open(p, "wb").write(data); return None
        except Exception as e: err = str(e)
    return (c["idx"], err)
todo = [c for c in inv if want is None or c["idx"] in want]
with cf.ThreadPoolExecutor(12) as ex:
    errs = [r for r in ex.map(get, todo) if r]
print("done", len(todo), "errors", errs[:20], len(errs))
