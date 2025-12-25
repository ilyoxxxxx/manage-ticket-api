export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const method = req.method;

    /* =====================================================
       0) WEBSOCKET (LIVE)
    ===================================================== */
    if (url.pathname === "/ws" && req.headers.get("Upgrade") === "websocket") {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      server.accept();

      env.SOCKETS ??= new Set();
      env.SOCKETS.add(server);
      server.addEventListener("close", () => env.SOCKETS.delete(server));

      return new Response(null, { status: 101, webSocket: client });
    }

    /* =====================================================
       1) AUTH DISCORD
    ===================================================== */
    if (url.pathname === "/auth/discord") {
      const params = new URLSearchParams({
        client_id: env.DISCORD_CLIENT_ID,
        redirect_uri: env.DISCORD_REDIRECT_URI,
        response_type: "code",
        scope: "identify guilds"
      });
      return Response.redirect(
        "https://discord.com/oauth2/authorize?" + params,
        302
      );
    }

    if (url.pathname === "/auth/discord/callback") {
      const code = url.searchParams.get("code");
      if (!code) return new Response("Missing code", { status: 400 });

      const token = await fetch("https://discord.com/api/oauth2/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: env.DISCORD_CLIENT_ID,
          client_secret: env.DISCORD_CLIENT_SECRET,
          grant_type: "authorization_code",
          code,
          redirect_uri: env.DISCORD_REDIRECT_URI
        })
      }).then(r => r.json());

      const user = await fetch("https://discord.com/api/users/@me", {
        headers: { Authorization: `Bearer ${token.access_token}` }
      }).then(r => r.json());

      const guilds = await fetch("https://discord.com/api/users/@me/guilds", {
        headers: { Authorization: `Bearer ${token.access_token}` }
      }).then(r => r.json());

      return new Response(null, {
        status: 302,
        headers: {
          "Set-Cookie": `session=${btoa(JSON.stringify({ user, guilds }))}; Path=/; HttpOnly; Secure`,
          "Location": "/dashboard"
        }
      });
    }

    /* =====================================================
       2) DASHBOARD
    ===================================================== */
    if (url.pathname === "/dashboard") {
      const session = getSession(req);
      if (!session) return Response.redirect("/auth/discord", 302);
      return html(renderDashboard(session.guilds));
    }

    /* =====================================================
       3) API SECURITY
    ===================================================== */
    if (url.pathname.startsWith("/api")) {
      if (req.headers.get("x-api-key") !== env.API_KEY)
        return new Response("Unauthorized", { status: 401 });
    }

    /* =====================================================
       4) CONFIG TICKET / AUTOMOD
    ===================================================== */
    if (method === "GET" && url.pathname.startsWith("/api/config/")) {
      const guildId = url.pathname.split("/")[3];
      const data = await env.TICKETS.get(guildId);
      return json(data ? JSON.parse(data) : defaultConfig());
    }

    if (method === "POST" && url.pathname === "/api/config") {
      const { guildId, config } = await req.json();
      await env.TICKETS.put(guildId, JSON.stringify(config));
      broadcast(env, { type: "config:update", guildId });
      return json({ success: true });
    }

    /* =====================================================
       5) STATS + EVENTS
    ===================================================== */
    if (method === "POST" && url.pathname === "/api/event") {
      const event = await req.json();
      await updateStats(env, event);
      broadcast(env, { type: "stats:update", guildId: event.guildId });
      return json({ success: true });
    }

    if (method === "GET" && url.pathname.startsWith("/api/stats/")) {
      const guildId = url.pathname.split("/")[3];
      const stats = await env.STATS.get(guildId);
      return json(stats ? JSON.parse(stats) : emptyStats());
    }

    /* =====================================================
       6) TRANSCRIPTS VIEWER
    ===================================================== */
    if (method === "GET" && url.pathname.startsWith("/api/transcripts/")) {
      const guildId = url.pathname.split("/")[3];
      const list = await env.TRANSCRIPTS.list({ prefix: guildId });
      return json(list.keys.map(k => ({
        id: k.name,
        createdAt: k.metadata?.createdAt
      })));
    }

    if (method === "GET" && url.pathname.startsWith("/api/transcript/")) {
      const key = url.pathname.split("/")[3];
      const html = await env.TRANSCRIPTS.get(key);
      return new Response(html, { headers: { "Content-Type": "text/html" } });
    }

    return new Response("Not Found", { status: 404 });
  }
};

/* =====================================================
   HELPERS
===================================================== */

function broadcast(env, payload) {
  if (!env.SOCKETS) return;
  const msg = JSON.stringify(payload);
  for (const ws of env.SOCKETS) {
    try { ws.send(msg); } catch {}
  }
}

async function updateStats(env, event) {
  const stats = JSON.parse(await env.STATS.get(event.guildId) || "{}");
  stats.openTickets ??= 0;
  stats.totalTickets ??= 0;
  stats.totalTranscripts ??= 0;

  if (event.action === "open") {
    stats.openTickets++;
    stats.totalTickets++;
  }
  if (event.action === "close") stats.openTickets--;

  await env.STATS.put(event.guildId, JSON.stringify(stats));
}

function emptyStats() {
  return { openTickets: 0, totalTickets: 0, totalTranscripts: 0 };
}

function getSession(req) {
  const cookie = req.headers.get("Cookie") || "";
  const match = cookie.match(/session=([^;]+)/);
  if (!match) return null;
  try { return JSON.parse(atob(match[1])); } catch { return null; }
}

function defaultConfig() {
  return {
    enabled: true,
    permissions: {
      dashboardAdmins: [],
      dashboardStaff: []
    },
    tickets: {
      categoryId: null,
      staffRoles: [],
      antiSpam: { enabled: true, cooldown: 300 },
      claim: { enabled: true }
    },
    automod: {
      enabled: true,
      blockLinks: true,
      blockEveryone: true,
      blockCaps: true
    },
    embed: {
      title: "🎫 Support",
      description: "Clique pour ouvrir un ticket",
      color: "#5865F2",
      image: null
    }
  };
}

function json(data) {
  return new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json" }
  });
}

function html(body) {
  return new Response(`
    <html>
      <head>
        <title>Manage Dashboard</title>
        <style>
          body{font-family:sans-serif;background:#0f0f14;color:white;padding:20px}
          .card{background:#1a1a25;padding:15px;border-radius:8px;margin-bottom:20px}
          iframe{width:100%;height:400px;border:none}
        </style>
      </head>
      <body>${body}</body>
    </html>
  `, { headers: { "Content-Type": "text/html" } });
}

function renderDashboard(guilds) {
  return `
    <h1>Manage Dashboard</h1>

    <div class="card">
      <select id="guild">
        ${guilds.map(g => `<option value="${g.id}">${g.name}</option>`).join("")}
      </select>
      <button onclick="load()">Charger</button>
    </div>

    <div class="card">
      <h2>Preview Embed</h2>
      <div id="preview"></div>
    </div>

    <div class="card">
      <h2>Stats (LIVE)</h2>
      <pre id="stats"></pre>
    </div>

    <script>
      const ws = new WebSocket("wss://" + location.host + "/ws");
      ws.onmessage = () => load();

      async function load(){
        const id = document.getElementById("guild").value;
        const cfg = await fetch("/api/config/"+id,{headers:{'x-api-key':'API_KEY'}}).then(r=>r.json());
        const stats = await fetch("/api/stats/"+id,{headers:{'x-api-key':'API_KEY'}}).then(r=>r.json());

        document.getElementById("preview").innerHTML =
          '<div style="border:2px solid '+cfg.embed.color+';padding:10px">'+
          '<h3>'+cfg.embed.title+'</h3>'+
          '<p>'+cfg.embed.description+'</p>'+
          '</div>';

        document.getElementById("stats").innerText =
          'Open: '+stats.openTickets+
          '\\nTotal: '+stats.totalTickets+
          '\\nTranscripts: '+stats.totalTranscripts;
      }
    </script>
  `;
}
