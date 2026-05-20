const express = require('express');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());

// ========== In-Memory Storage ==========
const users = { '1': { balance: 5000.00, name: 'Player1' } };
const activeBets = new Map();
let gameHistory = [];

// ========== Game State ==========
let currentRound = {
  roundId: 0,
  status: 'WAITING',
  multiplier: 1.00,
  crashPoint: 0,
  startTime: null,
  nextRoundTimer: null,
  multiplierTimer: null,
  watchdogTimer: null
};

// Helper: random crash point (1.01 - 100.00)
function getRandomCrashPoint() {
  const r = Math.random();
  let crash = 1.00 + (Math.log(1 - r) / -0.12);
  crash = Math.min(Math.max(crash, 1.01), 100.00);
  return parseFloat(crash.toFixed(2));
}

// Watchdog: if no multiplier update for 10 seconds, force crash and restart
function startWatchdog(round) {
  if (round.watchdogTimer) clearTimeout(round.watchdogTimer);
  round.watchdogTimer = setTimeout(() => {
    if (currentRound.roundId === round.roundId && currentRound.status === 'IN_GAME') {
      console.warn('⚠️ Watchdog triggered: forcing crash (multiplier frozen)');
      crashRound(true);
    }
  }, 10000); // 10 seconds with no update
}

function updateMultiplier(round) {
  if (currentRound.roundId !== round.roundId) return;
  if (currentRound.status !== 'IN_GAME') return;
  
  const elapsed = (Date.now() - round.startTime) / 1000;
  let multiplier = 1.00 + (elapsed * 1.2);
  
  if (multiplier >= round.crashPoint) {
    multiplier = round.crashPoint;
    currentRound.multiplier = multiplier;
    crashRound(false);
    return;
  }
  
  currentRound.multiplier = parseFloat(multiplier.toFixed(2));
  
  // Reset watchdog on each successful update
  startWatchdog(round);
  
  // Schedule next update
  round.multiplierTimer = setTimeout(() => updateMultiplier(round), 50);
}

function crashRound(forced = false) {
  if (currentRound.status !== 'IN_GAME') return;
  
  // Clear all timers
  if (currentRound.multiplierTimer) clearTimeout(currentRound.multiplierTimer);
  if (currentRound.watchdogTimer) clearTimeout(currentRound.watchdogTimer);
  
  currentRound.status = 'CRASHED';
  if (!forced) {
    currentRound.multiplier = currentRound.crashPoint;
  }
  
  // Settle bets (uncashed lose)
  for (let [betId, bet] of activeBets.entries()) {
    if (!bet.cashedOut) activeBets.delete(betId);
  }
  
  // Store history
  gameHistory.unshift({
    crashPoint: currentRound.multiplier,
    roundId: currentRound.roundId,
    timestamp: Date.now(),
    forced
  });
  if (gameHistory.length > 20) gameHistory.pop();
  
  console.log(`💥 Round ${currentRound.roundId} crashed at ${currentRound.multiplier}x${forced ? ' (forced)' : ''}`);
  
  // Schedule next round
  if (currentRound.nextRoundTimer) clearTimeout(currentRound.nextRoundTimer);
  currentRound.nextRoundTimer = setTimeout(() => startNewRound(), 5000);
}

function startNewRound() {
  // Clean up any existing timers
  if (currentRound.multiplierTimer) clearTimeout(currentRound.multiplierTimer);
  if (currentRound.nextRoundTimer) clearTimeout(currentRound.nextRoundTimer);
  if (currentRound.watchdogTimer) clearTimeout(currentRound.watchdogTimer);
  
  const newRoundId = currentRound.roundId + 1;
  const crashPoint = getRandomCrashPoint();
  
  currentRound = {
    roundId: newRoundId,
    status: 'IN_GAME',
    multiplier: 1.00,
    crashPoint: crashPoint,
    startTime: Date.now(),
    nextRoundTimer: null,
    multiplierTimer: null,
    watchdogTimer: null
  };
  
  activeBets.clear();
  startWatchdog(currentRound);
  currentRound.multiplierTimer = setTimeout(() => updateMultiplier(currentRound), 50);
  
  console.log(`✈️ Round ${newRoundId} started – crash at ${crashPoint}x`);
}

// ========== API Endpoints ==========
app.get('/api/game/state', (req, res) => {
  res.json({
    status: currentRound.status,
    multiplier: currentRound.multiplier,
    roundId: currentRound.roundId,
    crashPoint: currentRound.status === 'CRASHED' ? currentRound.multiplier : null
  });
});

app.post('/api/game/bet', (req, res) => {
  const { amount } = req.body;
  const userId = '1';
  if (currentRound.status !== 'WAITING') {
    return res.status(400).json({ error: `Cannot bet now (status: ${currentRound.status})` });
  }
  if (amount <= 0 || amount > users[userId].balance) {
    return res.status(400).json({ error: 'Invalid amount or insufficient balance' });
  }
  users[userId].balance -= amount;
  const betId = crypto.randomUUID();
  activeBets.set(betId, { userId, amount, roundId: currentRound.roundId, cashedOut: false });
  res.json({ betId, newBalance: users[userId].balance });
});

app.post('/api/game/cashout', (req, res) => {
  const { betId } = req.body;
  const userId = '1';
  const bet = activeBets.get(betId);
  if (!bet || bet.userId !== userId) return res.status(404).json({ error: 'Bet not found' });
  if (bet.cashedOut) return res.status(400).json({ error: 'Already cashed out' });
  if (currentRound.status !== 'IN_GAME') return res.status(400).json({ error: 'Round not in progress' });
  if (bet.roundId !== currentRound.roundId) return res.status(400).json({ error: 'Bet from old round' });
  
  const winAmount = bet.amount * currentRound.multiplier;
  users[userId].balance += winAmount;
  bet.cashedOut = true;
  activeBets.delete(betId);
  res.json({ winAmount, newBalance: users[userId].balance });
});

app.get('/api/user/balance', (req, res) => {
  res.json({ balance: users['1'].balance });
});

app.get('/api/game/history', (req, res) => {
  res.json(gameHistory);
});

// Health check endpoint for monitoring (optional)
app.get('/health', (req, res) => {
  res.json({ status: 'alive', round: currentRound.roundId, gameStatus: currentRound.status });
});

// Start the game
startNewRound();

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Aviator backend running 24/7 on port ${PORT}`);
});
