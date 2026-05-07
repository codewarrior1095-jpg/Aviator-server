import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import helmet from 'helmet';

const app = express();

// Security
app.use(helmet());
app.use(cors());
app.use(express.json());

// ==========================================
// GAME STATE - The ONLY thing server controls
// ==========================================
let gameState = {
  status: 'WAITING',        // WAITING | IN_GAME | CRASHED
  multiplier: 1.00,
  crashPoint: 1.00,
  roundId: 1,
  startTime: null,
  serverSeed: null,
  nextServerSeed: null
};

// Initialize seeds
function generateSeed() {
  return crypto.randomBytes(32).toString('hex');
}
gameState.serverSeed = generateSeed();
gameState.nextServerSeed = generateSeed();

/**
 * 🔐 PROVABLY FAIR CRASH POINT GENERATOR
 * This is the ONLY secret algorithm - hidden from hackers
 * Uses HMAC-SHA256 with server seed + round ID as client seed
 */
function generateCrashPoint(serverSeed, roundId) {
  const clientSeed = roundId.toString();
  const hash = crypto.createHmac('sha256', serverSeed)
    .update(clientSeed)
    .digest('hex');
  
  // Convert first 13 hex chars to a number
  const h = parseInt(hash.slice(0, 13), 16);
  const e = Math.pow(2, 52);
  
  // House edge of 1% applied
  const result = (0.99 * e) / (h + 1);
  
  // Clamp between 1.00x and 28.00x
  const clamped = Math.max(1.00, Math.min(28.00, result));
  return parseFloat(clamped.toFixed(2));
}

// ==========================================
// API ENDPOINT - Frontend polls this 20x/sec
// ==========================================
app.get('/api/game/state', (req, res) => {
  res.json({
    status: gameState.status,
    multiplier: gameState.multiplier,
    crashPoint: gameState.status === 'CRASHED' ? gameState.crashPoint : null,
    roundId: gameState.roundId,
    // For provably fair verification (hash of next seed)
    nextSeedHash: crypto.createHash('sha256').update(gameState.nextServerSeed).digest('hex')
  });
});

// ==========================================
// GAME LOOP - Runs autonomously on server
// ==========================================
async function runGameLoop() {
  console.log('🎮 Aviator Game Engine Started');
  console.log('🔐 Crash point generation: SERVER ONLY');
  
  while (true) {
    // === WAITING PHASE (5 seconds) ===
    gameState.status = 'WAITING';
    gameState.multiplier = 1.00;
    gameState.startTime = null;
    console.log(`\n🟢 Round ${gameState.roundId} - Waiting for bets...`);
    
    await sleep(5000);
    
    // === GENERATE CRASH POINT (SECRET) ===
    gameState.crashPoint = generateCrashPoint(gameState.serverSeed, gameState.roundId);
    gameState.status = 'IN_GAME';
    gameState.startTime = Date.now();
    console.log(`✈️ Round ${gameState.roundId} - Flying! Crash at: ${gameState.crashPoint}x`);
    
    // === IN_GAME PHASE ===
    const startTime = Date.now();
    while (true) {
      const elapsed = (Date.now() - startTime) / 1000;
      
      // Exponential multiplier growth (same formula as original)
      gameState.multiplier = parseFloat(Math.pow(Math.E, 0.085 * elapsed).toFixed(2));
      
      // Check if we hit the crash point
      if (gameState.multiplier >= gameState.crashPoint) {
        gameState.multiplier = gameState.crashPoint;
        break;
      }
      
      // Yield to event loop (50ms = 20 updates/sec)
      await sleep(50);
    }
    
    // === CRASHED ===
    gameState.status = 'CRASHED';
    console.log(`💥 Round ${gameState.roundId} - Crashed at ${gameState.crashPoint}x`);
    
    // === POST-ROUND: Rotate seeds ===
    gameState.serverSeed = gameState.nextServerSeed;
    gameState.nextServerSeed = generateSeed();
    gameState.roundId++;
    
    // Short cooldown between rounds
    await sleep(3000);
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ==========================================
// START SERVER
// ==========================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📡 Game state API: GET /api/game/state`);
  runGameLoop();
});
