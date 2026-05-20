import express from "express";
import cors from "cors";
import crypto from "crypto";
import helmet from "helmet";
import rateLimit from "express-rate-limit";

const app = express();

// ============================
// SECURITY MIDDLEWARE
// ============================
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "10kb" }));

const globalLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100 });
app.use("/api/", globalLimiter);

// IP Guard (keep your existing implementation – omitted for brevity, but include it)
// ... (paste your ipMap logic here)

// ============================
// GAME STATE
// ============================
let gameState = {
  status: "WAITING",
  multiplier: 1,
  roundId: 1,
  crashPoint: 1,
  serverSeed: "",
  clientSeed: "",
  crashPointHash: "",
};

// ============================
// CRYPTO (Provably Fair)
// ============================
function calculateCrashPoint(serverSeed, clientSeed) {
  const hash = crypto.createHmac("sha256", serverSeed).update(clientSeed).digest("hex");
  const num = parseInt(hash.slice(0, 13), 16);
  const e = Math.pow(2, 52);
  const result = (0.99 * e) / (num + 1);
  return Math.min(28, Math.max(1, parseFloat(result.toFixed(2))));
}
function createSeed() { return crypto.randomBytes(32).toString("hex"); }
function createHash(seed, crash) { return crypto.createHash("sha256").update(`${seed}:${crash}`).digest("hex"); }
function getClientSeed() { return `CLIENT-${Date.now()}`; }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ============================
// API ENDPOINTS
// ============================
app.get("/api/game/state", (req, res) => {
  const response = {
    status: gameState.status,
    multiplier: gameState.multiplier,
    roundId: gameState.roundId,
    crashPointHash: gameState.crashPointHash,
  };

  // 🔥 CRITICAL: Server‑controlled plane progress
  if (gameState.status === "IN_GAME") {
    const denom = gameState.crashPoint - 1;
    let progress = denom > 0 ? (gameState.multiplier - 1) / denom : 0;
    progress = Math.min(1, Math.max(0, progress));
    response.progress = progress;
  } else if (gameState.status === "CRASHED") {
    response.progress = 1;
  } else {
    response.progress = 0;
  }

  if (gameState.status === "CRASHED") {
    response.crashPoint = gameState.crashPoint;
    response.serverSeed = gameState.serverSeed;
  }

  res.setHeader("Cache-Control", "no-store");
  res.json(response);
});

app.get("/api/game/verify/:roundId", (req, res) => {
  const { serverSeed, clientSeed, crashPoint } = req.query;
  if (!serverSeed || !clientSeed || !crashPoint)
    return res.status(400).json({ error: "Missing data" });
  const calculated = calculateCrashPoint(serverSeed, clientSeed);
  res.json({
    roundId: req.params.roundId,
    calculated,
    provided: parseFloat(crashPoint),
    verified: Math.abs(calculated - crashPoint) < 0.01,
  });
});

app.get("/api/health", (req, res) => {
  res.json({ status: "ok", uptime: process.uptime() });
});

// ============================
// GAME ENGINE (RELIABLE LOOP)
// ============================
async function runGameLoop() {
  console.log("🎮 GAME ENGINE STARTED");
  try {
    while (true) {
      // WAITING (4 sec)
      gameState.status = "WAITING";
      gameState.multiplier = 1;
      gameState.serverSeed = createSeed();
      gameState.clientSeed = getClientSeed();
      gameState.crashPoint = calculateCrashPoint(gameState.serverSeed, gameState.clientSeed);
      gameState.crashPointHash = createHash(gameState.serverSeed, gameState.crashPoint);
      console.log(`Round ${gameState.roundId} crash point = ${gameState.crashPoint}`);
      await sleep(4000);

      // IN_GAME (multiplier increases)
      gameState.status = "IN_GAME";
      const start = Date.now();
      while (true) {
        const t = (Date.now() - start) / 1000;
        let multiplier = parseFloat(Math.exp(0.085 * t).toFixed(2));
        if (multiplier >= gameState.crashPoint) {
          multiplier = gameState.crashPoint;
          gameState.multiplier = multiplier;
          break;
        }
        gameState.multiplier = multiplier;
        await sleep(50);
      }

      // CRASHED (3 sec)
      gameState.status = "CRASHED";
      console.log(`💥 Round ${gameState.roundId} crashed at ${gameState.crashPoint}x`);
      gameState.roundId++;
      await sleep(3000);
    }
  } catch (err) {
    console.error("GAME LOOP CRASH:", err);
    setTimeout(runGameLoop, 2000);
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  runGameLoop();
});
