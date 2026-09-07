FROM node:22-bookworm-slim

WORKDIR /app

ARG DEBIAN_MIRROR=http://mirrors.tencent.com/debian

RUN sed -i "s|http://deb.debian.org/debian|${DEBIAN_MIRROR}|g" \
    /etc/apt/sources.list.d/debian.sources \
  && apt-get -o Acquire::Retries=3 update \
  && apt-get install -y --no-install-recommends \
    tesseract-ocr \
    tesseract-ocr-chi-sim \
    tesseract-ocr-eng \
    ffmpeg \
    python3 \
    python3-pip \
  && python3 -m pip install --break-system-packages --no-cache-dir \
    --index-url https://mirrors.cloud.tencent.com/pypi/simple \
    yt-dlp \
  && rm -rf /var/lib/apt/lists/*

ENV LONGTU_OCR_COMMAND=tesseract \
    LONGTU_OCR_LANGUAGES=chi_sim+eng \
    LONGTU_OCR_TIMEOUT_MS=20000

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY . .

CMD ["npm", "start"]
