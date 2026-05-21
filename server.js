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

// ==================== GAME STATE ====================
class GameEngine {
  constructor() {
    this.gameActive = false;
    this.currentMultiplier = 1.00;
    this.crashPoint = 1.00;
    this.players = new Map();
    this.updateInterval = null;
    this.roundStartTime = 0;
    this.lastMultiplierUpdate = 0;
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
    this.lastMultiplierUpdate = this.roundStartTime;
    
    // Generate authoritative crash point
    this.crashPoint = this.generateCrashPoint();
    
    console.log(`[GAME] Round started - Crash at: ${this.crashPoint.toFixed(2)}x`);
    
    // Broadcast round start to all clients
    io.emit('round_start', {
      crashPoint: this.crashPoint,
      startTime: this.roundStartTime,
      multiplier: 1.00
    });
    
    // Start multiplier updates
    this.startMultiplierUpdates();
  }
  
  generateCrashPoint() {
    // Exponential distribution for realistic game dynamics
    const random = Math.random();
    let crashPoint;
    
    if (random < 0.70) {
      // 70%: 1.00x - 2.00x
      crashPoint = 1.00 + Math.random() * 1.00;
    } else if (random < 0.90) {
      // 20%: 2.00x - 5.00x
      crashPoint = 2.00 + Math.random() * 3.00;
    } else if (random < 0.98) {
      // 8%: 5.00x - 10.00x
      crashPoint = 5.00 + Math.random() * 5.00;
    } else {
      // 2%: 10.00x - 100.00x
      crashPoint = 10.00 + Math.random() * 90.00;
    }
    
    return parseFloat(crashPoint.toFixed(2));
  }
  
  startMultiplierUpdates() {
    if (this.updateInterval) clearInterval(this.updateInterval);
    
    // Update every 50ms for smooth animation (20 FPS server updates)
    this.updateInterval = setInterval(() => {
      if (!this.gameActive) return;
      
      const now = Date.now();
      const elapsed = (now - this.roundStartTime) / 1000;
      
      // Exponential growth formula
      let newMultiplier = 1.00 + Math.pow(elapsed, 1.15) * 1.3;
      
      // Check for crash
      if (newMultiplier >= this.crashPoint) {
        newMultiplier = this.crashPoint;
        this.crashRound();
        return;
      }
      
      this.currentMultiplier = parseFloat(newMultiplier.toFixed(3));
      
      // Broadcast multiplier update to all clients
      io.emit('multiplier_update', {
        multiplier: this.currentMultiplier,
        timestamp: now
      });
      
    }, 50);
  }
  
  crashRound() {
    if (!this.gameActive) return;
    
    this.gameActive = false;
    
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }
    
    console.log(`[GAME] ROUND CRASHED at ${this.crashPoint.toFixed(2)}x`);
    
    // Broadcast crash event
    io.emit('crash', {
      multiplier: this.crashPoint,
      timestamp: Date.now()
    });
    
    // Store in history
    this.roundHistory.unshift({
      crashPoint: this.crashPoint,
      timestamp: Date.now()
    });
    
    if (this.roundHistory.length > 20) this.roundHistory.pop();
    
    // Process all uncashed bets as losses
    for (const [id, player] of this.players) {
      if (player.currentBet && !player.currentBet.cashedOut) {
        player.currentBet.lost = true;
        player.currentBet = null;
      } else if (player.currentBet && player.currentBet.cashedOut) {
        player.currentBet = null;
      }
    }
    
    // Schedule next round after 5 seconds
    setTimeout(() => {
      this.startNewRound();
    }, 5000);
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
    
    if (!player) {
      return { success: false, error: 'Player not found' };
    }
    
    if (!this.gameActive) {
      return { success: false, error: 'Round not active' };
    }
    
    if (player.currentBet) {
      return { success: false, error: 'Bet already placed this round' };
    }
    
    if (amount < 10 || amount > 5000) {
      return { success: false, error: 'Invalid bet amount' };
    }
    
    if (amount > player.balance) {
      return { success: false, error: 'Insufficient balance' };
    }
    
    // Place bet
    player.currentBet = {
      amount: amount,
      placedAt: Date.now(),
      cashedOut: false,
      cashoutMultiplier: null
    };
    
    player.balance -= amount;
    player.totalBet += amount;
    
    return {
      success: true,
      bet: player.currentBet,
      newBalance: player.balance
    };
  }
  
  cashout(socketId, requestedMultiplier) {
    const player = this.players.get(socketId);
    
    if (!player || !player.currentBet) {
      return { success: false, error: 'No active bet' };
    }
    
    if (player.currentBet.cashedOut) {
      return { success: false, error: 'Already cashed out' };
    }
    
    if (!this.gameActive) {
      return { success: false, error: 'Round already ended' };
    }
    
    // Verify multiplier matches current (anti-cheat)
    if (Math.abs(requestedMultiplier - this.currentMultiplier) > 0.05) {
      return { success: false, error: 'Invalid multiplier' };
    }
    
    const winAmount = player.currentBet.amount * this.currentMultiplier;
    player.currentBet.cashedOut = true;
    player.currentBet.cashoutMultiplier = this.currentMultiplier;
    player.balance += winAmount;
    player.totalWon += winAmount;
    
    return {
      success: true,
      multiplier: this.currentMultiplier,
      winAmount: winAmount,
      betAmount: player.currentBet.amount,
      newBalance: player.balance
    };
  }
  
  getPlayer(socketId) {
    return this.players.get(socketId);
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
      activeBets: activeBets,
      roundHistory: this.roundHistory.slice(0, 10)
    };
  }
  
  getPlayerCount() {
    return this.players.size;
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
}

// Initialize game engine
const gameEngine = new GameEngine();
gameEngine.start();

// ==================== SOCKET.IO EVENT HANDLERS ====================
io.on('connection', (socket) => {
  console.log(`[SOCKET] Player connected: ${socket.id}`);
  
  // Send current game state immediately
  socket.emit('game_state', gameEngine.getGameState());
  
  // Register player
  socket.on('register_player', (data) => {
    const player = gameEngine.registerPlayer(socket.id, data);
    socket.emit('player_registered', player);
    io.emit('players_online', gameEngine.getPlayerCount());
    io.emit('active_bets_update', gameEngine.getActiveBets());
  });
  
  // Place bet
  socket.on('place_bet', (data, callback) => {
    const result = gameEngine.placeBet(socket.id, data.amount);
    
    if (callback) callback(result);
    
    if (result.success) {
      // Broadcast to all clients
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
  
  // Cashout
  socket.on('cashout', (data, callback) => {
    const result = gameEngine.cashout(socket.id, data.multiplier);
    
    if (callback) callback(result);
    
    if (result.success) {
      // Broadcast to all clients
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
  
  // Get active bets
  socket.on('get_active_bets', () => {
    socket.emit('active_bets_update', gameEngine.getActiveBets());
  });
  
  // Get history
  socket.on('get_history', () => {
    socket.emit('history_update', gameEngine.roundHistory);
  });
  
  // Disconnect
  socket.on('disconnect', () => {
    console.log(`[SOCKET] Player disconnected: ${socket.id}`);
    gameEngine.removePlayer(socket.id);
    io.emit('players_online', gameEngine.getPlayerCount());
    io.emit('active_bets_update', gameEngine.getActiveBets());
  });
  
  // Heartbeat
  socket.on('ping', () => {
    socket.emit('pong');
  });
});

// ==================== START SERVER ====================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`[SERVER] Running on http://localhost:${PORT}`);
  console.log(`[SERVER] WebSocket server ready`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('[SERVER] Shutting down...');
  gameEngine.gameActive = false;
  if (gameEngine.updateInterval) clearInterval(gameEngine.updateInterval);
  server.close(() => process.exit(0));
});
