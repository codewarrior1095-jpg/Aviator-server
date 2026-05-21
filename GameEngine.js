const RoundManager = require('./RoundManager');
const PlayerManager = require('./PlayerManager');

class GameEngine {
  constructor(io) {
    this.io = io;
    this.roundManager = new RoundManager(this);
    this.playerManager = new PlayerManager();
    this.currentMultiplier = 1.00;
    this.gameActive = false;
    this.updateInterval = null;
    this.lastUpdateTime = 0;
    
    this.start();
  }
  
  start() {
    console.log('[Engine] Starting game engine');
    this.startNewRound();
  }
  
  startNewRound() {
    this.gameActive = true;
    this.currentMultiplier = 1.00;
    this.lastUpdateTime = Date.now();
    
    // Generate crash point server-side (authoritative)
    const crashPoint = this.roundManager.generateCrashPoint();
    
    // Broadcast round start
    this.io.emit('round_start', {
      crashPoint: crashPoint,
      startTime: Date.now(),
      multiplier: 1.00
    });
    
    console.log(`[Round] Started - Crash at: ${crashPoint.toFixed(2)}x`);
    
    // Start multiplier updates
    this.startMultiplierUpdates(crashPoint);
  }
  
  startMultiplierUpdates(crashPoint) {
    if (this.updateInterval) clearInterval(this.updateInterval);
    
    // Update at 60 FPS for smooth animation (backend still lightweight)
    this.updateInterval = setInterval(() => {
      if (!this.gameActive) return;
      
      const now = Date.now();
      const elapsed = (now - this.lastUpdateTime) / 1000;
      
      // Exponential multiplier growth (smooth curve)
      let newMultiplier = 1.00 + Math.pow(elapsed, 1.2) * 1.5;
      
      // Check for crash
      if (newMultiplier >= crashPoint) {
        newMultiplier = crashPoint;
        this.crashRound(crashPoint);
        return;
      }
      
      this.currentMultiplier = parseFloat(newMultiplier.toFixed(3));
      
      // Send lightweight multiplier update
      this.io.emit('multiplier_update', {
        multiplier: this.currentMultiplier,
        timestamp: now
      });
      
    }, 50); // 20 updates per second (optimized)
  }
  
  crashRound(crashPoint) {
    if (!this.gameActive) return;
    
    this.gameActive = false;
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }
    
    // Final multiplier broadcast
    this.io.emit('crash', {
      multiplier: crashPoint,
      timestamp: Date.now()
    });
    
    console.log(`[Round] Crashed at ${crashPoint.toFixed(2)}x`);
    
    // Process all uncashed-out bets as losses
    const losses = this.playerManager.processAllUncashedBets(crashPoint);
    
    // Schedule next round after cooldown
    setTimeout(() => {
      this.startNewRound();
    }, 5000);
  }
  
  placeBet(playerId, amount) {
    if (!this.gameActive) {
      return { success: false, error: 'Round not active' };
    }
    
    const player = this.playerManager.getPlayer(playerId);
    if (!player) {
      return { success: false, error: 'Player not registered' };
    }
    
    // Validate amount
    if (amount < 10 || amount > 5000) {
      return { success: false, error: 'Invalid bet amount' };
    }
    
    // Check if already bet this round
    if (player.currentBet) {
      return { success: false, error: 'Bet already placed this round' };
    }
    
    // Place bet
    player.currentBet = {
      amount: amount,
      placedAt: Date.now(),
      cashedOut: false,
      cashoutMultiplier: null
    };
    
    return { 
      success: true, 
      bet: player.currentBet,
      currentMultiplier: this.currentMultiplier
    };
  }
  
  cashout(playerId, requestedMultiplier) {
    const player = this.playerManager.getPlayer(playerId);
    
    if (!player || !player.currentBet) {
      return { success: false, error: 'No active bet found' };
    }
    
    if (player.currentBet.cashedOut) {
      return { success: false, error: 'Already cashed out' };
    }
    
    if (!this.gameActive) {
      return { success: false, error: 'Round already ended' };
    }
    
    // Verify multiplier matches current (prevent cheating)
    if (Math.abs(requestedMultiplier - this.currentMultiplier) > 0.01) {
      return { success: false, error: 'Invalid multiplier' };
    }
    
    // Process cashout
    const winAmount = player.currentBet.amount * this.currentMultiplier;
    player.currentBet.cashedOut = true;
    player.currentBet.cashoutMultiplier = this.currentMultiplier;
    player.totalWon += winAmount;
    
    return {
      success: true,
      multiplier: this.currentMultiplier,
      winAmount: winAmount,
      betAmount: player.currentBet.amount
    };
  }
  
  registerPlayer(socketId, data) {
    return this.playerManager.addPlayer(socketId, {
      name: data.name || `Player_${socketId.substr(0, 6)}`,
      avatar: data.avatar || null,
      balance: data.balance || 10000
    });
  }
  
  removePlayer(socketId) {
    this.playerManager.removePlayer(socketId);
  }
  
  getPlayerName(socketId) {
    const player = this.playerManager.getPlayer(socketId);
    return player ? player.name : 'Unknown';
  }
  
  getCurrentState() {
    return {
      gameActive: this.gameActive,
      currentMultiplier: this.currentMultiplier,
      playersOnline: this.playerManager.getCount(),
      activeBets: this.playerManager.getActiveBetsCount()
    };
  }
  
  getPlayerCount() {
    return this.playerManager.getCount();
  }
  
  stop() {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
    }
  }
}

module.exports = GameEngine;
