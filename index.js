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
const Parser  = require("rss-parser");
const express = require("express");
const fs      = require("fs");
const path    = require("path");
const os      = require("os");
const fetch   = require("node-fetch");

// ── Configurazione ────────────────────────────
const TOKEN      = process.env.TOKEN;
const CLIENT_ID  = process.env.CLIENT_ID  || "1512928969849311272";
const PORT       = process.env.PORT       || 3000;

if (!TOKEN) {
    console.error("[FATAL] TOKEN non impostato.");
    process.exit(1);
}

// ── Nodi Lavalink ─────────────────────────────
const LAVALINK_NODES = [
    { name: "serenetia", url: "lavalinkv4.serenetia.com", auth: "https://seretia.link/discord",    port: 443, secure: true  },
    { name: "jirayu",    url: "lavalink.jirayu.net",      auth: "youshallnotpass",                  port: 443, secure: true  },
    { name: "millohost", url: "lava-v4.millohost.my.id",  auth: "https://discord.gg/mjS5J2K3ep",   port: 443, secure: true  },
    { name: "trinium",   url: "lavalink-v4.triniumhost.com", auth: "free",                          port: 443, secure: true  },
];

// ── Feed RSS ──────────────────────────────────
const FEEDS = [
    { url: "https://www.ansa.it/sito/notizie/politica/politica_rss.xml", label: "Politica", color: 0x2b5ce6 },
    { url: "https://www.ansa.it/sito/notizie/economia/economia_rss.xml", label: "Economia", color: 0x27ae60 },
    { url: "https://www.ansa.it/sito/notizie/mondo/mondo_rss.xml",       label: "Mondo",    color: 0xe67e22 },
    { url: "https://www.ansa.it/sito/notizie/cronaca/cronaca_rss.xml",   label: "Cronaca",  color: 0xe74c3c },
];
const rssParser = new Parser({ timeout: 10_000 });

function buildNewsEmbed(item, feedInfo) {
    return new EmbedBuilder()
        .setColor(feedInfo.color)
        .setTitle((item.title || "Notizia").slice(0, 256))
        .setURL(item.link)
        .setDescription((item.contentSnippet || "Nessuna descrizione.").slice(0, 300))
        .setFooter({ text: `Tricolore News · ${feedInfo.label}` })
        .setTimestamp(item.pubDate ? new Date(item.pubDate) : new Date());
}

// ── TTS files map ─────────────────────────────
const ttsFiles = new Map();
const sleep    = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Stato musicale ────────────────────────────
const musicStates = new Map();

function getMusicState(guildId) {
    if (!musicStates.has(guildId)) {
        musicStates.set(guildId, {
            queue: [], player: null, current: null,
            volume: 100, loop: "none", shuffle: false,
            textChannel: null, isPlaying: false,
        });
    }
    return musicStates.get(guildId);
}

function formatDuration(ms) {
    if (!ms || ms <= 0) return "Live";
    const totalSec = Math.floor(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    if (h > 0) return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
    return `${m}:${s.toString().padStart(2, "0")}`;
}

async function playNext(guildId) {
    const state = getMusicState(guildId);
    const { queue, loop, shuffle, player } = state;
    if (!player || player.destroyed) { state.isPlaying = false; return; }
    if (queue.length === 0 && loop !== "track") {
        state.current = null; state.isPlaying = false;
        state.textChannel?.send("✅ **Coda terminata.** Aggiungi altre canzoni con `/play`!").catch(() => {});
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
    state.current = track; state.isPlaying = true;
    try {
        await player.playTrack({ track: { encoded: track.encoded } });
        await player.setGlobalVolume(state.volume);
        const embed = new EmbedBuilder()
            .setColor(0x1db954).setAuthor({ name: "▶  Ora in riproduzione" })
            .setTitle(track.title.slice(0, 256)).setURL(track.uri).setThumbnail(track.thumbnail ?? null)
            .addFields(
                { name: "⏱ Durata",       value: formatDuration(track.duration), inline: true },
                { name: "👤 Richiesto da", value: track.requestedBy,              inline: true },
                { name: "🔊 Volume",       value: `${state.volume}%`,             inline: true },
                { name: "🔁 Loop",         value: state.loop,                     inline: true },
                { name: "🔀 Shuffle",      value: state.shuffle ? "✅" : "❌",    inline: true },
                { name: "📋 In coda",      value: `${queue.length} brani`,        inline: true },
            )
            .setFooter({ text: "Tricolore Music · Lavalink" }).setTimestamp();
        state.textChannel?.send({ embeds: [embed] }).catch(() => {});
    } catch (err) {
        console.error("[MUSIC] Errore playTrack:", err.message);
        state.textChannel?.send(`⚠️ Impossibile riprodurre **${track.title}**. Salto...`).catch(() => {});
        state.isPlaying = false;
        playNext(guildId);
    }
}

// ── Slash Commands ────────────────────────────
const commands = [
    new SlashCommandBuilder()
        .setName("news").setDescription("Mostra le ultime notizie ANSA")
        .addStringOption((opt) =>
            opt.setName("categoria").setDescription("Filtra per categoria")
                .addChoices(
                    { name: "Politica", value: "politica" }, { name: "Economia", value: "economia" },
                    { name: "Mondo",    value: "mondo"    }, { name: "Cronaca",  value: "cronaca"  },
                    { name: "Tutte",    value: "tutte"    }
                )
        ).toJSON(),
    new SlashCommandBuilder()
        .setName("play").setDescription("Riproduce una canzone da YouTube (URL o ricerca testo)")
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
        .setName("chiedi").setDescription("Fai una domanda – risponde in chat e a voce nel canale vocale")
        .addStringOption((opt) =>
            opt.setName("domanda").setDescription("La tua domanda").setRequired(true)
        ).toJSON(),
    new SlashCommandBuilder()
        .setName("volume").setDescription("Imposta il volume (1-200)")
        .addIntegerOption((opt) =>
            opt.setName("valore").setDescription("Volume da 1 a 200").setMinValue(1).setMaxValue(200).setRequired(true)
        ).toJSON(),
    new SlashCommandBuilder()
        .setName("loop").setDescription("Imposta la modalità loop")
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
        await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
        console.log("[INFO] Comandi registrati con successo.");
    } catch (err) {
        console.error("[ERROR] Registrazione comandi fallita:", err.message);
    }
}

async function getMemberVoiceChannel(interaction) {
    try {
        const member = interaction.guild.members.cache.get(interaction.user.id)
                    ?? await interaction.guild.members.fetch(interaction.user.id);
        return member.voice?.channel ?? null;
    } catch { return null; }
}

function getAvailableNode() {
    for (const node of shoukaku.nodes.values()) {
        if (node.state === 1) return node;
    }
    return null;
}

async function ensureLavalinkPlayer(guild, voiceChannel) {
    const state = getMusicState(guild.id);
    if (state.player && !state.player.destroyed) return state.player;
    const node = getAvailableNode();
    if (!node) throw new Error("Nessun nodo Lavalink disponibile. Riprova tra qualche secondo.");
    const player = await shoukaku.joinVoiceChannel({
        guildId: guild.id, channelId: voiceChannel.id, shardId: guild.shardId ?? 0,
    });
    player.on("end",       ()      => { getMusicState(guild.id).isPlaying = false; playNext(guild.id); });
    player.on("exception", (data)  => {
        console.error("[LAVALINK] Eccezione:", data?.exception?.message ?? data);
        const s = getMusicState(guild.id); s.isPlaying = false;
        s.textChannel?.send("⚠️ Errore durante la riproduzione. Salto...").catch(() => {});
        playNext(guild.id);
    });
    player.on("stuck",  () => { getMusicState(guild.id).isPlaying = false; playNext(guild.id); });
    player.on("closed", () => { const s = getMusicState(guild.id); s.player = null; s.isPlaying = false; });
    state.player = player;
    return player;
}

// ── Client & Shoukaku ─────────────────────────
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });

const shoukaku = new Shoukaku(
    new Connectors.DiscordJS(client), LAVALINK_NODES,
    { moveOnDisconnect: true, resumable: false, resumableTimeout: 30, reconnectTries: 5, reconnectInterval: 5, restTimeout: 15000, userAgent: "Tricolore-Bot/1.0" }
);
shoukaku.on("ready",      (name)        => console.log(`[LAVALINK] Nodo connesso: ${name}`));
shoukaku.on("error",      (name, error) => console.error(`[LAVALINK] Errore nodo "${name}":`, error?.message ?? error));
shoukaku.on("disconnect", (name, moved) => console.warn(`[LAVALINK] Nodo disconnesso: ${name} | moved=${moved}`));

client.once("ready", async () => {
    console.log(`[INFO] Bot online come ${client.user.tag}`);
    await registerCommands();
});

// ── Comandi ───────────────────────────────────
client.on("interactionCreate", async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    const { commandName, guild } = interaction;

    // /news
    if (commandName === "news") {
        await interaction.deferReply();
        const categoria   = interaction.options.getString("categoria") || "tutte";
        const targetFeeds = categoria === "tutte" ? FEEDS : FEEDS.filter((f) => f.label.toLowerCase() === categoria);
        const embeds = [];
        for (const feedInfo of targetFeeds) {
            let feed; try { feed = await rssParser.parseURL(feedInfo.url); } catch { continue; }
            for (const item of feed.items.slice(0, 3)) {
                if (!item.link) continue;
                embeds.push(buildNewsEmbed(item, feedInfo));
                if (embeds.length >= 10) break;
            }
            if (embeds.length >= 10) break;
        }
        if (embeds.length === 0) { await interaction.editReply({ content: "⚠️ Nessuna notizia disponibile." }); return; }
        await interaction.editReply({ embeds });
        return;
    }

    // /join
    if (commandName === "join") {
        const voiceChannel = await getMemberVoiceChannel(interaction);
        if (!voiceChannel) { await interaction.reply({ content: "❌ Devi essere in un canale vocale!", ephemeral: true }); return; }
        try {
            const state = getMusicState(guild.id);
            state.textChannel = interaction.channel;
            if (state.player && !state.player.destroyed) {
                try { await state.player.stopTrack(); } catch {}
                shoukaku.leaveVoiceChannel(guild.id);
                state.player = null; state.isPlaying = false;
            } else {
                try { shoukaku.leaveVoiceChannel(guild.id); } catch {}
            }
            await new Promise(r => setTimeout(r, 500));
            await ensureLavalinkPlayer(guild, voiceChannel);
            await interaction.reply({ content: `🎙️ Entrato nel canale **${voiceChannel.name}**!` });
        } catch (err) {
            console.error("[JOIN]", err.message);
            await interaction.reply({ content: `❌ ${err.message}`, ephemeral: true });
        }
        return;
    }

    // /leave
    if (commandName === "leave") {
        const state = getMusicState(guild.id);
        if (!state.player || state.player.destroyed) { await interaction.reply({ content: "❌ Non sono in nessun canale vocale!", ephemeral: true }); return; }
        try { await state.player.stopTrack(); } catch {}
        shoukaku.leaveVoiceChannel(guild.id);
        state.player = null; state.queue = []; state.current = null; state.isPlaying = false;
        musicStates.delete(guild.id);
        await interaction.reply({ content: "👋 Uscito dal canale vocale e coda svuotata." });
        return;
    }

    // /play
    if (commandName === "play") {
        const query = interaction.options.getString("query", true);
        await interaction.deferReply();
        const voiceChannel = await getMemberVoiceChannel(interaction);
        if (!voiceChannel) { await interaction.editReply({ content: "❌ Devi essere in un canale vocale!" }); return; }
        let player;
        try {
            const state = getMusicState(guild.id); state.textChannel = interaction.channel;
            player = await ensureLavalinkPlayer(guild, voiceChannel);
        } catch (err) { await interaction.editReply({ content: `❌ ${err.message}` }); return; }
        const node = getAvailableNode();
        if (!node) { await interaction.editReply({ content: "❌ Nessun nodo Lavalink disponibile." }); return; }
        const search = /^https?:\/\//.test(query) ? query : `ytsearch:${query}`;
        let result;
        try { result = await node.rest.resolve(search); }
        catch (err) { await interaction.editReply({ content: "⚠️ Errore durante la ricerca. Riprova." }); return; }
        if (!result || !result.data) { await interaction.editReply({ content: `⚠️ Nessun risultato per: **${query}**` }); return; }
        const state = getMusicState(guild.id);
        let tracks = [];
        switch (result.loadType) {
            case "track":    tracks = [result.data]; break;
            case "search":   tracks = result.data.length > 0 ? [result.data[0]] : []; break;
            case "playlist": tracks = result.data.tracks ?? []; break;
        }
        if (tracks.length === 0) { await interaction.editReply({ content: `⚠️ Nessun risultato per: **${query}**` }); return; }
        for (const t of tracks) {
            state.queue.push({
                encoded: t.encoded, title: t.info.title, uri: t.info.uri, duration: t.info.length,
                thumbnail: t.info.artworkUrl ?? (t.info.sourceName === "youtube" ? `https://img.youtube.com/vi/${t.info.identifier}/hqdefault.jpg` : null),
                requestedBy: interaction.user.username,
            });
        }
        if (!state.isPlaying) {
            await interaction.editReply({ content: tracks.length > 1 ? `🎵 Playlist aggiunta: **${tracks.length} brani**. Avvio...` : `🎵 Caricamento di **${tracks[0].info.title}**...` });
            playNext(guild.id);
        } else {
            const t0 = tracks[0];
            const embed = new EmbedBuilder().setColor(0x1db954)
                .setAuthor({ name: tracks.length > 1 ? `➕  Playlist aggiunta (${tracks.length} brani)` : "➕  Aggiunto alla coda" })
                .setTitle(t0.info.title.slice(0, 256)).setURL(t0.info.uri)
                .setThumbnail(t0.info.artworkUrl ?? (t0.info.sourceName === "youtube" ? `https://img.youtube.com/vi/${t0.info.identifier}/hqdefault.jpg` : null))
                .addFields({ name: "⏱ Durata", value: formatDuration(t0.info.length), inline: true }, { name: "📋 Posizione", value: `#${state.queue.length}`, inline: true })
                .setFooter({ text: "Tricolore Music · Lavalink" }).setTimestamp();
            await interaction.editReply({ embeds: [embed] });
        }
        return;
    }

    // /skip
    if (commandName === "skip") {
        const state = getMusicState(guild.id);
        if (!state.player || !state.current) { await interaction.reply({ content: "❌ Nessuna canzone in riproduzione.", ephemeral: true }); return; }
        const prevLoop = state.loop; if (state.loop === "track") state.loop = "none";
        try { await state.player.stopTrack(); } catch {}
        state.loop = prevLoop;
        await interaction.reply({ content: `⏭️ **${state.current?.title ?? ""}** saltata.` });
        return;
    }

    // /stop
    if (commandName === "stop") {
        const state = getMusicState(guild.id);
        state.queue = []; state.current = null; state.loop = "none"; state.isPlaying = false;
        try { await state.player?.stopTrack(); } catch {}
        await interaction.reply({ content: "⏹️ Riproduzione fermata e coda svuotata." });
        return;
    }

    // /pause
    if (commandName === "pause") {
        const state = getMusicState(guild.id);
        if (!state.player || !state.isPlaying) { await interaction.reply({ content: "❌ Nessuna canzone in riproduzione.", ephemeral: true }); return; }
        if (state.player.paused) { await interaction.reply({ content: "❌ Già in pausa.", ephemeral: true }); return; }
        await state.player.setPaused(true);
        await interaction.reply({ content: "⏸️ Riproduzione in pausa. Usa `/resume` per riprendere." });
        return;
    }

    // /resume
    if (commandName === "resume") {
        const state = getMusicState(guild.id);
        if (!state.player || !state.player.paused) { await interaction.reply({ content: "❌ La riproduzione non è in pausa.", ephemeral: true }); return; }
        await state.player.setPaused(false);
        await interaction.reply({ content: "▶️ Riproduzione ripresa!" });
        return;
    }

    // /nowplaying
    if (commandName === "nowplaying") {
        const state = getMusicState(guild.id);
        if (!state.current) { await interaction.reply({ content: "❌ Nessuna canzone in riproduzione.", ephemeral: true }); return; }
        const track = state.current;
        const embed = new EmbedBuilder().setColor(0x1db954).setAuthor({ name: "🎵  Ora in riproduzione" })
            .setTitle(track.title.slice(0, 256)).setURL(track.uri).setThumbnail(track.thumbnail ?? null)
            .addFields(
                { name: "⏱ Durata", value: formatDuration(track.duration), inline: true },
                { name: "👤 Richiesto da", value: track.requestedBy, inline: true },
                { name: "🔊 Volume", value: `${state.volume}%`, inline: true },
                { name: "🔁 Loop", value: state.loop, inline: true },
                { name: "🔀 Shuffle", value: state.shuffle ? "✅" : "❌", inline: true },
                { name: "📋 In coda", value: `${state.queue.length} brani`, inline: true },
            )
            .setFooter({ text: "Tricolore Music · Lavalink" }).setTimestamp();
        await interaction.reply({ embeds: [embed] });
        return;
    }

    // /queue
    if (commandName === "queue") {
        const state = getMusicState(guild.id);
        if (!state.current && state.queue.length === 0) { await interaction.reply({ content: "📭 La coda è vuota.", ephemeral: true }); return; }
        const lines = [];
        if (state.current) lines.push(`**▶  In riproduzione:**\n[${state.current.title}](${state.current.uri}) · ${formatDuration(state.current.duration)}\n`);
        if (state.queue.length > 0) {
            lines.push("**📋  Coda:**");
            state.queue.slice(0, 15).forEach((t, i) => lines.push(`\`${i + 1}.\` [${t.title.slice(0, 50)}](${t.uri}) · ${formatDuration(t.duration)} · *${t.requestedBy}*`));
            if (state.queue.length > 15) lines.push(`\n*...e altri ${state.queue.length - 15} brani*`);
        }
        const embed = new EmbedBuilder().setColor(0x1db954).setTitle("🎶  Coda musicale")
            .setDescription(lines.join("\n").slice(0, 4096))
            .addFields({ name: "🔁 Loop", value: state.loop, inline: true }, { name: "🔀 Shuffle", value: state.shuffle ? "✅" : "❌", inline: true }, { name: "🔊 Volume", value: `${state.volume}%`, inline: true })
            .setFooter({ text: `${state.queue.length} brani in attesa · Tricolore Music` }).setTimestamp();
        await interaction.reply({ embeds: [embed] });
        return;
    }

    // /volume
    if (commandName === "volume") {
        const value = interaction.options.getInteger("valore", true);
        const state = getMusicState(guild.id); state.volume = value;
        try { await state.player?.setGlobalVolume(value); } catch {}
        await interaction.reply({ content: `🔊 Volume impostato a **${value}%**.` });
        return;
    }

    // /loop
    if (commandName === "loop") {
        const modalita = interaction.options.getString("modalita", true);
        const state = getMusicState(guild.id); state.loop = modalita;
        const labels = { none: "🚫 Nessun loop", track: "🔂 Loop traccia", queue: "🔁 Loop coda" };
        await interaction.reply({ content: `Loop impostato su: **${labels[modalita]}**` });
        return;
    }

    // /shuffle
    if (commandName === "shuffle") {
        const state = getMusicState(guild.id); state.shuffle = !state.shuffle;
        await interaction.reply({ content: state.shuffle ? "🔀 Shuffle **attivato**!" : "➡️ Shuffle **disattivato**." });
        return;
    }

    // /chiedi
    if (commandName === "chiedi") {
        const domanda = interaction.options.getString("domanda", true);
        await interaction.deferReply();

        const state = getMusicState(guild.id);
        if (!state.player || state.player.destroyed) {
            await interaction.editReply({ content: "❌ Devo essere in un canale vocale! Usa prima `/join`." });
            return;
        }

        // 1. Cerca risposta: DuckDuckGo → Wikipedia IT
        let risposta = null;
        try {
            const ddgRes = await fetch(
                `https://api.duckduckgo.com/?q=${encodeURIComponent(domanda)}&format=json&no_html=1&skip_disambig=1`,
                { headers: { "User-Agent": "TricoloreBot/1.0" } }
            );
            const ddg = await ddgRes.json();
            if (ddg.AbstractText && ddg.AbstractText.trim().length > 20) {
                const frasi = ddg.AbstractText.match(/[^.!?]+[.!?]+/g) || [ddg.AbstractText];
                risposta = frasi.slice(0, 3).join(" ").trim();
            } else if (ddg.Answer && ddg.Answer.trim().length > 0) {
                risposta = ddg.Answer.trim();
            }
        } catch (err) { console.warn("[CHIEDI] DuckDuckGo error:", err.message); }

        if (!risposta || risposta.length < 10) {
            try {
                const wikiRes = await fetch(
                    `https://it.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(domanda)}`,
                    { headers: { "User-Agent": "TricoloreBot/1.0" } }
                );
                if (wikiRes.ok) {
                    const wiki = await wikiRes.json();
                    if (wiki.extract && wiki.extract.trim().length > 10) {
                        const frasi = wiki.extract.match(/[^.!?]+[.!?]+/g) || [wiki.extract];
                        risposta = frasi.slice(0, 3).join(" ").trim();
                    }
                }
            } catch (err) { console.warn("[CHIEDI] Wikipedia error:", err.message); }
        }

        if (!risposta || risposta.length < 5) {
            risposta = `Non ho trovato una risposta per "${domanda}". Prova con il nome di un luogo, una persona o un argomento specifico!`;
        }

        // 2. Mostra subito la risposta scritta
        const embed = new EmbedBuilder()
            .setColor(0x7289da).setAuthor({ name: "🤖 Tricolore AI" })
            .setTitle(domanda.slice(0, 256)).setDescription(risposta.slice(0, 1024))
            .setFooter({ text: "Tricolore Bot · DuckDuckGo + Wikipedia" }).setTimestamp();
        await interaction.editReply({ embeds: [embed] });

        // 3. TTS con Google Translate
        const tmpFile = path.join(os.tmpdir(), `tts_${Date.now()}.mp3`);
        try {
            const ttsRes = await fetch(
                `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(risposta.slice(0, 200))}&tl=it&client=tw-ob`,
                { headers: { "User-Agent": "Mozilla/5.0" } }
            );
            if (!ttsRes.ok) throw new Error(`TTS HTTP ${ttsRes.status}`);
            fs.writeFileSync(tmpFile, await ttsRes.buffer());
        } catch (err) {
            console.warn("[CHIEDI] TTS error:", err.message);
            return; // risposta scritta già inviata, audio non disponibile
        }

        // 4. Riproduci audio tramite Lavalink
        const node = getAvailableNode();
        if (!node) { fs.unlink(tmpFile, () => {}); return; }

        const fileId  = path.basename(tmpFile);
        const fileUrl = `${SERVICE_URL}/tts/${fileId}`;
        ttsFiles.set(fileId, tmpFile);

        try {
            const res = await node.rest.resolve(fileUrl);
            if (!res || !res.data) throw new Error("Nessun risultato");
            const tracks = res.loadType === "track" ? [res.data] : (Array.isArray(res.data) && res.data[0] ? [res.data[0]] : []);
            if (tracks.length === 0) throw new Error("Traccia non trovata");
            state.queue.unshift({
                encoded: tracks[0].encoded, title: `🤖 ${domanda.slice(0, 50)}`,
                uri: fileUrl, duration: 0, thumbnail: null,
                requestedBy: "Tricolore AI", isTTS: true, tmpFile,
            });
            if (!state.isPlaying) playNext(guild.id);
        } catch (err) {
            console.warn("[CHIEDI] Audio error:", err.message);
            fs.unlink(tmpFile, () => {});
            ttsFiles.delete(fileId);
        }
        return;
    }
});

// ── Express ───────────────────────────────────
const app = express();
app.get("/", (_req, res) => res.send("Tricolore Bot – Online ✅"));
app.get("/tts/:fileId", (req, res) => {
    const filePath = ttsFiles.get(req.params.fileId);
    if (!filePath || !fs.existsSync(filePath)) { res.status(404).send("Not found"); return; }
    res.setHeader("Content-Type", "audio/mpeg");
    res.sendFile(filePath, (err) => {
        if (!err) setTimeout(() => { fs.unlink(filePath, () => {}); ttsFiles.delete(req.params.fileId); }, 30_000);
    });
});
app.get("/health", (_req, res) => res.json({ status: "ok", uptime: process.uptime(), nodes: [...shoukaku.nodes.keys()], timestamp: new Date().toISOString() }));

const SERVICE_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
app.listen(PORT, () => console.log(`[INFO] Express in ascolto sulla porta ${PORT}`));

// ── Keep-alive ────────────────────────────────
setInterval(() => {
    const lib = SERVICE_URL.startsWith("https") ? require("https") : require("http");
    lib.get(`${SERVICE_URL}/health`, (res) => {
        console.log(`[KEEP-ALIVE] Ping OK - status ${res.statusCode}`);
    }).on("error", (err) => console.warn("[KEEP-ALIVE] Ping fallito:", err.message));
}, 14 * 60 * 1000);

process.on("unhandledRejection", (r) => console.error("[UNHANDLED REJECTION]", r));
process.on("uncaughtException",  (e) => console.error("[UNCAUGHT EXCEPTION]", e.message));

client.login(TOKEN);
