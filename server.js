const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const GameEngine = require('./game/GameEngine');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  // Optimize for real-time gaming
  pingTimeout: 60000,
  pingInterval: 25000,
  transports: ['websocket', 'polling'],
  allowEIO3: true
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../frontend')));

// Game instance
const gameEngine = new GameEngine(io);

// Socket.IO connection handling
io.on('connection', (socket) => {
  console.log(`[Socket] Player connected: ${socket.id}`);
  
  // Send current game state immediately
  const currentState = gameEngine.getCurrentState();
  socket.emit('game_state', currentState);
  
  // Player registration
  socket.on('register_player', (data) => {
    const player = gameEngine.registerPlayer(socket.id, data);
    socket.emit('player_registered', player);
    io.emit('players_online', gameEngine.getPlayerCount());
  });
  
  // Place bet
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
    }
  });
  
  // Cashout
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
    }
  });
  
  // Disconnect
  socket.on('disconnect', () => {
    console.log(`[Socket] Player disconnected: ${socket.id}`);
    gameEngine.removePlayer(socket.id);
    io.emit('players_online', gameEngine.getPlayerCount());
  });
  
  // Heartbeat for connection health
  socket.on('ping', () => {
    socket.emit('pong');
  });
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`[Server] Running on port ${PORT}`);
  console.log(`[Game] Aviator crash game engine started`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('[Server] Shutting down gracefully...');
  gameEngine.stop();
  server.close(() => process.exit(0));
});
