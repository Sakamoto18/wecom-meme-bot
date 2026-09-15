#!/bin/sh
Xvfb :99 -screen 0 1440x1000x24 -ac &
export DISPLAY=:99
x11vnc -display :99 -forever -shared -nopw -rfbport 5900 &
/usr/share/novnc/utils/novnc_proxy --vnc localhost:5900 --listen 6080 &
exec uvicorn app:app --host 0.0.0.0 --port 9001
