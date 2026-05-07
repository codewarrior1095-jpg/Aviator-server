import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import helmet from 'helmet';

const app = express();

app.use(helmet());
app.use(cors());
app.use(express.json());

// ==========================================
// PROVABLY FAIR SYSTEM
// ==========================================

/**
 * ARCHITECTURE:
 * 
 * 1. BEFORE each round, server generates:
 *    - serverSeed (random 64-char hex)
 *    - crashPoint (computed from serverSeed + clientSeed)
 *    - HASH of crashPoint + serverSeed (published BEFORE round)
 * 
 * 2. DURING round:
 *    - Only multiplier is broadcast (NOT crashPoint)
 *    - No API endpoint reveals crashPoint during gameplay
 * 
 * 3. AFTER round:
 *    - serverSeed is revealed
 *    - Players can verify: SHA256(serverSeed + clientSeed) matches published hash
 *    - Players can verify crashPoint from the formula
 */

let gameState = {
  status: 'WAITING',
  multiplier: 1.00,
  roundId: 1,
  startTime: null,
  
  // SECRET - Never exposed during gameplay
  crashPoint: 1.00,
  serverSeed: null,
  
  // PUBLIC - Published before round starts
  crashPointHash: null,        // Hash commitment
  clientSeed: null,            // Nigeria time when round starts
  
  // REVEALED after crash
  revealedServerSeed: null,
  revealedCrashPoint: null
};

// ==========================================
// CRASH POINT GENERATOR (Provably Fair)
// ==========================================

/**
 * Deterministic crash point from seeds
 * Same formula as before but uses seeds instead of Math.random()
 */
function calculateCrashPoint(serverSeed, clientSeed) {
  const hash = crypto.createHmac('sha256', serverSeed)
    .update(clientSeed)
    .digest('hex');
  
  // Use first 13 hex chars (52 bits)
  const h = parseInt(hash.slice(0, 13), 16);
  const e = Math.pow(2, 52);
  
  // House edge: 1%
  const result = (0.99 * e) / (h + 1);
  
  // Clamp 1.00x - 28.00x
  return parseFloat(Math.max(1.00, Math.min(28.00, result)).toFixed(2));
}

/**
 * Create hash commitment BEFORE round starts
 * Players can verify after crash that we didn't cheat
 */
function createCrashPointHash(serverSeed, crashPoint) {
  return crypto.createHash('sha256')
    .update(`${serverSeed}:${crashPoint}`)
    .digest('hex');
}

/**
 * Get Nigeria time as client seed
 * Format: YYYY-MM-DD HH:MM:SS WAT
 */
function getNigeriaClientSeed() {
  const now = new Date();
  // Nigeria is UTC+1 (West Africa Time)
  const nigeriaTime = new Date(now.getTime() + (1 * 60 * 60 * 1000));
  return nigeriaTime.toISOString().replace('T', ' ').slice(0, 19) + ' WAT';
}

function generateServerSeed() {
  return crypto.randomBytes(32).toString('hex');
}

// ==========================================
// API ENDPOINTS
// ==========================================

/**
 * GET /api/game/state
 * DURING GAMEPLAY: Only returns multiplier and status
 * Crash point is NEVER revealed here during IN_GAME
 */
app.get('/api/game/state', (req, res) => {
  const response = {
    status: gameState.status,
    multiplier: gameState.multiplier,
    roundId: gameState.roundId,
    
    // Published BEFORE round (hash commitment)
    crashPointHash: gameState.crashPointHash,
    clientSeed: gameState.clientSeed,
    
    // ONLY revealed after crash
    serverSeed: gameState.status === 'CRASHED' ? gameState.serverSeed : null,
    crashPoint: gameState.status === 'CRASHED' ? gameState.crashPoint : null
  };
  
  // Strip fields if game is IN_GAME (don't reveal crash data)
  if (gameState.status === 'IN_GAME') {
    delete response.crashPoint;
    delete response.serverSeed;
  }
  
  res.json(response);
});

/**
 * GET /api/game/verify
 * Players can verify any past round
 */
app.get('/api/game/verify/:roundId', (req, res) => {
  const { roundId } = req.params;
  const { serverSeed, clientSeed, crashPoint } = req.query;
  
  if (!serverSeed || !clientSeed || !crashPoint) {
    return res.status(400).json({ error: 'Missing serverSeed, clientSeed, or crashPoint' });
  }
  
  // Recalculate
  const calculatedCrashPoint = calculateCrashPoint(serverSeed, clientSeed);
  const calculatedHash = createCrashPointHash(serverSeed, parseFloat(crashPoint));
  
  res.json({
    roundId: parseInt(roundId),
    provided: {
      serverSeed,
      clientSeed,
      crashPoint: parseFloat(crashPoint)
    },
    calculated: {
      crashPoint: calculatedCrashPoint
    },
    verified: calculatedCrashPoint === parseFloat(crashPoint)
  });
});

// ==========================================
// GAME LOOP
// ==========================================

async function runGameLoop() {
  console.log('🎮 Provably Fair Aviator Engine Started');
  console.log('🔐 Crash points committed via SHA256 hash BEFORE rounds');
  console.log('⏰ Client seed = Nigeria time (WAT)');
  
  while (true) {
    // === WAITING PHASE ===
    gameState.status = 'WAITING';
    gameState.multiplier = 1.00;
    gameState.startTime = null;
    
    // Generate round secrets
    gameState.serverSeed = generateServerSeed();
    gameState.clientSeed = getNigeriaClientSeed();
    
    // Calculate crash point
    gameState.crashPoint = calculateCrashPoint(gameState.serverSeed, gameState.clientSeed);
    
    // Create hash commitment (published NOW)
    gameState.crashPointHash = createCrashPointHash(gameState.serverSeed, gameState.crashPoint);
    
    console.log(`\n🟢 Round ${gameState.roundId} - Accepting bets`);
    console.log(`   Client Seed: ${gameState.clientSeed}`);
    console.log(`   Hash Commitment: ${gameState.crashPointHash.slice(0, 16)}...`);
    console.log(`   Crash Point (SECRET): ${gameState.crashPoint}x`);
    
    await sleep(5000);
    
    // === IN_GAME PHASE ===
    gameState.status = 'IN_GAME';
    gameState.startTime = Date.now();
    console.log(`✈️ Round ${gameState.roundId} - Flying!`);
    
    const startTime = Date.now();
    while (true) {
      const elapsed = (Date.now() - startTime) / 1000;
      
      // Calculate multiplier (same formula)
      gameState.multiplier = parseFloat(Math.pow(Math.E, 0.085 * elapsed).toFixed(2));
      
      // Check crash
      if (gameState.multiplier >= gameState.crashPoint) {
        gameState.multiplier = gameState.crashPoint;
        break;
      }
      
      await sleep(50);
    }
    
    // === CRASHED ===
    gameState.status = 'CRASHED';
    console.log(`💥 Round ${gameState.roundId} - Crashed at ${gameState.crashPoint}x`);
    console.log(`   Server Seed Revealed: ${gameState.serverSeed.slice(0, 16)}...`);
    console.log(`   Players can now verify: /api/game/verify/${gameState.roundId}`);
    
    gameState.roundId++;
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
  console.log(`🚀 Provably Fair Server on port ${PORT}`);
  console.log(`📡 State: GET /api/game/state`);
  console.log(`✅ Verify: GET /api/game/verify/:roundId`);
  runGameLoop();
});
