"use strict";

// ──────────────────────────────────────────────
//  Tricolore News & Music Bot  –  index.js
//  Versione con Lavalink (Shoukaku) + notizie ANSA
// ──────────────────────────────────────────────

const {
    Client,
    GatewayIntentBits,
    EmbedBuilder,
    REST,
    Routes,
    SlashCommandBuilder,
} = require("discord.js");
const { Shoukaku, Connectors } = require("shoukaku");
const Parser  = require("rss-parser");
const express = require("express");
const fs      = require("fs");
const path    = require("path");

// ── Configurazione ────────────────────────────
const TOKEN      = process.env.TOKEN;
const CLIENT_ID  = process.env.CLIENT_ID  || "1512928969849311272";
const GUILD_ID   = process.env.GUILD_ID   || "1512809889666175211";
const CHANNEL_ID = process.env.CHANNEL_ID;
const PORT       = process.env.PORT       || 3000;

if (!TOKEN) {
    console.error("[FATAL] TOKEN non impostato.");
    process.exit(1);
}

// ── Nodi Lavalink pubblici ────────────────────
// Lista di nodi pubblici gratuiti con fallback automatico
const LAVALINK_NODES = [
    {
        name:      "lavalink.clxud.xyz",
        url:       "lavalink.clxud.xyz",
        auth:      "youshallnotpass",
        port:      443,
        secure:    true,
    },
    {
        name:      "lavalink.jirayu.net",
        url:       "lavalink.jirayu.net",
        auth:      "youshallnotpass",
        port:      13592,
        secure:    false,
    },
    {
        name:      "lavalink.devamop.in",
        url:       "lavalink.devamop.in",
        auth:      "DevamOP",
        port:      443,
        secure:    true,
    },
];

// ── Feed RSS ──────────────────────────────────
const FEEDS = [
    { url: "https://www.ansa.it/sito/notizie/politica/politica_rss.xml",  label: "Politica",  color: 0x2b5ce6 },
    { url: "https://www.ansa.it/sito/notizie/economia/economia_rss.xml",  label: "Economia",  color: 0x27ae60 },
    { url: "https://www.ansa.it/sito/notizie/mondo/mondo_rss.xml",        label: "Mondo",     color: 0xe67e22 },
    { url: "https://www.ansa.it/sito/notizie/cronaca/cronaca_rss.xml",    label: "Cronaca",   color: 0xe74c3c },
];

// ── Persistenza notizie ───────────────────────
const SENT_FILE = path.join(__dirname, "sent_news.json");

function loadSentNews() {
    try {
        if (fs.existsSync(SENT_FILE)) {
            const data = JSON.parse(fs.readFileSync(SENT_FILE, "utf8"));
            return new Set(Array.isArray(data) ? data : []);
        }
    } catch {
        console.warn("[WARN] Impossibile leggere sent_news.json.");
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
const sleep    = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Stato Musicale per guild ──────────────────
const musicStates = new Map();

function getMusicState(guildId) {
    if (!musicStates.has(guildId)) {
        musicStates.set(guildId, {
            queue:       [],      // Array di { title, uri, duration, thumbnail, requestedBy }
            player:      null,    // Shoukaku Player
            current:     null,    // Traccia corrente
            volume:      100,     // 1-200
            loop:        "none",  // "none" | "track" | "queue"
            shuffle:     false,
            textChannel: null,
        });
    }
    return musicStates.get(guildId);
}

function formatDuration(ms) {
    if (!ms) return "Live";
    const totalSec = Math.floor(ms / 1000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `${m}:${s.toString().padStart(2, "0")}`;
}

// ── Avvia prossima traccia ────────────────────
async function playNext(guildId) {
    const state = getMusicState(guildId);
    const { queue, loop, shuffle, player } = state;

    if (!player) return;

    if (queue.length === 0 && loop !== "track") {
        state.current = null;
        state.textChannel?.send("✅ **Coda terminata.** Aggiungi altre canzoni con `/play`!").catch(() => {});
        return;
    }

    let track;
    if (loop === "track" && state.current) {
        track = state.current;
    } else {
        const idx = shuffle && queue.length > 1
            ? Math.floor(Math.random() * queue.length)
            : 0;
        track = queue.splice(idx, 1)[0];
        if (loop === "queue") queue.push(track);
    }

    state.current = track;

    try {
        await player.playTrack({ track: track.encoded });
        await player.setVolume(state.volume);

        const embed = new EmbedBuilder()
            .setColor(0x1db954)
            .setAuthor({ name: "▶  Ora in riproduzione" })
            .setTitle(track.title.slice(0, 256))
            .setURL(track.uri)
            .setThumbnail(track.thumbnail ?? null)
            .addFields(
                { name: "Durata",       value: formatDuration(track.duration), inline: true },
                { name: "Richiesto da", value: track.requestedBy,              inline: true },
                { name: "Volume",       value: `${state.volume}%`,             inline: true },
                { name: "Loop",         value: state.loop,                     inline: true },
                { name: "Shuffle",      value: state.shuffle ? "✅" : "❌",    inline: true },
                { name: "In coda",      value: `${queue.length} brani`,        inline: true },
            )
            .setFooter({ text: "Tricolore Music · Lavalink" })
            .setTimestamp();

        state.textChannel?.send({ embeds: [embed] }).catch(() => {});
    } catch (err) {
        console.error("[MUSIC] Errore playTrack:", err.message);
        state.textChannel?.send(`⚠️ Impossibile riprodurre **${track.title}**. Salto...`).catch(() => {});
        playNext(guildId);
    }
}

// ── Slash Commands ────────────────────────────
const commands = [
    new SlashCommandBuilder()
        .setName("news")
        .setDescription("Mostra le ultime notizie ANSA")
        .addStringOption((opt) =>
            opt.setName("categoria").setDescription("Filtra per categoria")
                .addChoices(
                    { name: "Politica", value: "politica" },
                    { name: "Economia", value: "economia" },
                    { name: "Mondo",    value: "mondo"    },
                    { name: "Cronaca",  value: "cronaca"  },
                    { name: "Tutte",    value: "tutte"    }
                )
        ).toJSON(),

    new SlashCommandBuilder()
        .setName("play")
        .setDescription("Riproduce una canzone da YouTube (URL o ricerca testo)")
        .addStringOption((opt) =>
            opt.setName("query").setDescription("URL YouTube o nome della canzone").setRequired(true)
        ).toJSON(),

    new SlashCommandBuilder().setName("skip")      .setDescription("Salta la canzone corrente").toJSON(),
    new SlashCommandBuilder().setName("stop")      .setDescription("Ferma la musica e svuota la coda").toJSON(),
    new SlashCommandBuilder().setName("pause")     .setDescription("Mette in pausa la riproduzione").toJSON(),
    new SlashCommandBuilder().setName("resume")    .setDescription("Riprende la riproduzione").toJSON(),
    new SlashCommandBuilder().setName("queue")     .setDescription("Mostra la coda attuale").toJSON(),
    new SlashCommandBuilder().setName("nowplaying").setDescription("Mostra la canzone in riproduzione").toJSON(),
    new SlashCommandBuilder().setName("shuffle")   .setDescription("Attiva/disattiva la riproduzione casuale").toJSON(),
    new SlashCommandBuilder().setName("join")      .setDescription("Fa entrare il bot nel tuo canale vocale").toJSON(),
    new SlashCommandBuilder().setName("leave")     .setDescription("Fa uscire il bot dal canale vocale").toJSON(),

    new SlashCommandBuilder()
        .setName("volume")
        .setDescription("Imposta il volume (1-200)")
        .addIntegerOption((opt) =>
            opt.setName("valore").setDescription("Volume da 1 a 200").setMinValue(1).setMaxValue(200).setRequired(true)
        ).toJSON(),

    new SlashCommandBuilder()
        .setName("loop")
        .setDescription("Imposta la modalità loop")
        .addStringOption((opt) =>
            opt.setName("modalita").setDescription("Modalità di ripetizione").setRequired(true)
                .addChoices(
                    { name: "Nessuno",     value: "none"  },
                    { name: "Traccia",     value: "track" },
                    { name: "Coda intera", value: "queue" }
                )
        ).toJSON(),
];

async function registerCommands() {
    try {
        const rest = new REST({ version: "10" }).setToken(TOKEN);
        await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
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
        .setDescription((item.contentSnippet || "Nessuna descrizione.").slice(0, 300))
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
        console.error("[ERROR] Canale non trovato:", err.message);
        return;
    }

    let newCount = 0;
    for (const feedInfo of FEEDS) {
        let feed;
        try { feed = await rssParser.parseURL(feedInfo.url); } catch { continue; }

        for (const item of feed.items.slice(0, 5)) {
            if (!item.link || sentNews.has(item.link)) continue;
            sentNews.add(item.link);
            if (isFirstRun) continue;
            try {
                await channel.send({ embeds: [buildNewsEmbed(item, feedInfo)] });
                newCount++;
                await sleep(1_200);
            } catch (err) {
                console.error("[ERROR] Invio notizia:", err.message);
            }
        }
    }

    saveSentNews(sentNews);
    if (!isFirstRun) console.log(`[INFO] ${newCount} nuove notizie inviate.`);
    else console.log(`[INFO] Primo avvio: ${sentNews.size} notizie indicizzate.`);
}

// ── Helper: canale vocale dell'utente ─────────
async function getMemberVoiceChannel(interaction) {
    try {
        const member = interaction.guild.members.cache.get(interaction.user.id)
                    ?? await interaction.guild.members.fetch(interaction.user.id);
        return member.voice?.channel ?? null;
    } catch { return null; }
}

// ── Helper: ottieni/crea player Lavalink ──────
async function ensureLavalinkPlayer(guild, voiceChannel) {
    const state = getMusicState(guild.id);

    // Se c'è già un player connesso al canale giusto, riusalo
    if (state.player && !state.player.destroyed) return state.player;

    // Prende un nodo disponibile
    const node = shoukaku.options.nodes.length > 0
        ? shoukaku.getIdealNode()
        : null;

    if (!node) throw new Error("Nessun nodo Lavalink disponibile al momento.");

    const player = await shoukaku.joinVoiceChannel({
        guildId:   guild.id,
        channelId: voiceChannel.id,
        shardId:   0,
    });

    // Evento: traccia finita → prossima
    player.on("end", () => playNext(guild.id));

    // Evento: errore player
    player.on("exception", (error) => {
        console.error("[LAVALINK] Eccezione:", error?.message);
        getMusicState(guild.id).textChannel
            ?.send("⚠️ Errore durante la riproduzione. Salto alla prossima...").catch(() => {});
        playNext(guild.id);
    });

    // Evento: player si è bloccato (stuck)
    player.on("stuck", () => {
        console.warn("[LAVALINK] Player bloccato, salto...");
        playNext(guild.id);
    });

    state.player = player;
    return player;
}

// ── Client Discord ────────────────────────────
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
    ],
});

// ── Shoukaku (Lavalink client) ────────────────
const shoukaku = new Shoukaku(
    new Connectors.DiscordJS(client),
    LAVALINK_NODES,
    {
        moveOnDisconnect: true,
        resumable:        false,
        resumableTimeout: 30,
        reconnectTries:   3,
        restTimeout:      10000,
    }
);

shoukaku.on("ready",      (name)        => console.log(`[LAVALINK] Nodo connesso: ${name}`));
shoukaku.on("error",      (name, error) => console.error(`[LAVALINK] Errore nodo ${name}:`, error.message));
shoukaku.on("disconnect", (name)        => console.warn(`[LAVALINK] Nodo disconnesso: ${name}`));

// ── Ready ─────────────────────────────────────
client.once("ready", async () => {
    console.log(`[INFO] Bot online come ${client.user.tag}`);
    await registerCommands();
    await checkNews(true);
    setInterval(() => checkNews(false), 5 * 60 * 1000);
});

// ── Gestione comandi ──────────────────────────
client.on("interactionCreate", async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    const { commandName, guild } = interaction;

    // ── /news ─────────────────────────────────
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
            await interaction.editReply({ content: "⚠️ Nessuna notizia disponibile." });
            return;
        }
        await interaction.editReply({ embeds });
        return;
    }

    // ── /join ─────────────────────────────────
    if (commandName === "join") {
        const voiceChannel = await getMemberVoiceChannel(interaction);
        if (!voiceChannel) {
            await interaction.reply({ content: "❌ Devi essere in un canale vocale!", ephemeral: true });
            return;
        }
        try {
            const state = getMusicState(guild.id);
            state.textChannel = interaction.channel;
            await ensureLavalinkPlayer(guild, voiceChannel);
            await interaction.reply({ content: `🎙️ Entrato nel canale **${voiceChannel.name}**!` });
        } catch (err) {
            await interaction.reply({ content: `❌ ${err.message}`, ephemeral: true });
        }
        return;
    }

    // ── /leave ────────────────────────────────
    if (commandName === "leave") {
        const state = getMusicState(guild.id);
        if (!state.player || state.player.destroyed) {
            await interaction.reply({ content: "❌ Non sono in nessun canale vocale!", ephemeral: true });
            return;
        }
        state.queue   = [];
        state.current = null;
        await state.player.stopTrack();
        shoukaku.leaveVoiceChannel(guild.id);
        state.player = null;
        musicStates.delete(guild.id);
        await interaction.reply({ content: "👋 Uscito dal canale vocale e coda svuotata." });
        return;
    }

    // ── /play ─────────────────────────────────
    if (commandName === "play") {
        const query = interaction.options.getString("query", true);
        await interaction.deferReply();

        const voiceChannel = await getMemberVoiceChannel(interaction);
        if (!voiceChannel) {
            await interaction.editReply({ content: "❌ Devi essere in un canale vocale per usare `/play`!" });
            return;
        }

        let player;
        try {
            const state = getMusicState(guild.id);
            state.textChannel = interaction.channel;
            player = await ensureLavalinkPlayer(guild, voiceChannel);
        } catch (err) {
            await interaction.editReply({ content: `❌ ${err.message}` });
            return;
        }

        // Cerca la traccia sul nodo Lavalink
        const node   = shoukaku.getIdealNode();
        const isUrl  = /^https?:\/\//.test(query);
        const search = isUrl ? query : `ytsearch:${query}`;

        let result;
        try {
            result = await node.rest.resolve(search);
        } catch (err) {
            await interaction.editReply({ content: "⚠️ Errore durante la ricerca. Riprova." });
            return;
        }

        if (!result || !result.tracks?.length) {
            await interaction.editReply({ content: `⚠️ Nessun risultato per: **${query}**` });
            return;
        }

        const state  = getMusicState(guild.id);
        const tracks = result.loadType === "PLAYLIST_LOADED"
            ? result.tracks
            : [result.tracks[0]];

        for (const t of tracks) {
            state.queue.push({
                encoded:     t.encoded,
                title:       t.info.title,
                uri:         t.info.uri,
                duration:    t.info.length,
                thumbnail:   t.info.artworkUrl ?? `https://img.youtube.com/vi/${t.info.identifier}/hqdefault.jpg`,
                requestedBy: interaction.user.username,
            });
        }

        const isPlaying = player.track !== null && !player.paused;

        if (!isPlaying) {
            await interaction.editReply({ content: `🎵 Caricamento di **${tracks[0].info.title}**...` });
            playNext(guild.id);
        } else {
            const embed = new EmbedBuilder()
                .setColor(0x1db954)
                .setAuthor({ name: tracks.length > 1 ? `➕  Playlist aggiunta (${tracks.length} brani)` : "➕  Aggiunto alla coda" })
                .setTitle(tracks[0].info.title.slice(0, 256))
                .setURL(tracks[0].info.uri)
                .setThumbnail(`https://img.youtube.com/vi/${tracks[0].info.identifier}/hqdefault.jpg`)
                .addFields(
                    { name: "Durata",    value: formatDuration(tracks[0].info.length), inline: true },
                    { name: "Posizione", value: `#${state.queue.length}`,              inline: true },
                )
                .setFooter({ text: "Tricolore Music · Lavalink" })
                .setTimestamp();
            await interaction.editReply({ embeds: [embed] });
        }
        return;
    }

    // ── /skip ─────────────────────────────────
    if (commandName === "skip") {
        const state = getMusicState(guild.id);
        if (!state.player || !state.current) {
            await interaction.reply({ content: "❌ Nessuna canzone in riproduzione.", ephemeral: true });
            return;
        }
        const prevLoop = state.loop;
        if (state.loop === "track") state.loop = "none";
        await state.player.stopTrack();
        state.loop = prevLoop;
        await interaction.reply({ content: `⏭️ **${state.current.title}** saltata.` });
        return;
    }

    // ── /stop ─────────────────────────────────
    if (commandName === "stop") {
        const state = getMusicState(guild.id);
        state.queue   = [];
        state.current = null;
        state.loop    = "none";
        await state.player?.stopTrack();
        await interaction.reply({ content: "⏹️ Riproduzione fermata e coda svuotata." });
        return;
    }

    // ── /pause ────────────────────────────────
    if (commandName === "pause") {
        const state = getMusicState(guild.id);
        if (!state.player || state.player.paused || !state.current) {
            await interaction.reply({ content: "❌ Nessuna canzone in riproduzione.", ephemeral: true });
            return;
        }
        await state.player.setPaused(true);
        await interaction.reply({ content: "⏸️ Riproduzione in pausa. Usa `/resume` per riprendere." });
        return;
    }

    // ── /resume ───────────────────────────────
    if (commandName === "resume") {
        const state = getMusicState(guild.id);
        if (!state.player || !state.player.paused) {
            await interaction.reply({ content: "❌ La riproduzione non è in pausa.", ephemeral: true });
            return;
        }
        await state.player.setPaused(false);
        await interaction.reply({ content: "▶️ Riproduzione ripresa!" });
        return;
    }

    // ── /nowplaying ───────────────────────────
    if (commandName === "nowplaying") {
        const state = getMusicState(guild.id);
        if (!state.current) {
            await interaction.reply({ content: "❌ Nessuna canzone in riproduzione.", ephemeral: true });
            return;
        }
        const track = state.current;
        const embed = new EmbedBuilder()
            .setColor(0x1db954)
            .setAuthor({ name: "🎵  Ora in riproduzione" })
            .setTitle(track.title.slice(0, 256))
            .setURL(track.uri)
            .setThumbnail(track.thumbnail ?? null)
            .addFields(
                { name: "Durata",       value: formatDuration(track.duration), inline: true },
                { name: "Richiesto da", value: track.requestedBy,              inline: true },
                { name: "Volume",       value: `${state.volume}%`,             inline: true },
                { name: "Loop",         value: state.loop,                     inline: true },
                { name: "Shuffle",      value: state.shuffle ? "✅" : "❌",    inline: true },
                { name: "In coda",      value: `${state.queue.length} brani`,  inline: true },
            )
            .setFooter({ text: "Tricolore Music · Lavalink" })
            .setTimestamp();
        await interaction.reply({ embeds: [embed] });
        return;
    }

    // ── /queue ────────────────────────────────
    if (commandName === "queue") {
        const state = getMusicState(guild.id);
        if (!state.current && state.queue.length === 0) {
            await interaction.reply({ content: "📭 La coda è vuota.", ephemeral: true });
            return;
        }

        const lines = [];
        if (state.current) {
            lines.push(`**▶  In riproduzione:**\n[${state.current.title}](${state.current.uri}) · ${formatDuration(state.current.duration)}\n`);
        }
        if (state.queue.length > 0) {
            lines.push("**📋  Coda:**");
            state.queue.slice(0, 15).forEach((t, i) => {
                lines.push(`\`${i + 1}.\` [${t.title.slice(0, 50)}](${t.uri}) · ${formatDuration(t.duration)} · *${t.requestedBy}*`);
            });
            if (state.queue.length > 15) lines.push(`\n*...e altri ${state.queue.length - 15} brani*`);
        }

        const embed = new EmbedBuilder()
            .setColor(0x1db954)
            .setTitle("🎶  Coda musicale")
            .setDescription(lines.join("\n").slice(0, 4096))
            .addFields(
                { name: "Loop",    value: state.loop,                  inline: true },
                { name: "Shuffle", value: state.shuffle ? "✅" : "❌", inline: true },
                { name: "Volume",  value: `${state.volume}%`,          inline: true },
            )
            .setFooter({ text: `${state.queue.length} brani in attesa · Tricolore Music` })
            .setTimestamp();
        await interaction.reply({ embeds: [embed] });
        return;
    }

    // ── /volume ───────────────────────────────
    if (commandName === "volume") {
        const value = interaction.options.getInteger("valore", true);
        const state = getMusicState(guild.id);
        state.volume = value;
        await state.player?.setVolume(value);
        await interaction.reply({ content: `🔊 Volume impostato a **${value}%**.` });
        return;
    }

    // ── /loop ─────────────────────────────────
    if (commandName === "loop") {
        const modalita = interaction.options.getString("modalita", true);
        const state    = getMusicState(guild.id);
        state.loop     = modalita;
        const labels   = { none: "🚫 Nessun loop", track: "🔂 Loop traccia", queue: "🔁 Loop coda" };
        await interaction.reply({ content: `Loop impostato su: **${labels[modalita]}**` });
        return;
    }

    // ── /shuffle ──────────────────────────────
    if (commandName === "shuffle") {
        const state   = getMusicState(guild.id);
        state.shuffle = !state.shuffle;
        await interaction.reply({
            content: state.shuffle
                ? "🔀 Shuffle **attivato**!"
                : "➡️ Shuffle **disattivato**.",
        });
        return;
    }
});

// ── Express keep-alive ────────────────────────
const app = express();
app.get("/",       (_req, res) => res.send("Tricolore News & Music Bot – Online ✅"));
app.get("/health", (_req, res) => res.json({
    status:    "ok",
    uptime:    process.uptime(),
    sentNews:  sentNews.size,
    timestamp: new Date().toISOString(),
}));
app.listen(PORT, () => console.log(`[INFO] Express in ascolto sulla porta ${PORT}`));

// ── Errori globali ────────────────────────────
process.on("unhandledRejection", (r) => console.error("[UNHANDLED REJECTION]", r));
process.on("uncaughtException",  (e) => console.error("[UNCAUGHT EXCEPTION]", e.message));

// ── Login ─────────────────────────────────────
client.login(TOKEN);
