FROM ghcr.io/lavalink-devs/lavalink:4-alpine

USER root
RUN mkdir -p /opt/Lavalink/plugins
ADD https://github.com/lavalink-devs/youtube-source/releases/download/1.18.2/youtube-plugin-1.18.2.jar /opt/Lavalink/plugins/youtube-plugin-1.18.2.jar
RUN chown -R lavalink:lavalink /opt/Lavalink/plugins
USER lavalink

COPY application.yml /opt/Lavalink/application.yml
