#!/usr/bin/env python3
"""Frame cutout helper for machines without Apple Vision: person matte per frame with rembg's u2net_human_seg.

Same protocol as scripts/cutout.swift:
  stdin   raw BGRA frames, W x H each
  stdout  one 8-bit matte per frame, W x H bytes (255 = person)
  argv    <W> <H> <fast|balanced|accurate> <track.jsonl>
  track   one JSON line per frame: {"f": face box or null, "p": box around the matte or null, "c": coverage}, boxes 0..1
The network sees a 320x320 picture, so the matte is coarse; when OpenCV's ximgproc module is installed a guided filter
snaps it back to the real edges. Faces come from OpenCV's frontal-face Haar cascade when OpenCV is installed.
"""
import json
import sys

import numpy as np
from PIL import Image
from rembg import new_session

W, H, quality, track_path = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3], sys.argv[4]
session = new_session('u2net_human_seg')
try:
    import cv2
    guided = hasattr(cv2, 'ximgproc')
    faces = cv2.CascadeClassifier(cv2.data.haarcascades + 'haarcascade_frontalface_default.xml')
    if faces.empty():
        faces = None
except Exception:
    cv2, guided, faces = None, False, None

frame_bytes = W * H * 4
inp, out = sys.stdin.buffer, sys.stdout.buffer


def r4(v):
    return round(float(v), 4)


with open(track_path, 'w') as track:
    while True:
        buf = inp.read(frame_bytes)
        if len(buf) < frame_bytes:
            break
        rgb = np.ascontiguousarray(np.frombuffer(buf, np.uint8).reshape(H, W, 4)[..., [2, 1, 0]])
        mask = np.array(session.predict(Image.fromarray(rgb))[0].convert('L').resize((W, H), Image.BILINEAR))
        if guided and quality != 'fast':
            mask = cv2.ximgproc.guidedFilter(guide=rgb, src=mask, radius=max(4, W // 160), eps=(0.02 * 255) ** 2)
        mask = np.ascontiguousarray(mask.astype(np.uint8))
        face = None
        if faces is not None:
            small = cv2.resize(cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY), (W // 2, H // 2))
            found = faces.detectMultiScale(small, 1.15, 5)
            if len(found):
                x, y, w, h = max(found, key=lambda b: b[2] * b[3])
                face = [r4(2 * x / W), r4(2 * y / H), r4(2 * (x + w) / W), r4(2 * (y + h) / H)]
        on = mask > 127
        cover = float(on.mean())
        person = None
        if on.any():
            ys, xs = np.where(on)
            person = [r4(xs.min() / W), r4(ys.min() / H), r4((xs.max() + 1) / W), r4((ys.max() + 1) / H)]
        track.write(json.dumps({'f': face, 'p': person, 'c': r4(cover)}) + '\n')
        out.write(mask.tobytes())
        out.flush()
