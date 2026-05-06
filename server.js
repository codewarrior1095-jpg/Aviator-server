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
// The private key needs proper formatting - Render sometimes mangles the newlines
const serviceAccount = {
  type: "service_account",
  project_id: process.env.FIREBASE_PROJECT_ID,
  private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
  private_key: process.env.FIREBASE_PRIVATE_KEY ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n') : undefined,
  client_email: process.env.FIREBASE_CLIENT_EMAIL,
  client_id: process.env.FIREBASE_CLIENT_ID,
  auth_uri: "https://accounts.google.com/o/oauth2/auth",
  token_uri: "https://oauth2.googleapis.com/token",
  auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
  client_x509_cert_url: process.env.FIREBASE_CLIENT_CERT_URL
};

let db;
let firebaseInitialized = false;

// Only initialize Firebase if we have valid credentials
if (serviceAccount.private_key && serviceAccount.project_id && serviceAccount.client_email) {
  try {
    initializeApp({
      credential: cert(serviceAccount)
    });
    db = getFirestore();
    firebaseInitialized = true;
    console.log('Firebase initialized successfully');
  } catch (error) {
    console.error('Firebase initialization error:', error.message);
    console.log('Server will run without Firebase. Auth and betting features will be disabled.');
  }
} else {
  console.log('Firebase credentials missing. Server will run in limited mode.');
  console.log('Missing:', {
    project_id: !serviceAccount.project_id,
    private_key: !serviceAccount.private_key,
    client_email: !serviceAccount.client_email
  });
}

const app = express();

// Security middleware
app.use(helmet());
app.use(cors({
  origin: '*', // Allow all origins for now
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
  if (!firebaseInitialized) {
    return res.status(503).json({ error: 'Service temporarily unavailable - Firebase not configured' });
  }
  
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
    firebase: firebaseInitialized,
    uptime: process.uptime()
  });
});

// Register user
app.post('/api/auth/register', async (req, res) => {
  if (!firebaseInitialized) {
    return res.status(503).json({ error: 'Service temporarily unavailable' });
  }
  
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
      process.env.JWT_SECRET,
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
  if (!firebaseInitialized) {
    return res.status(503).json({ error: 'Service temporarily unavailable' });
  }
  
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
      process.env.JWT_SECRET,
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
    
    if (!amount || amount <= 0) {
      return res.status(400).json({ error: 'Invalid bet amount' });
    }
    
    if (gameState.status !== 'WAITING') {
      return res.status(400).json({ error: 'Game is not accepting bets' });
    }
    
    const userRef = db.collection('users').doc(req.user.username);
    const userDoc = await userRef.get();
    const userData = userDoc.data();
    
    if (userData.balance < amount) {
      return res.status(400).json({ error: 'Insufficient balance' });
    }
    
    await userRef.update({
      balance: userData.balance - amount
    });
    
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
    
    await betRef.update({
      status: 'cashed_out',
      cashoutMultiplier: currentMultiplier,
      winnings,
      cashedOutAt: new Date().toISOString()
    });
    
    const userRef = db.collection('users').doc(req.user.username);
    await userRef.update({
      balance: FieldValue.increment(winnings)
    });
    
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

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Firebase initialized: ${firebaseInitialized}`);
  console.log(`Node version: ${process.version}`);
  
  // Only start game loop
  startGameLoop();
});

// Game loop
async function startGameLoop() {
  console.log('Game loop started');
  
  while (true) {
    try {
      gameState.status = 'WAITING';
      gameState.currentMultiplier = 1.00;
      gameState.startTime = null;
      console.log(`Round ${gameState.roundId} - Waiting`);
      
      await new Promise(resolve => setTimeout(resolve, 5000));
      
      const clientSeed = gameState.roundId.toString();
      gameState.crashPoint = await generateCrashPoint(currentServerSeed, clientSeed);
      gameState.status = 'IN_GAME';
      gameState.startTime = Date.now();
      console.log(`Round ${gameState.roundId} - Flying. Crash: ${gameState.crashPoint}x`);
      
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
        
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      
      // Rotate seeds
      currentServerSeed = nextServerSeed;
      nextServerSeed = crypto.randomBytes(16).toString('hex');
      
      gameState.roundId++;
      
      await new Promise(resolve => setTimeout(resolve, 3000));
      
    } catch (error) {
      console.error('Game loop error:', error);
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
}
