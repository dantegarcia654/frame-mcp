# Word-level transcript for frame edit.
#   python3 whisper_words.py <media> <out.json> [model]                 whole file
#   python3 whisper_words.py <wav> <out.json> [model] <offset> <keep_from> <keep_to>
# The second form transcribes one chunk of a longer file: words are shifted by <offset> and only words whose midpoint
# falls in [keep_from, keep_to) are kept, so overlapping chunks stitch without duplicates. frame edit runs several of
# these at once on long footage.
import json, os, sys, warnings
warnings.filterwarnings("ignore")
import whisper

src, out = sys.argv[1], sys.argv[2]
model_name = sys.argv[3] if len(sys.argv) > 3 else "base.en"
offset = float(sys.argv[4]) if len(sys.argv) > 4 else 0.0
keep_from = float(sys.argv[5]) if len(sys.argv) > 5 else -1e9
keep_to = float(sys.argv[6]) if len(sys.argv) > 6 else 1e9
model = whisper.load_model(model_name)
# One greedy pass: same words as the default on clean speech, and bounded time on noise (the default retries at higher
# temperatures, which can take longer than the clip). Noise then tends to come back as a loop, which frame edit detects.
r = model.transcribe(src, word_timestamps=True, fp16=False, language="en", temperature=0.0, condition_on_previous_text=False)
words = []
for s in r["segments"]:
    for w in s.get("words", []):
        t = w["word"].strip()
        a, b = w["start"] + offset, w["end"] + offset
        if t and keep_from <= (a + b) / 2 < keep_to:
            words.append({"text": t, "start": round(a, 2), "end": round(b, 2)})
with open(out + ".tmp", "w") as f:
    json.dump({"words": words, "text": " ".join(w["text"] for w in words)}, f)
os.replace(out + ".tmp", out)
