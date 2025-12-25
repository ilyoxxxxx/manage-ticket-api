export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const method = req.method;

    /* ================= SECURITY ================= */
    const apiKey = req.headers.get("x-api-key");
    if (apiKey !== env.API_KEY) {
      return new Response("Unauthorized", { status: 401 });
    }

    /* ================= WEBSOCKET ================= */
    if (url.pathname === "/ws" && req.headers.get("Upgrade") === "websocket") {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);

      server.accept();
      env.SOCKETS.add(server);

      server.addEventListener("close", () => {
        env.SOCKETS.delete(server);
      });

      return new Response(null, {
        status: 101,
        webSocket: client
      });
    }

    /* ================= GET CONFIG ================= */
    if (method === "GET" && url.pathname.startsWith("/ticket/")) {
      const guildId = url.pathname.split("/")[2];
      const data = await env.TICKETS.get(guildId);
      return json(data ? JSON.parse(data) : {});
    }

    /* ================= SAVE CONFIG ================= */
    if (method === "POST" && url.pathname === "/ticket") {
      const body = await req.json();
      const { guildId, config } = body;

      if (!guildId || !config) {
        return json({ error: "Missing guildId or config" }, 400);
      }

      await env.TICKETS.put(guildId, JSON.stringify(config));
      broadcast(env, {
        type: "config:update",
        guildId,
        config
      });

      return json({ success: true });
    }

    /* ================= LOG TICKET EVENT ================= */
    if (method === "POST" && url.pathname === "/ticket/event") {
      const event = await req.json();

      broadcast(env, {
        type: "ticket:event",
        event
      });

      return json({ success: true });
    }

    /* ================= SAVE TRANSCRIPT ================= */
    if (method === "POST" && url.pathname === "/ticket/transcript") {
      const { ticketId, html } = await req.json();

      if (!ticketId || !html) {
        return json({ error: "Missing transcript data" }, 400);
      }

      await env.TRANSCRIPTS.put(ticketId, html);
      return json({ success: true });
    }

    return new Response("Not found", { status: 404 });
  }
};

/* ================= HELPERS ================= */

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

function broadcast(env, payload) {
  const msg = JSON.stringify(payload);
  for (const ws of env.SOCKETS) {
    try {
      ws.send(msg);
    } catch {}
  }
}
