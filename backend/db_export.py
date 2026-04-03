"""Export ayah timings to SQLite database compatible with quran_android."""

import os
import sqlite3
import zipfile


def create_timing_database(
    output_path: str,
    timings_by_surah: dict[int, list[dict]],
    schema_version: int = 1,
    db_version: int = 1,
):
    """
    Create a quran_android compatible timing database.

    Args:
        output_path: Path for the .db file
        timings_by_surah: {surah_number: [{"ayah": int, "time": int}, ...]}
        schema_version: 1 = ayah-level only, 2 = with word timings
        db_version: database version number
    """
    if os.path.exists(output_path):
        os.remove(output_path)

    conn = sqlite3.connect(output_path)
    cursor = conn.cursor()

    # Create tables matching quran_android schema
    if schema_version >= 2:
        cursor.execute("""
            CREATE TABLE timings (
                sura INTEGER NOT NULL,
                ayah INTEGER NOT NULL,
                time INTEGER NOT NULL,
                words TEXT DEFAULT ''
            )
        """)
    else:
        cursor.execute("""
            CREATE TABLE timings (
                sura INTEGER NOT NULL,
                ayah INTEGER NOT NULL,
                time INTEGER NOT NULL
            )
        """)

    cursor.execute("""
        CREATE TABLE properties (
            property TEXT NOT NULL,
            value TEXT NOT NULL
        )
    """)

    # Insert properties
    cursor.execute(
        "INSERT INTO properties (property, value) VALUES (?, ?)",
        ("version", str(db_version)),
    )
    cursor.execute(
        "INSERT INTO properties (property, value) VALUES (?, ?)",
        ("schema_version", str(schema_version)),
    )

    # Insert timings
    for surah_num, timings in sorted(timings_by_surah.items()):
        for entry in timings:
            if schema_version >= 2:
                cursor.execute(
                    "INSERT INTO timings (sura, ayah, time, words) VALUES (?, ?, ?, ?)",
                    (surah_num, entry["ayah"], entry["time"], entry.get("words", "")),
                )
            else:
                cursor.execute(
                    "INSERT INTO timings (sura, ayah, time) VALUES (?, ?, ?)",
                    (surah_num, entry["ayah"], entry["time"]),
                )

    # Create index for faster lookups
    cursor.execute("CREATE INDEX idx_timings_sura ON timings (sura)")

    conn.commit()
    conn.close()


def export_as_zip(db_path: str, zip_path: str = None) -> str:
    """
    Compress the .db file to a .zip for quran_android download format.

    Returns the path to the zip file.
    """
    if zip_path is None:
        zip_path = db_path + ".zip"

    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.write(db_path, os.path.basename(db_path))

    return zip_path


def export_single_surah(
    output_path: str,
    surah_number: int,
    timings: list[dict],
) -> str:
    """
    Export timing data for a single surah to a database file.
    Useful for testing individual surahs.
    """
    create_timing_database(output_path, {surah_number: timings})
    return output_path
