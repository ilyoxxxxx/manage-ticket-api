export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const method = req.method;

    /* =========================
       AUTH DISCORD (OAUTH2)
    ========================= */

    if (url.pathname === "/auth/discord") {
      const params = new URLSearchParams({
        client_id: env.DISCORD_CLIENT_ID,
        redirect_uri: env.DISCORD_REDIRECT_URI,
        response_type: "code",
        scope: "identify guilds"
      });
      return Response.redirect(
        "https://discord.com/oauth2/authorize?" + params.toString(),
        302
      );
    }

    if (url.pathname === "/auth/discord/callback") {
      const code = url.searchParams.get("code");
      if (!code) return new Response("Missing code", { status: 400 });

      const tokenRes = await fetch("https://discord.com/api/oauth2/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: env.DISCORD_CLIENT_ID,
          client_secret: env.DISCORD_CLIENT_SECRET,
          grant_type: "authorization_code",
          code,
          redirect_uri: env.DISCORD_REDIRECT_URI
        })
      });

      const token = await tokenRes.json();

      const user = await fetch("https://discord.com/api/users/@me", {
        headers: { Authorization: `Bearer ${token.access_token}` }
      }).then(r => r.json());

      const guilds = await fetch("https://discord.com/api/users/@me/guilds", {
        headers: { Authorization: `Bearer ${token.access_token}` }
      }).then(r => r.json());

      const session = btoa(JSON.stringify({ user, guilds }));

      return new Response(null, {
        status: 302,
        headers: {
          "Set-Cookie": `session=${session}; Path=/; HttpOnly; Secure; SameSite=Lax`,
          "Location": "/dashboard"
        }
      });
    }

    /* =========================
       DASHBOARD HTML
    ========================= */

    if (url.pathname === "/dashboard") {
      const session = getSession(req);
      if (!session) return Response.redirect("/auth/discord", 302);

      return html(renderDashboard(session.guilds));
    }

    /* =========================
       API SECURITY
    ========================= */

    if (url.pathname.startsWith("/api")) {
      if (req.headers.get("x-api-key") !== env.API_KEY) {
        return json({ error: "Unauthorized" }, 401);
      }
    }

    /* =========================
       AUTOMOD API
    ========================= */

    if (method === "GET" && url.pathname.startsWith("/api/automod/")) {
      const guildId = url.pathname.split("/")[3];
      const data = await env.AUTOMOD.get(guildId);
      return json(data ? JSON.parse(data) : defaultAutomod());
    }

    if (method === "POST" && url.pathname === "/api/automod") {
      const { guildId, config } = await req.json();
      await env.AUTOMOD.put(guildId, JSON.stringify(config));
      return json({ success: true });
    }

    if (method === "POST" && url.pathname === "/api/automod/event") {
      const { guildId, type } = await req.json();
      const stats = JSON.parse(await env.STATS.get(guildId) || "{}");
      stats.automod ??= {};
      stats.automod[type] = (stats.automod[type] || 0) + 1;
      await env.STATS.put(guildId, JSON.stringify(stats));
      return json({ success: true });
    }

    /* =========================
       TICKETS API
    ========================= */

    if (method === "GET" && url.pathname.startsWith("/api/tickets/")) {
      const guildId = url.pathname.split("/")[3];
      const data = await env.TICKETS.get(guildId);
      return json(data ? JSON.parse(data) : defaultTickets());
    }

    if (method === "POST" && url.pathname === "/api/tickets") {
      const { guildId, config } = await req.json();
      await env.TICKETS.put(guildId, JSON.stringify(config));
      return json({ success: true });
    }

    if (method === "POST" && url.pathname === "/api/tickets/event") {
      const { guildId, action } = await req.json();
      const stats = JSON.parse(await env.STATS.get(guildId) || "{}");
      stats.tickets ??= { open: 0, total: 0 };

      if (action === "open") {
        stats.tickets.open++;
        stats.tickets.total++;
      }

      if (action === "close") {
        stats.tickets.open = Math.max(0, stats.tickets.open - 1);
      }

      await env.STATS.put(guildId, JSON.stringify(stats));
      return json({ success: true });
    }

    /* =========================
       STATS
    ========================= */

    if (method === "GET" && url.pathname.startsWith("/api/stats/")) {
      const guildId = url.pathname.split("/")[3];
      const stats = await env.STATS.get(guildId);
      return json(stats ? JSON.parse(stats) : {});
    }

    /* =========================
       TRANSCRIPTS
    ========================= */

    if (method === "POST" && url.pathname === "/api/transcript") {
      const { key, html } = await req.json();
      await env.TRANSCRIPTS.put(key, html);
      return json({ success: true });
    }

    if (method === "GET" && url.pathname.startsWith("/api/transcripts/")) {
      const guildId = url.pathname.split("/")[3];
      const list = await env.TRANSCRIPTS.list({ prefix: guildId });
      return json(list.keys.map(k => k.name));
    }

    if (method === "GET" && url.pathname.startsWith("/api/transcript/")) {
      const key = url.pathname.split("/")[3];
      const html = await env.TRANSCRIPTS.get(key);
      return new Response(html || "Not found", {
        headers: { "Content-Type": "text/html" }
      });
    }

    return new Response("Not Found", { status: 404 });
  }
};

/* =========================
   HELPERS
========================= */

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

function html(body) {
  return new Response(`
    <html>
      <head>
        <title>Manage Dashboard</title>
        <style>
          body { font-family: sans-serif; background:#0f0f14; color:white; padding:20px }
          .card { background:#1a1a25; padding:15px; border-radius:8px; margin-bottom:15px }
        </style>
      </head>
      <body>${body}</body>
    </html>
  `, { headers: { "Content-Type": "text/html" } });
}

function getSession(req) {
  const cookie = req.headers.get("Cookie") || "";
  const match = cookie.match(/session=([^;]+)/);
  if (!match) return null;
  try {
    return JSON.parse(atob(match[1]));
  } catch {
    return null;
  }
}

function renderDashboard(guilds) {
  return `
    <h1>Manage Dashboard</h1>
    <div class="card">
      <h2>Serveurs</h2>
      <ul>
        ${guilds.map(g => `<li>${g.name}</li>`).join("")}
      </ul>
    </div>
  `;
}

function defaultAutomod() {
  return {
    enabled: false,
    filters: {
      links: { enabled: true },
      everyone: { enabled: true },
      caps: { enabled: true, percent: 70, minLength: 10 },
      badWords: { enabled: false, words: [] }
    },
    actions: {
      delete: true,
      warn: false,
      timeout: { enabled: false, duration: 600 }
    },
    exceptions: { roles: [], channels: [], users: [] },
    logs: { channelId: null }
  };
}

function defaultTickets() {
  return {
    enabled: false,
    panel: { channelId: null, messageId: null },
    categoryId: null,
    staffRoles: [],
    antiSpam: { enabled: true, maxOpen: 1 },
    embed: {
      title: "🎫 Support",
      description: "Clique pour ouvrir un ticket",
      color: "#5865F2"
    }
  };
}
