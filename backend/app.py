"""Flask API server for Ayah Splitter."""

import os
import json
import traceback

from flask import Flask, request, jsonify, send_file, send_from_directory
from flask_cors import CORS

from audio_analyzer import analyze_surah, get_waveform_data, load_audio
from db_export import create_timing_database, export_as_zip
from quran_metadata import AYAH_COUNTS, SURAH_NAMES, NO_BASMALLAH
from quran_text import get_surah_text, has_text

app = Flask(__name__, static_folder="../frontend/static", static_url_path="/static")
CORS(app)

UPLOAD_DIR = os.environ.get("UPLOAD_DIR", "/data/uploads")
OUTPUT_DIR = os.environ.get("OUTPUT_DIR", "/data/output")

os.makedirs(UPLOAD_DIR, exist_ok=True)
os.makedirs(OUTPUT_DIR, exist_ok=True)

# Session state
session_timings: dict[int, list[dict]] = {}
session_uploads: set[int] = set()  # Track which surahs were uploaded this session


@app.route("/")
def index():
    return send_from_directory("../frontend", "index.html")


@app.route("/api/metadata", methods=["GET"])
def get_metadata():
    """Return Quran metadata (surah names, ayah counts)."""
    surahs = []
    for num in range(1, 115):
        surahs.append({
            "number": num,
            "name": SURAH_NAMES[num],
            "ayah_count": AYAH_COUNTS[num],
            "has_basmallah": num not in NO_BASMALLAH,
        })
    return jsonify({"surahs": surahs})


@app.route("/api/upload", methods=["POST"])
def upload_file():
    """Upload an MP3 file for a specific surah."""
    if "file" not in request.files:
        return jsonify({"error": "No file provided"}), 400

    file = request.files["file"]
    surah_number = request.form.get("surah_number")

    if not surah_number:
        filename = file.filename
        base = os.path.splitext(filename)[0]
        try:
            surah_number = int(base)
        except ValueError:
            return jsonify({"error": "Could not determine surah number"}), 400
    else:
        surah_number = int(surah_number)

    if surah_number < 1 or surah_number > 114:
        return jsonify({"error": f"Invalid surah number: {surah_number}"}), 400

    filename = f"{surah_number:03d}.mp3"
    filepath = os.path.join(UPLOAD_DIR, filename)
    file.save(filepath)

    session_uploads.add(surah_number)

    size_mb = os.path.getsize(filepath) / (1024 * 1024)

    return jsonify({
        "success": True,
        "surah_number": surah_number,
        "surah_name": SURAH_NAMES[surah_number],
        "size_mb": round(size_mb, 2),
    })


@app.route("/api/upload-folder", methods=["POST"])
def upload_folder():
    """Upload multiple MP3 files at once."""
    if "files" not in request.files:
        return jsonify({"error": "No files provided"}), 400

    files = request.files.getlist("files")
    uploaded = []

    for file in files:
        filename = file.filename
        base = os.path.splitext(os.path.basename(filename))[0]
        try:
            surah_number = int(base)
        except ValueError:
            continue

        if 1 <= surah_number <= 114:
            dest = os.path.join(UPLOAD_DIR, f"{surah_number:03d}.mp3")
            file.save(dest)
            session_uploads.add(surah_number)
            uploaded.append(surah_number)

    return jsonify({"success": True, "uploaded_surahs": sorted(uploaded)})


@app.route("/api/analyze/<int:surah_number>", methods=["POST"])
def analyze(surah_number):
    """Analyze a surah audio file and return estimated timings."""
    if surah_number < 1 or surah_number > 114:
        return jsonify({"error": "Invalid surah number"}), 400

    filepath = os.path.join(UPLOAD_DIR, f"{surah_number:03d}.mp3")
    if not os.path.exists(filepath):
        return jsonify({"error": f"Audio file not found for surah {surah_number}"}), 404

    params = request.get_json(silent=True) or {}
    trim_start = params.get("trim_start_ms", 0)
    trim_end = params.get("trim_end_ms", 0)
    basmallah_mode = params.get("basmallah_mode", "auto")
    manual_basmallah_end_ms = params.get("manual_basmallah_end_ms")

    if basmallah_mode not in {"auto", "present", "absent"}:
        return jsonify({"error": "Invalid basmallah_mode"}), 400

    try:
        result = analyze_surah(
            filepath, surah_number,
            trim_start_ms=trim_start, trim_end_ms=trim_end,
            basmallah_mode=basmallah_mode,
            manual_basmallah_end_ms=manual_basmallah_end_ms,
        )
        session_timings[surah_number] = result["timings"]
        text = get_surah_text(surah_number)

        return jsonify({
            "surah": surah_number,
            "surah_name": SURAH_NAMES[surah_number],
            "duration_ms": result["duration_ms"],
            "num_ayahs": result["num_ayahs"],
            "silences": result["silences"],
            "timings": result["timings"],
            "ayah_text": text,
            "basmallah_detected": result.get("basmallah_detected"),
            "basmallah_transcription": result.get("basmallah_transcription"),
            "basmallah_method": result.get("basmallah_method"),
            "basmallah_confidence": result.get("basmallah_confidence"),
        })
    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


@app.route("/api/waveform/<int:surah_number>", methods=["GET"])
def waveform(surah_number):
    """Get waveform data for visualization."""
    filepath = os.path.join(UPLOAD_DIR, f"{surah_number:03d}.mp3")
    if not os.path.exists(filepath):
        return jsonify({"error": "Audio file not found"}), 404

    num_points = request.args.get("points", 2000, type=int)

    try:
        data = get_waveform_data(filepath, num_points=num_points)
        audio = load_audio(filepath)
        return jsonify({
            "waveform": data,
            "duration_ms": len(audio),
            "num_points": len(data),
        })
    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


@app.route("/api/timings/<int:surah_number>", methods=["GET"])
def get_timings(surah_number):
    """Get current timings for a surah."""
    if surah_number not in session_timings:
        return jsonify({"error": "No timings available. Analyze the surah first."}), 404
    return jsonify({"timings": session_timings[surah_number]})


@app.route("/api/timings/<int:surah_number>", methods=["PUT"])
def update_timings(surah_number):
    """Update timings after manual adjustment."""
    data = request.get_json()
    if not data or "timings" not in data:
        return jsonify({"error": "No timings provided"}), 400

    session_timings[surah_number] = data["timings"]
    return jsonify({"success": True, "timings": session_timings[surah_number]})


@app.route("/api/export", methods=["POST"])
def export_database():
    """Export timings as a quran_android compatible .db file.
    Accepts timings from client (localStorage) or uses server session."""
    data = request.get_json(silent=True) or {}
    db_name = data.get("db_name", "gapless_timing")
    schema_version = data.get("schema_version", 1)

    # Accept timings from client (localStorage mode)
    client_timings = data.get("all_timings")
    if client_timings:
        # Format: {"1": [{ayah, time}, ...], "36": [...]}
        for k, v in client_timings.items():
            session_timings[int(k)] = v

    if not session_timings:
        return jsonify({"error": "No timings to export. Analyze surahs first."}), 400

    db_path = os.path.join(OUTPUT_DIR, f"{db_name}.db")
    zip_path = os.path.join(OUTPUT_DIR, f"{db_name}.db.zip")

    try:
        create_timing_database(
            db_path,
            session_timings,
            schema_version=schema_version,
        )
        export_as_zip(db_path, zip_path)

        return jsonify({
            "success": True,
            "db_path": db_path,
            "zip_path": zip_path,
            "surahs_exported": len(session_timings),
        })
    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


@app.route("/api/export/download", methods=["GET"])
def download_export():
    """Download the exported database zip file."""
    db_name = request.args.get("db_name", "gapless_timing")
    zip_path = os.path.join(OUTPUT_DIR, f"{db_name}.db.zip")

    if not os.path.exists(zip_path):
        return jsonify({"error": "Export file not found. Run export first."}), 404

    return send_file(
        zip_path,
        as_attachment=True,
        download_name=f"{db_name}.db.zip",
    )


@app.route("/api/audio/<int:surah_number>", methods=["GET"])
def serve_audio(surah_number):
    """Serve uploaded audio file for playback in browser."""
    filepath = os.path.join(UPLOAD_DIR, f"{surah_number:03d}.mp3")
    if not os.path.exists(filepath):
        return jsonify({"error": "Audio file not found"}), 404
    return send_file(filepath, mimetype="audio/mpeg")


@app.route("/api/text/<int:surah_number>", methods=["GET"])
def get_text(surah_number):
    """Get Arabic ayah text for a surah."""
    if surah_number < 1 or surah_number > 114:
        return jsonify({"error": "Invalid surah number"}), 400

    text = get_surah_text(surah_number)
    return jsonify({
        "surah": surah_number,
        "available": has_text(surah_number),
        "ayahs": text,
    })


@app.route("/api/uploaded-surahs", methods=["GET"])
def list_uploaded():
    """List only surahs uploaded in this session."""
    uploaded = []
    for surah_num in sorted(session_uploads):
        filepath = os.path.join(UPLOAD_DIR, f"{surah_num:03d}.mp3")
        if os.path.exists(filepath):
            size_mb = os.path.getsize(filepath) / (1024 * 1024)
            uploaded.append({
                "surah": surah_num,
                "name": SURAH_NAMES[surah_num],
                "size_mb": round(size_mb, 2),
                "analyzed": surah_num in session_timings,
            })
    return jsonify({"surahs": uploaded})


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8080))
    debug = os.environ.get("FLASK_DEBUG", "0") == "1"
    app.run(host="0.0.0.0", port=port, debug=debug)
