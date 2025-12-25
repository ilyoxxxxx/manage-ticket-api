

const API_URL = "https://manage-ticket-api.ilyesquibroute93.workers.dev";
const API_KEY = "Managebot@@@";

/* ======================================================
   CACHE (léger pour éviter spam API)
====================================================== */
const cache = new Map();
const CACHE_TTL = 30_000; // 30s

async function getAutomodConfig(guildId) {
  const now = Date.now();
  const cached = cache.get(guildId);

  if (cached && cached.expires > now) {
    return cached.data;
  }

  const res = await fetch(`${API_URL}/api/automod/${guildId}`, {
    headers: { "x-api-key": API_KEY }
  });

  const data = await res.json();
  cache.set(guildId, { data, expires: now + CACHE_TTL });
  return data;
}

/* ======================================================
   UTILITAIRES
====================================================== */

function isException(msg, exceptions = {}) {
  if (exceptions.users?.includes(msg.author.id)) return true;
  if (exceptions.channels?.includes(msg.channel.id)) return true;
  if (exceptions.roles?.some(r => msg.member.roles.cache.has(r))) return true;
  return false;
}

function percentCaps(text) {
  const letters = text.replace(/[^a-zA-Z]/g, "");
  if (!letters.length) return 0;
  const caps = letters.replace(/[^A-Z]/g, "").length;
  return (caps / letters.length) * 100;
}

/* ======================================================
   DÉTECTION INFRACTIONS (100 % CONFIG)
====================================================== */

function detectViolation(msg, filters) {
  const content = msg.content;

  if (filters.links?.enabled && /(https?:\/\/|discord\.gg)/i.test(content)) {
    return "links";
  }

  if (filters.everyone?.enabled &&
      (content.includes("@everyone") || content.includes("@here"))) {
    return "everyone";
  }

  if (filters.caps?.enabled) {
    const pct = percentCaps(content);
    if (content.length >= filters.caps.minLength &&
        pct >= filters.caps.percent) {
      return "caps";
    }
  }

  if (filters.badWords?.enabled) {
    const lower = content.toLowerCase();
    if (filters.badWords.words.some(w => lower.includes(w))) {
      return "badWords";
    }
  }

  if (filters.emojis?.enabled) {
    const emojis = content.match(/\p{Extended_Pictographic}/gu) || [];
    if (emojis.length > filters.emojis.max) {
      return "emojis";
    }
  }

  return null;
}

/* ======================================================
   SANCTIONS (CONFIGURABLE)
====================================================== */

async function applySanctions(msg, config, type) {
  const actions = config.actions;

  if (actions.delete) {
    await msg.delete().catch(() => {});
  }

  if (actions.warn?.enabled) {
    await msg.author.send(
      `⚠️ Avertissement sur **${msg.guild.name}**\nRaison : ${type}`
    ).catch(() => {});
  }

  if (actions.timeout?.enabled) {
    await msg.member.timeout(
      actions.timeout.duration * 1000,
      `Automod: ${type}`
    ).catch(() => {});
  }

  if (actions.kick?.enabled) {
    await msg.member.kick(`Automod: ${type}`).catch(() => {});
  }

  if (actions.ban?.enabled) {
    await msg.member.ban({ reason: `Automod: ${type}` }).catch(() => {});
  }
}

/* ======================================================
   LOGS + STATS API
====================================================== */

async function logEvent(guildId, type, userId) {
  await fetch(`${API_URL}/api/automod/event`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": API_KEY
    },
    body: JSON.stringify({ guildId, type, userId })
  }).catch(() => {});
}

/* ======================================================
   EXPORT PRINCIPAL
====================================================== */

module.exports = client => {
  client.on("messageCreate", async msg => {
    if (!msg.guild || msg.author.bot) return;

    let config;
    try {
      config = await getAutomodConfig(msg.guild.id);
    } catch {
      return;
    }

    if (!config.enabled) return;
    if (isException(msg, config.exceptions)) return;

    const violation = detectViolation(msg, config.filters);
    if (!violation) return;

    await applySanctions(msg, config, violation);
    await logEvent(msg.guild.id, violation, msg.author.id);

    // LOGS DISCORD
    if (config.logs?.channelId) {
      const logChannel = msg.guild.channels.cache.get(config.logs.channelId);
      if (logChannel) {
        logChannel.send({
          embeds: [{
            color: 0xff0000,
            title: "🛡️ Automod",
            description: `
**Utilisateur**: ${msg.author}
**Type**: ${violation}
**Salon**: ${msg.channel}
**Message**:
\`\`\`
${msg.content.slice(0, 1500)}
\`\`\`
            `,
            timestamp: new Date()
          }]
        }).catch(() => {});
      }
    }
  });
};


