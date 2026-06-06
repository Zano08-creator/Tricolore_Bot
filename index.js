const { Client, GatewayIntentBits, EmbedBuilder, REST, Routes, SlashCommandBuilder } = require("discord.js");
const Parser = require("rss-parser");
const express = require("express");

const client = new Client({
    intents: [GatewayIntentBits.Guilds]
});

const parser = new Parser();

const TOKEN = "MTUxMjgzNDUzNTEyNDEwNzMzNg.Gk5YM7.etBBrf972pqsOhVkkNL3-JqpBNtOP0QV_o7-cs";
const CLIENT_ID = "1512866636070260826";
const GUILD_ID = "1512809889666175211";
const CHANNEL_ID = "1512849401322672309";

/* RSS IDENTICI AL TUO SITO */
const FEEDS = [
    "https://www.ansa.it/sito/notizie/politica/politica_rss.xml",
    "https://www.ansa.it/sito/notizie/economia/economia_rss.xml",
    "https://www.ansa.it/sito/notizie/mondo/mondo_rss.xml",
    "https://www.ansa.it/sito/notizie/cronaca/cronaca_rss.xml"
];

let sent = new Set();

/* 🔔 INVIO NEWS AUTOMATICO */
async function checkNews() {
    try {
        const channel = await client.channels.fetch(CHANNEL_ID);

        for (const feed of FEEDS) {
            const data = await parser.parseURL(feed);

            for (const item of data.items.slice(0, 5)) {
                if (!item.link || sent.has(item.link)) continue;

                sent.add(item.link);

                const embed = new EmbedBuilder()
                    .setTitle(item.title)
                    .setURL(item.link)
                    .setDescription(item.contentSnippet?.slice(0, 200))
                    .setTimestamp();

                channel.send({ embeds: [embed] });
            }
        }
    } catch (err) {
        console.log(err);
    }
}

/* 🤖 SLASH COMMAND /news */
const commands = [
    new SlashCommandBuilder()
        .setName("news")
        .setDescription("Mostra le ultime notizie")
        .toJSON()
];

const rest = new REST({ version: "10" }).setToken(TOKEN);

async function registerCommands() {
    await rest.put(
        Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
        { body: commands }
    );
}

/* 🌐 SERVER PER TENERE ONLINE (IMPORTANTE PER HOSTING) */
const app = express();
app.get("/", (req, res) => res.send("Bot online"));
app.listen(3000);

/* 🤖 BOT READY */
client.once("ready", async () => {
    console.log("Bot online!");

    await registerCommands();

    checkNews();
    setInterval(checkNews, 5 * 60 * 1000);
});

/* 📩 /news COMMAND */
client.on("interactionCreate", async interaction => {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === "news") {
        const data = await parser.parseURL(FEEDS[0]);

        const latest = data.items.slice(0, 5);

        const embeds = latest.map(item =>
            new EmbedBuilder()
                .setTitle(item.title)
                .setURL(item.link)
                .setDescription(item.contentSnippet?.slice(0, 200))
        );

        interaction.reply({ embeds });
    }
});

client.login(TOKEN);