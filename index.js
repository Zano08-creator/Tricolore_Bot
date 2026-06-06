:::writing{variant="document" id="58127"}
const { Client, GatewayIntentBits, EmbedBuilder, REST, Routes, SlashCommandBuilder } = require("discord.js");
const Parser = require("rss-parser");
const express = require("express");

const TOKEN = process.env.TOKEN;
const CLIENT_ID = "1512928969849311272";
const GUILD_ID = "1512809889666175211";
const CHANNEL_ID = "1512849401322672309";

const client = new Client({
    intents: [GatewayIntentBits.Guilds]
});

const parser = new Parser();

const FEEDS = [
    "https://www.ansa.it/sito/notizie/politica/politica_rss.xml",
    "https://www.ansa.it/sito/notizie/economia/economia_rss.xml",
    "https://www.ansa.it/sito/notizie/mondo/mondo_rss.xml",
    "https://www.ansa.it/sito/notizie/cronaca/cronaca_rss.xml"
];

const sentNews = new Set();

const commands = [
    new SlashCommandBuilder()
        .setName("news")
        .setDescription("Mostra le ultime notizie")
        .toJSON()
];

async function registerCommands() {
    try {
        const rest = new REST({ version: "10" }).setToken(TOKEN);

        await rest.put(
            Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
            { body: commands }
        );

        console.log("Comando /news registrato");
    } catch (error) {
        console.error("Errore registrazione comandi:", error);
    }
}

async function checkNews() {
    try {
        const channel = await client.channels.fetch(CHANNEL_ID);

        if (!channel) {
            console.log("Canale non trovato");
            return;
        }

        for (const feedUrl of FEEDS) {
            try {
                const feed = await parser.parseURL(feedUrl);

                for (const item of feed.items.slice(0, 5)) {
                    if (!item.link) continue;
                    if (sentNews.has(item.link)) continue;

                    sentNews.add(item.link);

                    const embed = new EmbedBuilder()
                        .setTitle(item.title || "Notizia")
                        .setURL(item.link)
                        .setDescription((item.contentSnippet || "Nessuna descrizione").slice(0, 300))
                        .setFooter({ text: "Tricolore News" })
                        .setTimestamp();

                    await channel.send({ embeds: [embed] });
                }
            } catch (err) {
                console.error("Errore feed:", feedUrl, err);
            }
        }
    } catch (err) {
        console.error("Errore invio news:", err);
    }
}

client.once("ready", async () => {
    console.log(`Bot online come ${client.user.tag}`);

    await registerCommands();
    await checkNews();

    setInterval(checkNews, 5 * 60 * 1000);
});

client.on("interactionCreate", async interaction => {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === "news") {
        try {
            const feed = await parser.parseURL(FEEDS[0]);

            const embeds = feed.items.slice(0, 5).map(item =>
                new EmbedBuilder()
                    .setTitle(item.title || "Notizia")
                    .setURL(item.link)
                    .setDescription((item.contentSnippet || "Nessuna descrizione").slice(0, 300))
            );

            await interaction.reply({ embeds });
        } catch (err) {
            console.error(err);

            await interaction.reply({
                content: "Errore nel caricamento delle news.",
                ephemeral: true
            });
        }
    }
});

const app = express();

app.get("/", (req, res) => {
    res.send("Tricolore News Bot Online");
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`Server avviato sulla porta ${PORT}`);
});

process.on("unhandledRejection", console.error);
process.on("uncaughtException", console.error);

client.login(TOKEN);
:::
