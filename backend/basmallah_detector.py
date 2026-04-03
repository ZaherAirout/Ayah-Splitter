"""Detect Basmallah at the start of a surah using local Whisper model + heuristics."""

import os
import tempfile
import logging

from pydub import AudioSegment
from pydub.silence import detect_silence

logger = logging.getLogger(__name__)

# Lazy-loaded model
_model = None
_model_size = os.environ.get("WHISPER_MODEL", "small")


def _get_model():
    """Lazy-load the faster-whisper model."""
    global _model
    if _model is None:
        from faster_whisper import WhisperModel
        logger.info(f"Loading Whisper model '{_model_size}'...")
        _model = WhisperModel(
            _model_size,
            device="cpu",
            compute_type="int8",
        )
        logger.info("Whisper model loaded.")
    return _model


# Keywords that indicate Basmallah in transcription
_BASMALLAH_PATTERNS = [
    "بسم الله",
    "بسم اللّه",
    "بسم ال",
    "بسمل",
    "bismillah",
    "bismi",
    "bism",
]


def detect_basmallah(audio: AudioSegment, check_duration_ms: int = 15000) -> dict:
    """
    Check if the beginning of an audio clip contains Basmallah recitation.

    Uses two complementary strategies:
    1. Whisper transcription: check if first words match Basmallah text
    2. Silence heuristic: if there's a significant silence gap in the first
       3-8 seconds, it's likely a Basmallah-to-ayah1 boundary

    Args:
        audio: Full surah AudioSegment
        check_duration_ms: How many ms from the start to check

    Returns:
        {
            "has_basmallah": bool,
            "transcription": str,
            "basmallah_end_ms": int|None,
            "confidence": float,
            "method": str,  # "whisper", "heuristic", or "none"
        }
    """
    clip = audio[:min(check_duration_ms, len(audio))]

    # Strategy 1: Whisper transcription
    whisper_result = _whisper_detect(clip)

    if whisper_result["has_basmallah"]:
        return whisper_result

    # Strategy 2: Silence-based heuristic
    # If there's a significant silence in the first 3-10 seconds, it's likely
    # the gap between Basmallah and ayah 1.
    # Basmallah typically lasts 2-6 seconds.
    heuristic_result = _heuristic_detect(clip)

    if heuristic_result["has_basmallah"]:
        # Merge whisper transcription info
        heuristic_result["transcription"] = whisper_result["transcription"]
        return heuristic_result

    # Neither method detected Basmallah
    return {
        "has_basmallah": False,
        "transcription": whisper_result["transcription"],
        "basmallah_end_ms": None,
        "confidence": 0.0,
        "method": "none",
    }


def _whisper_detect(clip: AudioSegment) -> dict:
    """Use Whisper to detect Basmallah in audio clip."""
    model = _get_model()

    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        tmp_path = tmp.name
        clip.export(tmp_path, format="wav")

    try:
        segments_iter, info = model.transcribe(
            tmp_path,
            language="ar",
            beam_size=5,
            vad_filter=False,
            word_timestamps=True,
        )

        segments = []
        full_text = ""
        basmallah_end_ms = None

        for segment in segments_iter:
            seg_data = {
                "start": segment.start,
                "end": segment.end,
                "text": segment.text.strip(),
                "words": [],
            }
            if segment.words:
                seg_data["words"] = [
                    {"word": w.word, "start": w.start, "end": w.end, "probability": w.probability}
                    for w in segment.words
                ]
            segments.append(seg_data)
            full_text += " " + segment.text.strip()

        full_text = full_text.strip()

        # Check if transcription contains Basmallah
        has_bsm = False
        text_lower = full_text.lower().strip()
        for pattern in _BASMALLAH_PATTERNS:
            if pattern in text_lower:
                has_bsm = True
                break

        if has_bsm:
            basmallah_end_ms = _find_basmallah_end_from_segments(segments)

        return {
            "has_basmallah": has_bsm,
            "transcription": full_text,
            "basmallah_end_ms": basmallah_end_ms,
            "confidence": 0.9 if has_bsm else 0.0,
            "method": "whisper" if has_bsm else "none",
        }

    finally:
        os.unlink(tmp_path)


def _heuristic_detect(clip: AudioSegment) -> dict:
    """
    Heuristic Basmallah detection based on silence patterns.

    Strategy:
    1. Find where leading silence ends (= audio content start)
    2. Look for a significant silence gap after content_start+1500ms
       up to content_start+10000ms
    3. If found with actual audio content before it, it's likely Basmallah

    Typical Basmallah duration: 2-8 seconds of recitation.
    """
    duration_ms = len(clip)
    audio_dbfs = clip.dBFS

    # Try multiple thresholds to find silence gaps
    for thresh_offset in [-8, -10, -12]:
        thresh = audio_dbfs + thresh_offset
        silences = detect_silence(
            clip, min_silence_len=150, silence_thresh=thresh, seek_step=5
        )

        # Find where leading silence ends
        content_start = 0
        for s, e in silences:
            if s < 300:
                content_start = max(content_start, e)
            else:
                break

        # Look for inner silences after content starts
        search_start = content_start + 1500
        search_end = content_start + 10000
        inner = []
        for s, e in silences:
            dur = e - s
            if s >= search_start and s <= search_end and dur >= 150:
                inner.append((s, e, dur))

        if inner:
            # Pick the largest silence in this range
            inner.sort(key=lambda x: x[2], reverse=True)
            bsm_gap = inner[0]
            gap_mid = (bsm_gap[0] + bsm_gap[1]) // 2

            # Verify there's actual audio content between content_start and the gap
            if bsm_gap[0] > content_start + 500:
                pre_audio = clip[content_start:bsm_gap[0]]
                if pre_audio.dBFS > audio_dbfs - 15:
                    return {
                        "has_basmallah": True,
                        "transcription": "",
                        "basmallah_end_ms": gap_mid,
                        "confidence": 0.7,
                        "method": "heuristic",
                    }

    return {
        "has_basmallah": False,
        "transcription": "",
        "basmallah_end_ms": None,
        "confidence": 0.0,
        "method": "none",
    }


def _find_basmallah_end_from_segments(segments: list[dict]) -> int | None:
    """Find the timestamp where Basmallah ends using word timestamps."""
    all_words = []
    for seg in segments:
        all_words.extend(seg.get("words", []))

    if not all_words:
        if segments:
            return int(segments[0]["end"] * 1000)
        return None

    # Look for الرحيم (end of Basmallah) in the first few words
    raheem_keywords = ["الرحيم", "الرَّحِيم", "رحيم"]

    for i, w in enumerate(all_words[:12]):
        word_text = w["word"].strip()
        for kw in raheem_keywords:
            if kw in word_text:
                return int(w["end"] * 1000)

    # Fallback: use end of ~5th word
    if len(all_words) >= 4:
        return int(all_words[min(4, len(all_words) - 1)]["end"] * 1000)

    return None


def detect_basmallah_from_file(filepath: str, check_duration_ms: int = 15000) -> dict:
    """Convenience: load audio file and detect basmallah."""
    audio = AudioSegment.from_mp3(filepath)
    return detect_basmallah(audio, check_duration_ms)
