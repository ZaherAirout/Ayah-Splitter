"""Detect Basmallah at the start of a surah using local Whisper model + heuristics."""

import os
import tempfile
import logging
import re

from pydub import AudioSegment
from pydub.silence import detect_silence

logger = logging.getLogger(__name__)

# Lazy-loaded model
_model = None
_model_size = os.environ.get("WHISPER_MODEL", "large-v3")


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

_ARABIC_DIACRITICS_RE = re.compile(r"[\u0610-\u061a\u064b-\u065f\u0670\u06d6-\u06ed]")
_NON_TOKEN_RE = re.compile(r"[^0-9a-z\u0621-\u063a\u0641-\u064a\s]+")


def _normalize_text(text: str) -> str:
    """Normalize Arabic transcription for keyword and prefix matching."""
    if not text:
        return ""

    text = text.lower().replace("اللّه", "الله")
    text = _ARABIC_DIACRITICS_RE.sub("", text)
    text = (
        text.replace("أ", "ا")
        .replace("إ", "ا")
        .replace("آ", "ا")
        .replace("ٱ", "ا")
        .replace("ؤ", "و")
        .replace("ئ", "ي")
        .replace("ى", "ي")
        .replace("ة", "ه")
        .replace("ـ", " ")
    )
    text = _NON_TOKEN_RE.sub(" ", text)
    return " ".join(text.split())


def _normalized_tokens(text: str) -> list[str]:
    tokens = _normalize_text(text).split()
    while tokens and tokens[0].isdigit():
        tokens.pop(0)
    return tokens


def _contains_basmallah_phrase(text: str) -> bool:
    normalized = " ".join(_normalized_tokens(text))
    return any(_normalize_text(pattern) in normalized for pattern in _BASMALLAH_PATTERNS)


def _transcription_starts_like_ayah1(transcription: str, surah_number: int | None) -> bool:
    """Detect when Whisper clearly starts with ayah 1, which rules out a separate basmallah."""
    if not surah_number or surah_number == 1:
        return False

    try:
        from quran_text import get_ayah_text
    except Exception:
        return False

    ayah1_text = get_ayah_text(surah_number, 1)
    if not ayah1_text:
        return False

    trans_tokens = _normalized_tokens(transcription)
    ayah_tokens = _normalized_tokens(ayah1_text)
    if len(trans_tokens) < 2 or len(ayah_tokens) < 2:
        return False

    window = min(4, len(trans_tokens), len(ayah_tokens))
    fuzzy_matches = 0.0
    for idx in range(window):
        left = trans_tokens[idx]
        right = ayah_tokens[idx]
        if left == right:
            fuzzy_matches += 1.0
        elif left.startswith(right) or right.startswith(left):
            fuzzy_matches += 0.8

    ayah_prefix = " ".join(ayah_tokens[: min(3, len(ayah_tokens))])
    transcription_prefix = " ".join(trans_tokens[: min(5, len(trans_tokens))])

    return bool(ayah_prefix and ayah_prefix in transcription_prefix) or fuzzy_matches >= max(2.0, window - 0.4)


def _safe_dbfs(segment: AudioSegment) -> float:
    dbfs = segment.dBFS
    if len(segment) == 0 or dbfs == float("-inf"):
        return -120.0
    return dbfs


def detect_basmallah(
    audio: AudioSegment,
    check_duration_ms: int = 15000,
    surah_number: int | None = None,
) -> dict:
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
    starts_like_ayah1 = _transcription_starts_like_ayah1(
        whisper_result["transcription"], surah_number
    )

    if whisper_result["has_basmallah"]:
        return whisper_result

    if starts_like_ayah1:
        return {
            "has_basmallah": False,
            "transcription": whisper_result["transcription"],
            "basmallah_end_ms": None,
            "confidence": 0.75,
            "method": "ayah1_match",
        }

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
            condition_on_previous_text=False,
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
        has_bsm = _contains_basmallah_phrase(full_text)

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
    max_gap_end = min(8000, int(duration_ms * 0.55))

    if max_gap_end < 2400:
        return {
            "has_basmallah": False,
            "transcription": "",
            "basmallah_end_ms": None,
            "confidence": 0.0,
            "method": "none",
        }

    # Try multiple thresholds to find silence gaps
    for thresh_offset in [-10, -12, -14]:
        thresh = audio_dbfs + thresh_offset
        silences = detect_silence(
            clip, min_silence_len=180, silence_thresh=thresh, seek_step=5
        )

        # Find where leading silence ends
        content_start = 0
        for s, e in silences:
            if s < 300:
                content_start = max(content_start, e)
            else:
                break

        # Look for inner silences after content starts
        search_start = content_start + 1200
        search_end = content_start + max_gap_end
        inner = []
        for s, e in silences:
            dur = e - s
            if s >= search_start and s <= search_end and dur >= 180:
                inner.append((s, e, dur))

        if inner:
            # Prefer longer gaps, but strongly penalize late candidates.
            inner.sort(
                key=lambda x: (x[2] * 1.7) - max(0, x[0] - (content_start + 4500)) * 0.05,
                reverse=True,
            )
            bsm_gap = inner[0]
            gap_mid = (bsm_gap[0] + bsm_gap[1]) // 2

            # Verify there's actual audio content between content_start and the gap
            if bsm_gap[0] > content_start + 1200:
                pre_audio = clip[content_start:bsm_gap[0]]
                post_audio = clip[bsm_gap[1]:min(duration_ms, bsm_gap[1] + 1800)]
                if (
                    _safe_dbfs(pre_audio) > audio_dbfs - 15
                    and _safe_dbfs(post_audio) > audio_dbfs - 18
                ):
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
