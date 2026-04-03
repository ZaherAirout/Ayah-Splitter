FROM python:3.12-slim

# Install ffmpeg (required by pydub for MP3 processing)
RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python dependencies
COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY backend/ ./backend/
COPY frontend/ ./frontend/

# Create data directories
RUN mkdir -p /data/uploads /data/output

ENV UPLOAD_DIR=/data/uploads
ENV OUTPUT_DIR=/data/output
ENV PORT=8080

EXPOSE 8080

WORKDIR /app/backend

CMD ["gunicorn", "--bind", "0.0.0.0:8080", "--workers", "2", "--timeout", "900", "app:app"]
