FROM python:3.12-slim
ENV DEBIAN_FRONTEND=noninteractive
WORKDIR /app
RUN sed -i 's|deb.debian.org|mirrors.tencent.com|g' /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && apt-get install -y --no-install-recommends chromium ca-certificates fonts-noto-cjk fonts-noto-color-emoji libnss3 libatk-bridge2.0-0 libgtk-3-0 libgbm1 libasound2 libxshmfence1 libx11-xcb1 gcc python3-dev xvfb x11vnc novnc \
    && rm -rf /var/lib/apt/lists/*
COPY requirements.txt .
RUN pip install --no-cache-dir --index-url https://mirrors.cloud.tencent.com/pypi/simple -r requirements.txt
COPY app.py profile_guard.py ./
COPY start.sh .
RUN chmod +x start.sh
ENV DOUYIN_PROFILE=/data/profile
VOLUME ["/data"]
CMD ["./start.sh"]
