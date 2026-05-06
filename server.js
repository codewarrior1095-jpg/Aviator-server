import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';

dotenv.config();

// Initialize Firebase Admin with environment variables
const firebaseConfig = {
  type: "service_account",
  project_id: process.env.FIREBASE_PROJECT_ID,
  private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
  private_key: process.env.FIREBASE_PRIVATE_KEY ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n') : '',
  client_email: process.env.FIREBASE_CLIENT_EMAIL,
  client_id: process.env.FIREBASE_CLIENT_ID,
  auth_uri: "https://accounts.google.com/o/oauth2/auth",
  token_uri: "https://oauth2.googleapis.com/token",
  auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
  client_x509_cert_url: process.env.FIREBASE_CLIENT_CERT_URL
};

// Check if Firebase credentials exist before initializing
try {
  initializeApp({
    credential: cert(firebaseConfig)
  });
  console.log('Firebase initialized successfully');
} catch (error) {
  console.error('Firebase initialization error:', error.message);
  console.log('Server will start but Firebase features may not work');
}

const db = getFirestore();
const app = express();

// Security middleware
app.use(helmet());
app.use(cors({
  origin: ['https://aviator-server-puy9.onrender.com', 'http://localhost:3000', 'http://localhost:5000'],
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  credentials: true
}));
app.use(express.json());

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100
});
app.use('/api/', limiter);

// Rate limit specifically for betting
const betLimiter = rateLimit({
  windowMs: 1000, // 1 second
  max: 1, // 1 bet per second
  message: { error: 'Too many bets, please wait' }
});

// Authentication middleware
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  
  if (!token) {
    return res.status(401).json({ error: 'Access denied. No token provided.' });
  }
  
  if (!process.env.JWT_SECRET) {
    return res.status(500).json({ error: 'JWT secret not configured on server' });
  }
  
  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid or expired token' });
    }
    req.user = user;
    next();
  });
};

// Game state (server-side only - completely hidden from clients)
let gameState = {
  status: 'WAITING', // WAITING, IN_GAME, CRASHED
  crashPoint: 1.00,
  startTime: null,
  currentMultiplier: 1.00,
  roundId: 1
};

// Generate crash point using provably fair algorithm
async function generateCrashPoint(serverSeed, clientSeed) {
  const hash = crypto.createHmac('sha256', serverSeed)
    .update(clientSeed)
    .digest('hex');
  
  const h = parseInt(hash.slice(0, 52/4), 16);
  const e = Math.pow(2, 52);
  
  // House edge of 1%
  const result = (0.99 * e) / (h + 1);
  return Math.max(1, parseFloat(result.toFixed(2)));
}

// Server seed management
let currentServerSeed = crypto.randomBytes(16).toString('hex');
let nextServerSeed = crypto.randomBytes(16).toString('hex');

// API Routes

// Health check
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: Date.now(),
    uptime: process.uptime()
  });
});

// Register user
app.post('/api/auth/register', async (req, res) => {
  try {
    const { username, password } = req.body;
    
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }
    
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }
    
    const userRef = db.collection('users').doc(username);
    const userDoc = await userRef.get();
    
    if (userDoc.exists) {
      return res.status(400).json({ error: 'Username already exists' });
    }
    
    const hashedPassword = await bcrypt.hash(password, 12);
    
    await userRef.set({
      username,
      password: hashedPassword,
      balance: 1000, // Starting bonus
      createdAt: new Date().toISOString(),
      lastLogin: new Date().toISOString()
    });
    
    const token = jwt.sign(
      { username, userId: username },
      process.env.JWT_SECRET || 'fallback-secret',
      { expiresIn: '24h' }
    );
    
    res.json({
      token,
      user: {
        username,
        balance: 1000
      }
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// Login user
app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    
    const userRef = db.collection('users').doc(username);
    const userDoc = await userRef.get();
    
    if (!userDoc.exists) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    const userData = userDoc.data();
    const validPassword = await bcrypt.compare(password, userData.password);
    
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    await userRef.update({
      lastLogin: new Date().toISOString()
    });
    
    const token = jwt.sign(
      { username, userId: username },
      process.env.JWT_SECRET || 'fallback-secret',
      { expiresIn: '24h' }
    );
    
    res.json({
      token,
      user: {
        username: userData.username,
        balance: userData.balance
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

// Get user balance (read only)
app.get('/api/user/balance', authenticateToken, async (req, res) => {
  try {
    const userRef = db.collection('users').doc(req.user.username);
    const userDoc = await userRef.get();
    
    if (!userDoc.exists) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    const userData = userDoc.data();
    res.json({
      balance: userData.balance,
      username: userData.username
    });
  } catch (error) {
    console.error('Balance check error:', error);
    res.status(500).json({ error: 'Failed to get balance' });
  }
});

// Place bet (server validates everything)
app.post('/api/game/bet', authenticateToken, betLimiter, async (req, res) => {
  try {
    const { amount, autoCashout } = req.body;
    
    // Validate bet amount
    if (!amount || amount <= 0) {
      return res.status(400).json({ error: 'Invalid bet amount' });
    }
    
    if (gameState.status !== 'WAITING') {
      return res.status(400).json({ error: 'Game is not accepting bets' });
    }
    
    // Check user balance
    const userRef = db.collection('users').doc(req.user.username);
    const userDoc = await userRef.get();
    const userData = userDoc.data();
    
    if (userData.balance < amount) {
      return res.status(400).json({ error: 'Insufficient balance' });
    }
    
    // Deduct bet from balance
    await userRef.update({
      balance: userData.balance - amount
    });
    
    // Record bet
    const betRef = db.collection('bets').doc();
    await betRef.set({
      userId: req.user.username,
      roundId: gameState.roundId,
      amount,
      autoCashout: autoCashout || null,
      status: 'active',
      placedAt: new Date().toISOString()
    });
    
    res.json({
      success: true,
      betId: betRef.id,
      newBalance: userData.balance - amount,
      message: 'Bet placed successfully'
    });
  } catch (error) {
    console.error('Bet error:', error);
    res.status(500).json({ error: 'Failed to place bet' });
  }
});

// Cash out (server validates and pays out)
app.post('/api/game/cashout', authenticateToken, async (req, res) => {
  try {
    const { betId } = req.body;
    
    if (gameState.status !== 'IN_GAME') {
      return res.status(400).json({ error: 'Cannot cash out - game not active' });
    }
    
    const betRef = db.collection('bets').doc(betId);
    const betDoc = await betRef.get();
    
    if (!betDoc.exists) {
      return res.status(404).json({ error: 'Bet not found' });
    }
    
    const betData = betDoc.data();
    
    if (betData.userId !== req.user.username) {
      return res.status(403).json({ error: 'Unauthorized' });
    }
    
    if (betData.status !== 'active') {
      return res.status(400).json({ error: 'Bet already cashed out' });
    }
    
    if (betData.roundId !== gameState.roundId) {
      return res.status(400).json({ error: 'Wrong round' });
    }
    
    const currentMultiplier = gameState.currentMultiplier;
    const winnings = betData.amount * currentMultiplier;
    
    // Update bet status
    await betRef.update({
      status: 'cashed_out',
      cashoutMultiplier: currentMultiplier,
      winnings,
      cashedOutAt: new Date().toISOString()
    });
    
    // Add winnings to user balance
    const userRef = db.collection('users').doc(req.user.username);
    await userRef.update({
      balance: FieldValue.increment(winnings)
    });
    
    // Get new balance
    const userDoc = await userRef.get();
    
    res.json({
      success: true,
      multiplier: currentMultiplier,
      winnings,
      newBalance: userDoc.data().balance
    });
  } catch (error) {
    console.error('Cashout error:', error);
    res.status(500).json({ error: 'Failed to cash out' });
  }
});

// Get current game state (public)
app.get('/api/game/state', (req, res) => {
  res.json({
    status: gameState.status,
    crashPoint: gameState.status === 'CRASHED' ? gameState.crashPoint : null,
    roundId: gameState.roundId,
    multiplier: gameState.status === 'IN_GAME' ? gameState.currentMultiplier : 1.00,
    nextServerSeedHash: crypto.createHash('sha256').update(nextServerSeed).digest('hex')
  });
});

// Get round history
app.get('/api/game/history', async (req, res) => {
  try {
    const historyRef = db.collection('gameHistory')
      .orderBy('roundId', 'desc')
      .limit(20);
    
    const snapshot = await historyRef.get();
    const history = [];
    
    snapshot.forEach(doc => {
      history.push(doc.data());
    });
    
    res.json(history);
  } catch (error) {
    console.error('History error:', error);
    res.status(500).json({ error: 'Failed to get history' });
  }
});

// Game loop (runs on server)
async function runGameLoop() {
  console.log('Game loop started');
  
  while (true) {
    try {
      // Waiting phase
      gameState.status = 'WAITING';
      gameState.currentMultiplier = 1.00;
      gameState.startTime = null;
      console.log(`Round ${gameState.roundId} - Waiting for bets`);
      
      // Wait 5 seconds for bets
      await new Promise(resolve => setTimeout(resolve, 5000));
      
      // Generate crash point
      const clientSeed = gameState.roundId.toString();
      gameState.crashPoint = await generateCrashPoint(currentServerSeed, clientSeed);
      gameState.status = 'IN_GAME';
      gameState.startTime = Date.now();
      console.log(`Round ${gameState.roundId} - Started. Crash point: ${gameState.crashPoint}x`);
      
      // Game running phase
      const startTime = Date.now();
      while (true) {
        const elapsed = (Date.now() - startTime) / 1000;
        gameState.currentMultiplier = Math.pow(Math.E, 0.07 * elapsed);
        
        if (gameState.currentMultiplier >= gameState.crashPoint) {
          gameState.currentMultiplier = gameState.crashPoint;
          gameState.status = 'CRASHED';
          console.log(`Round ${gameState.roundId} - Crashed at ${gameState.crashPoint}x`);
          break;
        }
        
        // Check auto cashouts
        await processAutoCashouts();
        
        await new Promise(resolve => setTimeout(resolve, 50)); // 20 updates per second
      }
      
      // Record round in history
      await db.collection('gameHistory').add({
        roundId: gameState.roundId,
        crashPoint: gameState.crashPoint,
        serverSeed: currentServerSeed,
        finishedAt: new Date().toISOString()
      });
      
      // Rotate seeds
      currentServerSeed = nextServerSeed;
      nextServerSeed = crypto.randomBytes(16).toString('hex');
      
      // Process all remaining bets as losses
      await processRemainingBets();
      
      gameState.roundId++;
      
      // Short delay between rounds
      await new Promise(resolve => setTimeout(resolve, 3000));
      
    } catch (error) {
      console.error('Game loop error:', error);
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
}

async function processAutoCashouts() {
  try {
    const betsRef = db.collection('bets')
      .where('roundId', '==', gameState.roundId)
      .where('status', '==', 'active');
    
    const snapshot = await betsRef.get();
    
    for (const doc of snapshot.docs) {
      const betData = doc.data();
      if (betData.autoCashout && betData.autoCashout <= gameState.currentMultiplier) {
        const winnings = betData.amount * betData.autoCashout;
        
        await doc.ref.update({
          status: 'cashed_out',
          cashoutMultiplier: betData.autoCashout,
          winnings,
          cashedOutAt: new Date().toISOString()
        });
        
        const userRef = db.collection('users').doc(betData.userId);
        await userRef.update({
          balance: FieldValue.increment(winnings)
        });
      }
    }
  } catch (error) {
    console.error('Auto cashout error:', error);
  }
}

async function processRemainingBets() {
  try {
    const betsRef = db.collection('bets')
      .where('roundId', '==', gameState.roundId)
      .where('status', '==', 'active');
    
    const snapshot = await betsRef.get();
    
    for (const doc of snapshot.docs) {
      await doc.ref.update({
        status: 'lost',
        cashoutMultiplier: null,
        winnings: 0
      });
    }
  } catch (error) {
    console.error('Process remaining bets error:', error);
  }
}

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Node version: ${process.version}`);
  runGameLoop().catch(error => {
    console.error('Fatal game loop error:', error);
  });
});
