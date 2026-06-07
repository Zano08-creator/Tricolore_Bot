"use strict";

// ──────────────────────────────────────────────
//  Tricolore News Bot  –  index.js
//  Versione con supporto notizie + musica completa
// ──────────────────────────────────────────────

const {
    Client,
    GatewayIntentBits,
    EmbedBuilder,
    REST,
    Routes,
    SlashCommandBuilder,
} = require("discord.js");
const {
    joinVoiceChannel,
    VoiceConnectionStatus,
    getVoiceConnection,
    createAudioPlayer,
    createAudioResource,
    AudioPlayerStatus,
    NoSubscriberBehavior,
} = require("@discordjs/voice");
const Parser  = require("rss-parser");
const express = require("express");
const fs      = require("fs");
const path    = require("path");
const ytdl    = require("@distube/ytdl-core");
const yts     = require("yt-search");

// ── Configurazione ────────────────────────────
const TOKEN      = process.env.TOKEN;
const CLIENT_ID  = process.env.CLIENT_ID || "1512928969849311272";
const GUILD_ID   = process.env.GUILD_ID  || "1512809889666175211";
const CHANNEL_ID = process.env.CHANNEL_ID;
const PORT       = process.env.PORT      || 3000;

if (!TOKEN) {
    console.error("[FATAL] TOKEN non impostato. Imposta la variabile d'ambiente TOKEN.");
    process.exit(1);
}

// ── Feed RSS ──────────────────────────────────
const FEEDS = [
    { url: "https://www.ansa.it/sito/notizie/politica/politica_rss.xml",  label: "Politica",  color: 0x2b5ce6 },
    { url: "https://www.ansa.it/sito/notizie/economia/economia_rss.xml",  label: "Economia",  color: 0x27ae60 },
    { url: "https://www.ansa.it/sito/notizie/mondo/mondo_rss.xml",        label: "Mondo",     color: 0xe67e22 },
    { url: "https://www.ansa.it/sito/notizie/cronaca/cronaca_rss.xml",    label: "Cronaca",   color: 0xe74c3c },
];

// ── Persistenza notizie già inviate ───────────
const SENT_FILE = path.join(__dirname, "sent_news.json");

function loadSentNews() {
    try {
        if (fs.existsSync(SENT_FILE)) {
            const data = JSON.parse(fs.readFileSync(SENT_FILE, "utf8"));
            return new Set(Array.isArray(data) ? data : []);
        }
    } catch {
        console.warn("[WARN] Impossibile leggere sent_news.json, si riparte da zero.");
    }
    return new Set();
}

function saveSentNews(set) {
    try {
        fs.writeFileSync(SENT_FILE, JSON.stringify([...set]), "utf8");
    } catch (err) {
        console.error("[ERROR] Impossibile salvare sent_news.json:", err.message);
    }
}

const sentNews = loadSentNews();

// ── Utilità ───────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function formatDuration(seconds) {
    if (!seconds) return "Live";
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, "0")}`;
}

// ── Stato Musicale (per guild) ────────────────
// Struttura: Map<guildId, MusicState>
const musicStates = new Map();

function getMusicState(guildId) {
    if (!musicStates.has(guildId)) {
        musicStates.set(guildId, {
            queue:      [],        // Array di { title, url, duration, thumbnail, requestedBy }
            player:     null,      // AudioPlayer
            connection: null,      // VoiceConnection
            current:    null,      // Traccia corrente
            volume:     100,       // Volume 1-200
            loop:       "none",    // "none" | "track" | "queue"
            shuffle:    false,
            textChannel: null,     // Canale testo per messaggi di stato
        });
    }
    return musicStates.get(guildId);
}

// ── Ricerca & Stream YouTube ──────────────────
async function searchYouTube(query) {
    // Se è già un URL YouTube, usalo direttamente
    if (/^https?:\/\/(www\.)?(youtube\.com|youtu\.be)/.test(query)) {
        try {
            const info = await ytdl.getInfo(query);
            const details = info.videoDetails;
            return {
                title:       details.title,
                url:         details.video_url,
                duration:    parseInt(details.lengthSeconds, 10),
                thumbnail:   details.thumbnails?.at(-1)?.url ?? null,
            };
        } catch {
            return null;
        }
    }

    // Altrimenti cerca per testo
    try {
        const result = await yts(query);
        const video  = result.videos[0];
        if (!video) return null;
        return {
            title:     video.title,
            url:       video.url,
            duration:  video.seconds,
            thumbnail: video.thumbnail,
        };
    } catch {
        return null;
    }
}

function createStream(url) {
    return ytdl(url, {
        filter:  "audioonly",
        quality: "highestaudio",
        highWaterMark: 1 << 25,
    });
}

// ── Avvia riproduzione ────────────────────────
async function playNext(guildId) {
    const state = getMusicState(guildId);
    const { queue, loop, shuffle } = state;

    if (queue.length === 0) {
        state.current = null;
        if (state.textChannel) {
            state.textChannel.send("✅ **Coda terminata.** Aggiungi altre canzoni con `/play`!").catch(() => {});
        }
        return;
    }

    // Sceglie la prossima traccia
    let nextIndex = 0;
    if (shuffle && queue.length > 1) {
        nextIndex = Math.floor(Math.random() * queue.length);
    }

    // In modalità loop traccia, non rimuovere dalla coda
    let track;
    if (loop === "track" && state.current) {
        track = state.current;
    } else {
        track = queue.splice(nextIndex, 1)[0];
        if (loop === "queue") queue.push(track); // reinserisce in fondo
    }

    state.current = track;

    try {
        const stream   = createStream(track.url);
        const resource = createAudioResource(stream, { inlineVolume: true });
        resource.volume?.setVolumeLogarithmic(state.volume / 100);
        state.currentResource = resource;

        state.player.play(resource);

        // Embed "ora in riproduzione"
        if (state.textChannel) {
            const embed = new EmbedBuilder()
                .setColor(0x1db954)
                .setAuthor({ name: "▶  Ora in riproduzione" })
                .setTitle(track.title.slice(0, 256))
                .setURL(track.url)
                .setThumbnail(track.thumbnail)
                .addFields(
                    { name: "Durata",      value: formatDuration(track.duration), inline: true },
                    { name: "Richiesto da",value: track.requestedBy,              inline: true },
                    { name: "Volume",      value: `${state.volume}%`,             inline: true },
                    { name: "Loop",        value: state.loop,                     inline: true },
                    { name: "Shuffle",     value: state.shuffle ? "✅" : "❌",    inline: true },
                    { name: "In coda",     value: `${state.queue.length} brani`,  inline: true },
                )
                .setFooter({ text: "Tricolore Music" })
                .setTimestamp();

            state.textChannel.send({ embeds: [embed] }).catch(() => {});
        }
    } catch (err) {
        console.error("[MUSIC] Errore stream:", err.message);
        if (state.textChannel) {
            state.textChannel.send(`⚠️ Impossibile riprodurre **${track.title}**. Salto alla prossima...`).catch(() => {});
        }
        playNext(guildId);
    }
}

// ── Crea/recupera player per guild ───────────
function ensurePlayer(guildId) {
    const state = getMusicState(guildId);

    if (state.player) return state.player;

    const player = createAudioPlayer({
        behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
    });

    player.on(AudioPlayerStatus.Idle, () => {
        playNext(guildId);
    });

    player.on("error", (err) => {
        console.error("[MUSIC] Player error:", err.message);
        playNext(guildId);
    });

    state.player = player;
    return player;
}

// ── Slash commands ────────────────────────────
const commands = [
    // NEWS
    new SlashCommandBuilder()
        .setName("news")
        .setDescription("Mostra le ultime notizie ANSA")
        .addStringOption((opt) =>
            opt.setName("categoria")
                .setDescription("Filtra per categoria")
                .addChoices(
                    { name: "Politica", value: "politica" },
                    { name: "Economia", value: "economia" },
                    { name: "Mondo",    value: "mondo"    },
                    { name: "Cronaca",  value: "cronaca"  },
                    { name: "Tutte",    value: "tutte"    }
                )
        ).toJSON(),

    // MUSICA
    new SlashCommandBuilder()
        .setName("play")
        .setDescription("Riproduce una canzone da YouTube (URL o ricerca testo)")
        .addStringOption((opt) =>
            opt.setName("query")
                .setDescription("URL YouTube o nome della canzone")
                .setRequired(true)
        ).toJSON(),

    new SlashCommandBuilder()
        .setName("skip")
        .setDescription("Salta la canzone corrente").toJSON(),

    new SlashCommandBuilder()
        .setName("stop")
        .setDescription("Ferma la musica e svuota la coda").toJSON(),

    new SlashCommandBuilder()
        .setName("pause")
        .setDescription("Mette in pausa la riproduzione").toJSON(),

    new SlashCommandBuilder()
        .setName("resume")
        .setDescription("Riprende la riproduzione").toJSON(),

    new SlashCommandBuilder()
        .setName("queue")
        .setDescription("Mostra la coda attuale").toJSON(),

    new SlashCommandBuilder()
        .setName("nowplaying")
        .setDescription("Mostra la canzone attualmente in riproduzione").toJSON(),

    new SlashCommandBuilder()
        .setName("volume")
        .setDescription("Imposta il volume (1-200)")
        .addIntegerOption((opt) =>
            opt.setName("valore")
                .setDescription("Volume da 1 a 200 (default: 100)")
                .setMinValue(1)
                .setMaxValue(200)
                .setRequired(true)
        ).toJSON(),

    new SlashCommandBuilder()
        .setName("loop")
        .setDescription("Imposta la modalità loop")
        .addStringOption((opt) =>
            opt.setName("modalita")
                .setDescription("Modalità di ripetizione")
                .setRequired(true)
                .addChoices(
                    { name: "Nessuno",    value: "none"  },
                    { name: "Traccia",    value: "track" },
                    { name: "Coda intera",value: "queue" }
                )
        ).toJSON(),

    new SlashCommandBuilder()
        .setName("shuffle")
        .setDescription("Attiva/disattiva la riproduzione casuale").toJSON(),

    new SlashCommandBuilder()
        .setName("join")
        .setDescription("Fa entrare il bot nel tuo canale vocale attuale").toJSON(),

    new SlashCommandBuilder()
        .setName("leave")
        .setDescription("Fa uscire il bot dal canale vocale e svuota la coda").toJSON(),
];

async function registerCommands() {
    try {
        const rest = new REST({ version: "10" }).setToken(TOKEN);
        await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), {
            body: commands,
        });
        console.log("[INFO] Comandi registrati con successo.");
    } catch (err) {
        console.error("[ERROR] Registrazione comandi fallita:", err.message);
    }
}

// ── Build embed notizie ───────────────────────
function buildNewsEmbed(item, feedInfo) {
    return new EmbedBuilder()
        .setColor(feedInfo.color)
        .setTitle((item.title || "Notizia").slice(0, 256))
        .setURL(item.link)
        .setDescription((item.contentSnippet || "Nessuna descrizione disponibile.").slice(0, 300))
        .setFooter({ text: `Tricolore News · ${feedInfo.label}` })
        .setTimestamp(item.pubDate ? new Date(item.pubDate) : new Date());
}

// ── Polling notizie ───────────────────────────
const rssParser = new Parser({ timeout: 10_000 });

async function checkNews(isFirstRun = false) {
    if (!CHANNEL_ID) return;

    let channel;
    try {
        channel = await client.channels.fetch(CHANNEL_ID);
        if (!channel?.isTextBased()) return;
    } catch (err) {
        console.error("[ERROR] Impossibile recuperare il canale:", err.message);
        return;
    }

    let newCount = 0;

    for (const feedInfo of FEEDS) {
        let feed;
        try {
            feed = await rssParser.parseURL(feedInfo.url);
        } catch (err) {
            console.error(`[ERROR] Feed "${feedInfo.label}":`, err.message);
            continue;
        }

        for (const item of feed.items.slice(0, 5)) {
            if (!item.link || sentNews.has(item.link)) continue;
            sentNews.add(item.link);
            if (isFirstRun) continue;

            try {
                await channel.send({ embeds: [buildNewsEmbed(item, feedInfo)] });
                newCount++;
                await sleep(1_200);
            } catch (err) {
                console.error("[ERROR] Invio embed fallito:", err.message);
            }
        }
    }

    saveSentNews(sentNews);

    if (!isFirstRun) {
        console.log(`[INFO] Controllo notizie – ${newCount} nuove notizie inviate.`);
    } else {
        console.log(`[INFO] Primo avvio: ${sentNews.size} notizie indicizzate.`);
    }
}

// ── Helpers: ottieni canale vocale dell'utente ─
async function getMemberVoiceChannel(interaction) {
    try {
        const member = interaction.guild.members.cache.get(interaction.user.id)
                    ?? await interaction.guild.members.fetch(interaction.user.id);
        return member.voice?.channel ?? null;
    } catch {
        return null;
    }
}

// ── Client Discord ────────────────────────────
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
    ],
});

client.once("ready", async () => {
    console.log(`[INFO] Bot online come ${client.user.tag}`);
    await registerCommands();
    await checkNews(true);
    setInterval(() => checkNews(false), 5 * 60 * 1000);
});

// ── Gestione interazioni ──────────────────────
client.on("interactionCreate", async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    const { commandName, guild } = interaction;

    // ════════════════════════════════
    //  /news
    // ════════════════════════════════
    if (commandName === "news") {
        await interaction.deferReply();
        const categoria   = interaction.options.getString("categoria") || "tutte";
        const targetFeeds = categoria === "tutte"
            ? FEEDS
            : FEEDS.filter((f) => f.label.toLowerCase() === categoria);

        const embeds = [];
        for (const feedInfo of targetFeeds) {
            let feed;
            try { feed = await rssParser.parseURL(feedInfo.url); } catch { continue; }
            for (const item of feed.items.slice(0, 3)) {
                if (!item.link) continue;
                embeds.push(buildNewsEmbed(item, feedInfo));
                if (embeds.length >= 10) break;
            }
            if (embeds.length >= 10) break;
        }

        if (embeds.length === 0) {
            await interaction.editReply({ content: "⚠️ Nessuna notizia disponibile al momento." });
            return;
        }
        await interaction.editReply({ embeds });
        return;
    }

    // ════════════════════════════════
    //  /join
    // ════════════════════════════════
    if (commandName === "join") {
        const voiceChannel = await getMemberVoiceChannel(interaction);
        if (!voiceChannel) {
            await interaction.reply({ content: "❌ Devi prima entrare in un canale vocale!", ephemeral: true });
            return;
        }

        const existing = getVoiceConnection(guild.id);
        if (existing) {
            if (existing.joinConfig.channelId === voiceChannel.id) {
                await interaction.reply({ content: `✅ Sono già nel canale **${voiceChannel.name}**!`, ephemeral: true });
                return;
            }
            existing.destroy();
        }

        try {
            const connection = joinVoiceChannel({
                channelId:      voiceChannel.id,
                guildId:        guild.id,
                adapterCreator: guild.voiceAdapterCreator,
                selfDeaf:       true,
                selfMute:       false,
            });

            const state  = getMusicState(guild.id);
            state.connection  = connection;
            state.textChannel = interaction.channel;

            const player = ensurePlayer(guild.id);
            connection.subscribe(player);

            await interaction.reply({ content: `🎙️ Entrato nel canale **${voiceChannel.name}**!` });
        } catch (err) {
            console.error("[ERROR] join:", err.message);
            await interaction.reply({ content: "❌ Non riesco ad entrare nel canale vocale.", ephemeral: true });
        }
        return;
    }

    // ════════════════════════════════
    //  /leave
    // ════════════════════════════════
    if (commandName === "leave") {
        const connection = getVoiceConnection(guild.id);
        if (!connection) {
            await interaction.reply({ content: "❌ Non sono in nessun canale vocale!", ephemeral: true });
            return;
        }

        const state     = getMusicState(guild.id);
        const chName    = guild.channels.cache.get(connection.joinConfig.channelId)?.name ?? "canale";
        state.queue     = [];
        state.current   = null;
        state.player?.stop();
        connection.destroy();
        musicStates.delete(guild.id);

        await interaction.reply({ content: `👋 Uscito dal canale **${chName}** e coda svuotata.` });
        return;
    }

    // ════════════════════════════════
    //  /play
    // ════════════════════════════════
    if (commandName === "play") {
        const query = interaction.options.getString("query", true);
        await interaction.deferReply();

        // Assicura che il bot sia nel canale vocale
        const voiceChannel = await getMemberVoiceChannel(interaction);
        if (!voiceChannel) {
            await interaction.editReply({ content: "❌ Devi essere in un canale vocale per usare `/play`!" });
            return;
        }

        let connection = getVoiceConnection(guild.id);
        if (!connection) {
            connection = joinVoiceChannel({
                channelId:      voiceChannel.id,
                guildId:        guild.id,
                adapterCreator: guild.voiceAdapterCreator,
                selfDeaf:       true,
                selfMute:       false,
            });
        }

        const state       = getMusicState(guild.id);
        state.connection  = connection;
        state.textChannel = interaction.channel;

        const player = ensurePlayer(guild.id);
        connection.subscribe(player);

        // Cerca la canzone
        const track = await searchYouTube(query);
        if (!track) {
            await interaction.editReply({ content: `⚠️ Nessun risultato trovato per: **${query}**` });
            return;
        }

        track.requestedBy = interaction.user.username;
        state.queue.push(track);

        const isPlaying = player.state.status === AudioPlayerStatus.Playing
                       || player.state.status === AudioPlayerStatus.Buffering;

        if (!isPlaying) {
            await interaction.editReply({ content: `🎵 Caricamento di **${track.title}**...` });
            playNext(guild.id);
        } else {
            const embed = new EmbedBuilder()
                .setColor(0x1db954)
                .setAuthor({ name: "➕  Aggiunto alla coda" })
                .setTitle(track.title.slice(0, 256))
                .setURL(track.url)
                .setThumbnail(track.thumbnail)
                .addFields(
                    { name: "Durata",       value: formatDuration(track.duration), inline: true },
                    { name: "Posizione",    value: `#${state.queue.length}`,        inline: true },
                    { name: "Richiesto da", value: track.requestedBy,               inline: true },
                )
                .setFooter({ text: "Tricolore Music" })
                .setTimestamp();

            await interaction.editReply({ embeds: [embed] });
        }
        return;
    }

    // ════════════════════════════════
    //  /skip
    // ════════════════════════════════
    if (commandName === "skip") {
        const state = getMusicState(guild.id);
        if (!state.player || state.player.state.status === AudioPlayerStatus.Idle) {
            await interaction.reply({ content: "❌ Nessuna canzone in riproduzione.", ephemeral: true });
            return;
        }

        // Forza il passaggio alla prossima (disabilita temporaneamente loop traccia)
        const prevLoop = state.loop;
        if (state.loop === "track") state.loop = "none";
        state.player.stop();
        state.loop = prevLoop;

        await interaction.reply({ content: `⏭️ **${state.current?.title ?? "Canzone"}** saltata.` });
        return;
    }

    // ════════════════════════════════
    //  /stop
    // ════════════════════════════════
    if (commandName === "stop") {
        const state = getMusicState(guild.id);
        state.queue   = [];
        state.current = null;
        state.loop    = "none";
        state.player?.stop();

        await interaction.reply({ content: "⏹️ Riproduzione fermata e coda svuotata." });
        return;
    }

    // ════════════════════════════════
    //  /pause
    // ════════════════════════════════
    if (commandName === "pause") {
        const state = getMusicState(guild.id);
        if (state.player?.state.status !== AudioPlayerStatus.Playing) {
            await interaction.reply({ content: "❌ Il bot non sta riproducendo nulla.", ephemeral: true });
            return;
        }
        state.player.pause();
        await interaction.reply({ content: `⏸️ Riproduzione in pausa. Usa \`/resume\` per riprendere.` });
        return;
    }

    // ════════════════════════════════
    //  /resume
    // ════════════════════════════════
    if (commandName === "resume") {
        const state = getMusicState(guild.id);
        if (state.player?.state.status !== AudioPlayerStatus.Paused) {
            await interaction.reply({ content: "❌ La riproduzione non è in pausa.", ephemeral: true });
            return;
        }
        state.player.unpause();
        await interaction.reply({ content: `▶️ Riproduzione ripresa!` });
        return;
    }

    // ════════════════════════════════
    //  /nowplaying
    // ════════════════════════════════
    if (commandName === "nowplaying") {
        const state = getMusicState(guild.id);
        if (!state.current) {
            await interaction.reply({ content: "❌ Nessuna canzone in riproduzione al momento.", ephemeral: true });
            return;
        }

        const track = state.current;
        const embed = new EmbedBuilder()
            .setColor(0x1db954)
            .setAuthor({ name: "🎵  Ora in riproduzione" })
            .setTitle(track.title.slice(0, 256))
            .setURL(track.url)
            .setThumbnail(track.thumbnail)
            .addFields(
                { name: "Durata",       value: formatDuration(track.duration), inline: true },
                { name: "Richiesto da", value: track.requestedBy,              inline: true },
                { name: "Volume",       value: `${state.volume}%`,             inline: true },
                { name: "Loop",         value: state.loop,                     inline: true },
                { name: "Shuffle",      value: state.shuffle ? "✅" : "❌",    inline: true },
                { name: "In coda",      value: `${state.queue.length} brani`,  inline: true },
            )
            .setFooter({ text: "Tricolore Music" })
            .setTimestamp();

        await interaction.reply({ embeds: [embed] });
        return;
    }

    // ════════════════════════════════
    //  /queue
    // ════════════════════════════════
    if (commandName === "queue") {
        const state = getMusicState(guild.id);

        if (!state.current && state.queue.length === 0) {
            await interaction.reply({ content: "📭 La coda è vuota.", ephemeral: true });
            return;
        }

        const lines = [];
        if (state.current) {
            lines.push(`**▶  In riproduzione:**\n[${state.current.title}](${state.current.url}) · ${formatDuration(state.current.duration)}\n`);
        }

        if (state.queue.length > 0) {
            lines.push("**📋  Coda:**");
            state.queue.slice(0, 15).forEach((t, i) => {
                lines.push(`\`${i + 1}.\` [${t.title.slice(0, 50)}](${t.url}) · ${formatDuration(t.duration)} · *${t.requestedBy}*`);
            });
            if (state.queue.length > 15) {
                lines.push(`\n*...e altri ${state.queue.length - 15} brani*`);
            }
        }

        const embed = new EmbedBuilder()
            .setColor(0x1db954)
            .setTitle("🎶  Coda musicale")
            .setDescription(lines.join("\n").slice(0, 4096))
            .addFields(
                { name: "Loop",    value: state.loop,                     inline: true },
                { name: "Shuffle", value: state.shuffle ? "✅" : "❌",    inline: true },
                { name: "Volume",  value: `${state.volume}%`,             inline: true },
            )
            .setFooter({ text: `${state.queue.length} brani in attesa · Tricolore Music` })
            .setTimestamp();

        await interaction.reply({ embeds: [embed] });
        return;
    }

    // ════════════════════════════════
    //  /volume
    // ════════════════════════════════
    if (commandName === "volume") {
        const value = interaction.options.getInteger("valore", true);
        const state = getMusicState(guild.id);
        state.volume = value;

        // Applica subito se c'è una risorsa attiva
        if (state.currentResource?.volume) {
            state.currentResource.volume.setVolumeLogarithmic(value / 100);
        }

        await interaction.reply({ content: `🔊 Volume impostato a **${value}%**.` });
        return;
    }

    // ════════════════════════════════
    //  /loop
    // ════════════════════════════════
    if (commandName === "loop") {
        const modalita = interaction.options.getString("modalita", true);
        const state    = getMusicState(guild.id);
        state.loop     = modalita;

        const labels = { none: "🚫 Nessun loop", track: "🔂 Loop traccia", queue: "🔁 Loop coda" };
        await interaction.reply({ content: `Loop impostato su: **${labels[modalita]}**` });
        return;
    }

    // ════════════════════════════════
    //  /shuffle
    // ════════════════════════════════
    if (commandName === "shuffle") {
        const state   = getMusicState(guild.id);
        state.shuffle = !state.shuffle;
        await interaction.reply({
            content: state.shuffle
                ? "🔀 Shuffle **attivato**! Le canzoni verranno riprodotte in ordine casuale."
                : "➡️ Shuffle **disattivato**. Riproduzione in ordine normale.",
        });
        return;
    }
});

// ── Server Express (keep-alive) ───────────────
const app = express();

app.get("/", (_req, res) => res.send("Tricolore News & Music Bot – Online ✅"));
app.get("/health", (_req, res) =>
    res.json({
        status:    "ok",
        uptime:    process.uptime(),
        sentNews:  sentNews.size,
        timestamp: new Date().toISOString(),
    })
);

app.listen(PORT, () => console.log(`[INFO] Server Express in ascolto sulla porta ${PORT}`));

// ── Gestione errori globale ───────────────────
process.on("unhandledRejection", (reason) => console.error("[UNHANDLED REJECTION]", reason));
process.on("uncaughtException",  (err)    => console.error("[UNCAUGHT EXCEPTION]", err.message));

// ── Avvio ─────────────────────────────────────
client.login(TOKEN);
