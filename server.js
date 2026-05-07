import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import helmet from 'helmet';

const app = express();

// Security hardening
app.use(helmet());
app.use(cors());
app.use(express.json());

// ==========================================
// PROVABLY FAIR SYSTEM - HARDENED
// ==========================================

/**
 * 🔒 SECURITY ARCHITECTURE:
 * 
 * 1. Crash point generated ONCE before round
 * 2. Hash commitment published (can't be faked)
 * 3. During gameplay: ONLY multiplier broadcast
 * 4. Server internally decides when to crash
 * 5. Crash point NEVER leaves server during IN_GAME
 * 6. After crash: seeds revealed for verification
 */

let gameState = {
  status: 'WAITING',        // WAITING | IN_GAME | CRASHED
  multiplier: 1.00,
  roundId: 1,
  startTime: null,
  
  // 🔒 SECRET - Never exposed during gameplay
  crashPoint: 1.00,
  serverSeed: null,
  
  // 📋 PUBLIC - Published before round
  crashPointHash: null,
  clientSeed: null,
};

// ==========================================
// CRASH POINT GENERATOR (Provably Fair)
// ==========================================

function calculateCrashPoint(serverSeed, clientSeed) {
  const hash = crypto.createHmac('sha256', serverSeed)
    .update(clientSeed)
    .digest('hex');
  
  const h = parseInt(hash.slice(0, 13), 16);
  const e = Math.pow(2, 52);
  const result = (0.99 * e) / (h + 1);
  
  return parseFloat(Math.max(1.00, Math.min(28.00, result)).toFixed(2));
}

function createCrashPointHash(serverSeed, crashPoint) {
  return crypto.createHash('sha256')
    .update(`${serverSeed}:${crashPoint}`)
    .digest('hex');
}

function getNigeriaClientSeed() {
  const now = new Date();
  const nigeriaTime = new Date(now.getTime() + (1 * 60 * 60 * 1000));
  return nigeriaTime.toISOString().replace('T', ' ').slice(0, 19) + ' WAT';
}

function generateServerSeed() {
  return crypto.randomBytes(32).toString('hex');
}

// ==========================================
// 🔒 HARDENED API ENDPOINT
// Crash point REMOVED from public response
// ==========================================
app.get('/api/game/state', (req, res) => {
  
  // 🛡️ BASE RESPONSE - Safe for all states
  const response = {
    status: gameState.status,
    multiplier: gameState.multiplier,
    roundId: gameState.roundId,
    
    // Provably fair (public commitments)
    crashPointHash: gameState.crashPointHash,
    clientSeed: gameState.clientSeed,
  };
  
  // 🔒 ONLY reveal crash data AFTER round ends
  if (gameState.status === 'CRASHED') {
    response.serverSeed = gameState.serverSeed;
    response.crashPoint = gameState.crashPoint;
  }
  
  // ❌ During WAITING and IN_GAME:
  // crashPoint and serverSeed are COMPLETELY ABSENT
  // Not null, not undefined - GONE from the response
  
  res.json(response);
});

/**
 * ✅ Verification endpoint (for past rounds only)
 */
app.get('/api/game/verify/:roundId', (req, res) => {
  const { roundId } = req.params;
  const { serverSeed, clientSeed, crashPoint } = req.query;
  
  if (!serverSeed || !clientSeed || !crashPoint) {
    return res.status(400).json({ error: 'Missing verification parameters' });
  }
  
  const calculatedCrashPoint = calculateCrashPoint(serverSeed, clientSeed);
  const calculatedHash = createCrashPointHash(serverSeed, parseFloat(crashPoint));
  
  res.json({
    roundId: parseInt(roundId),
    provided: { serverSeed, clientSeed, crashPoint: parseFloat(crashPoint) },
    calculated: { crashPoint: calculatedCrashPoint },
    verified: calculatedCrashPoint === parseFloat(crashPoint)
  });
});

// ==========================================
// GAME LOOP - Server controls everything
// ==========================================

async function runGameLoop() {
  console.log('🛡️ HARDENED Provably Fair Engine Started');
  console.log('🔒 Crash point NEVER broadcast during gameplay');
  
  while (true) {
    // === WAITING PHASE (5 seconds) ===
    gameState.status = 'WAITING';
    gameState.multiplier = 1.00;
    gameState.startTime = null;
    
    // Generate round secrets
    gameState.serverSeed = generateServerSeed();
    gameState.clientSeed = getNigeriaClientSeed();
    gameState.crashPoint = calculateCrashPoint(gameState.serverSeed, gameState.clientSeed);
    gameState.crashPointHash = createCrashPointHash(gameState.serverSeed, gameState.crashPoint);
    
    console.log(`\n🟢 Round ${gameState.roundId}`);
    console.log(`   Client Seed: ${gameState.clientSeed}`);
    console.log(`   Hash: ${gameState.crashPointHash.slice(0, 16)}...`);
    console.log(`   Crash (SECRET): ${gameState.crashPoint}x`);
    
    await sleep(5000);
    
    // === IN_GAME PHASE ===
    gameState.status = 'IN_GAME';
    gameState.startTime = Date.now();
    console.log(`✈️ Flying - Crash point HIDDEN from API`);
    
    const startTime = Date.now();
    while (true) {
      const elapsed = (Date.now() - startTime) / 1000;
      gameState.multiplier = parseFloat(Math.pow(Math.E, 0.085 * elapsed).toFixed(2));
      
      // Server internally checks crash
      if (gameState.multiplier >= gameState.crashPoint) {
        gameState.multiplier = gameState.crashPoint;
        break;
      }
      
      await sleep(50);
    }
    
    // === CRASHED ===
    gameState.status = 'CRASHED';
    console.log(`💥 Crashed at ${gameState.crashPoint}x - Seeds now public`);
    
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
  console.log('🔒 HARDENED SERVER RUNNING');
  console.log(`📡 Port: ${PORT}`);
  console.log('🛡️ Crash point: INTERNAL ONLY');
  console.log('✅ Verification: /api/game/verify/:roundId');
  runGameLoop();
});
