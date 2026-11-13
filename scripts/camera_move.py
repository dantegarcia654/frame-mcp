#!/usr/bin/env python3
"""Camera Move: turn one still image into a depth-parallax camera move (2.5D, not a true 3D world).

Depth comes from Depth-Anything-V2-Small running locally. The camera path is warped per pixel in OpenCV and piped to ffmpeg.
Usage: camera_move.py IN.jpg OUT.mp4 --move push_in --seconds 4 --size 1080x1920 [--strength 1.0] [--depth-out depth.png]
Moves: push_in, pull_out, orbit, parallax, dolly_zoom
Honest limits: edges revealed behind foreground objects are stretched, not invented. Keep strength moderate (<=1.3).
"""
import argparse, math, subprocess, sys
import numpy as np, cv2
from PIL import Image

MOVES = {  # (tx, ty, tz) end values; tz>0 = dolly in. orbit/parallax are shaped by path() below
    'push_in': (0.0, 0.0, 0.16), 'pull_out': (0.0, 0.0, -0.16), 'orbit': (0.05, 0.012, 0.05),
    'parallax': (0.06, 0.0, 0.0), 'dolly_zoom': (0.0, 0.0, 0.2),
}

def ease(t): return t * t * (3 - 2 * t)

def path(move, t):
    """Camera offset at normalised time t in [0,1] -> (tx, ty, tz)."""
    tx, ty, tz = MOVES[move]
    if move == 'orbit':
        a = (t - 0.5) * math.pi
        return tx * math.sin(a), ty * math.cos(a), tz * ease(t)
    if move == 'parallax':
        return tx * math.cos(math.pi * t) * -1 + 0 * ty, 0.0, 0.0
    e = ease(t)
    return tx * e, ty * e, tz * e

def estimate_depth(img):
    from transformers import pipeline
    import torch
    dev = 'mps' if torch.backends.mps.is_available() else ('cuda' if torch.cuda.is_available() else 'cpu')
    pipe = pipeline('depth-estimation', model='depth-anything/Depth-Anything-V2-Small-hf', device=dev)
    d = np.array(pipe(Image.fromarray(img))['depth'], dtype=np.float32)
    d = (d - d.min()) / max(1e-6, d.max() - d.min())  # 1 = near, 0 = far
    return d

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('inp'); ap.add_argument('out')
    ap.add_argument('--move', default='push_in', choices=list(MOVES))
    ap.add_argument('--seconds', type=float, default=4.0)
    ap.add_argument('--fps', type=int, default=30)
    ap.add_argument('--size', default='1080x1920')
    ap.add_argument('--strength', type=float, default=1.0)
    ap.add_argument('--depth-out')
    a = ap.parse_args()
    W, H = (int(v) for v in a.size.lower().split('x'))

    src = cv2.cvtColor(cv2.imread(a.inp, cv2.IMREAD_COLOR), cv2.COLOR_BGR2RGB)
    # cover-crop the still to the output aspect, at 1.25x working size so the move has room
    sh, sw = src.shape[:2]
    scale = max(W / sw, H / sh) * 1.25
    nw, nh = int(sw * scale), int(sh * scale)
    big = cv2.resize(src, (nw, nh), interpolation=cv2.INTER_CUBIC)
    d = estimate_depth(src)
    d = cv2.resize(d, (nw, nh), interpolation=cv2.INTER_CUBIC)
    d = cv2.bilateralFilter(d, 9, 0.1, 9)  # smooth interiors, keep object edges
    if a.depth_out: cv2.imwrite(a.depth_out, (d * 255).astype(np.uint8))

    gx, gy = np.meshgrid(np.arange(W, dtype=np.float32), np.arange(H, dtype=np.float32))
    ox, oy = (nw - W) / 2, (nh - H) / 2          # crop origin of the output window in the big image
    cx, cy = nw / 2, nh / 2
    n = int(a.seconds * a.fps)
    ff = subprocess.Popen(['ffmpeg', '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{W}x{H}', '-r', str(a.fps), '-i', '-',
                           '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '17', '-preset', 'medium', '-movflags', '+faststart', a.out], stdin=subprocess.PIPE)
    k = a.strength
    for i in range(n):
        tx, ty, tz = path(a.move, i / max(1, n - 1))
        bx, by = gx + ox, gy + oy                   # base sample position in the big image
        z = cv2.remap(d, bx, by, cv2.INTER_LINEAR)  # depth under each output pixel
        if a.move == 'dolly_zoom':                  # background expands while the subject holds: zoom is inverse to nearness
            zoom = tz * k * (0.9 - z)
        else:                                       # near things move more than far things
            zoom = tz * k * (0.35 + 0.9 * z)
        mapx = bx + (bx - cx) * zoom * -1 + tx * k * nw * (z - 0.35)
        mapy = by + (by - cy) * zoom * -1 + ty * k * nh * (z - 0.35)
        frame = cv2.remap(big, mapx, mapy, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT)
        ff.stdin.write(frame.tobytes())
    ff.stdin.close(); rc = ff.wait()
    if rc: sys.exit(f'ffmpeg failed ({rc})')
    print(f'OK {a.out} {n} frames {W}x{H} move={a.move} depth=Depth-Anything-V2-Small')

if __name__ == '__main__': main()
