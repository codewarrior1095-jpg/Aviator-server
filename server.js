require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');

const setupWebSocketServer = require('./websocket');
const gameEngine = require('./game-engine');
const betRoutes = require('./routes/bet');
const cashoutRoutes = require('./routes/cashout');
const gameStateRoutes = require('./routes/game-state');

const app = express();
const server = http.createServer(app);

// Middleware
app.use(cors());
app.use(express.json());

// Health check
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'running', 
        timestamp: Date.now(),
        gameActive: gameEngine.currentRound?.isActive || false
    });
});

// API Routes
app.use('/api', betRoutes);
app.use('/api', cashoutRoutes);
app.use('/api', gameStateRoutes);

// Setup WebSocket
setupWebSocketServer(server);

// Start game engine
gameEngine.start();

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Secure Aviator backend running on port ${PORT}`);
    console.log(`🔒 Server-authoritative mode - ALL game logic is server-side`);
});