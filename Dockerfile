# ──────────────────────────────────────────────────────────────
#  Dockerfile — Lavalink v4 (ottimizzato per Render free tier)
# ──────────────────────────────────────────────────────────────

# Immagine ufficiale Alpine: leggera (~150 MB) e con Java 21
FROM ghcr.io/lavalink-devs/lavalink:4-alpine

# Copia la configurazione dentro il container
COPY application.yml /opt/Lavalink/application.yml

# Porta esposta (Render la legge automaticamente dalla env PORT,
# ma Lavalink di default usa 2333 — viene override sotto)
EXPOSE 2333

# Render inietta la variabile PORT (es. 10000).
# La passiamo a Lavalink come SERVER_PORT così non dobbiamo
# hardcodare nulla nel application.yml.
ENV SERVER_PORT=2333

# Punto di entrata già definito nell'immagine base; non serve CMD
