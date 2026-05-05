import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ===== HIDDEN GAME ENGINE (Server-side) =====
class AviatorEngine {
  constructor() {
    this.gameState = 'WAITING';
    this.multiplier = 1.00;
    this.crashPoint = 0;
    this.gameStartTime = null;
    this.currentGameId = null;
  }

  // Generate crash point (algorithm kept secret on server)
  generateCrashPoint() {
    // This algorithm is HIDDEN from clients
    // Players cannot see or modify this logic
    const randomValue = Math.random();
    const houseEdge = 0.97; // 3% house edge
    
    // Complex algorithm that determines when plane crashes
    let crashMultiplier;
    if (randomValue < 0.7) {
      crashMultiplier = 1 + (Math.random() * 4);
    } else if (randomValue < 0.9) {
      crashMultiplier = 5 + (Math.random() * 15);
    } else {
      crashMultiplier = 20 + (Math.random() * 80);
    }
    
    crashMultiplier = Math.min(crashMultiplier, 100);
    crashMultiplier = parseFloat(crashMultiplier.toFixed(2));
    
    console.log(`🎮 New game - Crash point: ${crashMultiplier}x (Hidden from client)`);
    return crashMultiplier;
  }

  startNewGame() {
    this.gameState = 'ACTIVE';
    this.crashPoint = this.generateCrashPoint();
    this.multiplier = 1.00;
    this.gameStartTime = Date.now();
    this.currentGameId = Math.random().toString(36).substr(2, 9);
    
    return {
      gameId: this.currentGameId,
      startTime: this.gameStartTime
    };
  }

  getCurrentMultiplier() {
    if (this.gameState !== 'ACTIVE') return 1.00;
    
    const elapsed = (Date.now() - this.gameStartTime) / 1000;
    // Exponential growth formula (hidden on server)
    let multiplier = Math.pow(Math.E, 0.07 * elapsed);
    
    if (multiplier >= this.crashPoint) {
      multiplier = this.crashPoint;
      this.gameState = 'CRASHED';
      console.log(`💥 Game crashed at ${multiplier}x`);
      
      // Schedule next game after 2.5 seconds
      setTimeout(() => {
        this.startNewGame();
        io.emit('game_started', this.getGameState());
      }, 2500);
    }
    
    this.multiplier = parseFloat(multiplier.toFixed(2));
    return this.multiplier;
  }

  getGameState() {
    return {
      state: this.gameState,
      multiplier: this.getCurrentMultiplier(),
      crashPoint: this.gameState === 'CRASHED' ? this.crashPoint : null,
      gameId: this.currentGameId
    };
  }
}

// Initialize game engine
const gameEngine = new AviatorEngine();
gameEngine.startNewGame();

// Game loop - updates multiplier 60 times per second
setInterval(() => {
  const gameState = gameEngine.getGameState();
  io.emit('game_update', gameState);
}, 1000 / 60);

// Socket.io connection handling
io.on('connection', (socket) => {
  console.log('🎮 Player connected:', socket.id);
  
  // Send current game state to new player
  socket.emit('game_update', gameEngine.getGameState());
  
  // Handle bet placement
  socket.on('place_bet', (data) => {
    console.log(`💰 Bet placed: $${data.amount} by ${socket.id}`);
    // Process bet (store in database, etc.)
    socket.emit('bet_confirmed', { 
      success: true, 
      amount: data.amount,
      timestamp: Date.now()
    });
  });
  
  socket.on('disconnect', () => {
    console.log('👋 Player disconnected:', socket.id);
  });
});

// API endpoint for REST calls
app.get('/api/game/state', (req, res) => {
  res.json(gameEngine.getGameState());
});

app.post('/api/bet/place', (req, res) => {
  const { amount, userId } = req.body;
  // Process bet logic here
  res.json({ success: true, amount, message: 'Bet placed successfully' });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`🚀 Aviator server running on port ${PORT}`);
  console.log(`🔒 Game engine is hidden from client-side`);
});