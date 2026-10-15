# Runs etl/load_all.py once: download, schema, zones and every month.
# Built and started by the `loader` service in docker-compose.yml.
FROM python:3.12-slim

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY sql sql
COPY etl etl
COPY scripts scripts
# so the test suite can run here too: docker compose run --rm loader pytest tests
COPY tests tests

CMD ["python", "etl/load_all.py"]
