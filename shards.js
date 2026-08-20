import { ShardingManager } from "discord.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/* =========================================================
   1. SHARDING MANAGER
========================================================= */
const manager = new ShardingManager(path.join(__dirname, "index.js"), {
  token: process.env.DISCORD_TOKEN,
  totalShards: "auto",
});

manager.on("shardCreate", (shard) => {
  console.log(`[Sharding] 🚀 Successfully launched Shard #${shard.id}`);
});

manager.spawn().catch((error) => {
  console.error("[Sharding] ❌ Failed to spawn shards:", error);
});

/* =========================================================
   2. HEALTH SERVER
========================================================= */
const app = express();
const PORT = process.env.PORT || 3000;
const startTime = Date.now();

app.get("/health", async (req, res) => {
  try {
    const serverCounts = await manager.broadcastEval(
      (client) => client.guilds.cache.size
    );

    const servers = serverCounts.reduce(
      (total, count) => total + count,
      0
    );

    res.json({
      status: "online",
      message: "Bozos TTS Shard Manager is running",
      uptime: Math.floor((Date.now() - startTime) / 1000),
      servers,
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

app.listen(PORT, () => {
  console.log(`[Health Server] Running on port ${PORT}`);
});
