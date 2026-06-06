"use strict";

// ──────────────────────────────────────────────
//  Tricolore News Bot  –  index.js
//  Versione pulita e robusta
// ──────────────────────────────────────────────

const {
    Client,
    GatewayIntentBits,
    EmbedBuilder,
    REST,
    Routes,
    SlashCommandBuilder,
} = require("discord.js");
const Parser  = require("rss-parser");
const express = require("express");
const fs      = require("fs");
const path    = require("path");

// ── Configurazione ────────────────────────────
const TOKEN     = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID || "1512928969849311272";
const GUILD_ID  = process.env.GUILD_ID  || "1512809889666175211";
const CHANNEL_ID= process.env.CHANNEL_ID|| "1512849401322672309";
const PORT      = process.env.PORT       || 3000;

if (!TOKEN) {
    console.error("[FATAL] TOKEN non impostato. Imposta la variabile d'ambiente TOKEN.");
    process.exit(1);
}

// ── Feed RSS con etichette e colori ───────────
const FEEDS = [
    { url: "https://www.ansa.it/sito/notizie/politica/politica_rss.xml",  label: "Politica",  color: 0x2b5ce6 },
    { url: "https://www.ansa.it/sito/notizie/economia/economia_rss.xml",  label: "Economia",  color: 0x27ae60 },
    { url: "https://www.ansa.it/sito/notizie/mondo/mondo_rss.xml",        label: "Mondo",     color: 0xe67e22 },
    { url: "https://www.ansa.it/sito/notizie/cronaca/cronaca_rss.xml",    label: "Cronaca",   color: 0xe74c3c },
];

// ── Persistenza notizie già inviate ───────────
//    Salviamo i link su file per sopravvivere ai riavvii.
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

// ── Utilità: delay ────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Slash commands ────────────────────────────
const commands = [
    new SlashCommandBuilder()
        .setName("news")
        .setDescription("Mostra le ultime notizie ANSA")
        .addStringOption((opt) =>
            opt
                .setName("categoria")
                .setDescription("Filtra per categoria")
                .addChoices(
                    { name: "Politica", value: "politica" },
                    { name: "Economia", value: "economia" },
                    { name: "Mondo",    value: "mondo"    },
                    { name: "Cronaca",  value: "cronaca"  },
                    { name: "Tutte",    value: "tutte"    }
                )
        )
        .toJSON(),
];

async function registerCommands() {
    try {
        const rest = new REST({ version: "10" }).setToken(TOKEN);
        await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), {
            body: commands,
        });
        console.log("[INFO] Comando /news registrato con successo.");
    } catch (err) {
        console.error("[ERROR] Registrazione comandi fallita:", err.message);
    }
}

// ── Build embed ───────────────────────────────
function buildEmbed(item, feedInfo) {
    return new EmbedBuilder()
        .setColor(feedInfo.color)
        .setTitle((item.title || "Notizia").slice(0, 256))
        .setURL(item.link)
        .setDescription((item.contentSnippet || "Nessuna descrizione disponibile.").slice(0, 300))
        .setFooter({ text: `Tricolore News · ${feedInfo.label}` })
        .setTimestamp(item.pubDate ? new Date(item.pubDate) : new Date());
}

// ── Polling automatico ────────────────────────
const parser = new Parser({ timeout: 10_000 });

async function checkNews(isFirstRun = false) {
    let channel;
    try {
        channel = await client.channels.fetch(CHANNEL_ID);
        if (!channel?.isTextBased()) {
            console.warn("[WARN] Il canale non è testuale o non è stato trovato.");
            return;
        }
    } catch (err) {
        console.error("[ERROR] Impossibile recuperare il canale:", err.message);
        return;
    }

    let newCount = 0;

    for (const feedInfo of FEEDS) {
        let feed;
        try {
            feed = await parser.parseURL(feedInfo.url);
        } catch (err) {
            console.error(`[ERROR] Feed "${feedInfo.label}" non raggiungibile:`, err.message);
            continue;
        }

        for (const item of feed.items.slice(0, 5)) {
            if (!item.link) continue;
            if (sentNews.has(item.link)) continue;

            sentNews.add(item.link);

            // Al primo avvio segniamo le notizie già esistenti senza inviarle,
            // così il canale non viene inondato di messaggi vecchi.
            if (isFirstRun) continue;

            try {
                await channel.send({ embeds: [buildEmbed(item, feedInfo)] });
                newCount++;
                // Piccolo delay per rispettare il rate limit di Discord
                await sleep(1_200);
            } catch (err) {
                console.error("[ERROR] Invio embed fallito:", err.message);
            }
        }
    }

    saveSentNews(sentNews);

    if (!isFirstRun) {
        console.log(`[INFO] Controllo completato – ${newCount} nuove notizie inviate.`);
    } else {
        console.log(`[INFO] Primo avvio: ${sentNews.size} notizie indicizzate (nessun invio).`);
    }
}

// ── Client Discord ────────────────────────────
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once("ready", async () => {
    console.log(`[INFO] Bot online come ${client.user.tag}`);
    await registerCommands();
    await checkNews(true);                          // Primo giro: solo indicizzazione
    setInterval(() => checkNews(false), 5 * 60 * 1000); // Poll ogni 5 minuti
});

client.on("interactionCreate", async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName !== "news") return;

    await interaction.deferReply();

    const categoria = interaction.options.getString("categoria") || "tutte";
    const targetFeeds = categoria === "tutte"
        ? FEEDS
        : FEEDS.filter((f) => f.label.toLowerCase() === categoria);

    const embeds = [];

    for (const feedInfo of targetFeeds) {
        let feed;
        try {
            feed = await parser.parseURL(feedInfo.url);
        } catch {
            continue;
        }

        for (const item of feed.items.slice(0, 3)) {
            if (!item.link) continue;
            embeds.push(buildEmbed(item, feedInfo));
            if (embeds.length >= 10) break; // Discord max 10 embed per messaggio
        }
        if (embeds.length >= 10) break;
    }

    if (embeds.length === 0) {
        await interaction.editReply({
            content: "⚠️ Nessuna notizia disponibile al momento.",
        });
        return;
    }

    await interaction.editReply({ embeds });
});

// ── Server Express (keep-alive) ───────────────
const app = express();

app.get("/", (_req, res) => res.send("Tricolore News Bot – Online ✅"));
app.get("/health", (_req, res) =>
    res.json({
        status: "ok",
        uptime: process.uptime(),
        sentNews: sentNews.size,
        timestamp: new Date().toISOString(),
    })
);

app.listen(PORT, () => console.log(`[INFO] Server Express in ascolto sulla porta ${PORT}`));

// ── Gestione errori globale ───────────────────
process.on("unhandledRejection", (reason) =>
    console.error("[UNHANDLED REJECTION]", reason)
);
process.on("uncaughtException", (err) =>
    console.error("[UNCAUGHT EXCEPTION]", err.message)
);

// ── Avvio ─────────────────────────────────────
client.login(TOKEN);
