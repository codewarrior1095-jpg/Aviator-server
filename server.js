const express = require('express');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());

// ---------- In‑memory storage (replace with DB later) ----------
let users = {
  '1': { balance: 5000.00, name: 'Player1' }   // default user
};
let activeBets = new Map();        // betId -> { userId, amount, roundId }
let gameHistory = [];               // { crashPoint, roundId, timestamp }
let currentRound = {
  roundId: 1,
  status: 'WAITING',      // WAITING, IN_GAME, CRASHED
  multiplier: 1.00,
  startTime: null,
  crashPoint: 0,
  totalBetAmount: 0
};

let gameLoopInterval = null;

// ---------- Game Engine ----------
function startNewRound() {
  // 1. Generate a provably fair crash point (between 1.00 and 100.00)
  const crashPoint = 1.00 + Math.random() * 99;   // for demo – replace with hash chain if needed
  
  currentRound = {
    roundId: currentRound.roundId + 1,
    status: 'IN_GAME',
    multiplier: 1.00,
    startTime: Date.now(),
    crashPoint: crashPoint,
    totalBetAmount: 0
  };
  
  // Clear old bets from previous round
  activeBets.clear();
  
  // Start the multiplier updater
  if (gameLoopInterval) clearInterval(gameLoopInterval);
  const start = Date.now();
  gameLoopInterval = setInterval(() => {
    if (currentRound.status !== 'IN_GAME') return;
    
    const elapsed = (Date.now() - start) / 1000;   // seconds
    let multiplier = 1.00 + (elapsed * 1.5);       // increases 1.5x per second
    multiplier = Math.min(multiplier, currentRound.crashPoint);
    
    currentRound.multiplier = parseFloat(multiplier.toFixed(2));
    
    // Check for crash
    if (currentRound.multiplier >= currentRound.crashPoint) {
      clearInterval(gameLoopInterval);
      currentRound.status = 'CRASHED';
      currentRound.multiplier = currentRound.crashPoint;
      
      // Settle all uncashed bets – they lose
      for (let [betId, bet] of activeBets.entries()) {
        if (!bet.cashedOut) {
          // bet lost – no refund
          activeBets.delete(betId);
        }
      }
      
      // Record history
      gameHistory.unshift({
        crashPoint: currentRound.crashPoint,
        roundId: currentRound.roundId,
        timestamp: Date.now()
      });
      if (gameHistory.length > 20) gameHistory.pop();
      
      // Schedule next round after 5 seconds
      setTimeout(() => {
        currentRound.status = 'WAITING';
        startNewRound();
      }, 5000);
    }
  }, 50); // update every 50ms for smoothness
}

// ---------- API Endpoints ----------
app.get('/api/game/state', (req, res) => {
  res.json({
    status: currentRound.status,
    multiplier: currentRound.multiplier,
    roundId: currentRound.roundId
  });
});

app.post('/api/game/bet', (req, res) => {
  const { amount } = req.body;
  const userId = '1';   // in real app get from auth token
  
  if (currentRound.status !== 'WAITING') {
    return res.status(400).json({ error: 'Cannot bet – round already in progress' });
  }
  if (amount <= 0 || amount > users[userId].balance) {
    return res.status(400).json({ error: 'Invalid amount or insufficient balance' });
  }
  
  // Deduct balance
  users[userId].balance -= amount;
  const betId = crypto.randomUUID();
  activeBets.set(betId, {
    userId,
    amount,
    roundId: currentRound.roundId,
    cashedOut: false
  });
  currentRound.totalBetAmount += amount;
  
  res.json({ betId, newBalance: users[userId].balance });
});

app.post('/api/game/cashout', (req, res) => {
  const { betId } = req.body;
  const userId = '1';
  
  const bet = activeBets.get(betId);
  if (!bet || bet.userId !== userId) {
    return res.status(404).json({ error: 'Bet not found' });
  }
  if (bet.cashedOut) {
    return res.status(400).json({ error: 'Already cashed out' });
  }
  if (currentRound.status !== 'IN_GAME') {
    return res.status(400).json({ error: 'Cannot cash out now' });
  }
  
  const winAmount = bet.amount * currentRound.multiplier;
  users[userId].balance += winAmount;
  bet.cashedOut = true;
  
  res.json({ winAmount, newBalance: users[userId].balance });
});

app.get('/api/user/balance', (req, res) => {
  res.json({ balance: users['1'].balance });
});

app.get('/api/game/history', (req, res) => {
  res.json(gameHistory);
});

// Optional: WebSocket (for real‑time push) – keep your second frontend working
const http = require('http');
const socketIo = require('socket.io');
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: '*' } });

io.on('connection', (socket) => {
  console.log('Client connected via WS');
  // Send current state immediately
  socket.emit('gameState', {
    status: currentRound.status,
    multiplier: currentRound.multiplier,
    progress: (currentRound.multiplier - 1) / (currentRound.crashPoint - 1) || 0
  });
  
  // Broadcast multiplier updates only to clients who want them
  const interval = setInterval(() => {
    if (currentRound.status === 'IN_GAME') {
      socket.emit('multiplierUpdate', {
        multiplier: currentRound.multiplier,
        progress: (currentRound.multiplier - 1) / (currentRound.crashPoint - 1)
      });
    } else if (currentRound.status === 'CRASHED') {
      socket.emit('gameCrashed', { crashPoint: currentRound.crashPoint });
      clearInterval(interval);
    }
  }, 100);
  
  socket.on('disconnect', () => clearInterval(interval));
});

// Start the game
startNewRound();

// Launch server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✅ Backend running on port ${PORT}`);
});
