#!/usr/bin/env python3
"""Empaqueta dist/chrome y dist/firefox en zip (sin depender del binario `zip`)."""
import os
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
DIST = os.path.normpath(os.path.join(HERE, "..", "dist"))

for target in ("chrome", "firefox"):
    src = os.path.join(DIST, target)
    out = os.path.join(DIST, f"tab-bomb-{target}.zip")
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for root, _dirs, files in os.walk(src):
            for name in sorted(files):
                full = os.path.join(root, name)
                arc = os.path.relpath(full, src)
                z.write(full, arc)
                print(" ", target, "+", arc)
    print("->", out, os.path.getsize(out), "bytes")
