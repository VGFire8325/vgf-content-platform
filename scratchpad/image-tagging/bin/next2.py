# next2.py [k=4]: build k 2x2 800px sheets (sheets/n0..n{k-1}.jpg) of the next untagged installed pictures.
import json, sys, os, subprocess
D = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
k = int(sys.argv[1]) if len(sys.argv) > 1 else 4
p = json.load(open(f"{D}/progress.json"))
todo = [r for r in sorted(int(a) for a, v in p["pass1"].items() if v == "installed") if str(r) not in p["pass2"]]
print("remaining:", len(todo))
for s in range(k):
    ids = todo[s*4:(s+1)*4]
    if not ids: break
    out = subprocess.run([sys.executable, "-I", f"{D}/bin/sheet.py", "i" + ",".join(map(str, ids)), "4", "800"], capture_output=True, text=True).stdout.splitlines()
    os.replace(out[0], f"{D}/sheets/n{s}.jpg")
    for l in out[1:]: print(l[:110])
