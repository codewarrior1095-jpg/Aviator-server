class RoundManager {
  constructor(gameEngine) {
    this.gameEngine = gameEngine;
    this.currentRound = null;
    this.roundHistory = [];
  }
  
  generateCrashPoint() {
    // Authoritative crash point generation
    // Uses exponential distribution for realistic probabilities
    const random = Math.random();
    
    // Modified exponential distribution
    // 70% chance: 1.00x - 2.00x
    // 20% chance: 2.00x - 5.00x
    // 8% chance: 5.00x - 10.00x
    // 2% chance: 10.00x - 100.00x
    
    let crashPoint;
    
    if (random < 0.70) {
      // Low range: 1.00 - 2.00
      crashPoint = 1.00 + Math.random() * 1.00;
    } else if (random < 0.90) {
      // Medium range: 2.00 - 5.00
      crashPoint = 2.00 + Math.random() * 3.00;
    } else if (random < 0.98) {
      // High range: 5.00 - 10.00
      crashPoint = 5.00 + Math.random() * 5.00;
    } else {
      // Very high range: 10.00 - 100.00
      crashPoint = 10.00 + Math.random() * 90.00;
    }
    
    return parseFloat(crashPoint.toFixed(2));
  }
  
  startRound() {
    this.currentRound = {
      id: Date.now(),
      startTime: Date.now(),
      crashPoint: this.generateCrashPoint(),
      bets: [],
      status: 'active'
    };
    
    return this.currentRound;
  }
  
  endRound(crashMultiplier) {
    if (!this.currentRound) return null;
    
    this.currentRound.status = 'crashed';
    this.currentRound.crashMultiplier = crashMultiplier;
    this.currentRound.endTime = Date.now();
    
    // Store in history
    this.roundHistory.unshift(this.currentRound);
    if (this.roundHistory.length > 50) {
      this.roundHistory.pop();
    }
    
    const endedRound = this.currentRound;
    this.currentRound = null;
    
    return endedRound;
  }
  
  getHistory(limit = 20) {
    return this.roundHistory.slice(0, limit);
  }
}

module.exports = RoundManager;
