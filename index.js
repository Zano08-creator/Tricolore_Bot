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
const fetch   = require("node-fetch");

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
function buildNodeList() {
    const nodes = [];
    if (process.env.LAVALINK_HOST) {
        nodes.push({
            name:   "self-hosted",
            url:    process.env.LAVALINK_HOST,
            auth:   process.env.LAVALINK_PASS || "youshallnotpass",
            port:   parseInt(process.env.LAVALINK_PORT || "443", 10),
            secure: (process.env.LAVALINK_SSL ?? "true") !== "false",
        });
        console.log(`[CONFIG] Nodo self-hosted: ${process.env.LAVALINK_HOST}`);
    }
    nodes.push(
        { name: "serenetia-ssl",   url: "lavalinkv4.serenetia.com",    auth: "https://seretia.link/discord",   port: 443, secure: true  },
        { name: "serenetia-nossl", url: "lavalinkv4.serenetia.com",    auth: "https://seretia.link/discord",   port: 80,  secure: false },
        { name: "millohost-ssl",   url: "lava-v4.millohost.my.id",     auth: "https://discord.gg/mjS5J2K3ep", port: 443, secure: true  },
        { name: "trinium-ssl",     url: "lavalink-v4.triniumhost.com", auth: "free",                          port: 443, secure: true  },
    );
    return nodes;
}

const LAVALINK_NODES = buildNodeList();

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
//  STATO MUSICALE
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
//  PLAYER
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
        const s   = getMusicState(guild.id);
        const msg = data?.exception?.message ?? "Errore sconosciuto";
        console.error("[LAVALINK] Eccezione:", msg);
        s.isPlaying = false;

        const isYtBlock =
            msg.includes("Something broke") ||
            msg.includes("403")             ||
            msg.includes("429")             ||
            msg.includes("blocked")         ||
            msg.includes("Sign in")         ||
            msg.includes("unavailable")     ||
            msg.includes("requires login");

        if (isYtBlock) {
            const title = s.current?.title ?? "...";
            s.textChannel?.send(
                `⚠️ **YouTube ha bloccato questa traccia.**\n` +
                `Prova con \`/play\` scegliendo **SoundCloud** dal menu sorgente.`
            ).catch(() => {});
        } else {
            s.textChannel?.send("⚠️ Errore riproduzione. Salto alla prossima...").catch(() => {});
        }
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
    new SlashCommandBuilder()
        .setName("play").setDescription("Riproduce una canzone")
        .addStringOption(o => o.setName("query").setDescription("URL o nome della canzone").setRequired(true))
        .addStringOption(o =>
            o.setName("sorgente").setDescription("Da dove cercare (default: YouTube)")
             .addChoices(
                { name: "🎵 YouTube",    value: "youtube"    },
                { name: "🎶 SoundCloud", value: "soundcloud" },
             )
        ).toJSON(),
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
    new SlashCommandBuilder()
        .setName("chiedi").setDescription("Fai una domanda all'AI")
        .addStringOption(o => o.setName("domanda").setDescription("La tua domanda").setRequired(true))
        .toJSON(),
];

// ─────────────────────────────────────────────
//  CLIENT & SHOUKAKU
// ─────────────────────────────────────────────
const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
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
            // Pulizia completa per evitare stati bloccati
            if (state.player) {
                try { await state.player.stopTrack(); } catch {}
                try { state.player.clean(); } catch {}
            }
            try { shoukaku.leaveVoiceChannel(guild.id); } catch {}
            state.player    = null;
            state.isPlaying = false;
            await new Promise(r => setTimeout(r, 800));
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
        const query    = interaction.options.getString("query", true);
        const sorgente = interaction.options.getString("sorgente") ?? "youtube";
        await interaction.deferReply();
        const vc = await getMemberVoiceChannel(interaction);
        if (!vc) { await interaction.editReply("❌ Devi essere in un canale vocale!"); return; }
        try {
            const state = getMusicState(guild.id);
            state.textChannel = interaction.channel;
            await ensurePlayer(guild, vc);
            const node = getAvailableNode();
            if (!node) { await interaction.editReply("❌ Nessun nodo audio disponibile."); return; }

            // Logica ricerca: URL diretto → as-is | SoundCloud scelto → scsearch | default → ytsearch con fallback sc
            let searches;
            if (/^https?:\/\//.test(query)) {
                searches = [query];
            } else if (sorgente === "soundcloud") {
                searches = [`scsearch:${query}`];
            } else {
                searches = [`ytsearch:${query}`, `scsearch:${query}`];
            }

            let result     = null;
            let usedSource = "YouTube";
            for (const search of searches) {
                result = await node.rest.resolve(search).catch(() => null);
                if (result?.data && result.loadType !== "error" && result.loadType !== "empty") {
                    usedSource = search.startsWith("scsearch") ? "SoundCloud" : "YouTube";
                    break;
                }
                result = null;
            }

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
                    source:      usedSource,
                });
            }

            if (!state.isPlaying) {
                await interaction.editReply(
                    tracks.length > 1
                        ? `🎵 Playlist aggiunta: **${tracks.length} brani** da ${usedSource}. Avvio in corso...`
                        : `🎵 Caricamento: **${tracks[0].info.title}** (${usedSource})...`
                );
                await new Promise(r => setTimeout(r, 500));
                playNext(guild.id);
            } else {
                const t0 = tracks[0];
                await interaction.editReply({ embeds: [
                    new EmbedBuilder().setColor(0x1db954)
                        .setAuthor({ name: tracks.length > 1 ? `➕ Playlist aggiunta (${tracks.length} brani)` : "➕ Aggiunto alla coda" })
                        .setTitle(t0.info.title.slice(0, 256)).setURL(t0.info.uri)
                        .setThumbnail(t0.info.artworkUrl ?? null)
                        .addFields(
                            { name: "⏱ Durata",    value: formatDuration(t0.info.length), inline: true },
                            { name: "📋 Posizione", value: `#${state.queue.length}`,       inline: true },
                            { name: "🎵 Sorgente",  value: usedSource,                     inline: true },
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
                    { name: "🔁 Loop",    value: state.loop,                inline: true },
                    { name: "🔀 Shuffle", value: state.shuffle ? "✅":"❌", inline: true },
                    { name: "🔊 Volume",  value: `${state.volume}%`,        inline: true },
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
        const risposta = await askAI(domanda) ?? "Non sono riuscito a rispondere, riprova tra poco!";
        const embed = new EmbedBuilder()
            .setColor(0x7289da)
            .setAuthor({ name: "🤖 Tricolore AI" })
            .setTitle(domanda.slice(0, 256))
            .setDescription(risposta.slice(0, 1024))
            .setFooter({ text: "Tricolore AI · Powered by Groq" })
            .setTimestamp();
        await interaction.editReply({ embeds: [embed] });
        return;
    }
});

// ─────────────────────────────────────────────
//  EXPRESS
// ─────────────────────────────────────────────
const app         = express();
const SERVICE_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;

app.get("/",       (_req, res) => res.send("Tricolore Bot – Online ✅"));
app.get("/health", (_req, res) => {
    const nodeInfo = [...shoukaku.nodes.entries()].map(([name, node]) => ({
        name,
        state: node.state === 1 ? "connected" : node.state === 0 ? "connecting" : "disconnected",
        stats: node.stats ?? null,
    }));
    res.json({
        status:    "ok",
        uptime:    Math.floor(process.uptime()),
        nodes:     nodeInfo,
        timestamp: new Date().toISOString(),
    });
});

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
//  NODE WATCHDOG (ogni 30 secondi)
// ─────────────────────────────────────────────
setInterval(async () => {
    for (const nodeConfig of LAVALINK_NODES) {
        const node = shoukaku.nodes.get(nodeConfig.name);
        if (!node || node.state !== 1) {
            console.warn(`[WATCHDOG] Nodo "${nodeConfig.name}" non connesso, riconnessione...`);
            try {
                if (node) shoukaku.removeNode(nodeConfig.name);
                await new Promise(r => setTimeout(r, 500));
                shoukaku.addNode(nodeConfig);
                console.log(`[WATCHDOG] Nodo "${nodeConfig.name}" riaggiunto.`);
            } catch (err) {
                console.error(`[WATCHDOG] Riconnessione "${nodeConfig.name}" fallita:`, err.message);
            }
        }
    }
}, 30 * 1000);

// ─────────────────────────────────────────────
//  GESTIONE ERRORI GLOBALI
// ─────────────────────────────────────────────
process.on("unhandledRejection", r => console.error("[UNHANDLED]", r));
process.on("uncaughtException",  e => console.error("[EXCEPTION]", e.message));

client.login(TOKEN);
