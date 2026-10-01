FROM ghcr.io/lavalink-devs/lavalink:4-alpine

USER root
RUN mkdir -p /opt/Lavalink/plugins
ADD https://github.com/lavalink-devs/youtube-source/releases/download/1.18.2/youtube-plugin-1.18.2.jar /opt/Lavalink/plugins/youtube-plugin-1.18.2.jar
ADD https://github.com/topi314/LavaSrc/releases/download/4.8.3/lavasrc-plugin-4.8.3.jar /opt/Lavalink/plugins/lavasrc-plugin-4.8.3.jar
RUN chown -R lavalink:lavalink /opt/Lavalink/plugins
USER lavalink

COPY application.yml /opt/Lavalink/application.yml
