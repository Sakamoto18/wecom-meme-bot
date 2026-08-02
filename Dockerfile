FROM node:22-bookworm-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    tesseract-ocr \
    tesseract-ocr-chi-sim \
    tesseract-ocr-eng \
  && rm -rf /var/lib/apt/lists/*

ENV LONGTU_OCR_COMMAND=tesseract \
    LONGTU_OCR_LANGUAGES=chi_sim+eng \
    LONGTU_OCR_TIMEOUT_MS=20000

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY . .

CMD ["npm", "start"]
