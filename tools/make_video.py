#!/usr/bin/env python3
"""Monta el vídeo demo (800x600, H.264) a partir de los frames capturados."""
import glob
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, ".."))
DEMO = os.path.join(ROOT, "dist", "demo")
FRAMES = os.path.join(DEMO, "frames")
WORK = os.path.join(DEMO, "build")
FONT_B = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
BG = "0x0f0d14"

SCENES = [
    # (id, segundos, estilo, captions [(texto, desde, hasta)])
    #   estilo 'popup' → el popup se ancla arriba y el texto va en la franja inferior
    #   estilo 'page'  → página a pantalla completa, texto arriba (no tapa el cartel de la bomba)
    ("a", 7.0, "popup", [("Todas tus pestañas, ordenadas por antigüedad", 0, 7),
                         ("la roja es la que está a punto de explotar", 3.5, 7)]),
    ("b", 17.0, "page", [("Al agotarse el TTL, la bomba se arma dentro de la página", 0, 9),
                         ("«Mantener viva» la salva en el último segundo", 9, 17)]),
    ("c", 9.0, "popup", [("Y los zombis que ya no quieres…", 0, 4.2),
                         ("…un clic y se cierran de verdad", 4.2, 9)]),
]


def run(cmd):
    p = subprocess.run(cmd, capture_output=True, text=True)
    if p.returncode != 0:
        print("FFMPEG FALLÓ:\n", " ".join(cmd), "\n", p.stderr[-1500:])
        sys.exit(1)


def caption_files():
    out = {}
    for sid, _dur, _style, caps in SCENES:
        paths = []
        for i, (text, _a, _b) in enumerate(caps):
            f = os.path.join(WORK, f"cap_{sid}_{i}.txt")
            with open(f, "w", encoding="utf-8") as fh:
                fh.write(text)
            paths.append(f)
        out[sid] = paths
    return out


def scene_video(sid, dur, style, caps, cap_paths, dst):
    files = sorted(glob.glob(os.path.join(FRAMES, sid, "*.jpg")))
    if not files:
        print("no hay frames para", sid)
        sys.exit(1)
    fps = max(1.0, round(len(files) / dur, 3))

    if style == "popup":
        # popup arriba (alto 552) y franja de 48 px abajo para el texto
        vf = [
            "scale=800:552:force_original_aspect_ratio=decrease",
            f"pad=800:600:(ow-iw)/2:0:color={BG}",
            "setsar=1",
        ]
        cap_y = "h-text_h-14"
    else:
        vf = [
            "scale=800:600:force_original_aspect_ratio=decrease",
            f"pad=800:600:(ow-iw)/2:(oh-ih)/2:color={BG}",
            "setsar=1",
        ]
        cap_y = "26"

    for i, (text, a, b) in enumerate(caps):
        vf.append(
            "drawtext=fontfile={f}:textfile={t}:fontcolor=white:fontsize=23:"
            "box=1:boxcolor=0x000000C0:boxborderw=14:"
            "x=(w-text_w)/2:y={y}:enable='between(t,{a},{b})'".format(
                f=FONT_B, t=cap_paths[i], a=a, b=b, y=cap_y
            )
        )
    vf.append("format=yuv420p")

    run([
        "ffmpeg", "-y", "-loglevel", "error",
        "-framerate", str(fps), "-i", os.path.join(FRAMES, sid, "%04d.jpg"),
        "-vf", ",".join(vf), "-r", "30",
        "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p",
        dst,
    ])


def card_video(img, dur, dst):
    run([
        "ffmpeg", "-y", "-loglevel", "error",
        "-loop", "1", "-i", img, "-t", str(dur), "-r", "30",
        "-vf", "fade=t=in:st=0:d=0.5,fade=t=out:st={}:d=0.6,format=yuv420p".format(dur - 0.7),
        "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p",
        dst,
    ])


def main():
    os.makedirs(WORK, exist_ok=True)
    caps = caption_files()
    parts = []

    title = os.path.join(WORK, "00_title.mp4")
    card_video(os.path.join(DEMO, "card_title.png"), 3.2, title)
    parts.append(title)

    for sid, dur, style, scaps in SCENES:
        dst = os.path.join(WORK, f"{sid}.mp4")
        scene_video(sid, dur, style, scaps, caps[sid], dst)
        parts.append(dst)
        print("  escena", sid, "ok")

    end = os.path.join(WORK, "99_end.mp4")
    card_video(os.path.join(DEMO, "card_end.png"), 4.5, end)
    parts.append(end)

    lst = os.path.join(WORK, "list.txt")
    with open(lst, "w", encoding="utf-8") as fh:
        for p in parts:
            fh.write("file '{}'\n".format(p))

    out = os.path.join(DEMO, "tab-bomb-demo.mp4")
    run([
        "ffmpeg", "-y", "-loglevel", "error",
        "-f", "concat", "-safe", "0", "-i", lst,
        "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
        "-shortest",
        "-c:v", "libx264", "-preset", "medium", "-crf", "21", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "64k", "-movflags", "+faststart",
        out,
    ])
    print("vídeo:", out, os.path.getsize(out) // 1024, "KB")


if __name__ == "__main__":
    main()
