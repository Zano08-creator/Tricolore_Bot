"use strict";

const {
    Client,
    GatewayIntentBits,
    EmbedBuilder,
    REST,
    Routes,
    SlashCommandBuilder,
} = require("discord.js");
const { Shoukaku, Connectors } = require("shoukaku");
const {
    joinVoiceChannel,
    createAudioPlayer,
    createAudioResource,
    AudioPlayerStatus,
    VoiceConnectionStatus,
    entersState,
    StreamType,
    getVoiceConnection,
} = require("@discordjs/voice");
const Parser  = require("rss-parser");
const express = require("express");
const fetch   = require("node-fetch");
const { Readable } = require("stream");

// ─────────────────────────────────────────────
//  CONFIGURAZIONE
// ─────────────────────────────────────────────
const TOKEN     = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID || "1512928969849311272";
const PORT      = process.env.PORT      || 3000;

if (!TOKEN) { console.error("[FATAL] TOKEN mancante."); process.exit(1); }

// ─────────────────────────────────────────────
//  LAVALINK NODES
// ─────────────────────────────────────────────
const LAVALINK_NODES = [
    { name: "serenetia", url: "lavalinkv4.serenetia.com",    auth: "https://seretia.link/discord",  port: 443, secure: true },
    { name: "jirayu",    url: "lavalink.jirayu.net",         auth: "youshallnotpass",               port: 443, secure: true },
    { name: "millohost", url: "lava-v4.millohost.my.id",     auth: "https://discord.gg/mjS5J2K3ep", port: 443, secure: true },
    { name: "trinium",   url: "lavalink-v4.triniumhost.com", auth: "free",                          port: 443, secure: true },
];

// ─────────────────────────────────────────────
//  FEED RSS ANSA
// ─────────────────────────────────────────────
const FEEDS = [
    { url: "https://www.ansa.it/sito/notizie/politica/politica_rss.xml", label: "Politica", color: 0x2b5ce6 },
    { url: "https://www.ansa.it/sito/notizie/economia/economia_rss.xml", label: "Economia", color: 0x27ae60 },
    { url: "https://www.ansa.it/sito/notizie/mondo/mondo_rss.xml",       label: "Mondo",    color: 0xe67e22 },
    { url: "https://www.ansa.it/sito/notizie/cronaca/cronaca_rss.xml",   label: "Cronaca",  color: 0xe74c3c },
];
const rssParser = new Parser({ timeout: 10_000 });

// ─────────────────────────────────────────────
//  STATO MUSICALE (Lavalink/Shoukaku)
// ─────────────────────────────────────────────
const musicStates = new Map();

function getMusicState(guildId) {
    if (!musicStates.has(guildId)) {
        musicStates.set(guildId, {
            queue:       [],
            player:      null,
            current:     null,
            volume:      100,
            loop:        "none",
            shuffle:     false,
            textChannel: null,
            isPlaying:   false,
        });
    }
    return musicStates.get(guildId);
}

function formatDuration(ms) {
    if (!ms || ms <= 0) return "🔴 Live";
    const s   = Math.floor(ms / 1000);
    const h   = Math.floor(s / 3600);
    const m   = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h > 0) return `${h}:${String(m).padStart(2,"0")}:${String(sec).padStart(2,"0")}`;
    return `${m}:${String(sec).padStart(2,"0")}`;
}

// ─────────────────────────────────────────────
//  PLAYER MUSICALE: avvia la prossima traccia
// ─────────────────────────────────────────────
async function playNext(guildId) {
    const state = getMusicState(guildId);
    const { queue, loop, shuffle, player } = state;

    if (!player || player.destroyed) { state.isPlaying = false; return; }

    if (queue.length === 0 && loop !== "track") {
        state.current   = null;
        state.isPlaying = false;
        state.textChannel?.send("✅ **Coda terminata.** Aggiungi canzoni con `/play`!").catch(() => {});
        return;
    }

    let track;
    if (loop === "track" && state.current) {
        track = state.current;
    } else {
        const idx = shuffle && queue.length > 1 ? Math.floor(Math.random() * queue.length) : 0;
        track = queue.splice(idx, 1)[0];
        if (loop === "queue") queue.push({ ...track });
    }

    state.current   = track;
    state.isPlaying = true;

    try {
        await player.playTrack({ track: { encoded: track.encoded } });
        await player.setGlobalVolume(state.volume);

        const embed = new EmbedBuilder()
            .setColor(0x1db954)
            .setAuthor({ name: "▶  Ora in riproduzione" })
            .setTitle(track.title.slice(0, 256))
            .setURL(track.uri)
            .setThumbnail(track.thumbnail ?? null)
            .addFields(
                { name: "⏱ Durata",       value: formatDuration(track.duration), inline: true },
                { name: "👤 Richiesto da", value: track.requestedBy,              inline: true },
                { name: "🔊 Volume",       value: `${state.volume}%`,             inline: true },
                { name: "🔁 Loop",         value: state.loop,                     inline: true },
                { name: "🔀 Shuffle",      value: state.shuffle ? "✅" : "❌",    inline: true },
                { name: "📋 In coda",      value: `${queue.length} brani`,        inline: true },
            )
            .setFooter({ text: "Tricolore Music" })
            .setTimestamp();
        state.textChannel?.send({ embeds: [embed] }).catch(() => {});
    } catch (err) {
        console.error("[MUSIC] Errore playTrack:", err.message);
        state.isPlaying = false;
        playNext(guildId);
    }
}

// ─────────────────────────────────────────────
//  TTS – sistema completamente separato da Lavalink
//
//  Usa @discordjs/voice per:
//    1. Entrare nel canale vocale (connessione separata)
//    2. Scaricare l'MP3 da Google TTS
//    3. Streamarlo direttamente con ffmpeg
//    4. Uscire alla fine (o restituire il controllo)
//
//  La musica Lavalink NON viene interrotta.
//  Le due connessioni vocali coesistono sullo stesso canale
//  (Lavalink gestisce l'audio musicale, @discordjs/voice il TTS).
//
//  NOTA: Discord permette una sola connessione vocale per guild.
//  Quindi gestiamo il TTS sulla stessa connessione voice già
//  aperta da Lavalink oppure ne apriamo una temporanea se non c'è
//  musica in corso. Usiamo un AudioPlayer separato.
// ─────────────────────────────────────────────

// Coda TTS per guild: { text, voiceChannel }
const ttsQueues  = new Map(); // guildId → Array
const ttsRunning = new Map(); // guildId → boolean

async function fetchTTSBuffer(text) {
    const testo = text.replace(/[*_`~]/g, "").slice(0, 200);
    const url   = `https://translate.google.com/translate_tts?ie=UTF-8&tl=it&client=tw-ob&q=${encodeURIComponent(testo)}`;
    const res   = await fetch(url, {
        timeout: 10_000,
        headers: { "User-Agent": "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)" },
    });
    if (!res.ok) throw new Error(`Google TTS HTTP ${res.status}`);
    const buf = await res.buffer();
    if (!buf || buf.length < 100) throw new Error("Buffer TTS vuoto");
    return buf;
}

/**
 * Aggiunge un messaggio TTS alla coda del guild e avvia
 * l'elaborazione se non è già in corso.
 */
function enqueueTTS(guildId, text, voiceChannelId, guildObj) {
    if (!ttsQueues.has(guildId)) ttsQueues.set(guildId, []);
    ttsQueues.get(guildId).push({ text, voiceChannelId, guildObj });
    processTTSQueue(guildId);
}

async function processTTSQueue(guildId) {
    if (ttsRunning.get(guildId)) return;
    const queue = ttsQueues.get(guildId);
    if (!queue || queue.length === 0) return;

    ttsRunning.set(guildId, true);

    while (queue.length > 0) {
        const { text, voiceChannelId, guildObj } = queue.shift();
        try {
            await playTTSItem(guildId, text, voiceChannelId, guildObj);
        } catch (err) {
            console.error("[TTS] Errore item:", err.message);
        }
        // Piccola pausa tra messaggi TTS consecutivi
        if (queue.length > 0) await new Promise(r => setTimeout(r, 400));
    }

    ttsRunning.set(guildId, false);
}

/**
 * Riproduce un singolo testo TTS nel canale vocale indicato.
 * Usa @discordjs/voice completamente separato da Shoukaku/Lavalink.
 */
async function playTTSItem(guildId, text, voiceChannelId, guildObj) {
    // 1. Scarica il buffer TTS
    const buf = await fetchTTSBuffer(text);
    console.log(`[TTS] Buffer OK: ${buf.length} bytes`);

    // 2. Connessione vocale via @discordjs/voice
    //    Se Lavalink è già connesso allo stesso canale, Discord
    //    sostituirà il bot vocale con questa connessione; al termine
    //    Shoukaku si riconnette automaticamente (moveOnDisconnect: true).
    //    Se NON c'è musica in corso, è la connessione principale.
    const connection = joinVoiceChannel({
        channelId:      voiceChannelId,
        guildId:        guildId,
        adapterCreator: guildObj.voiceAdapterCreator,
        selfDeaf:       false,
    });

    try {
        // Aspetta che la connessione sia pronta (max 5s)
        await entersState(connection, VoiceConnectionStatus.Ready, 5_000);
    } catch {
        connection.destroy();
        throw new Error("Connessione vocale TTS non riuscita");
    }

    // 3. Crea player e resource dallo stream in memoria
    const player  = createAudioPlayer();
    const stream  = Readable.from(buf);
    const resource = createAudioResource(stream, {
        inputType: StreamType.Arbitrary, // ffmpeg decoderà l'MP3
    });

    connection.subscribe(player);
    player.play(resource);

    // 4. Aspetta la fine della riproduzione
    await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            player.stop(true);
            resolve();
        }, 60_000); // safety: max 60s

        player.once(AudioPlayerStatus.Idle, () => {
            clearTimeout(timeout);
            resolve();
        });
        player.once("error", (err) => {
            clearTimeout(timeout);
            console.error("[TTS] Player error:", err.message);
            resolve(); // non bloccare la coda
        });
    });

    // 5. Distruggi la connessione TTS
    //    Se c'era musica in riproduzione con Lavalink, Shoukaku
    //    tenterà di riconnettersi grazie a moveOnDisconnect: true.
    connection.destroy();
    console.log("[TTS] Fine riproduzione, connessione distrutta.");

    // 6. Piccola attesa per dare tempo a Shoukaku di riconnettersi
    const musicState = getMusicState(guildId);
    if (musicState.isPlaying && musicState.player && !musicState.player.destroyed) {
        await new Promise(r => setTimeout(r, 1_500));
    }
}

// ─────────────────────────────────────────────
//  AI: Groq
// ─────────────────────────────────────────────
const GROQ_KEY = process.env.GROQ_KEY;

const SYSTEM_PROMPT =
    "Sei Tricolore, un assistente simpatico in un server Discord italiano. " +
    "Rispondi SEMPRE in italiano, in modo chiaro e conciso (massimo 2-3 frasi). " +
    "Non usare markdown, asterischi o simboli speciali.";

async function askAI(domanda) {
    if (!GROQ_KEY) { console.error("[AI] GROQ_KEY non impostata!"); return null; }
    try {
        const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
            method: "POST",
            headers: {
                "Content-Type":  "application/json",
                "Authorization": `Bearer ${GROQ_KEY}`,
            },
            body: JSON.stringify({
                model:       "llama-3.1-8b-instant",
                messages:    [
                    { role: "system", content: SYSTEM_PROMPT },
                    { role: "user",   content: domanda },
                ],
                max_tokens:  200,
                temperature: 0.7,
            }),
            timeout: 15_000,
        });
        if (!res.ok) throw new Error(`Groq HTTP ${res.status}`);
        const data     = await res.json();
        const risposta = data?.choices?.[0]?.message?.content?.trim();
        if (!risposta) throw new Error("Risposta vuota");
        console.log("[AI] Risposta Groq OK.");
        return risposta;
    } catch (err) {
        console.error("[AI] Groq fallito:", err.message);
        return null;
    }
}

// ─────────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────────
function getAvailableNode() {
    for (const node of shoukaku.nodes.values()) {
        if (node.state === 1) return node;
    }
    return null;
}

async function getMemberVoiceChannel(interaction) {
    try {
        const member = interaction.guild.members.cache.get(interaction.user.id)
                    ?? await interaction.guild.members.fetch(interaction.user.id);
        return member.voice?.channel ?? null;
    } catch { return null; }
}

async function ensurePlayer(guild, voiceChannel) {
    const state = getMusicState(guild.id);
    if (state.player && !state.player.destroyed) return state.player;
    if (!getAvailableNode())
        throw new Error("Nessun nodo Lavalink disponibile. Riprova tra qualche secondo.");

    const player = await shoukaku.joinVoiceChannel({
        guildId:   guild.id,
        channelId: voiceChannel.id,
        shardId:   guild.shardId ?? 0,
    });

    player.on("end", () => {
        const s = getMusicState(guild.id);
        s.isPlaying = false;
        playNext(guild.id);
    });

    player.on("exception", (data) => {
        const s = getMusicState(guild.id);
        console.error("[LAVALINK] Eccezione:", data?.exception?.message ?? data);
        s.isPlaying = false;
        s.textChannel?.send("⚠️ Errore riproduzione. Salto alla prossima...").catch(() => {});
        playNext(guild.id);
    });

    player.on("stuck", () => {
        const s = getMusicState(guild.id);
        s.isPlaying = false;
        playNext(guild.id);
    });

    player.on("closed", () => {
        const s = getMusicState(guild.id);
        s.player    = null;
        s.isPlaying = false;
    });

    state.player = player;
    return player;
}

// ─────────────────────────────────────────────
//  SLASH COMMANDS
// ─────────────────────────────────────────────
const commands = [
    // News
    new SlashCommandBuilder()
        .setName("news").setDescription("Mostra le ultime notizie ANSA")
        .addStringOption(o =>
            o.setName("categoria").setDescription("Filtra per categoria")
             .addChoices(
                { name: "Politica", value: "politica" },
                { name: "Economia", value: "economia" },
                { name: "Mondo",    value: "mondo"    },
                { name: "Cronaca",  value: "cronaca"  },
                { name: "Tutte",    value: "tutte"    },
             )
        ).toJSON(),

    // Musica
    new SlashCommandBuilder()
        .setName("play").setDescription("Riproduce una canzone (URL o ricerca)")
        .addStringOption(o => o.setName("query").setDescription("URL o nome canzone").setRequired(true))
        .toJSON(),
    new SlashCommandBuilder().setName("skip")      .setDescription("Salta la canzone corrente").toJSON(),
    new SlashCommandBuilder().setName("stop")      .setDescription("Ferma e svuota la coda").toJSON(),
    new SlashCommandBuilder().setName("pause")     .setDescription("Mette in pausa").toJSON(),
    new SlashCommandBuilder().setName("resume")    .setDescription("Riprende la riproduzione").toJSON(),
    new SlashCommandBuilder().setName("queue")     .setDescription("Mostra la coda").toJSON(),
    new SlashCommandBuilder().setName("nowplaying").setDescription("Canzone in riproduzione").toJSON(),
    new SlashCommandBuilder().setName("shuffle")   .setDescription("Attiva/disattiva shuffle").toJSON(),
    new SlashCommandBuilder().setName("join")      .setDescription("Entra nel canale vocale").toJSON(),
    new SlashCommandBuilder().setName("leave")     .setDescription("Esci dal canale vocale").toJSON(),
    new SlashCommandBuilder()
        .setName("volume").setDescription("Imposta il volume (1-200)")
        .addIntegerOption(o => o.setName("valore").setDescription("Volume 1-200").setMinValue(1).setMaxValue(200).setRequired(true))
        .toJSON(),
    new SlashCommandBuilder()
        .setName("loop").setDescription("Modalità loop")
        .addStringOption(o =>
            o.setName("modalita").setDescription("Tipo di loop").setRequired(true)
             .addChoices(
                { name: "Nessuno",     value: "none"  },
                { name: "Traccia",     value: "track" },
                { name: "Coda intera", value: "queue" },
             )
        ).toJSON(),

    // AI
    new SlashCommandBuilder()
        .setName("chiedi").setDescription("Fai una domanda all'AI (risponde in chat e a voce)")
        .addStringOption(o => o.setName("domanda").setDescription("La tua domanda").setRequired(true))
        .toJSON(),
];

// ─────────────────────────────────────────────
//  CLIENT & SHOUKAKU
// ─────────────────────────────────────────────
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
    ],
});

const shoukaku = new Shoukaku(
    new Connectors.DiscordJS(client),
    LAVALINK_NODES,
    {
        moveOnDisconnect:  true,
        resumable:         false,
        reconnectTries:    5,
        reconnectInterval: 5,
        restTimeout:       15000,
    }
);

shoukaku.on("ready",      n     => console.log(`[LAVALINK] Connesso: ${n}`));
shoukaku.on("error",      (n,e) => console.error(`[LAVALINK] Errore ${n}:`, e?.message));
shoukaku.on("disconnect", n     => console.warn(`[LAVALINK] Disconnesso: ${n}`));

client.once("ready", async () => {
    console.log(`[BOT] Online come ${client.user.tag}`);
    const rest = new REST({ version: "10" }).setToken(TOKEN);
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    console.log("[BOT] Comandi registrati.");
});

// ─────────────────────────────────────────────
//  GESTIONE COMANDI
// ─────────────────────────────────────────────
client.on("interactionCreate", async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    const { commandName, guild } = interaction;

    // ── /news ──────────────────────────────────
    if (commandName === "news") {
        await interaction.deferReply();
        const cat   = interaction.options.getString("categoria") || "tutte";
        const feeds = cat === "tutte" ? FEEDS : FEEDS.filter(f => f.label.toLowerCase() === cat);
        const embeds = [];
        for (const feed of feeds) {
            let parsed;
            try { parsed = await rssParser.parseURL(feed.url); } catch { continue; }
            for (const item of parsed.items.slice(0, 3)) {
                if (!item.link) continue;
                embeds.push(
                    new EmbedBuilder()
                        .setColor(feed.color)
                        .setTitle((item.title || "Notizia").slice(0, 256))
                        .setURL(item.link)
                        .setDescription((item.contentSnippet || "Nessuna descrizione.").slice(0, 300))
                        .setFooter({ text: `Tricolore News · ${feed.label}` })
                        .setTimestamp(item.pubDate ? new Date(item.pubDate) : new Date())
                );
                if (embeds.length >= 10) break;
            }
            if (embeds.length >= 10) break;
        }
        if (!embeds.length) { await interaction.editReply("⚠️ Nessuna notizia disponibile."); return; }
        await interaction.editReply({ embeds });
        return;
    }

    // ── /join ──────────────────────────────────
    if (commandName === "join") {
        const vc = await getMemberVoiceChannel(interaction);
        if (!vc) { await interaction.reply({ content: "❌ Devi essere in un canale vocale!", ephemeral: true }); return; }
        try {
            const state = getMusicState(guild.id);
            state.textChannel = interaction.channel;
            if (state.player && !state.player.destroyed) {
                try { await state.player.stopTrack(); } catch {}
                shoukaku.leaveVoiceChannel(guild.id);
                state.player    = null;
                state.isPlaying = false;
            }
            await new Promise(r => setTimeout(r, 500));
            await ensurePlayer(guild, vc);
            await interaction.reply(`🎙️ Entrato in **${vc.name}**!`);
        } catch (err) {
            await interaction.reply({ content: `❌ ${err.message}`, ephemeral: true });
        }
        return;
    }

    // ── /leave ─────────────────────────────────
    if (commandName === "leave") {
        const state = getMusicState(guild.id);
        if (!state.player || state.player.destroyed) {
            await interaction.reply({ content: "❌ Non sono in nessun canale vocale!", ephemeral: true }); return;
        }
        try { await state.player.stopTrack(); } catch {}
        shoukaku.leaveVoiceChannel(guild.id);
        musicStates.delete(guild.id);
        await interaction.reply("👋 Uscito dal canale vocale.");
        return;
    }

    // ── /play ──────────────────────────────────
    if (commandName === "play") {
        const query = interaction.options.getString("query", true);
        await interaction.deferReply();
        const vc = await getMemberVoiceChannel(interaction);
        if (!vc) { await interaction.editReply("❌ Devi essere in un canale vocale!"); return; }
        try {
            const state = getMusicState(guild.id);
            state.textChannel = interaction.channel;
            await ensurePlayer(guild, vc);
            const node = getAvailableNode();
            if (!node) { await interaction.editReply("❌ Nessun nodo audio disponibile."); return; }

            const search = /^https?:\/\//.test(query) ? query : `ytsearch:${query}`;
            const result = await node.rest.resolve(search).catch(() => null);
            if (!result?.data) { await interaction.editReply(`⚠️ Nessun risultato per: **${query}**`); return; }

            let tracks = [];
            if (result.loadType === "track")    tracks = [result.data];
            if (result.loadType === "search")   tracks = result.data.slice(0, 1);
            if (result.loadType === "playlist") tracks = result.data.tracks ?? [];
            if (!tracks.length) { await interaction.editReply(`⚠️ Nessun risultato per: **${query}**`); return; }

            for (const t of tracks) {
                state.queue.push({
                    encoded:     t.encoded,
                    title:       t.info.title,
                    uri:         t.info.uri,
                    duration:    t.info.length,
                    thumbnail:   t.info.artworkUrl
                                 ?? (t.info.sourceName === "youtube"
                                    ? `https://img.youtube.com/vi/${t.info.identifier}/hqdefault.jpg`
                                    : null),
                    requestedBy: interaction.user.username,
                });
            }

            if (!state.isPlaying) {
                await interaction.editReply(
                    tracks.length > 1
                        ? `🎵 Playlist aggiunta: **${tracks.length} brani**. Avvio in corso...`
                        : `🎵 Caricamento: **${tracks[0].info.title}**...`
                );
                playNext(guild.id);
            } else {
                const t0 = tracks[0];
                await interaction.editReply({ embeds: [
                    new EmbedBuilder().setColor(0x1db954)
                        .setAuthor({ name: tracks.length > 1 ? `➕ Playlist aggiunta (${tracks.length} brani)` : "➕ Aggiunto alla coda" })
                        .setTitle(t0.info.title.slice(0, 256)).setURL(t0.info.uri)
                        .setThumbnail(t0.info.artworkUrl ?? null)
                        .addFields(
                            { name: "⏱ Durata",   value: formatDuration(t0.info.length), inline: true },
                            { name: "📋 Posizione", value: `#${state.queue.length}`,       inline: true },
                        )
                        .setFooter({ text: "Tricolore Music" }).setTimestamp()
                ]});
            }
        } catch (err) {
            await interaction.editReply(`❌ ${err.message}`);
        }
        return;
    }

    // ── /skip ──────────────────────────────────
    if (commandName === "skip") {
        const state = getMusicState(guild.id);
        if (!state.current) { await interaction.reply({ content: "❌ Nessuna canzone in riproduzione.", ephemeral: true }); return; }
        const title    = state.current.title;
        const prevLoop = state.loop;
        if (state.loop === "track") state.loop = "none";
        try { await state.player.stopTrack(); } catch {}
        state.loop = prevLoop;
        await interaction.reply(`⏭️ **${title}** saltata.`);
        return;
    }

    // ── /stop ──────────────────────────────────
    if (commandName === "stop") {
        const state = getMusicState(guild.id);
        state.queue     = [];
        state.loop      = "none";
        state.isPlaying = false;
        try { await state.player?.stopTrack(); } catch {}
        state.current = null;
        // Svuota anche la coda TTS
        if (ttsQueues.has(guild.id)) ttsQueues.get(guild.id).length = 0;
        await interaction.reply("⏹️ Riproduzione fermata e coda svuotata.");
        return;
    }

    // ── /pause ─────────────────────────────────
    if (commandName === "pause") {
        const state = getMusicState(guild.id);
        if (!state.player || !state.isPlaying) { await interaction.reply({ content: "❌ Nessuna canzone in riproduzione.", ephemeral: true }); return; }
        if (state.player.paused) { await interaction.reply({ content: "❌ Già in pausa.", ephemeral: true }); return; }
        await state.player.setPaused(true);
        await interaction.reply("⏸️ Messo in pausa. Usa `/resume` per riprendere.");
        return;
    }

    // ── /resume ────────────────────────────────
    if (commandName === "resume") {
        const state = getMusicState(guild.id);
        if (!state.player?.paused) { await interaction.reply({ content: "❌ Non è in pausa.", ephemeral: true }); return; }
        await state.player.setPaused(false);
        await interaction.reply("▶️ Riproduzione ripresa!");
        return;
    }

    // ── /nowplaying ────────────────────────────
    if (commandName === "nowplaying") {
        const state = getMusicState(guild.id);
        if (!state.current) { await interaction.reply({ content: "❌ Nessuna canzone in riproduzione.", ephemeral: true }); return; }
        const t = state.current;
        await interaction.reply({ embeds: [
            new EmbedBuilder().setColor(0x1db954).setAuthor({ name: "🎵 Ora in riproduzione" })
                .setTitle(t.title.slice(0, 256)).setURL(t.uri).setThumbnail(t.thumbnail ?? null)
                .addFields(
                    { name: "⏱ Durata",       value: formatDuration(t.duration), inline: true },
                    { name: "👤 Richiesto da", value: t.requestedBy,              inline: true },
                    { name: "🔊 Volume",       value: `${state.volume}%`,         inline: true },
                    { name: "🔁 Loop",         value: state.loop,                 inline: true },
                    { name: "🔀 Shuffle",      value: state.shuffle ? "✅":"❌",  inline: true },
                    { name: "📋 In coda",      value: `${state.queue.length} brani`, inline: true },
                )
                .setFooter({ text: "Tricolore Music" }).setTimestamp()
        ]});
        return;
    }

    // ── /queue ─────────────────────────────────
    if (commandName === "queue") {
        const state = getMusicState(guild.id);
        if (!state.current && !state.queue.length) { await interaction.reply({ content: "📭 La coda è vuota.", ephemeral: true }); return; }
        const lines = [];
        if (state.current) lines.push(`**▶ In riproduzione:**\n[${state.current.title}](${state.current.uri}) · ${formatDuration(state.current.duration)}\n`);
        if (state.queue.length) {
            lines.push("**📋 Coda:**");
            state.queue.slice(0, 15).forEach((t, i) =>
                lines.push(`\`${i+1}.\` [${t.title.slice(0,50)}](${t.uri}) · ${formatDuration(t.duration)} · *${t.requestedBy}*`)
            );
            if (state.queue.length > 15) lines.push(`\n*...e altri ${state.queue.length - 15} brani*`);
        }
        await interaction.reply({ embeds: [
            new EmbedBuilder().setColor(0x1db954).setTitle("🎶 Coda musicale")
                .setDescription(lines.join("\n").slice(0, 4096))
                .addFields(
                    { name: "🔁 Loop",    value: state.loop,                 inline: true },
                    { name: "🔀 Shuffle", value: state.shuffle ? "✅":"❌",  inline: true },
                    { name: "🔊 Volume",  value: `${state.volume}%`,         inline: true },
                )
                .setFooter({ text: `${state.queue.length} brani in attesa · Tricolore Music` }).setTimestamp()
        ]});
        return;
    }

    // ── /volume ────────────────────────────────
    if (commandName === "volume") {
        const val   = interaction.options.getInteger("valore", true);
        const state = getMusicState(guild.id);
        state.volume = val;
        try { await state.player?.setGlobalVolume(val); } catch {}
        await interaction.reply(`🔊 Volume impostato a **${val}%**.`);
        return;
    }

    // ── /loop ──────────────────────────────────
    if (commandName === "loop") {
        const mod = interaction.options.getString("modalita", true);
        getMusicState(guild.id).loop = mod;
        const labels = { none: "🚫 Nessun loop", track: "🔂 Loop traccia", queue: "🔁 Loop coda" };
        await interaction.reply(`Loop impostato su: **${labels[mod]}**`);
        return;
    }

    // ── /shuffle ───────────────────────────────
    if (commandName === "shuffle") {
        const state   = getMusicState(guild.id);
        state.shuffle = !state.shuffle;
        await interaction.reply(state.shuffle ? "🔀 Shuffle **attivato**!" : "➡️ Shuffle **disattivato**.");
        return;
    }

    // ── /chiedi ────────────────────────────────
    if (commandName === "chiedi") {
        const domanda = interaction.options.getString("domanda", true);
        await interaction.deferReply();

        // 1. Ottieni risposta AI
        const risposta = await askAI(domanda) ?? "Non sono riuscito a rispondere, riprova tra poco!";

        // 2. Verifica se l'utente è in un canale vocale
        const vc     = await getMemberVoiceChannel(interaction);
        const inVoice = vc !== null;

        // 3. Invia embed in chat
        const embed = new EmbedBuilder()
            .setColor(0x7289da)
            .setAuthor({ name: "🤖 Tricolore AI" })
            .setTitle(domanda.slice(0, 256))
            .setDescription(risposta.slice(0, 1024))
            .setFooter({ text: inVoice
                ? "🔊 Risposta vocale in arrivo..."
                : "🔇 Unisciti a un canale vocale per la risposta vocale" })
            .setTimestamp();
        await interaction.editReply({ embeds: [embed] });

        // 4. Riproduzione vocale separata (se l'utente è in voice)
        if (inVoice) {
            try {
                enqueueTTS(guild.id, risposta, vc.id, guild);
            } catch (err) {
                console.warn("[CHIEDI] Errore TTS:", err.message);
            }
        }
        return;
    }
});

// ─────────────────────────────────────────────
//  EXPRESS
// ─────────────────────────────────────────────
const app        = express();
const SERVICE_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;

app.get("/",       (_req, res) => res.send("Tricolore Bot – Online ✅"));
app.get("/health", (_req, res) => res.json({
    status:    "ok",
    uptime:    Math.floor(process.uptime()),
    nodes:     [...shoukaku.nodes.keys()],
    timestamp: new Date().toISOString(),
}));

app.listen(PORT, () => console.log(`[EXPRESS] Porta ${PORT} | URL: ${SERVICE_URL}`));

// ─────────────────────────────────────────────
//  KEEP-ALIVE (ogni 14 minuti)
// ─────────────────────────────────────────────
setInterval(() => {
    const lib = SERVICE_URL.startsWith("https") ? require("https") : require("http");
    lib.get(`${SERVICE_URL}/health`, res => {
        console.log(`[KEEP-ALIVE] OK – status ${res.statusCode}`);
    }).on("error", err => console.warn("[KEEP-ALIVE] Fallito:", err.message));
}, 14 * 60 * 1000);

// ─────────────────────────────────────────────
//  GESTIONE ERRORI GLOBALI
// ─────────────────────────────────────────────
process.on("unhandledRejection", r => console.error("[UNHANDLED]", r));
process.on("uncaughtException",  e => console.error("[EXCEPTION]", e.message));

client.login(TOKEN);
