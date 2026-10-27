# Image utilisable par Hugging Face Spaces, Render (mode Docker) ou tout serveur
FROM python:3.12-slim
ENV PYTHONUNBUFFERED=1 SME_PORT=8000 SME_DATA_DIR=/tmp/sme_data SME_BACKUP_DIR=/tmp/sme_data/backups TZ=Africa/Casablanca
RUN pip install --no-cache-dir "flask>=3.0" tzdata
RUN useradd -m -u 1000 user
WORKDIR /app
COPY --chown=user . /app
USER user
EXPOSE 8000
CMD ["python", "app.py"]
