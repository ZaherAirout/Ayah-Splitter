"""Whisper Quran transcription with word-level timestamps.

Uses tarteel-ai/whisper-base-ar-quran (Quran-fine-tuned Whisper) through the
HuggingFace Transformers ASR pipeline with `return_timestamps="word"`, sliding
30 s windows with 5 s stride so it can handle full-surah audio.
"""

import logging
import numpy as np
from pydub import AudioSegment

logger = logging.getLogger(__name__)

MODEL_NAME = "tarteel-ai/whisper-base-ar-quran"
_SAMPLE_RATE = 16000
_CHUNK_LENGTH_S = 30
_STRIDE_LENGTH_S = 5

_pipeline = None


def _get_pipeline():
    global _pipeline
    if _pipeline is None:
        import torch  # noqa: F401
        from transformers import (
            GenerationConfig,
            WhisperForConditionalGeneration,
            WhisperProcessor,
            pipeline,
        )

        logger.info(f"Loading '{MODEL_NAME}'...")
        processor = WhisperProcessor.from_pretrained(MODEL_NAME)
        model = WhisperForConditionalGeneration.from_pretrained(MODEL_NAME)

        # Tarteel fine-tunes ship a trimmed generation_config missing timestamp
        # token IDs — use the base Whisper generation config so that
        # `return_timestamps="word"` works.
        base = GenerationConfig.from_pretrained("openai/whisper-base")
        logger.info(f"DBG base no_timestamps_token_id: {getattr(base, 'no_timestamps_token_id', 'MISS')}")
        model.generation_config = base
        logger.info(f"DBG model.generation_config no_timestamps_token_id: {getattr(model.generation_config, 'no_timestamps_token_id', 'MISS')}")

        _pipeline = pipeline(
            "automatic-speech-recognition",
            model=model,
            tokenizer=processor.tokenizer,
            feature_extractor=processor.feature_extractor,
            chunk_length_s=_CHUNK_LENGTH_S,
            stride_length_s=_STRIDE_LENGTH_S,
            return_timestamps="word",
        )
        logger.info("ASR pipeline loaded.")
    return _pipeline


def _audio_to_array(audio: AudioSegment) -> np.ndarray:
    audio = audio.set_frame_rate(_SAMPLE_RATE).set_channels(1)
    samples = np.array(audio.get_array_of_samples(), dtype=np.float32)
    max_val = float(2 ** (8 * audio.sample_width - 1))
    return samples / max_val


def transcribe_words(audio: AudioSegment) -> list[dict]:
    """Transcribe the full audio and return a flat list of word records.

    Each record: {"word": str, "start_ms": int, "end_ms": int}
    """
    samples = _audio_to_array(audio)
    pipe = _get_pipeline()

    result = pipe({"array": samples, "sampling_rate": _SAMPLE_RATE})

    words: list[dict] = []
    prev_end_ms = 0
    for chunk in result.get("chunks", []) or []:
        text = (chunk.get("text") or "").strip()
        ts = chunk.get("timestamp") or (None, None)
        start_s, end_s = ts[0], ts[1]
        if not text:
            continue
        start_ms = int(round(start_s * 1000)) if start_s is not None else prev_end_ms
        end_ms = int(round(end_s * 1000)) if end_s is not None else start_ms + 200
        if end_ms <= start_ms:
            end_ms = start_ms + 50
        words.append({"word": text, "start_ms": start_ms, "end_ms": end_ms})
        prev_end_ms = end_ms

    return words
