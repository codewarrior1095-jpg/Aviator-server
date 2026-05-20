import express from "express";
import cors from "cors";
import crypto from "crypto";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { Server } from "socket.io";
import http from "http";

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: ["http://localhost:3000", "http://localhost:5000", "http://127.0.0.1:5500", "http://127.0.0.1:5501"],
    credentials: true
  }
});

// ========== SECURITY MIDDLEWARE (keep your existing) ==========
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "10kb" }));

const globalLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100 });
const gameStateLimiter = rateLimit({ windowMs: 1000, max: 30 });
const verifyLimiter = rateLimit({ windowMs: 60 * 1000, max: 5 });
app.use("/api/", globalLimiter);
app.use("/api/game/state", gameStateLimiter);
app.use("/api/game/verify", verifyLimiter);

// IP Guard (keep your existing ipMap logic – not repeated for brevity, but include it)
// ... (paste your ipMap code here)

// ========== GAME STATE ==========
let gameState = {
  status: "WAITING",
  multiplier: 1,
  roundId: 1,
  crashPoint: 1,
  serverSeed: "",
  clientSeed: "",
  crashPointHash: "",
};

// ========== CRYPTO (Provably Fair) ==========
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

// ========== REST API ENDPOINTS (unchanged) ==========
app.get("/api/game/state", (req, res) => {
  // This endpoint still works for backward compatibility, but frontend will use WebSocket.
  const response = {
    status: gameState.status,
    multiplier: gameState.multiplier,
    roundId: gameState.roundId,
    crashPointHash: gameState.crashPointHash,
  };
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

// ========== AUTH, BALANCE, BETTING, CASHOUT (keep your existing) ==========
// I'm assuming you already have these endpoints from previous solutions.
// If not, you must add them. For brevity, I'm not repeating full JWT auth here,
// but your existing backend should have them. Below is a minimal placeholder.
// In production, replace with your real auth/betting logic.

app.post("/api/auth/register", (req, res) => { /* your code */ });
app.post("/api/auth/login", (req, res) => { /* your code */ });
app.get("/api/user/balance", (req, res) => { /* your code */ });
app.post("/api/game/bet", (req, res) => { /* your code */ });
app.post("/api/game/cashout", (req, res) => { /* your code */ });
app.get("/api/game/history", (req, res) => { /* your code */ });

// ========== GAME ENGINE WITH SOCKET.IO EMITS ==========
async function runGameLoop() {
  console.log("🎮 GAME ENGINE STARTED (WebSocket mode)");
  try {
    while (true) {
      // ----- WAITING -----
      gameState.status = "WAITING";
      gameState.multiplier = 1;
      gameState.serverSeed = createSeed();
      gameState.clientSeed = getClientSeed();
      gameState.crashPoint = calculateCrashPoint(gameState.serverSeed, gameState.clientSeed);
      gameState.crashPointHash = createHash(gameState.serverSeed, gameState.crashPoint);
      console.log(`Round ${gameState.roundId} crash point = ${gameState.crashPoint}`);

      // Emit WAITING state
      io.emit("gameState", {
        status: "WAITING",
        multiplier: 1,
        roundId: gameState.roundId,
        crashPointHash: gameState.crashPointHash,
        progress: 0
      });

      await sleep(4000);

      // ----- IN_GAME (multiplier increases) -----
      gameState.status = "IN_GAME";
      const start = Date.now();
      let lastMultiplier = 1;
      let lastProgress = 0;

      while (true) {
        const t = (Date.now() - start) / 1000;
        let multiplier = parseFloat(Math.exp(0.085 * t).toFixed(2));
        if (multiplier >= gameState.crashPoint) {
          multiplier = gameState.crashPoint;
          gameState.multiplier = multiplier;
          // Calculate progress for final moment before crash
          const denom = gameState.crashPoint - 1;
          let progress = denom > 0 ? (multiplier - 1) / denom : 1;
          progress = Math.min(1, Math.max(0, progress));
          io.emit("multiplierUpdate", {
            multiplier: multiplier,
            progress: progress,
            roundId: gameState.roundId
          });
          break;
        }
        gameState.multiplier = multiplier;
        const denom = gameState.crashPoint - 1;
        let progress = denom > 0 ? (multiplier - 1) / denom : 0;
        progress = Math.min(1, Math.max(0, progress));
        // Only emit if changed to reduce traffic (optional)
        if (multiplier !== lastMultiplier || progress !== lastProgress) {
          io.emit("multiplierUpdate", {
            multiplier: multiplier,
            progress: progress,
            roundId: gameState.roundId
          });
          lastMultiplier = multiplier;
          lastProgress = progress;
        }
        await sleep(50); // 20 updates per second
      }

      // ----- CRASHED -----
      gameState.status = "CRASHED";
      console.log(`💥 Round ${gameState.roundId} crashed at ${gameState.crashPoint}x`);

      io.emit("gameCrashed", {
        crashPoint: gameState.crashPoint,
        roundId: gameState.roundId,
        serverSeed: gameState.serverSeed,
        clientSeed: gameState.clientSeed,
        progress: 1
      });

      gameState.roundId++;
      await sleep(3000);
    }
  } catch (err) {
    console.error("GAME LOOP CRASH:", err);
    setTimeout(runGameLoop, 2000);
  }
}

// Socket.IO connection handler
io.on("connection", (socket) => {
  console.log("Client connected via WebSocket:", socket.id);
  // Send current game state immediately
  const denom = gameState.crashPoint - 1;
  let progress = 0;
  if (gameState.status === "IN_GAME") {
    progress = denom > 0 ? (gameState.multiplier - 1) / denom : 0;
    progress = Math.min(1, Math.max(0, progress));
  } else if (gameState.status === "CRASHED") {
    progress = 1;
  }
  socket.emit("gameState", {
    status: gameState.status,
    multiplier: gameState.multiplier,
    roundId: gameState.roundId,
    crashPointHash: gameState.crashPointHash,
    progress: progress,
    crashPoint: gameState.status === "CRASHED" ? gameState.crashPoint : undefined
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT} (WebSocket ready)`);
  runGameLoop();
});
