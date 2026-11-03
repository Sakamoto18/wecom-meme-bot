"""Transcribe one audio file with faster-whisper and print JSON segments.

Usage: python asr_transcribe.py AUDIO_PATH (16 kHz mono 16-bit WAV, as ffmpeg writes it)
Env: ASR_MODEL (model size or local model directory, default "small").
Output: [{"start": seconds, "end": seconds, "text": "..."}]
"""
import json
import os
import sys
import wave

import numpy as np


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: asr_transcribe.py AUDIO_PATH", file=sys.stderr)
        return 2
    from faster_whisper import WhisperModel

    model = WhisperModel(
        os.environ.get("ASR_MODEL", "small"),
        device="cpu",
        compute_type="int8",
        cpu_threads=max(1, os.cpu_count() or 1),
    )
    # Decode the WAV here: faster-whisper's own decoder depends on PyAV, whose
    # newer releases dropped an argument it passes.
    with wave.open(sys.argv[1], "rb") as audio_file:
        frames = audio_file.readframes(audio_file.getnframes())
    audio = np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0
    segments, _info = model.transcribe(
        audio,
        language="zh",
        vad_filter=True,
        beam_size=1,
        initial_prompt="以下是普通话的视频语音。",
    )
    rows = [
        {"start": round(segment.start, 2), "end": round(segment.end, 2), "text": segment.text.strip()}
        for segment in segments
        if segment.text.strip()
    ]
    # The Windows console code page is not UTF-8; write bytes so Node reads UTF-8.
    sys.stdout.buffer.write(json.dumps(rows, ensure_ascii=False).encode("utf-8"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
