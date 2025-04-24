require("dotenv").config();
// ── AJOUT DEBUG ─────────────────────────────────────────────────
console.log("▶︎ DEBUG env:", {
  DISCORD_TOKEN: process.env.DISCORD_TOKEN ? "[OK]" : "[MISSING]",
  GUILD_ID: process.env.GUILD_ID ? process.env.GUILD_ID : "[MISSING]",
});
// ────────────────────────────────────────────────────────────────

const express = require("express"); // ← ajout pour Railway
const app = express(); // ← création de l’app HTTP

// --- Petit serveur HTTP pour Railway (garde le bot « réveillé ») ---
app.get("/", (_, res) => res.send("Bot Pokémon en ligne !"));
app.listen(process.env.PORT || 3000, () => {
  console.log("🌐 Serveur HTTP démarré sur le port", process.env.PORT || 3000);
});

const fs = require("fs");
const path = require("path");
const axios = require("axios");
const {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  REST,
  Routes,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  Events,
} = require("discord.js");

// --- Gestion des erreurs globales ---
process.on("unhandledRejection", (reason, p) =>
  console.error("💥 Unhandled Rejection at:", p, "reason:", reason),
);
process.on("uncaughtException", (err) =>
  console.error("💀 Uncaught Exception thrown:", err),
);

// --- Répertoires et fichiers ---
const GUILD_ID = process.env.GUILD_ID;
const COOLDOWN_HOURS = parseInt(process.env.COOLDOWN_HOURS) || 1;
const COOLDOWN_MS = COOLDOWN_HOURS * 60 * 60 * 1000;
const DATA_DIR = path.join(__dirname, "data");
const PATH_COLLECTION = path.join(DATA_DIR, "collections.json");
const PATH_COOLDOWNS = path.join(DATA_DIR, "cooldowns.json");
const PATH_WATCHES = path.join(DATA_DIR, "watches.json");
const PATH_BADGES = path.join(DATA_DIR, "badges.json");
const PATH_STATS = path.join(DATA_DIR, "stats.json");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

// --- I/O JSON ---
function ensureJSON(filePath, defaultData = {}) {
  try {
    const raw = fs.existsSync(filePath)
      ? fs.readFileSync(filePath, "utf8").trim()
      : "";
    if (!raw) {
      fs.writeFileSync(filePath, JSON.stringify(defaultData, null, 2));
      return defaultData;
    }
    return JSON.parse(raw);
  } catch (err) {
    console.error(`Erreur accès ${filePath}:`, err);
    return defaultData;
  }
}
function writeJSON(filePath, data) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error(`Erreur écriture ${filePath}:`, err);
  }
}

// --- Chargement des sets Pokémon TCG ---
let allSets = [];
async function loadAllSets() {
  try {
    const res = await axios.get(
      "https://api.pokemontcg.io/v2/sets?pageSize=500",
    );
    allSets = res.data.data.sort(
      (a, b) => new Date(b.releaseDate) - new Date(a.releaseDate),
    );
    console.log(`📦 Chargé ${allSets.length} sets`);
  } catch (err) {
    console.error("❌ Error loading sets:", err);
  }
}

// --- Helpers ---
async function safeExecute(inter, fn) {
  try {
    await fn();
  } catch (err) {
    console.error(`❌ Error in /${inter.commandName}:`, err);
    if (!inter.replied) {
      await inter.reply({
        content: "❌ Une erreur est survenue, réessaie.",
        ephemeral: true,
      });
    }
  }
}
async function fetchCard(set, num) {
  const queries = [
    `set.id:${set} number:${num} language:fr`,
    `set.id:${set} number:${num}`,
  ];
  for (const q of queries) {
    const url = `https://api.pokemontcg.io/v2/cards?q=${encodeURIComponent(q)}&pageSize=1`;
    const res = await axios.get(url);
    if (res.data.data.length) return res.data.data[0];
  }
  return null;
}

// --- Commandes Slash ---
const commands = [
  new SlashCommandBuilder()
    .setName("ouvrir")
    .setDescription("Ouvre un booster Pokémon")
    .addStringOption((o) =>
      o
        .setName("set")
        .setDescription("ID du set")
        .setRequired(true)
        .setAutocomplete(true),
    ),
  new SlashCommandBuilder()
    .setName("inventaire")
    .setDescription("Affiche le nombre total de cartes par set"),
  new SlashCommandBuilder()
    .setName("sets")
    .setDescription("Liste ou filtre les sets")
    .addStringOption((o) =>
      o
        .setName("filter")
        .setDescription("Filtrer par nom/série")
        .setRequired(false),
    ),
  new SlashCommandBuilder()
    .setName("prix")
    .setDescription("Prix d’une carte")
    .addStringOption((o) =>
      o
        .setName("set")
        .setDescription("ID du set")
        .setRequired(true)
        .setAutocomplete(true),
    )
    .addStringOption((o) =>
      o
        .setName("numero")
        .setDescription("Numéro de la carte")
        .setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("badges")
    .setDescription("Affiche tes badges obtenus"),
  new SlashCommandBuilder()
    .setName("watched")
    .setDescription("Liste tes cartes surveillées"),
  new SlashCommandBuilder()
    .setName("top")
    .setDescription("Top collectionneurs global"),
  new SlashCommandBuilder()
    .setName("stats")
    .setDescription("Affiche ton nombre d’ouvertures et trades"),
  new SlashCommandBuilder()
    .setName("profil")
    .setDescription("Profil utilisateur avec total cartes et badges"),
].map((c) => c.toJSON());

// --- Initialisation du client Discord ---
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});
client.on("error", console.error);

client.once(Events.ClientReady, async () => {
  console.log("🔄 Démarrage du bot…");
  await loadAllSets();
  const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);
  await rest.put(Routes.applicationGuildCommands(client.user.id, GUILD_ID), {
    body: commands,
  });
  console.log("✅ Commandes enregistrées");
});

// --- Gestion des interactions ---
client.on(Events.InteractionCreate, async (inter) => {
  // Autocomplete pour `set`
  if (inter.isAutocomplete()) {
    const focused = inter.options.getFocused().toLowerCase();
    const choices = allSets
      .filter(
        (s) =>
          s.id.toLowerCase().includes(focused) ||
          (s.name && s.name.toLowerCase().includes(focused)),
      )
      .slice(0, 25)
      .map((s) => ({ name: `${s.id}: ${s.name}`, value: s.id }));
    return inter.respond(choices);
  }

  // Boutons watch/unwatch pour /prix
  if (inter.isButton()) {
    const [action, set, num] = inter.customId.split("_");
    if (action === "watch" || action === "unwatch") {
      const uid = inter.user.id;
      const watches = ensureJSON(PATH_WATCHES, {});
      const key = `${set}/${num}`;
      watches[uid] = watches[uid] || [];
      if (action === "watch") {
        if (!watches[uid].some((w) => w.key === key)) {
          const card = await fetchCard(set, num);
          watches[uid].push({
            key,
            lastPrice: card?.cardmarket?.prices?.averageSellPrice || 0,
          });
        }
      } else {
        watches[uid] = watches[uid].filter((w) => w.key !== key);
      }
      writeJSON(PATH_WATCHES, watches);
      // Bascule le bouton
      const isWatching = action === "watch";
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`${isWatching ? "unwatch" : "watch"}_${set}_${num}`)
          .setLabel(
            isWatching ? "🔕 Désactiver la surveillance" : "🔔 Surveiller",
          )
          .setStyle(isWatching ? ButtonStyle.Danger : ButtonStyle.Primary),
      );
      return inter.update({ components: [row] });
    }
  }

  // Slash Commands
  if (inter.isChatInputCommand()) {
    await safeExecute(inter, async () => {
      const uid = inter.user.id;
      const collections = ensureJSON(PATH_COLLECTION, {});
      const cooldowns = ensureJSON(PATH_COOLDOWNS, {});
      const badges = ensureJSON(PATH_BADGES, {});
      const stats = ensureJSON(PATH_STATS, {});
      const watches = ensureJSON(PATH_WATCHES, {});

      switch (inter.commandName) {
        case "ouvrir": {
          const set = inter.options.getString("set").toUpperCase();
          await inter.deferReply();
          const now = Date.now();
          if (cooldowns[uid] && now - cooldowns[uid] < COOLDOWN_MS) {
            const rem = COOLDOWN_MS - (now - cooldowns[uid]);
            const m = Math.floor(rem / 60000),
              s = Math.floor((rem % 60000) / 1000);
            return inter.editReply({ content: `⏳ Attends ${m}m${s}s` });
          }
          const res = await axios.get(
            `https://api.pokemontcg.io/v2/cards?q=${encodeURIComponent(`set.id:${set}`)}&pageSize=250`,
          );
          const cards = res.data.data;
          if (!cards.length)
            return inter.editReply({
              content: `❌ Set ${set} introuvable.`,
              ephemeral: true,
            });
          const rand = (arr, n) =>
            [...arr].sort(() => 0.5 - Math.random()).slice(0, n);
          const booster = [
            ...rand(
              cards.filter((c) => c.rarity === "Common"),
              6,
            ),
            ...rand(
              cards.filter((c) => c.rarity === "Uncommon"),
              3,
            ),
            ...rand(
              cards.filter((c) => c.rarity?.includes("Rare")),
              1,
            ),
          ];
          collections[uid] = {
            ...(collections[uid] || {}),
            [set]: { ...((collections[uid] || {})[set] || {}) },
          };
          booster.forEach((c) => {
            const key = `${c.set.id}/${c.number}`;
            collections[uid][set][key] = (collections[uid][set][key] || 0) + 1;
          });
          writeJSON(PATH_COLLECTION, collections);
          cooldowns[uid] = now;
          writeJSON(PATH_COOLDOWNS, cooldowns);
          stats[uid] = stats[uid] || { openers: 0, trades: 0 };
          stats[uid].openers++;
          writeJSON(PATH_STATS, stats);
          if (!(badges[uid] || []).includes("premier-booster")) {
            badges[uid] = [...(badges[uid] || []), "premier-booster"];
            writeJSON(PATH_BADGES, badges);
            await inter.followUp({
              content: "🎉 Badge Premier Booster débloqué !",
              ephemeral: true,
            });
          }
          const emb = new EmbedBuilder()
            .setTitle(`🎁 Booster — ${set}`)
            .setImage(booster.at(-1).images.large)
            .setFooter({ text: "Pokémon TCG Bot" });
          booster.forEach((c) =>
            emb.addFields({
              name: c.name,
              value: `${c.rarity || "—"} • #${c.number}`,
              inline: true,
            }),
          );
          return inter.editReply({ embeds: [emb] });
        }
        case "inventaire": {
          const sets = Object.keys(collections[uid] || {});
          if (!sets.length)
            return inter.reply({
              content: "❌ Pas de collection.",
              ephemeral: true,
            });
          const emb = new EmbedBuilder().setTitle("📋 Inventaire complet");
          sets.forEach((s) => {
            const tot = Object.values(collections[uid][s]).reduce(
              (a, b) => a + b,
              0,
            );
            emb.addFields({ name: s, value: `x${tot}`, inline: true });
          });
          return inter.reply({ embeds: [emb] });
        }
        case "sets": {
          const filter = inter.options.getString("filter");
          let arr = allSets;
          if (filter) {
            const f = filter.toLowerCase();
            arr = arr.filter(
              (s) =>
                s.id.toLowerCase().includes(f) ||
                (s.name && s.name.toLowerCase().includes(f)) ||
                (s.series && s.series.toLowerCase().includes(f)),
            );
          }
          const latest = arr.slice(0, 25);
          const desc =
            latest.map((s) => `<\`${s.id}\`>: ${s.name}`).join("\n") +
            (arr.length > 25 ? `\n…+${arr.length - 25} autres` : "");
          const emb = new EmbedBuilder()
            .setTitle(filter ? `Résultats \`${filter}\`` : "25 derniers sets")
            .setDescription(desc)
            .setFooter({ text: "/sets filter:SV pour SV uniquement" });
          return inter.reply({ embeds: [emb] });
        }
        case "prix": {
          const set = inter.options.getString("set").toUpperCase();
          const num = inter.options.getString("numero");
          await inter.deferReply();
          const card = await fetchCard(set, num);
          if (!card)
            return inter.editReply({
              content: `❌ ${set}/${num} introuvable.`,
              ephemeral: true,
            });
          const p = card.cardmarket?.prices || {};
          const emb = new EmbedBuilder()
            .setTitle(`${card.name} — ${card.set.name}`)
            .setImage(card.images.large)
            .addFields(
              {
                name: "Prix bas",
                value: p.lowPrice ? `${p.lowPrice} €` : "N/A",
                inline: true,
              },
              {
                name: "Prix moyen",
                value: p.averageSellPrice ? `${p.averageSellPrice} €` : "N/A",
                inline: true,
              },
              {
                name: "Tendance",
                value: p.trendPrice ? `${p.trendPrice} €` : "N/A",
                inline: true,
              },
            )
            .setFooter({ text: "Pokémon TCG Bot" });
          const isWatching = watches[uid]?.some(
            (w) => w.key === `${set}/${num}`,
          );
          const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(`${isWatching ? "unwatch" : "watch"}_${set}_${num}`)
              .setLabel(
                isWatching ? "🔕 Désactiver la surveillance" : "🔔 Surveiller",
              )
              .setStyle(isWatching ? ButtonStyle.Danger : ButtonStyle.Primary),
            new ButtonBuilder()
              .setLabel("🔗 Cardmarket")
              .setStyle(ButtonStyle.Link)
              .setURL(
                `https://www.cardmarket.com/fr/Pokemon/Products/Singles?searchString=${encodeURIComponent(card.name)}`,
              ),
          );
          return inter.editReply({ embeds: [emb], components: [row] });
        }
        case "badges": {
          const userBadges = ensureJSON(PATH_BADGES, {})[uid] || [];
          if (!userBadges.length)
            return inter.reply({ content: "🎖️ Aucun badge.", ephemeral: true });
          const labels = { "premier-booster": "🥇 Premier Booster" };
          const desc = userBadges.map((id) => labels[id] || id).join("\n");
          return inter.reply({
            embeds: [
              new EmbedBuilder().setTitle("🎖️ Badges").setDescription(desc),
            ],
          });
        }
        case "watched": {
          const list = watches[uid] || [];
          if (!list.length)
            return inter.reply({
              content: "ℹ️ Aucune carte surveillée.",
              ephemeral: true,
            });
          const emb = new EmbedBuilder()
            .setTitle("🔔 Cartes surveillées")
            .setDescription(list.map((w) => `• ${w.key}`).join("\n"))
            .setColor(0x00ae86);
          return inter.reply({ embeds: [emb], ephemeral: true });
        }
        case "top": {
          const allC = ensureJSON(PATH_COLLECTION, {});
          const lb = Object.entries(allC).map(([u, sets]) => ({
            userId: u,
            total: Object.values(sets).reduce(
              (s, cs) => s + Object.values(cs).reduce((a, b) => a + b, 0),
              0,
            ),
          }));
          const top5 = lb.sort((a, b) => b.total - a.total).slice(0, 5);
          const desc =
            top5
              .map((e, i) => `**${i + 1}.** <@${e.userId}> — ${e.total} cartes`)
              .join("\n") || "Aucun";
          const emb = new EmbedBuilder()
            .setTitle("🏆 Top global")
            .setDescription(desc)
            .setColor(0xffd700);
          return inter.reply({ embeds: [emb] });
        }
        case "stats": {
          const s = stats[uid] || { openers: 0, trades: 0 };
          return inter.reply({
            content: `📊 Boosters: ${s.openers}\n🔁 Trades: ${s.trades}`,
            ephemeral: true,
          });
        }
        case "profil": {
          const col = ensureJSON(PATH_COLLECTION, {})[uid] || {};
          const total = Object.values(col).reduce(
            (sum, cs) => sum + Object.values(cs).reduce((a, b) => a + b, 0),
            0,
          );
          const userBadges = ensureJSON(PATH_BADGES, {})[uid] || [];
          const emb = new EmbedBuilder()
            .setTitle(`🧑 ${inter.user.username}`)
            .addFields(
              { name: "📦 Total cartes", value: `${total}`, inline: true },
              {
                name: "🎖️ Badges",
                value: userBadges.length ? userBadges.join(", ") : "Aucun",
                inline: true,
              },
            )
            .setThumbnail(inter.user.displayAvatarURL());
          return inter.reply({ embeds: [emb] });
        }
        default:
          return inter.reply({
            content: "🔍 Commande non reconnue",
            ephemeral: true,
          });
      }
    });
  }
});

// --- Surveillance horaire des prix ---
setInterval(
  async () => {
    const watches = ensureJSON(PATH_WATCHES, {});
    for (const uid in watches) {
      for (const entry of watches[uid]) {
        const [set, num] = entry.key.split("/");
        try {
          const card = await fetchCard(set, num);
          const newP = card?.cardmarket?.prices?.averageSellPrice || 0;
          if (newP !== entry.lastPrice) {
            const user = await client.users.fetch(uid);
            await user.send(`🔔 ${entry.key}: ${entry.lastPrice}€ → ${newP}€`);
            entry.lastPrice = newP;
            writeJSON(PATH_WATCHES, watches);
          }
        } catch {}
      }
    }
  },
  1000 * 60 * 60,
);

// --- Connexion au bot ---
client.login(process.env.DISCORD_TOKEN.trim());
