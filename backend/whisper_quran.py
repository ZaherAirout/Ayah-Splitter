"""Quran transcription with word-level timestamps.

Uses the CTranslate2 conversion of Tarteel's Quran-tuned Whisper base model for
much faster CPU inference while preserving the same underlying fine-tuned
weights. Long files are processed in overlapping windows to keep memory bounded
and to provide steady progress updates.
"""

import logging
import os

import numpy as np
from pydub import AudioSegment

logger = logging.getLogger(__name__)

MODEL_NAME = os.getenv("QURAN_WHISPER_MODEL", "OdyAsh/faster-whisper-base-ar-quran")
_SAMPLE_RATE = 16000
_SEGMENT_KEEP_MS = 180_000
_SEGMENT_OVERLAP_MS = 5_000
_DEVICE = os.getenv("QURAN_WHISPER_DEVICE", "cpu")
_COMPUTE_TYPE = os.getenv("QURAN_WHISPER_COMPUTE_TYPE", "int8")
_BEAM_SIZE = max(1, int(os.getenv("QURAN_WHISPER_BEAM_SIZE", "5")))

_model = None


def _get_model():
    global _model
    if _model is None:
        from faster_whisper import WhisperModel

        logger.info(
            "Loading '%s' with faster-whisper (device=%s, compute_type=%s)...",
            MODEL_NAME,
            _DEVICE,
            _COMPUTE_TYPE,
        )
        _model = WhisperModel(
            MODEL_NAME,
            device=_DEVICE,
            compute_type=_COMPUTE_TYPE,
        )
        logger.info("ASR model loaded.")
    return _model


def _audio_to_array(audio: AudioSegment) -> np.ndarray:
    audio = audio.set_frame_rate(_SAMPLE_RATE).set_channels(1)
    samples = np.array(audio.get_array_of_samples(), dtype=np.float32)
    max_val = float(2 ** (8 * audio.sample_width - 1))
    return samples / max_val


def _transcribe_window(audio: AudioSegment, offset_ms: int = 0) -> list[dict]:
    model = _get_model()
    segments, _ = model.transcribe(
        _audio_to_array(audio),
        language="ar",
        task="transcribe",
        beam_size=_BEAM_SIZE,
        word_timestamps=True,
        condition_on_previous_text=False,
        vad_filter=False,
    )

    words: list[dict] = []
    prev_end_ms = offset_ms
    for segment in segments:
        segment_words = getattr(segment, "words", None) or []
        for word in segment_words:
            text = (getattr(word, "word", "") or "").strip()
            if not text:
                continue

            start_s = getattr(word, "start", None)
            end_s = getattr(word, "end", None)
            start_ms = int(round(start_s * 1000)) + offset_ms if start_s is not None else prev_end_ms
            end_ms = int(round(end_s * 1000)) + offset_ms if end_s is not None else start_ms + 200
            if end_ms <= start_ms:
                end_ms = start_ms + 50

            words.append({"word": text, "start_ms": start_ms, "end_ms": end_ms})
            prev_end_ms = end_ms

    return words


def transcribe_words(audio: AudioSegment, progress_cb=None) -> list[dict]:
    """Transcribe the full audio and return a flat list of word records.

    Each record: {"word": str, "start_ms": int, "end_ms": int}
    """
    total_ms = len(audio)
    if total_ms <= 0:
        if progress_cb:
            progress_cb(1, 1)
        return []

    if total_ms <= _SEGMENT_KEEP_MS + _SEGMENT_OVERLAP_MS:
        words = _transcribe_window(audio)
        if progress_cb:
            progress_cb(total_ms, total_ms)
        return words

    keep_starts = list(range(0, total_ms, _SEGMENT_KEEP_MS))
    words: list[dict] = []

    for segment_index, keep_start in enumerate(keep_starts):
        keep_end = min(total_ms, keep_start + _SEGMENT_KEEP_MS)
        segment_start = max(0, keep_start - (0 if keep_start == 0 else _SEGMENT_OVERLAP_MS))
        segment_end = min(
            total_ms,
            keep_end + (_SEGMENT_OVERLAP_MS if keep_end < total_ms else 0),
        )

        segment_audio = audio[segment_start:segment_end]
        segment_words = _transcribe_window(segment_audio, offset_ms=segment_start)

        for word in segment_words:
            midpoint_ms = (word["start_ms"] + word["end_ms"]) // 2
            if keep_start <= midpoint_ms < keep_end or (
                segment_index == len(keep_starts) - 1 and midpoint_ms == total_ms
            ):
                words.append(word)

        if progress_cb:
            progress_cb(keep_end, total_ms)

    return words
