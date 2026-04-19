FROM python:3.12-slim

# Install system dependencies
RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg libgomp1 && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install remaining Python dependencies
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
# HuggingFace model cache location (mounted as a volume for persistence)
ENV HF_HOME=/root/.cache/huggingface

EXPOSE 8080

WORKDIR /app/backend

CMD ["gunicorn", "--bind", "0.0.0.0:8080", "--workers", "1", "--timeout", "900", "app:app"]
