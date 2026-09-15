FROM mcr.microsoft.com/playwright/python:v1.55.0-noble
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app.py .
ENV DOUYIN_PROFILE=/data/profile
VOLUME ["/data"]
CMD ["uvicorn","app:app","--host","0.0.0.0","--port","9001"]
