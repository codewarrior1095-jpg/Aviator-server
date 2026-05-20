import express from "express";
import cors from "cors";
import crypto from "crypto";
import { Server } from "socket.io";
import http from "http";

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(cors());
app.use(express.json());

// ------------------------------
// Simple in‑memory user store
// ------------------------------
const users = new Map(); // userId -> { id, username, balance }
let nextUserId = 1;

// Helper: create a user with starting balance
function createUser(username) {
  const id = (nextUserId++).toString();
  const user = { id, username, balance: 5000 };
  users.set(id, user);
  return user;
}

// Pre‑create a demo user so we don't need login for testing
const demoUser = createUser("player1");
console.log(`Demo user: id=${demoUser.id}, balance=${demoUser.balance}`);

// ------------------------------
// Game state
// ------------------------------
let gameState = {
  status: "WAITING", // WAITING, IN_GAME, CRASHED
  multiplier: 1.0,
  roundId: 1,
  crashPoint: 1.0,
  serverSeed: "",
  clientSeed: "",
};

// ------------------------------
// Provably fair crash point
// ------------------------------
function getCrashPointFromHash(hash) {
  const num = parseInt(hash.slice(0, 13), 16);
  const e = Math.pow(2, 52);
  const result = (0.99 * e) / (num + 1);
  return Math.min(28, Math.max(1, parseFloat(result.toFixed(2))));
}

function generateCrashPoint() {
  const serverSeed = crypto.randomBytes(32).toString("hex");
  const clientSeed = `client-${Date.now()}`;
  const hash = crypto.createHmac("sha256", serverSeed).update(clientSeed).digest("hex");
  const crashPoint = getCrashPointFromHash(hash);
  return { serverSeed, clientSeed, crashPoint, hash };
}

// ------------------------------
// Bets storage (in‑memory)
// ------------------------------
let activeBets = []; // for current round: { userId, betId, amount }
let allBets = [];    // history
let roundHistory = [];

// ------------------------------
// API Endpoints (REST)
// ------------------------------

// Get user balance
app.get("/api/user/balance", (req, res) => {
  // For demo, always return demo user balance
  res.json({ balance: demoUser.balance });
});

// Place a bet
app.post("/api/game/bet", (req, res) => {
  const { amount } = req.body;
  if (gameState.status !== "WAITING") {
    return res.status(400).json({ error: "Can only bet before round starts" });
  }
  if (amount <= 0 || amount > demoUser.balance) {
    return res.status(400).json({ error: "Invalid amount or insufficient balance" });
  }
  demoUser.balance -= amount;
  const betId = crypto.randomBytes(8).toString("hex");
  activeBets.push({
    betId,
    userId: demoUser.id,
    username: demoUser.username,
    amount,
    cashedOut: false,
    cashedOutAt: null,
    winAmount: null,
  });
  res.json({ betId, newBalance: demoUser.balance });
});

// Cash out
app.post("/api/game/cashout", (req, res) => {
  const { betId } = req.body;
  const bet = activeBets.find(b => b.betId === betId);
  if (!bet) return res.status(404).json({ error: "Bet not found" });
  if (bet.cashedOut) return res.status(400).json({ error: "Already cashed out" });
  if (gameState.status !== "IN_GAME") {
    return res.status(400).json({ error: "Cannot cash out now" });
  }
  const winAmount = bet.amount * gameState.multiplier;
  bet.cashedOut = true;
  bet.cashedOutAt = Date.now();
  bet.winAmount = winAmount;
  demoUser.balance += winAmount;
  res.json({ winAmount, newBalance: demoUser.balance });
});

// Game history
app.get("/api/game/history", (req, res) => {
  res.json(roundHistory.slice(-20));
});

// Health check
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", round: gameState.roundId });
});

// ------------------------------
// Game Loop with WebSocket emits
// ------------------------------
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function runGame() {
  console.log("🎮 Game engine started (WebSocket mode)");
  while (true) {
    // ----- WAITING (4 sec) -----
    gameState.status = "WAITING";
    gameState.multiplier = 1.0;
    // Generate new crash point for this round
    const { serverSeed, clientSeed, crashPoint, hash } = generateCrashPoint();
    gameState.crashPoint = crashPoint;
    gameState.serverSeed = serverSeed;
    gameState.clientSeed = clientSeed;
    gameState.crashPointHash = hash;
    console.log(`Round ${gameState.roundId} crash point = ${crashPoint}x`);

    io.emit("gameState", {
      status: "WAITING",
      roundId: gameState.roundId,
      crashPointHash: hash,
      progress: 0,
    });
    await sleep(4000);

    // ----- IN_GAME (multiplier increases) -----
    gameState.status = "IN_GAME";
    const start = Date.now();
    activeBets = []; // clear previous round's active bets
    let lastProgress = -1;
    let lastMultiplier = -1;

    while (true) {
      const elapsed = (Date.now() - start) / 1000;
      let multiplier = parseFloat(Math.exp(0.085 * elapsed).toFixed(2));
      if (multiplier >= gameState.crashPoint) {
        multiplier = gameState.crashPoint;
        gameState.multiplier = multiplier;
        const progress = 1.0; // fully crashed
        io.emit("multiplierUpdate", { multiplier, progress, roundId: gameState.roundId });
        break;
      }
      gameState.multiplier = multiplier;
      // progress = (multiplier - 1) / (crashPoint - 1) , but capped
      let progress = (multiplier - 1) / (gameState.crashPoint - 1);
      progress = Math.min(1, Math.max(0, progress));
      if (progress !== lastProgress || multiplier !== lastMultiplier) {
        io.emit("multiplierUpdate", { multiplier, progress, roundId: gameState.roundId });
        lastProgress = progress;
        lastMultiplier = multiplier;
      }
      await sleep(50);
    }

    // ----- CRASHED -----
    gameState.status = "CRASHED";
    console.log(`💥 Round ${gameState.roundId} crashed at ${gameState.crashPoint}x`);
    // For any uncashed bet, they lose (no refund)
    for (let bet of activeBets) {
      if (!bet.cashedOut) {
        bet.winAmount = 0;
        allBets.push(bet);
      } else {
        allBets.push(bet);
      }
    }
    roundHistory.unshift({
      roundId: gameState.roundId,
      crashPoint: gameState.crashPoint,
      timestamp: Date.now(),
      serverSeed: gameState.serverSeed,
      clientSeed: gameState.clientSeed,
    });
    io.emit("gameCrashed", {
      crashPoint: gameState.crashPoint,
      roundId: gameState.roundId,
      progress: 1,
      serverSeed: gameState.serverSeed,
      clientSeed: gameState.clientSeed,
    });
    gameState.roundId++;
    await sleep(3000);
  }
}

// Socket.IO connection handler
io.on("connection", (socket) => {
  console.log("Client connected");
  // Send current game state immediately
  let progress = 0;
  if (gameState.status === "IN_GAME") {
    progress = (gameState.multiplier - 1) / (gameState.crashPoint - 1);
    progress = Math.min(1, Math.max(0, progress));
  } else if (gameState.status === "CRASHED") {
    progress = 1;
  }
  socket.emit("gameState", {
    status: gameState.status,
    multiplier: gameState.multiplier,
    roundId: gameState.roundId,
    crashPointHash: gameState.crashPointHash,
    progress,
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  runGame();
});
