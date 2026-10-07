FROM python:3.13-slim
ARG DEBIAN_FRONTEND=noninteractive
ENV PYTHONUNBUFFERED=1

RUN apt-get update && apt-get install -yqq --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*

RUN useradd -m appuser
WORKDIR /app
RUN chown appuser:appuser /app

USER appuser
COPY --chown=appuser:appuser vendor/ vendor
COPY --chown=appuser:appuser index.html skybox-paths.js tesseract.js viewer-skyboxes.js .
COPY --chown=appuser:appuser studio/ studio
# fallback skybox faces; the raw/ bind mount in `make run` hides these
COPY --chown=appuser:appuser raw/*.png raw/
# standalone mode:
# VOLUME ["/app/raw", "/app/exports", "/app/videos"]

EXPOSE 8000
CMD ["python3", "studio/server.py", "--port", "8000"]
