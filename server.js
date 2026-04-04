const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const cors = require('cors');
const admin = require('firebase-admin');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
require('dotenv').config();

// ========== FIREBASE ADMIN INITIALIZATION ==========
// Download service account key from Firebase Console > Project Settings > Service Accounts
const serviceAccount = require('./firebase-admin.json');

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: process.env.FIREBASE_DB_URL
});

const db = admin.database();

// ========== EXPRESS APP ==========
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(cors());
app.use(express.json());

// ========== GAME STATE ==========
let currentRound = {
    roundId: null,
    crashPoint: null,
    multiplier: 1.00,
    isActive: false,
    startTime: null,
    serverSeed: null,
    clientSeed: null,
    nonce: 0
};

// Active bets per user (stored in memory, could use Redis in production)
const activeBets = new Map(); // roundId -> Map of userId -> bet

// Connected WebSocket clients
const wsClients = new Map(); // userId -> WebSocket

// ========== PROVABLY FAIR CRASH POINT GENERATION ==========
function generateCrashPoint(serverSeed, clientSeed, nonce) {
    // Combine seeds with nonce
    const combined = `${serverSeed}:${clientSeed}:${nonce}`;
    const hash = crypto.createHash('sha256').update(combined).digest('hex');
    
    // Convert first 8 characters to a number between 0 and 1
    const randomValue = parseInt(hash.substring(0, 8), 16) / 0xFFFFFFFF;
    
    // Crash point formula (house edge ~1%)
    let crashPoint = 0.99 / (1 - randomValue);
    
    if (crashPoint < 1.00) crashPoint = 1.00;
    if (crashPoint > 1000) crashPoint = 1000;
    
    return parseFloat(crashPoint.toFixed(2));
}

// ========== VERIFY FIREBASE ID TOKEN ==========
async function verifyAuthToken(req, ws = null, userId = null) {
    try {
        let token;
        
        if (ws) {
            // For WebSocket, token is passed in query string during connection
            // We'll handle this in the WebSocket connection handler
            return userId;
        } else {
            // For HTTP requests
            const authHeader = req.headers.authorization;
            if (!authHeader || !authHeader.startsWith('Bearer ')) {
                throw new Error('No token provided');
            }
            token = authHeader.split('Bearer ')[1];
            const decodedToken = await admin.auth().verifyIdToken(token);
            return decodedToken.uid;
        }
    } catch (error) {
        console.error('Auth error:', error);
        return null;
    }
}

// ========== GET USER BALANCE ==========
async function getUserBalance(uid) {
    const snapshot = await db.ref(`users/${uid}/balance`).once('value');
    return snapshot.val() || 1000; // Default starting balance
}

async function updateUserBalance(uid, newBalance, transaction = null) {
    await db.ref(`users/${uid}/balance`).set(newBalance);
    
    // Log transaction for audit
    if (transaction) {
        await db.ref(`transactions/${Date.now()}_${uid}`).set({
            uid,
            ...transaction,
            timestamp: Date.now()
        });
    }
    
    // Notify user via WebSocket of balance change
    const ws = wsClients.get(uid);
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
            type: 'balance_update',
            balance: newBalance
        }));
    }
    
    return newBalance;
}

// ========== START NEW ROUND ==========
async function startNewRound() {
    // Close current round if active
    if (currentRound.isActive) {
        await endRound();
    }
    
    // Generate new round seeds
    const serverSeed = crypto.randomBytes(32).toString('hex');
    const clientSeed = crypto.randomBytes(16).toString('hex');
    const nonce = currentRound.nonce + 1;
    
    // Generate crash point
    const crashPoint = generateCrashPoint(serverSeed, clientSeed, nonce);
    
    currentRound = {
        roundId: uuidv4(),
        crashPoint: crashPoint,
        multiplier: 1.00,
        isActive: true,
        startTime: Date.now(),
        serverSeed: serverSeed,
        clientSeed: clientSeed,
        nonce: nonce,
        serverSeedHash: crypto.createHash('sha256').update(serverSeed).digest('hex')
    };
    
    console.log(`[ROUND] New round ${currentRound.roundId} started - Crash at ${crashPoint}x`);
    
    // Clear active bets for new round
    activeBets.clear();
    
    // Broadcast round start to all clients
    broadcastToAll({
        type: 'round_start',
        roundId: currentRound.roundId,
        startTime: currentRound.startTime,
        serverSeedHash: currentRound.serverSeedHash
    });
    
    // Start multiplier progression
    startMultiplierProgression();
    
    return currentRound;
}

// ========== MULTIPLIER PROGRESSION (Server-side) ==========
let multiplierInterval = null;

function startMultiplierProgression() {
    if (multiplierInterval) clearInterval(multiplierInterval);
    
    const startTime = currentRound.startTime;
    let lastMultiplier = 1.00;
    
    multiplierInterval = setInterval(async () => {
        if (!currentRound.isActive) {
            if (multiplierInterval) clearInterval(multiplierInterval);
            return;
        }
        
        const elapsed = (Date.now() - startTime) / 1000;
        // Exponential growth formula
        let multiplier = Math.pow(Math.E, 0.06 * elapsed);
        multiplier = parseFloat(multiplier.toFixed(2));
        
        // Check if we've reached crash point
        if (multiplier >= currentRound.crashPoint) {
            multiplier = currentRound.crashPoint;
            currentRound.multiplier = multiplier;
            
            // Broadcast final multiplier
            broadcastToAll({
                type: 'multiplier_update',
                multiplier: multiplier,
                roundId: currentRound.roundId
            });
            
            // End the round
            await endRound();
            return;
        }
        
        currentRound.multiplier = multiplier;
        
        // Broadcast multiplier to all clients
        broadcastToAll({
            type: 'multiplier_update',
            multiplier: multiplier,
            roundId: currentRound.roundId
        });
        
        lastMultiplier = multiplier;
    }, 100); // Update every 100ms for smooth animation
}

// ========== END ROUND ==========
async function endRound() {
    if (!currentRound.isActive) return;
    
    currentRound.isActive = false;
    console.log(`[ROUND] Round ${currentRound.roundId} ended at ${currentRound.multiplier}x`);
    
    // Process all active bets that didn't cash out
    for (const [userId, bet] of activeBets.entries()) {
        if (!bet.hasCashedOut) {
            // User lost their bet
            console.log(`[LOSS] User ${userId} lost $${bet.amount} - didn't cash out`);
            
            // Record loss in history
            await db.ref(`users/${userId}/betHistory/${Date.now()}`).set({
                roundId: currentRound.roundId,
                betAmount: bet.amount,
                cashoutAmount: 0,
                multiplier: currentRound.multiplier,
                result: -bet.amount,
                crashedAt: currentRound.multiplier,
                timestamp: Date.now(),
                status: 'crashed'
            });
        }
    }
    
    // Clear active bets
    activeBets.clear();
    
    // Broadcast round end
    broadcastToAll({
        type: 'round_end',
        roundId: currentRound.roundId,
        crashPoint: currentRound.crashPoint,
        finalMultiplier: currentRound.multiplier,
        serverSeed: currentRound.serverSeed, // Reveal seed for provably fair verification
        clientSeed: currentRound.clientSeed
    });
    
    // Schedule next round after 5 seconds
    setTimeout(async () => {
        await startNewRound();
    }, 5000);
}

// ========== PLACE BET ==========
app.post('/api/bet', async (req, res) => {
    try {
        // Verify user
        const uid = await verifyAuthToken(req);
        if (!uid) {
            return res.status(401).json({ success: false, error: 'Unauthorized' });
        }
        
        const { amount, extraMultiplier } = req.body;
        const betAmount = parseFloat(amount);
        const extra = extraMultiplier === true ? 1.2 : 1.0;
        
        // Validate bet amount
        if (isNaN(betAmount) || betAmount < 0.10 || betAmount > 1000) {
            return res.status(400).json({ success: false, error: 'Invalid bet amount' });
        }
        
        // Check if round is active
        if (!currentRound.isActive) {
            return res.status(400).json({ success: false, error: 'No active round' });
        }
        
        // Check if user already has a bet in this round
        if (activeBets.has(uid)) {
            return res.status(400).json({ success: false, error: 'Bet already placed this round' });
        }
        
        // Get user balance
        const balance = await getUserBalance(uid);
        
        // Check sufficient balance
        if (betAmount > balance) {
            return res.status(400).json({ success: false, error: 'Insufficient balance' });
        }
        
        // Deduct bet amount from balance
        const newBalance = balance - betAmount;
        await updateUserBalance(uid, newBalance, {
            type: 'bet',
            amount: betAmount,
            roundId: currentRound.roundId,
            multiplierAtBet: currentRound.multiplier
        });
        
        // Store active bet
        activeBets.set(uid, {
            amount: betAmount,
            extraMultiplier: extra,
            hasCashedOut: false,
            betTime: Date.now(),
            multiplierAtBet: currentRound.multiplier
        });
        
        console.log(`[BET] User ${uid} placed $${betAmount} bet (x${extra}) in round ${currentRound.roundId}`);
        
        res.json({
            success: true,
            betId: `${currentRound.roundId}_${uid}`,
            amount: betAmount,
            extraMultiplier: extra,
            currentMultiplier: currentRound.multiplier,
            balance: newBalance
        });
        
    } catch (error) {
        console.error('Bet error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// ========== CASHOUT ==========
app.post('/api/cashout', async (req, res) => {
    try {
        // Verify user
        const uid = await verifyAuthToken(req);
        if (!uid) {
            return res.status(401).json({ success: false, error: 'Unauthorized' });
        }
        
        // Check if round is active
        if (!currentRound.isActive) {
            return res.status(400).json({ success: false, error: 'No active round' });
        }
        
        // Check if user has an active bet
        const bet = activeBets.get(uid);
        if (!bet) {
            return res.status(400).json({ success: false, error: 'No active bet found' });
        }
        
        // Check if already cashed out
        if (bet.hasCashedOut) {
            return res.status(400).json({ success: false, error: 'Already cashed out' });
        }
        
        // Calculate payout
        const cashoutMultiplier = currentRound.multiplier * bet.extraMultiplier;
        const winAmount = bet.amount * cashoutMultiplier;
        
        // Mark as cashed out
        bet.hasCashedOut = true;
        bet.cashoutMultiplier = cashoutMultiplier;
        bet.cashoutTime = Date.now();
        
        // Update user balance with winnings
        const currentBalance = await getUserBalance(uid);
        const newBalance = currentBalance + winAmount;
        await updateUserBalance(uid, newBalance, {
            type: 'cashout',
            betAmount: bet.amount,
            winAmount: winAmount,
            multiplier: cashoutMultiplier,
            roundId: currentRound.roundId
        });
        
        // Record in history
        await db.ref(`users/${uid}/betHistory/${Date.now()}`).set({
            roundId: currentRound.roundId,
            betAmount: bet.amount,
            cashoutAmount: winAmount,
            multiplier: cashoutMultiplier,
            result: winAmount - bet.amount,
            cashedOutAt: currentRound.multiplier,
            timestamp: Date.now(),
            status: 'cashed_out'
        });
        
        console.log(`[CASHOUT] User ${uid} cashed out $${winAmount.toFixed(2)} at ${cashoutMultiplier}x`);
        
        res.json({
            success: true,
            winAmount: winAmount,
            multiplier: cashoutMultiplier,
            balance: newBalance
        });
        
    } catch (error) {
        console.error('Cashout error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// ========== GET GAME STATE ==========
app.get('/api/game-state', async (req, res) => {
    try {
        const uid = await verifyAuthToken(req);
        if (!uid) {
            return res.status(401).json({ success: false, error: 'Unauthorized' });
        }
        
        const userBet = activeBets.get(uid);
        
        res.json({
            success: true,
            roundActive: currentRound.isActive,
            roundId: currentRound.roundId,
            currentMultiplier: currentRound.multiplier,
            crashPoint: currentRound.isActive ? null : currentRound.crashPoint,
            userBet: userBet ? {
                amount: userBet.amount,
                extraMultiplier: userBet.extraMultiplier,
                hasCashedOut: userBet.hasCashedOut,
                potentialPayout: userBet.hasCashedOut ? null : 
                    (currentRound.multiplier * userBet.extraMultiplier * userBet.amount)
            } : null,
            serverSeedHash: currentRound.serverSeedHash
        });
        
    } catch (error) {
        console.error('Game state error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// ========== GET USER BALANCE ==========
app.get('/api/balance', async (req, res) => {
    try {
        const uid = await verifyAuthToken(req);
        if (!uid) {
            return res.status(401).json({ success: false, error: 'Unauthorized' });
        }
        
        const balance = await getUserBalance(uid);
        res.json({ success: true, balance: balance });
        
    } catch (error) {
        console.error('Balance error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// ========== GET BET HISTORY ==========
app.get('/api/history', async (req, res) => {
    try {
        const uid = await verifyAuthToken(req);
        if (!uid) {
            return res.status(401).json({ success: false, error: 'Unauthorized' });
        }
        
        const snapshot = await db.ref(`users/${uid}/betHistory`).once('value');
        const history = snapshot.val() || {};
        
        // Convert object to array and sort by timestamp
        const historyArray = Object.entries(history).map(([key, value]) => ({
            id: key,
            ...value
        })).sort((a, b) => b.timestamp - a.timestamp).slice(0, 20);
        
        res.json({ success: true, history: historyArray });
        
    } catch (error) {
        console.error('History error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// ========== WEBSOCKET CONNECTION ==========
wss.on('connection', async (ws, req) => {
    // Extract token from query string
    const url = new URL(req.url, `http://${req.headers.host}`);
    const token = url.searchParams.get('token');
    
    if (!token) {
        ws.close(1008, 'No authentication token');
        return;
    }
    
    try {
        const decodedToken = await admin.auth().verifyIdToken(token);
        const uid = decodedToken.uid;
        
        wsClients.set(uid, ws);
        
        // Send current game state
        ws.send(JSON.stringify({
            type: 'game_state',
            roundActive: currentRound.isActive,
            roundId: currentRound.roundId,
            currentMultiplier: currentRound.multiplier,
            serverSeedHash: currentRound.serverSeedHash
        }));
        
        // Send user balance
        const balance = await getUserBalance(uid);
        ws.send(JSON.stringify({
            type: 'balance_update',
            balance: balance
        }));
        
        console.log(`[WS] User ${uid} connected`);
        
        ws.on('close', () => {
            wsClients.delete(uid);
            console.log(`[WS] User ${uid} disconnected`);
        });
        
        ws.on('error', (error) => {
            console.error(`[WS] Error for user ${uid}:`, error);
        });
        
    } catch (error) {
        console.error('WebSocket auth error:', error);
        ws.close(1008, 'Invalid token');
    }
});

function broadcastToAll(message) {
    const data = JSON.stringify(message);
    for (const [uid, ws] of wsClients.entries()) {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(data);
        }
    }
}

// ========== HEALTH CHECK ==========
app.get('/api/health', (req, res) => {
    res.json({
        status: 'running',
        roundActive: currentRound.isActive,
        roundId: currentRound.roundId,
        connectedClients: wsClients.size,
        timestamp: Date.now()
    });
});

// ========== START SERVER ==========
const PORT = process.env.PORT || 3000;

server.listen(PORT, async () => {
    console.log(`🚀 Secure Aviator server running on port ${PORT}`);
    console.log(`🔒 Server-authoritative mode enabled`);
    
    // Initialize first round
    await startNewRound();
});
