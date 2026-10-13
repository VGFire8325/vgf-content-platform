# Reads pixel size of inventory rows lacking width/height from the first 128 KB only.
import json, os, urllib.request, io
from PIL import ImageFile
D = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
inv = json.load(open(f"{D}/inventory.json"))
for c in inv:
    if c["width"]: continue
    req = urllib.request.Request(c["url"], headers={"Range": "bytes=0-131071"})
    data = urllib.request.urlopen(req, timeout=30).read()
    p = ImageFile.Parser(); p.feed(data)
    if p.image: c["width"], c["height"] = p.image.size
    print(c["idx"], c["url"].rsplit("/",1)[-1][:60], c["width"], c["height"], len(data))
json.dump(inv, open(f"{D}/inventory.json", "w"), indent=0)
