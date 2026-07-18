FROM ghcr.io/lavalink-devs/lavalink:4-alpine
COPY application.yml /opt/Lavalink/application.yml
EXPOSE 2333
ENV SERVER_PORT=2333
# 512MB totali sul free tier di Render: heap piccolo + GC seriale
# (più leggero di G1 sotto i ~1-2GB) + metaspace limitato, per
# lasciare margine a stack/thread/buffer nativi e non finire OOM-killed.
ENV _JAVA_OPTIONS="-Xmx300m -XX:MaxMetaspaceSize=100m -XX:+UseSerialGC -Xss512k"
