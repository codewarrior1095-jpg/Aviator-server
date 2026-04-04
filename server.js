const express = require('express');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Store current game state (in production, use Redis or database)
let currentGameState = {
    roundId: null,
    crashPoint: null,
    isActive: false,
    startTime: null,
    serverSeed: null
};

// Generate secure random crash point
function generateCrashPoint() {
    const randomBytes = crypto.randomBytes(4);
    const randomValue = randomBytes.readUInt32BE() / 0xFFFFFFFF;
    
    let crashPoint = 0.99 / (1 - randomValue);
    if (crashPoint < 1.00) crashPoint = 1.00;
    if (crashPoint > 100) crashPoint = 100;
    
    return parseFloat(crashPoint.toFixed(2));
}

// Start a new round
app.post('/api/game/start', (req, res) => {
    const roundId = crypto.randomBytes(8).toString('hex');
    const crashPoint = generateCrashPoint();
    const serverSeed = crypto.randomBytes(32).toString('hex');
    
    currentGameState = {
        roundId: roundId,
        crashPoint: crashPoint,
        isActive: true,
        startTime: Date.now(),
        serverSeed: serverSeed,
        serverSeedHash: crypto.createHash('sha256').update(serverSeed).digest('hex')
    };
    
    console.log(`[GAME] Round ${roundId} started - Crash at ${crashPoint}x`);
    
    res.json({
        success: true,
        roundId: roundId,
        startTime: currentGameState.startTime,
        serverSeedHash: currentGameState.serverSeedHash
    });
});

// Get current game crash point (only revealed after crash)
app.get('/api/game/state', (req, res) => {
    if (!currentGameState.isActive) {
        // If game is not active, return that no game is running
        return res.json({
            success: true,
            isActive: false,
            message: "No active game round"
        });
    }
    
    res.json({
        success: true,
        isActive: true,
        roundId: currentGameState.roundId,
        startTime: currentGameState.startTime
        // crashPoint is NOT sent while game is active!
    });
});

// Check if game has crashed at a specific multiplier
app.post('/api/game/check-crash', (req, res) => {
    const { multiplier, roundId } = req.body;
    
    if (!currentGameState.isActive) {
        return res.json({
            success: true,
            hasCrashed: true,
            crashPoint: currentGameState.crashPoint || 1.00
        });
    }
    
    if (roundId !== currentGameState.roundId) {
        return res.status(400).json({
            success: false,
            error: "Invalid round ID"
        });
    }
    
    const hasCrashed = multiplier >= currentGameState.crashPoint;
    
    res.json({
        success: true,
        hasCrashed: hasCrashed,
        crashPoint: hasCrashed ? currentGameState.crashPoint : null,
        roundActive: !hasCrashed
    });
});

// Get crash result after round ends (for verification)
app.get('/api/game/result/:roundId', (req, res) => {
    const { roundId } = req.params;
    
    if (roundId !== currentGameState.roundId) {
        return res.status(404).json({
            success: false,
            error: "Round not found"
        });
    }
    
    res.json({
        success: true,
        roundId: currentGameState.roundId,
        crashPoint: currentGameState.crashPoint,
        serverSeedHash: currentGameState.serverSeedHash,
        // In production, reveal server seed after round for provably fair verification
        serverSeed: currentGameState.isActive ? null : currentGameState.serverSeed
    });
});

// Health check
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'running', 
        timestamp: Date.now(),
        activeGame: currentGameState.isActive
    });
});

// Root endpoint
app.get('/', (req, res) => {
    res.json({
        message: '🎮 Secure Aviator Backend',
        endpoints: {
            startGame: 'POST /api/game/start',
            gameState: 'GET /api/game/state',
            checkCrash: 'POST /api/game/check-crash',
            getResult: 'GET /api/game/result/:roundId',
            health: 'GET /api/health'
        }
    });
});

app.listen(PORT, () => {
    console.log(`✅ Secure Aviator server running on port ${PORT}`);
});
