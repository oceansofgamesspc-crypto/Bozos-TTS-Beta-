import { ShardingManager } from "discord.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { buildHolographicBetaEntry } from "./holographicBetaBuild.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/* =========================================================
   1. SHARDING MANAGER
========================================================= */
const holographicBetaEntry = path.join(__dirname, ".holographic-beta-index.generated.js");

try {
  buildHolographicBetaEntry(
    path.join(__dirname, "index.js"),
    holographicBetaEntry
  );
} catch (error) {
  console.error("[Holographic Beta] Failed to build the shard entry:", error);
  process.exit(1);
}

const manager = new ShardingManager(holographicBetaEntry, {
  token: process.env.DISCORD_TOKEN,
  totalShards: "auto",
});

manager.on("shardCreate", (shard) => {
  console.log(`[Sharding] 🚀 Successfully launched Shard #${shard.id}`);
});

manager.spawn().catch((error) => {
  console.error("[Sharding] ❌ Failed to spawn shards:", error);
});

let isShuttingDown = false;

/* =========================================================
   2. HEALTH SERVER
========================================================= */
const app = express();
const PORT = process.env.PORT || 3000;
const startTime = Date.now();

app.get("/health", async (req, res) => {
  try {
    const shardStats = await manager.broadcastEval((client) => ({
      servers: client.guilds.cache.size,
      latency: client.bozoMetrics || null,
    }));

    const servers = shardStats.reduce((total, item) => total + item.servers, 0);
    const latencyStats = shardStats.map((item) => item.latency).filter(Boolean);
    const playbackLatency = latencyStats.length
      ? {
          p50Ms: Math.round(latencyStats.reduce((sum, item) => sum + (item.playbackLatencyP50Ms || 0), 0) / latencyStats.length),
          p95Ms: Math.max(...latencyStats.map((item) => item.playbackLatencyP95Ms || 0)),
          lastMs: Math.max(...latencyStats.map((item) => item.playbackLatencyLastMs || 0)),
        }
      : null;

    res.json({
      status: "online",
      message: "Bozos TTS Shard Manager is running",
      uptime: Math.floor((Date.now() - startTime) / 1000),
      servers,
      playbackLatency,
    });
  } catch (error) {
    console.error("[Health] Failed to get server count:", error);

    res.status(500).json({
      status: "error",
      message: "Unable to get server count",
      uptime: Math.floor((Date.now() - startTime) / 1000),
    });
  }
});

const server = app.listen(PORT, () => {
  console.log(`[Health Server] Running on port ${PORT}`);
});

async function gracefulManagerShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`[Sharding] Graceful shutdown started (${signal}).`);

  server.close();
  for (const shard of manager.shards.values()) {
    try { shard.send({ type: "graceful-shutdown" }); } catch {}
  }

  // Allow shards time to destroy voice connections before Railway terminates us.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  process.exit(0);
}

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.once(signal, () => void gracefulManagerShutdown(signal));
}
