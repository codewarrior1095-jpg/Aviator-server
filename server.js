import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';

const app = express();

// ==========================================
// 🛡️ LAYER 1: Express Security Middleware
// ==========================================
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));

// Strict CORS - only allow your frontend domains
app.use(cors({
  origin: [
    'http://localhost:3000',
    'http://localhost:5000',
    'https://your-frontend-domain.com', // Replace with your actual domain
    'http://127.0.0.1:5500',
    'http://127.0.0.1:5501'
  ],
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  maxAge: 600
}));

app.use(express.json({ limit: '10kb' })); // Prevent payload attacks

// ==========================================
// 🛡️ LAYER 2: SERVER-SIDE RATE LIMITING
// Hacker CANNOT bypass this
// ==========================================

// Global rate limit: 100 requests per 15 minutes per IP
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, slow down' },
  keyGenerator: (req) => {
    return req.ip || req.headers['x-forwarded-for'] || 'unknown';
  }
});

// Strict rate limit on game state: 30 requests per second per IP
const gameStateLimiter = rateLimit({
  windowMs: 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Polling too fast' },
  keyGenerator: (req) => {
    return req.ip || req.headers['x-forwarded-for'] || 'unknown';
  }
});

// Verification endpoint: 5 requests per minute per IP
const verifyLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many verification attempts' },
  keyGenerator: (req) => {
    return req.ip || req.headers['x-forwarded-for'] || 'unknown';
  }
});

// Apply rate limiters
app.use('/api/', globalLimiter);
app.use('/api/game/state', gameStateLimiter);
app.use('/api/game/verify', verifyLimiter);

// ==========================================
// 🛡️ LAYER 3: IP BLACKLIST (in-memory)
// ==========================================
const suspiciousIPs = new Map();
const BLOCK_THRESHOLD = 50; // Block after 50 rapid requests
const BLOCK_DURATION = 5 * 60 * 1000; // 5 minute block

app.use((req, res, next) => {
  const ip = req.ip || req.headers['x-forwarded-for'] || 'unknown';
  
  // Check if IP is blocked
  if (suspiciousIPs.has(ip)) {
    const blockData = suspiciousIPs.get(ip);
    if (Date.now() - blockData.blockedAt < BLOCK_DURATION) {
      return res.status(403).json({ error: 'Access denied. Suspicious activity detected.' });
    } else {
      suspiciousIPs.delete(ip); // Unblock after duration
    }
  }
  
  // Track request frequency
  if (!suspiciousIPs.has(ip)) {
    suspiciousIPs.set(ip, { count: 0, firstRequest: Date.now(), blockedAt: 0 });
  }
  
  const data = suspiciousIPs.get(ip);
  data.count++;
  
  // Block if too many requests in short time
  if (data.count > BLOCK_THRESHOLD && Date.now() - data.firstRequest < 10000) {
    data.blockedAt = Date.now();
    console.log(`🛡️ BLOCKED IP: ${ip} (${data.count} requests in ${Math.round((Date.now()-data.firstRequest)/1000)}s)`);
    return res.status(403).json({ error: 'Access denied. Suspicious activity detected.' });
  }
  
  // Reset counter every 10 seconds
  if (Date.now() - data.firstRequest > 10000) {
    data.count = 0;
    data.firstRequest = Date.now();
  }
  
  next();
});

// ==========================================
// 🔒 GAME STATE - Crash point NEVER broadcast
// ==========================================
let gameState = {
  status: 'WAITING',
  multiplier: 1.00,
  roundId: 1,
  startTime: null,
  
  // SECRET - Never in API response during IN_GAME
  crashPoint: 1.00,
  serverSeed: null,
  
  // PUBLIC
  crashPointHash: null,
  clientSeed: null,
};

// ==========================================
// CRASH POINT GENERATOR
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
// 🔒 HARDENED API - crashPoint NEVER sent
// ==========================================
app.get('/api/game/state', (req, res) => {
  
  // Build response based on game state
  const response = {
    status: gameState.status,
    multiplier: gameState.multiplier,
    roundId: gameState.roundId,
    crashPointHash: gameState.crashPointHash,
    clientSeed: gameState.clientSeed,
  };
  
  // 🔒 CRITICAL: Only reveal crash data AFTER round ends
  if (gameState.status === 'CRASHED') {
    response.serverSeed = gameState.serverSeed;
    response.crashPoint = gameState.crashPoint;
  }
  // During WAITING and IN_GAME: crashPoint IS ABSENT from response
  
  // 🛡️ Security headers
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  
  res.json(response);
});

// ==========================================
// ✅ VERIFICATION ENDPOINT (past rounds)
// ==========================================
app.get('/api/game/verify/:roundId', (req, res) => {
  const { roundId } = req.params;
  const { serverSeed, clientSeed, crashPoint } = req.query;
  
  if (!serverSeed || !clientSeed || !crashPoint) {
    return res.status(400).json({ error: 'Missing parameters' });
  }
  
  // Validate inputs
  if (serverSeed.length !== 64 || !/^[a-f0-9]+$/.test(serverSeed)) {
    return res.status(400).json({ error: 'Invalid server seed format' });
  }
  
  const parsedCrashPoint = parseFloat(crashPoint);
  if (isNaN(parsedCrashPoint) || parsedCrashPoint < 1 || parsedCrashPoint > 28) {
    return res.status(400).json({ error: 'Invalid crash point value' });
  }
  
  const calculated = calculateCrashPoint(serverSeed, clientSeed);
  
  res.json({
    roundId: parseInt(roundId),
    provided: { serverSeed, clientSeed, crashPoint: parsedCrashPoint },
    calculated: { crashPoint: calculated },
    verified: Math.abs(calculated - parsedCrashPoint) < 0.01 // Float tolerance
  });
});

// ==========================================
// 🛡️ HEALTH CHECK (no sensitive data)
// ==========================================
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok',
    timestamp: Date.now(),
    uptime: process.uptime()
  });
});

// ==========================================
// GAME LOOP
// ==========================================
async function runGameLoop() {
  console.log('🛡️ HARDENED SERVER STARTED');
  console.log('🔒 Rate limiting: SERVER-SIDE (30 req/sec per IP)');
  console.log('🔒 Crash point: NEVER broadcast during gameplay');
  console.log('🔒 IP blocking: Automatic for suspicious activity');
  
  while (true) {
    // WAITING PHASE
    gameState.status = 'WAITING';
    gameState.multiplier = 1.00;
    gameState.startTime = null;
    
    gameState.serverSeed = generateServerSeed();
    gameState.clientSeed = getNigeriaClientSeed();
    gameState.crashPoint = calculateCrashPoint(gameState.serverSeed, gameState.clientSeed);
    gameState.crashPointHash = createCrashPointHash(gameState.serverSeed, gameState.crashPoint);
    
    console.log(`\n🟢 Round ${gameState.roundId} - Waiting`);
    console.log(`   Hash: ${gameState.crashPointHash.slice(0, 16)}...`);
    
    await sleep(5000);
    
    // IN_GAME PHASE
    gameState.status = 'IN_GAME';
    gameState.startTime = Date.now();
    console.log(`✈️ Round ${gameState.roundId} - Flying`);
    
    const startTime = Date.now();
    while (true) {
      const elapsed = (Date.now() - startTime) / 1000;
      gameState.multiplier = parseFloat(Math.pow(Math.E, 0.085 * elapsed).toFixed(2));
      
      if (gameState.multiplier >= gameState.crashPoint) {
        gameState.multiplier = gameState.crashPoint;
        break;
      }
      
      await sleep(50);
    }
    
    // CRASHED
    gameState.status = 'CRASHED';
    console.log(`💥 Round ${gameState.roundId} - Crashed at ${gameState.crashPoint}x`);
    
    gameState.roundId++;
    await sleep(3000);
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ==========================================
// START
// ==========================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server on port ${PORT}`);
  runGameLoop();
});
