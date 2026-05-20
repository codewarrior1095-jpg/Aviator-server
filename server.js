import express from "express";
import cors from "cors";
import crypto from "crypto";
import helmet from "helmet";
import rateLimit from "express-rate-limit";

const app = express();

/* =========================
   SECURITY MIDDLEWARE
========================= */
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(cors({
  origin: ["http://localhost:3000", "http://localhost:5000", "http://127.0.0.1:5500", "http://127.0.0.1:5501"],
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));
app.use(express.json({ limit: "10kb" }));

/* =========================
   RATE LIMITING
========================= */
const globalLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100 });
const gameStateLimiter = rateLimit({ windowMs: 1000, max: 30 });
const verifyLimiter = rateLimit({ windowMs: 60 * 1000, max: 5 });
app.use("/api/", globalLimiter);
app.use("/api/game/state", gameStateLimiter);
app.use("/api/game/verify", verifyLimiter);

/* =========================
   IP GUARD
========================= */
const ipMap = new Map();
function getIP(req) {
  return req.headers["x-forwarded-for"]?.split(",")[0] || req.socket.remoteAddress || "unknown";
}
app.use((req, res, next) => {
  const ip = getIP(req);
  const now = Date.now();
  if (!ipMap.has(ip)) ipMap.set(ip, { count: 1, start: now, blockedUntil: 0 });
  const data = ipMap.get(ip);
  if (data.blockedUntil > now) return res.status(403).json({ error: "Blocked temporarily" });
  data.count++;
  if (now - data.start > 10000) { data.count = 1; data.start = now; }
  if (data.count > 80) {
    data.blockedUntil = now + 5 * 60 * 1000;
    console.log(`BLOCKED IP: ${ip}`);
    return res.status(403).json({ error: "Too many requests" });
  }
  next();
});

/* =========================
   GAME STATE
========================= */
let gameState = {
  status: "WAITING",
  multiplier: 1,
  roundId: 1,
  crashPoint: 1,
  serverSeed: "",
  clientSeed: "",
  crashPointHash: "",
};

/* =========================
   CRYPTO LOGIC
========================= */
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

/* =========================
   API ENDPOINTS
========================= */
app.get("/api/game/state", (req, res) => {
  const response = {
    status: gameState.status,
    multiplier: gameState.multiplier,
    roundId: gameState.roundId,
    crashPointHash: gameState.crashPointHash,
  };

  // 🔥 CRITICAL: Server-controlled plane progress
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
  if (!serverSeed || !clientSeed || !crashPoint) return res.status(400).json({ error: "Missing data" });
  const calculated = calculateCrashPoint(serverSeed, clientSeed);
  res.json({
    roundId: req.params.roundId,
    calculated,
    provided: parseFloat(crashPoint),
    verified: Math.abs(calculated - crashPoint) < 0.01,
  });
});

app.get("/api/health", (req, res) => {
  res.json({ status: "ok", uptime: process.uptime(), time: Date.now() });
});

/* =========================
   GAME ENGINE
========================= */
async function runGameLoop() {
  console.log("GAME ENGINE STARTED");
  try {
    while (true) {
      gameState.status = "WAITING";
      gameState.multiplier = 1;
      gameState.serverSeed = createSeed();
      gameState.clientSeed = getClientSeed();
      gameState.crashPoint = calculateCrashPoint(gameState.serverSeed, gameState.clientSeed);
      gameState.crashPointHash = createHash(gameState.serverSeed, gameState.crashPoint);
      await sleep(4000);

      gameState.status = "IN_GAME";
      const start = Date.now();
      while (true) {
        const t = (Date.now() - start) / 1000;
        gameState.multiplier = parseFloat(Math.exp(0.085 * t).toFixed(2));
        if (gameState.multiplier >= gameState.crashPoint) {
          gameState.multiplier = gameState.crashPoint;
          break;
        }
        await sleep(50);
      }

      gameState.status = "CRASHED";
      console.log(`Round ${gameState.roundId} crashed at ${gameState.crashPoint}`);
      gameState.roundId++;
      await sleep(3000);
    }
  } catch (err) {
    console.error("GAME LOOP CRASH:", err);
    setTimeout(runGameLoop, 2000);
  }
}

/* =========================
   START SERVER
========================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`SERVER RUNNING ON PORT ${PORT}`);
  runGameLoop();
});
