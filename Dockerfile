FROM ghcr.io/lavalink-devs/lavalink:4-alpine
COPY application.yml /opt/Lavalink/application.yml
EXPOSE 2333
ENV SERVER_PORT=2333
