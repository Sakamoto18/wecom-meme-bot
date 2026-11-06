"""Transcribe one audio file with faster-whisper and print JSON segments.

Usage: python asr_transcribe.py AUDIO_PATH (16 kHz mono 16-bit WAV captured from browser audio)
Env: ASR_MODEL (model size or local model directory, default "small").
Output: [{"start": seconds, "end": seconds, "text": "..."}]
"""
import json
import os
import sys
import wave
import time

import numpy as np


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: asr_transcribe.py AUDIO_PATH", file=sys.stderr)
        return 2
    started = time.monotonic()
    def progress(stage, **values):
        print(json.dumps({'stage': stage, 'elapsedSeconds': round(time.monotonic() - started, 2), **values}), file=sys.stderr, flush=True)
    progress('import')
    from faster_whisper import WhisperModel
    progress('model_loading')

    model = WhisperModel(
        os.environ.get("ASR_MODEL", "small"),
        device="cpu",
        compute_type="int8",
        cpu_threads=max(1, os.cpu_count() or 1),
    )
    progress('model_loaded')
    # Decode the WAV here: faster-whisper's own decoder depends on PyAV, whose
    # newer releases dropped an argument it passes.
    with wave.open(sys.argv[1], "rb") as audio_file:
        if audio_file.getframerate() != 16000 or audio_file.getnchannels() != 1 or audio_file.getsampwidth() != 2:
            raise ValueError('ASR expects 16 kHz mono PCM16 WAV')
        frames = audio_file.readframes(audio_file.getnframes())
    audio = np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0
    progress('transcribing', audioSeconds=round(len(audio) / 16000, 2))
    segments, _info = model.transcribe(
        audio,
        language="zh",
        vad_filter=True,
        beam_size=1,
        # The default temperature fallback retries difficult/silent tails six
        # times; on CPU this can cost more than the whole spoken passage.
        temperature=0,
        condition_on_previous_text=False,
        initial_prompt="以下是普通话的视频语音。",
    )
    rows = []
    progress_path = os.environ.get('ASR_PROGRESS_PATH')
    for segment in segments:
        if not segment.text.strip() or segment.start >= len(audio) / 16000:
            continue
        row = {'start': round(segment.start, 2), 'end': round(min(segment.end, len(audio) / 16000), 2), 'text': segment.text.strip()}
        rows.append(row)
        if progress_path:
            with open(progress_path, 'a', encoding='utf-8') as output:
                output.write(json.dumps(row, ensure_ascii=False) + '\n')
        progress('segment', end=row['end'])
    progress('complete', segments=len(rows))
    # The Windows console code page is not UTF-8; write bytes so Node reads UTF-8.
    sys.stdout.buffer.write(json.dumps(rows, ensure_ascii=False).encode("utf-8"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
