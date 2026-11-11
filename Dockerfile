FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    BACKUP_PLAN_HOST=0.0.0.0 \
    BACKUP_PLAN_PORT=8765 \
    BACKUP_PLAN_DATA=/app/data/data.json

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py store.py demo_data.json dictionaries_default.json ./
COPY static ./static

EXPOSE 8765
CMD ["python", "app.py"]
