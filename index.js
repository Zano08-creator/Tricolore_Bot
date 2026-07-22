"use strict";

const {
    Client,
    GatewayIntentBits,
    EmbedBuilder,
    REST,
    Routes,
    SlashCommandBuilder,
} = require("discord.js");
const { Shoukaku, Connectors, Constants } = require("shoukaku");
const Parser  = require("rss-parser");
const express = require("express");
// Node 18+ ha fetch nativo (Shoukaku v4 richiede già node >=18).
// Rimosso "node-fetch": la v3 è ESM-only e rompe require(), e non
// supporta più l'opzione "timeout" che veniva passata sotto.

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

    // fetch nativo non ha più l'opzione "timeout": la implementiamo con AbortController.
    const controller = new AbortController();
    const timeoutId  = setTimeout(() => controller.abort(), 15_000);

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
            signal: controller.signal,
        });
        if (!res.ok) throw new Error(`Groq HTTP ${res.status}`);
        const data     = await res.json();
        const risposta = data?.choices?.[0]?.message?.content?.trim();
        if (!risposta) throw new Error("Risposta vuota");
        return risposta;
    } catch (err) {
        const msg = err.name === "AbortError" ? "Timeout richiesta Groq" : err.message;
        console.error("[AI] Groq fallito:", msg);
        return null;
    } finally {
        clearTimeout(timeoutId);
    }
}

// ─────────────────────────────────────────────
//  IMMAGINE FISSA PER /femboy
// ─────────────────────────────────────────────
// Metti qui il link della tua immagine: verrà mostrata SEMPRE,
// identica, ogni volta che qualcuno usa /femboy.
const FEMBOY_GIF = "https://i.imgur.com/DOGOUIz.gif";

// ─────────────────────────────────────────────
//  GIF PER /tsundere (scelta a caso tra più link)
// ─────────────────────────────────────────────
const TSUNDERE_GIFS = [
    "https://i.imgur.com/LvqCv7O.gif",
    "https://i.imgur.com/yovTEyD.gif",
    "https://i.imgur.com/fOTLqoq.gif",
];

function getRandomTsundereGif() {
    return TSUNDERE_GIFS[Math.floor(Math.random() * TSUNDERE_GIFS.length)];
}

// ─────────────────────────────────────────────
//  IMMAGINI Safebooru (rating:safe) — /waifu
// ─────────────────────────────────────────────
// Nota: usiamo SOLO rating:safe per stare tranquilli sui contenuti.
// Interroghiamo più tag correlati per ogni comando e uniamo i risultati
// per avere varietà. Ogni set di tag ha la propria cache in memoria,
// rinnovata periodicamente per non martellare l'API ad ogni comando.
const SAFEBOORU_EXCLUDE = "-guro -gore -loli -shota -child -lolicon";
const IMAGE_CACHE_TTL   = 30 * 60 * 1000; // 30 minuti

// Personaggi femminili molto noti/apprezzati nel fandom anime, usati come
// tag per pescare fanart di qualità. Combinati con rating:safe.
const WAIFU_TAG_SETS = [
    `rem_(re:zero) rating:safe ${SAFEBOORU_EXCLUDE}`,
    `asuna_(sao) rating:safe ${SAFEBOORU_EXCLUDE}`,
    `mikasa_ackerman rating:safe ${SAFEBOORU_EXCLUDE}`,
    `zero_two_(darling_in_the_franxx) rating:safe ${SAFEBOORU_EXCLUDE}`,
    `nezuko_kamado rating:safe ${SAFEBOORU_EXCLUDE}`,
    `hinata_hyuga rating:safe ${SAFEBOORU_EXCLUDE}`,
    `chika_fujiwara rating:safe ${SAFEBOORU_EXCLUDE}`,
];

const imageCaches = new Map(); // cacheKey -> { list, at }

async function fetchImagesForTags(tags) {
    const url =
        "https://safebooru.org/index.php?page=dapi&s=post&q=index&json=1" +
        `&limit=100&tags=${encodeURIComponent(tags)}`;

    const controller = new AbortController();
    const timeoutId  = setTimeout(() => controller.abort(), 10_000);
    try {
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok) throw new Error(`Safebooru HTTP ${res.status}`);
        const data = await res.json();
        if (!Array.isArray(data)) return [];
        return data
            .filter(p => p?.rating === "safe" && p?.image && p?.directory)
            .map(p => ({
                url:    `https://safebooru.org/images/${p.directory}/${p.image}`,
                source: p.source || null,
                id:     p.id,
            }));
    } catch (err) {
        console.error(`[IMAGES] Errore fetch Safebooru (tags="${tags}"):`, err.message);
        return [];
    } finally {
        clearTimeout(timeoutId);
    }
}

async function fetchImagesForTagSets(tagSets) {
    const results = await Promise.all(tagSets.map(fetchImagesForTags));
    const merged   = new Map(); // dedup per id
    for (const list of results) {
        for (const img of list) merged.set(img.id, img);
    }
    return [...merged.values()];
}

async function getRandomImage(cacheKey, tagSets) {
    const now   = Date.now();
    const cache = imageCaches.get(cacheKey) ?? { list: [], at: 0 };

    if (!cache.list.length || (now - cache.at) > IMAGE_CACHE_TTL) {
        const fresh = await fetchImagesForTagSets(tagSets);
        if (fresh.length) {
            cache.list = fresh;
            cache.at   = now;
            imageCaches.set(cacheKey, cache);
        }
    }
    if (!cache.list.length) return null;
    return cache.list[Math.floor(Math.random() * cache.list.length)];
}

// ─────────────────────────────────────────────
//  ANIME RANDOM (AniList GraphQL API)
// ─────────────────────────────────────────────
// NOTA: inizialmente usavamo Jikan (wrapper di MyAnimeList), ma il suo
// endpoint di ricerca si è dimostrato spesso instabile (errori 504 anche
// sulle richieste più semplici). AniList è mantenuta meglio, non ha
// rate-limit aggressivi per un uso come il nostro e offre già un filtro
// nativo per genere, quindi passiamo a quella.
const ANILIST_URL = "https://graphql.anilist.co";

// Generi che AniList espone ma che vogliamo escludere per restare su
// contenuti sicuri per un server generico.
const ANIME_GENRE_EXCLUDE = new Set(["Hentai", "Ecchi"]);

async function anilistQuery(query, variables, retries = 2) {
    for (let attempt = 0; attempt <= retries; attempt++) {
        const controller = new AbortController();
        const timeoutId  = setTimeout(() => controller.abort(), 10_000);
        try {
            const res = await fetch(ANILIST_URL, {
                method:  "POST",
                headers: { "Content-Type": "application/json", "Accept": "application/json" },
                body:    JSON.stringify({ query, variables }),
                signal:  controller.signal,
            });
            if (!res.ok) {
                const retryable = res.status === 429 || res.status >= 500;
                if (retryable && attempt < retries) {
                    clearTimeout(timeoutId);
                    await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
                    continue;
                }
                throw new Error(`AniList HTTP ${res.status}`);
            }
            const json = await res.json();
            if (json.errors?.length) throw new Error(json.errors.map(e => e.message).join("; "));
            return json.data;
        } catch (err) {
            const isLast = attempt >= retries;
            if (!isLast && err.name !== "AbortError") {
                clearTimeout(timeoutId);
                await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
                continue;
            }
            console.error("[ANIME] Errore AniList:", err.message);
            return null;
        } finally {
            clearTimeout(timeoutId);
        }
    }
    return null;
}

// Lista di riserva, usata SOLO se AniList non risponde nemmeno dopo i retry.
const FALLBACK_GENRES = [
    "Action", "Adventure", "Comedy", "Drama", "Fantasy", "Horror",
    "Mahou Shoujo", "Mecha", "Music", "Mystery", "Psychological",
    "Romance", "Sci-Fi", "Slice of Life", "Sports", "Supernatural", "Thriller",
].map(name => ({ name, value: name }));

let animeGenresCache = []; // [{ name: "Action", value: "Action" }, ...]

async function loadAnimeGenres() {
    const data = await anilistQuery("query { GenreCollection }", {});
    if (!data?.GenreCollection?.length) {
        console.warn("[ANIME] AniList irraggiungibile, uso la lista di generi di riserva.");
        animeGenresCache = FALLBACK_GENRES;
        return;
    }
    animeGenresCache = data.GenreCollection
        .filter(g => !ANIME_GENRE_EXCLUDE.has(g))
        .map(g => ({ name: g, value: g }))
        .sort((a, b) => a.name.localeCompare(b.name));
    console.log(`[ANIME] Caricati ${animeGenresCache.length} generi da AniList.`);
}

const ANIME_QUERY = `
query ($page: Int, $genre: String) {
    Page(page: $page, perPage: 25) {
        media(type: ANIME, isAdult: false, genre: $genre, sort: POPULARITY_DESC) {
            title { romaji english }
            description(asHtml: false)
            coverImage { large }
            genres
            episodes
            status
            averageScore
            siteUrl
        }
    }
}`;

const ANIME_CACHE_TTL = 60 * 60 * 1000; // 1 ora
const animeGenreCache = new Map(); // genere (o "__all__") -> { list, at }

async function getRandomAnime(genre) {
    // Chiave di cache unica: senza genere usiamo un "pool" generale.
    const cacheKey = genre || "__all__";
    const now       = Date.now();
    const cache     = animeGenreCache.get(cacheKey) ?? { list: [], at: 0 };

    if (!cache.list.length || (now - cache.at) > ANIME_CACHE_TTL) {
        // Pagina scelta a caso tra le prime 20 (25 anime a pagina =
        // pool di ~500 titoli) per avere varietà senza dover prima
        // interrogare AniList per sapere quante pagine esistono.
        const randomPage = Math.floor(Math.random() * 20) + 1;
        let data = await anilistQuery(ANIME_QUERY, { page: randomPage, genre: genre || null });
        if (!data?.Page?.media?.length && randomPage !== 1) {
            data = await anilistQuery(ANIME_QUERY, { page: 1, genre: genre || null });
        }
        if (data?.Page?.media?.length) {
            cache.list = data.Page.media;
            cache.at   = now;
            animeGenreCache.set(cacheKey, cache);
        }
        // Se AniList non risponde ma avevamo già una lista precedente
        // (anche scaduta), meglio riusare quella vecchia che restituire nulla.
    }

    if (!cache.list.length) return null;
    return cache.list[Math.floor(Math.random() * cache.list.length)] ?? null;
}

// ─────────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────────
// FIX: Constants.State.CONNECTED vale 2, non 1 (1 = NEARLY, uno stato
// transitorio). Con il vecchio controllo "=== 1" un nodo realmente
// connesso non veniva MAI riconosciuto come disponibile, causando
// errori intermittenti "Nessun nodo Lavalink disponibile" su /join e /play.
function getAvailableNode() {
    for (const node of shoukaku.nodes.values()) {
        if (node.state === Constants.State.CONNECTED) return node;
    }
    return null;
}

function describeNodeState(state) {
    switch (state) {
        case Constants.State.CONNECTED:    return "connected";
        case Constants.State.CONNECTING:   return "connecting";
        case Constants.State.NEARLY:       return "nearly";
        case Constants.State.RECONNECTING: return "reconnecting";
        case Constants.State.DISCONNECTING:return "disconnecting";
        default:                           return "disconnected";
    }
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

    // FIX: log per confermare a quale nodo il player è effettivamente collegato
    console.log(`[MUSIC] Player collegato al nodo: ${player.node?.name ?? "sconosciuto"}`);

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
    new SlashCommandBuilder()
        .setName("femboy").setDescription("Trasforma (scherzosamente) un utente in un femboy")
        .addUserOption(o => o.setName("utente").setDescription("L'utente da prendere in giro").setRequired(true))
        .toJSON(),
    new SlashCommandBuilder()
        .setName("waifu").setDescription("Mostra una bella immagine di una waifu anime")
        .toJSON(),
    new SlashCommandBuilder()
        .setName("tsundere").setDescription("Trasforma (scherzosamente) un utente in una tsundere")
        .addUserOption(o => o.setName("utente").setDescription("L'utente da prendere in giro").setRequired(true))
        .toJSON(),
    new SlashCommandBuilder()
        .setName("anime").setDescription("Consiglia un anime a caso")
        .addStringOption(o =>
            o.setName("genere")
             .setDescription("Filtra per genere (facoltativo, scrivi per cercare)")
             .setAutocomplete(true)
        ).toJSON(),
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
    await loadAnimeGenres();
    const rest = new REST({ version: "10" }).setToken(TOKEN);
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    console.log("[BOT] Comandi registrati.");
});

// ─────────────────────────────────────────────
//  GESTIONE COMANDI
// ─────────────────────────────────────────────
client.on("interactionCreate", async (interaction) => {

    // ── Autocomplete /anime genere ─────────────
    if (interaction.isAutocomplete()) {
        if (interaction.commandName === "anime") {
            const focused = interaction.options.getFocused().toLowerCase();
            const filtered = animeGenresCache
                .filter(g => g.name.toLowerCase().includes(focused))
                .slice(0, 25);
            await interaction.respond(
                filtered.map(g => ({ name: g.name, value: g.value }))
            ).catch(() => {});
        }
        return;
    }

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

            // Usa il nodo a cui il player è EFFETTIVAMENTE collegato,
            // non uno scelto a caso da getAvailableNode(). Prima, se il player
            // veniva connesso da Shoukaku a un nodo (es. self-hosted con OAuth),
            // ma la ricerca/resolve avveniva su un nodo diverso (es. un nodo
            // pubblico di terzi), la traccia trovata non era compatibile col
            // player -> riproduzione silenziosamente fallita.
            const node = state.player?.node ?? getAvailableNode();
            if (!node) { await interaction.editReply("❌ Nessun nodo audio disponibile."); return; }
            console.log(`[MUSIC] /play userà il nodo: ${node.name}`);

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
                result = await node.rest.resolve(search).catch((err) => {
                    console.error(`[MUSIC] Errore resolve "${search}":`, err.message);
                    return null;
                });
                if (result?.data && result.loadType !== "error" && result.loadType !== "empty") {
                    usedSource = search.startsWith("scsearch") ? "SoundCloud" : "YouTube";
                    break;
                }
                if (result?.loadType === "error") {
                    console.error(`[MUSIC] loadType error per "${search}":`, JSON.stringify(result.data));
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
            console.error("[MUSIC] Errore /play:", err);
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

    // ── /femboy ────────────────────────────────
    if (commandName === "femboy") {
        const target = interaction.options.getUser("utente", true);

        if (target.bot) {
            await interaction.reply({ content: "❌ Non puoi scegliere un bot!", ephemeral: true });
            return;
        }

        const embed = new EmbedBuilder()
            .setColor(0xff69b4)
            .setDescription(`✨ **${target.username}** è ufficialmente diventato/a un femboy! ✨`)
            .setImage(FEMBOY_GIF)
            .setFooter({ text: "Tricolore Bot" })
            .setTimestamp();

        await interaction.reply({ content: `<@${target.id}>`, embeds: [embed] });
        return;
    }

    // ── /waifu ─────────────────────────────────
    if (commandName === "waifu") {
        await interaction.deferReply();

        const img = await getRandomImage("waifu", WAIFU_TAG_SETS);
        if (!img) {
            await interaction.editReply("⚠️ Non sono riuscito a recuperare un'immagine, riprova tra poco.");
            return;
        }

        const embed = new EmbedBuilder()
            .setColor(0xffb6c1)
            .setAuthor({ name: "💖 Waifu del momento" })
            .setImage(img.url)
            .setFooter({ text: "Tricolore Bot · immagine via Safebooru (rating: safe)" })
            .setTimestamp();

        await interaction.editReply({ embeds: [embed] });
        return;
    }

    // ── /tsundere ──────────────────────────────
    if (commandName === "tsundere") {
        const target = interaction.options.getUser("utente", true);

        if (target.bot) {
            await interaction.reply({ content: "❌ Non puoi scegliere un bot!", ephemeral: true });
            return;
        }

        const embed = new EmbedBuilder()
            .setColor(0xff4d6d)
            .setAuthor({ name: "😳 B-baka! Non è mica per te..." })
            .setDescription(`✨ **${target.username}** è ufficialmente diventato/a una tsundere! ✨`)
            .setImage(getRandomTsundereGif())
            .setFooter({ text: "Tricolore Bot" })
            .setTimestamp();

        await interaction.reply({ content: `<@${target.id}>`, embeds: [embed] });
        return;
    }

    // ── /anime ─────────────────────────────────
    if (commandName === "anime") {
        await interaction.deferReply();

        const genre = interaction.options.getString("genere");

        // Se l'utente ha scritto testo libero senza selezionare un
        // suggerimento dalla lista (es. l'autocomplete non ha fatto in
        // tempo a rispondere, o la cache dei generi era vuota al momento),
        // il valore non corrisponde a nessun genere reale. Meglio avvisare
        // qui che mandare una query con un genere inventato ad AniList.
        const validGenres = new Set(animeGenresCache.map(g => g.value));
        if (genre && !validGenres.has(genre)) {
            await interaction.editReply(
                `⚠️ Genere non riconosciuto: **${genre}**.\n` +
                `Scrivi nel campo "genere" e **seleziona un'opzione dalla lista** che appare, ` +
                `invece di scrivere testo libero e premere invio.`
            );
            return;
        }

        const anime = await getRandomAnime(genre);

        if (!anime) {
            await interaction.editReply("⚠️ Non sono riuscito a trovare un anime, riprova tra poco.");
            return;
        }

        const STATUS_LABELS = {
            FINISHED:        "✅ Concluso",
            RELEASING:       "📡 In corso",
            NOT_YET_RELEASED:"🔜 Non ancora uscito",
            CANCELLED:       "❌ Cancellato",
            HIATUS:          "⏸️ In pausa",
        };

        const titolo    = anime.title?.english || anime.title?.romaji || "Titolo sconosciuto";
        const sinossi   = (anime.description || "Nessuna descrizione disponibile.")
                            .replace(/<[^>]+>/g, "") // AniList a volte include tag tipo <br>
                            .slice(0, 600);
        const genresStr = (anime.genres ?? []).join(", ") || "N/D";
        const cover     = anime.coverImage?.large ?? null;
        const voto      = anime.averageScore ? `${(anime.averageScore / 10).toFixed(1)}/10` : "N/D";
        const stato     = STATUS_LABELS[anime.status] ?? anime.status ?? "N/D";

        const embed = new EmbedBuilder()
            .setColor(0x9b59b6)
            .setAuthor({ name: "📺 Consiglio anime" })
            .setTitle(titolo.slice(0, 256))
            .setURL(anime.siteUrl ?? null)
            .setDescription(sinossi)
            .setImage(cover)
            .addFields(
                { name: "⭐ Voto",    value: voto, inline: true },
                { name: "🎬 Episodi", value: anime.episodes ? `${anime.episodes}` : "N/D", inline: true },
                { name: "📅 Stato",   value: stato, inline: true },
                { name: "🏷️ Generi", value: genresStr.slice(0, 1024), inline: false },
            )
            .setFooter({ text: "Tricolore Bot · dati via AniList" })
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
        state: describeNodeState(node.state),
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
const http  = require("http");
const https = require("https");

setInterval(() => {
    const lib = SERVICE_URL.startsWith("https") ? https : http;
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
        if (!node || node.state !== Constants.State.CONNECTED) {
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
// ─────────────────────────────────────────────
//  RETRY PERIODICO GENERI ANIME (ogni 10 minuti)
// ─────────────────────────────────────────────
// Se all'avvio AniList era irraggiungibile e stiamo usando la lista di
// fallback, riprova periodicamente a scaricare la lista completa reale.
setInterval(async () => {
    if (animeGenresCache !== FALLBACK_GENRES) return; // già caricata quella vera
    console.log("[ANIME] Ritento il caricamento della lista generi reale da AniList...");
    await loadAnimeGenres();
}, 10 * 60 * 1000);

process.on("unhandledRejection", r => console.error("[UNHANDLED]", r));
process.on("uncaughtException",  e => console.error("[EXCEPTION]", e.message));

client.login(TOKEN);
