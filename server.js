const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  pingTimeout: 60000,
  pingInterval: 25000,
  transports: ['websocket', 'polling']
});

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// Serve the main HTML file
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ==================== GAME ENGINE ====================
class GameEngine {
  constructor() {
    this.gameActive = false;
    this.currentMultiplier = 1.00;
    this.crashPoint = 1.00;
    this.players = new Map();
    this.updateInterval = null;
    this.roundStartTime = 0;
    this.roundHistory = [];
  }
  
  start() {
    console.log('[GAME] Starting game engine');
    this.startNewRound();
  }
  
  startNewRound() {
    this.gameActive = true;
    this.currentMultiplier = 1.00;
    this.roundStartTime = Date.now();
    this.crashPoint = this.generateCrashPoint();
    
    console.log(`[GAME] Round started - Crash at: ${this.crashPoint.toFixed(2)}x`);
    
    io.emit('round_start', {
      crashPoint: this.crashPoint,
      startTime: this.roundStartTime,
      multiplier: 1.00
    });
    
    this.startMultiplierUpdates();
  }
  
  generateCrashPoint() {
    const random = Math.random();
    let crashPoint;
    if (random < 0.70) {
      crashPoint = 1.00 + Math.random() * 1.00;
    } else if (random < 0.90) {
      crashPoint = 2.00 + Math.random() * 3.00;
    } else if (random < 0.98) {
      crashPoint = 5.00 + Math.random() * 5.00;
    } else {
      crashPoint = 10.00 + Math.random() * 90.00;
    }
    return parseFloat(crashPoint.toFixed(2));
  }
  
  startMultiplierUpdates() {
    if (this.updateInterval) clearInterval(this.updateInterval);
    
    this.updateInterval = setInterval(() => {
      if (!this.gameActive) return;
      
      const elapsed = (Date.now() - this.roundStartTime) / 1000;
      // 60% slower multiplier
      let newMultiplier = 1.00 + Math.pow(elapsed, 1.15) * 1.3 * 0.4;
      
      if (newMultiplier >= this.crashPoint) {
        newMultiplier = this.crashPoint;
        this.crashRound();
        return;
      }
      
      this.currentMultiplier = parseFloat(newMultiplier.toFixed(3));
      io.emit('multiplier_update', {
        multiplier: this.currentMultiplier,
        timestamp: Date.now()
      });
    }, 50);
  }
  
  crashRound() {
    if (!this.gameActive) return;
    this.gameActive = false;
    if (this.updateInterval) clearInterval(this.updateInterval);
    
    console.log(`[GAME] ROUND CRASHED at ${this.crashPoint.toFixed(2)}x`);
    io.emit('crash', { multiplier: this.crashPoint, timestamp: Date.now() });
    
    this.roundHistory.unshift({ crashPoint: this.crashPoint, timestamp: Date.now() });
    if (this.roundHistory.length > 20) this.roundHistory.pop();
    
    for (const [id, player] of this.players) {
      if (player.currentBet && !player.currentBet.cashedOut) player.currentBet = null;
      else if (player.currentBet && player.currentBet.cashedOut) player.currentBet = null;
    }
    
    setTimeout(() => this.startNewRound(), 5000);
  }
  
  registerPlayer(socketId, data) {
    const player = {
      id: socketId,
      name: data.name || `Player_${socketId.substr(0, 6)}`,
      balance: data.balance || 10000,
      currentBet: null,
      totalWon: 0,
      totalBet: 0,
      joinedAt: Date.now()
    };
    this.players.set(socketId, player);
    console.log(`[PLAYER] ${player.name} joined`);
    return player;
  }
  
  removePlayer(socketId) {
    const player = this.players.get(socketId);
    if (player) {
      console.log(`[PLAYER] ${player.name} left`);
      this.players.delete(socketId);
    }
  }
  
  placeBet(socketId, amount) {
    const player = this.players.get(socketId);
    if (!player) return { success: false, error: 'Player not found' };
    if (!this.gameActive) return { success: false, error: 'Round not active' };
    if (player.currentBet) return { success: false, error: 'Bet already placed' };
    if (amount < 10 || amount > 5000) return { success: false, error: 'Invalid amount' };
    if (amount > player.balance) return { success: false, error: 'Insufficient balance' };
    
    player.currentBet = { amount, placedAt: Date.now(), cashedOut: false, cashoutMultiplier: null };
    player.balance -= amount;
    player.totalBet += amount;
    return { success: true, bet: player.currentBet, newBalance: player.balance };
  }
  
  cashout(socketId, requestedMultiplier) {
    const player = this.players.get(socketId);
    if (!player || !player.currentBet) return { success: false, error: 'No active bet' };
    if (player.currentBet.cashedOut) return { success: false, error: 'Already cashed out' };
    if (!this.gameActive) return { success: false, error: 'Round ended' };
    if (Math.abs(requestedMultiplier - this.currentMultiplier) > 0.05) {
      return { success: false, error: 'Invalid multiplier' };
    }
    
    const winAmount = player.currentBet.amount * this.currentMultiplier;
    player.currentBet.cashedOut = true;
    player.currentBet.cashoutMultiplier = this.currentMultiplier;
    player.balance += winAmount;
    player.totalWon += winAmount;
    return { success: true, multiplier: this.currentMultiplier, winAmount, betAmount: player.currentBet.amount, newBalance: player.balance };
  }
  
  getPlayerName(socketId) {
    const player = this.players.get(socketId);
    return player ? player.name : 'Unknown';
  }
  
  getGameState() {
    const activeBets = Array.from(this.players.values()).filter(p => p.currentBet && !p.currentBet.cashedOut).length;
    return {
      gameActive: this.gameActive,
      currentMultiplier: this.currentMultiplier,
      crashPoint: this.crashPoint,
      playersOnline: this.players.size,
      activeBets,
      roundHistory: this.roundHistory.slice(0, 10)
    };
  }
  
  getActiveBets() {
    const active = [];
    for (const [id, player] of this.players) {
      if (player.currentBet && !player.currentBet.cashedOut) {
        active.push({
          playerId: id,
          playerName: player.name,
          amount: player.currentBet.amount,
          potentialWin: player.currentBet.amount * this.currentMultiplier
        });
      }
    }
    return active;
  }
  
  getPlayerCount() { return this.players.size; }
}

const gameEngine = new GameEngine();
gameEngine.start();

// ==================== SOCKET.IO HANDLERS ====================
io.on('connection', (socket) => {
  console.log(`[SOCKET] Player connected: ${socket.id}`);
  socket.emit('game_state', gameEngine.getGameState());
  
  socket.on('register_player', (data) => {
    const player = gameEngine.registerPlayer(socket.id, data);
    socket.emit('player_registered', player);
    io.emit('players_online', gameEngine.getPlayerCount());
    io.emit('active_bets_update', gameEngine.getActiveBets());
  });
  
  socket.on('place_bet', (data, callback) => {
    const result = gameEngine.placeBet(socket.id, data.amount);
    if (callback) callback(result);
    if (result.success) {
      io.emit('bet_placed', {
        playerId: socket.id,
        playerName: gameEngine.getPlayerName(socket.id),
        amount: data.amount,
        timestamp: Date.now()
      });
      io.emit('active_bets_update', gameEngine.getActiveBets());
      io.emit('players_online', gameEngine.getPlayerCount());
    }
  });
  
  socket.on('cashout', (data, callback) => {
    const result = gameEngine.cashout(socket.id, data.multiplier);
    if (callback) callback(result);
    if (result.success) {
      io.emit('player_cashed_out', {
        playerId: socket.id,
        playerName: gameEngine.getPlayerName(socket.id),
        multiplier: result.multiplier,
        winAmount: result.winAmount,
        betAmount: result.betAmount
      });
      io.emit('active_bets_update', gameEngine.getActiveBets());
    }
  });
  
  socket.on('get_active_bets', () => socket.emit('active_bets_update', gameEngine.getActiveBets()));
  socket.on('get_history', () => socket.emit('history_update', gameEngine.roundHistory));
  
  socket.on('disconnect', () => {
    console.log(`[SOCKET] Player disconnected: ${socket.id}`);
    gameEngine.removePlayer(socket.id);
    io.emit('players_online', gameEngine.getPlayerCount());
    io.emit('active_bets_update', gameEngine.getActiveBets());
  });
  
  socket.on('ping', () => socket.emit('pong'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`[SERVER] Running on http://0.0.0.0:${PORT}`);
  console.log(`[SERVER] Serving index.html`);
});

process.on('SIGINT', () => {
  console.log('[SERVER] Shutting down...');
  gameEngine.gameActive = false;
  if (gameEngine.updateInterval) clearInterval(gameEngine.updateInterval);
  server.close(() => process.exit(0));
});
