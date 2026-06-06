const { Client, GatewayIntentBits, EmbedBuilder, REST, Routes, SlashCommandBuilder } = require("discord.js");
const Parser = require("rss-parser");
const express = require("express");

const client = new Client({
    intents: [GatewayIntentBits.Guilds]
});

const parser = new Parser();

const TOKEN = "MTUxMjkyODk2OTg0OTMxMTI3Mg.GMrXRK.rfpbih8bJPXzR38h_yd8TJSQzZF3lT1Fm29Jds";
const CLIENT_ID = "1512928969849311272";
const GUILD_ID = "1512809889666175211";
const CHANNEL_ID = "1512849401322672309";

/* FEED RSS */
const FEEDS = [
    "https://www.ansa.it/sito/notizie/politica/politica_rss.xml",
    "https://www.ansa.it/sito/notizie/economia/economia_rss.xml",
    "https://www.ansa.it/sito/notizie/mondo/mondo_rss.xml",
    "https://www.ansa.it/sito/notizie/cronaca/cronaca_rss.xml"
];

let sent = new Set();

/* NEWS CHECK */
async function checkNews() {
    try {
        const channel = await client.channels.fetch(CHANNEL_ID);

        for (const feed of FEEDS) {
            try {
                const data = await parser.parseURL(feed);

                for (const item of data.items.slice(0, 5)) {
                    if (!item.link || sent.has(item.link)) continue;

                    sent.add(item.link);

                    const embed = new EmbedBuilder()
                        .setTitle(item.title || "Notizia")
                        .setURL(item.link)
                        .setDescription((item.contentSnippet || "").slice(0, 200))
                        .setTimestamp();

                    await channel.send({ embeds: [embed] });
                }
            } catch (e) {
                console.error("Errore feed:", feed, e.message);
            }
        }
    } catch (err) {
        console.error("Errore checkNews:", err);
    }
}

/* SLASH COMMAND */
const commands = [
    new SlashCommandBuilder()
        .setName("news")
        .setDescription("Mostra le ultime notizie")
        .toJSON()
];

const rest = new REST({ version: "10" }).setToken(TOKEN);

async function registerCommands() {
    try {
        await rest.put(
            Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
            { body: commands }
        );
    } catch (err) {
        console.error("Errore registerCommands:", err);
    }
}

/* EXPRESS (UNA SOLA VOLTA) */
const app = express();
const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
    res.send("Bot online");
});

app.listen(PORT, () => {
    console.log(`Server avviato sulla porta ${PORT}`);
});

/* BOT READY */
client.once("ready", async () => {
    console.log(`Bot online come ${client.user.tag}`);

    await registerCommands();

    checkNews();
    setInterval(checkNews, 5 * 60 * 1000);
});

/* /news COMMAND */
client.on("interactionCreate", async interaction => {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === "news") {
        try {
            const data = await parser.parseURL(FEEDS[0]);

            const embeds = data.items.slice(0, 5).map(item =>
                new EmbedBuilder()
                    .setTitle(item.title || "Notizia")
                    .setURL(item.link)
                    .setDescription((item.contentSnippet || "").slice(0, 200))
            );

            await interaction.reply({ embeds });
        } catch (err) {
            console.error(err);
            await interaction.reply({ content: "Errore nel caricamento news", ephemeral: true });
        }
    }
});

client.login(TOKEN).catch(console.error);

/* ERROR HANDLING GLOBALE */
process.on("unhandledRejection", console.error);
process.on("uncaughtException", console.error);
