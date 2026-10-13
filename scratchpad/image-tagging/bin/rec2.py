# rec2.py < lines "idx|room|mount|style|colors,comma,sep|quality|conf|alt text" (codes below). Pass-2 tags per distinct picture.
# room: L living_room B bedroom K kitchen D dining_room T bathroom S basement O office P patio_outdoor E entryway X other
# mount: W wall_mounted BI built_in R recessed M mantel_surround F freestanding IN insert TV tv_wall OT other U unknown
# conf: h m l.  A line "idx|=ref" copies ref's tags (alt text kept from ref).
import json, sys, os, datetime
D = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
P = f"{D}/progress.json"; prog = json.load(open(P))
R = dict(L="living_room", B="bedroom", K="kitchen", D="dining_room", T="bathroom", S="basement", O="office", P="patio_outdoor", E="entryway", X="other")
M = dict(W="wall_mounted", BI="built_in", R="recessed", M="mantel_surround", F="freestanding", IN="insert", TV="tv_wall", OT="other", U="unknown")
C = dict(h="high", m="medium", l="low")
for line in sys.stdin:
    line = line.strip()
    if not line: continue
    f = line.split("|")
    if f[1].startswith("="): prog["pass2"][f[0]] = dict(prog["pass2"][f[1][1:]]); continue
    if len(f) != 8: sys.exit(f"bad line: {line}")
    idx, room, mount, style, colors, q, conf, alt = f
    assert prog["pass1"].get(idx) == "installed", idx
    prog["pass2"][idx] = dict(room=R[room], mounting=M[mount], style=style, colors=[c.strip() for c in colors.split(",") if c.strip()],
                              quality=int(q), confidence=C[conf], alt_text=alt.strip())
    assert 1 <= int(q) <= 5
prog["updated"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
json.dump(prog, open(P + ".tmp", "w"), indent=0, sort_keys=True); os.replace(P + ".tmp", P)
reps = json.load(open(f"{D}/installed_reps.json"))
print("pass2 done:", sum(1 for r in reps if str(r) in prog["pass2"]), "/", len(reps))
