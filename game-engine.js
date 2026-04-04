const crypto = require('crypto');
const { db } = require('./firebase-admin');

class GameEngine {
    constructor() {
        this.currentRound = null;
        this.activeBets = new Map(); // roundId -> Map of userId -> bet
        this.multiplierInterval = null;
        this.wsClients = new Map(); // userId -> WebSocket
        this.isRunning = false;
    }

    // Generate provably fair crash point
    generateCrashPoint(serverSeed, clientSeed, nonce) {
        const combined = `${serverSeed}:${clientSeed}:${nonce}`;
        const hash = crypto.createHash('sha256').update(combined).digest('hex');
        const randomValue = parseInt(hash.substring(0, 8), 16) / 0xFFFFFFFF;
        
        let crashPoint = 0.99 / (1 - randomValue);
        if (crashPoint < 1.00) crashPoint = 1.00;
        if (crashPoint > 1000) crashPoint = 1000;
        
        return parseFloat(crashPoint.toFixed(2));
    }

    // Start new round
    async startNewRound() {
        if (this.currentRound && this.currentRound.isActive) {
            await this.endRound();
        }

        const roundId = crypto.randomBytes(8).toString('hex');
        const serverSeed = crypto.randomBytes(32).toString('hex');
        const clientSeed = crypto.randomBytes(16).toString('hex');
        const nonce = Date.now();

        const crashPoint = this.generateCrashPoint(serverSeed, clientSeed, nonce);

        this.currentRound = {
            roundId: roundId,
            crashPoint: crashPoint,
            multiplier: 1.00,
            isActive: true,
            startTime: Date.now(),
            serverSeed: serverSeed,
            clientSeed: clientSeed,
            nonce: nonce,
            serverSeedHash: crypto.createHash('sha256').update(serverSeed).digest('hex')
        };

        // Clear active bets for new round
        this.activeBets.clear();

        console.log(`[ROUND] ${roundId} started - Crash at ${crashPoint}x`);

        // Broadcast round start
        this.broadcast({
            type: 'round_start',
            roundId: roundId,
            startTime: this.currentRound.startTime,
            serverSeedHash: this.currentRound.serverSeedHash
        });

        // Start multiplier progression
        this.startMultiplierProgression();

        // Store round in Firebase for audit
        await db.ref(`rounds/${roundId}`).set({
            crashPoint: crashPoint,
            startTime: this.currentRound.startTime,
            serverSeedHash: this.currentRound.serverSeedHash,
            status: 'active'
        });

        return this.currentRound;
    }

    // Server-side multiplier progression
    startMultiplierProgression() {
        if (this.multiplierInterval) clearInterval(this.multiplierInterval);

        const startTime = this.currentRound.startTime;

        this.multiplierInterval = setInterval(async () => {
            if (!this.currentRound || !this.currentRound.isActive) {
                if (this.multiplierInterval) clearInterval(this.multiplierInterval);
                return;
            }

            const elapsed = (Date.now() - startTime) / 1000;
            let multiplier = Math.pow(Math.E, 0.06 * elapsed);
            multiplier = parseFloat(multiplier.toFixed(2));

            // Check crash condition
            if (multiplier >= this.currentRound.crashPoint) {
                multiplier = this.currentRound.crashPoint;
                this.currentRound.multiplier = multiplier;
                
                this.broadcast({
                    type: 'multiplier_update',
                    multiplier: multiplier,
                    roundId: this.currentRound.roundId
                });

                await this.endRound();
                return;
            }

            this.currentRound.multiplier = multiplier;

            // Broadcast multiplier to all clients
            this.broadcast({
                type: 'multiplier_update',
                multiplier: multiplier,
                roundId: this.currentRound.roundId
            });
        }, 100); // 100ms updates for smooth animation
    }

    // End current round - process all non-cashed out bets as losses
    async endRound() {
        if (!this.currentRound || !this.currentRound.isActive) return;

        this.currentRound.isActive = false;
        console.log(`[ROUND] ${this.currentRound.roundId} ended at ${this.currentRound.multiplier}x`);

        // Process all active bets that didn't cash out
        const roundBets = this.activeBets.get(this.currentRound.roundId) || new Map();
        
        for (const [userId, bet] of roundBets.entries()) {
            if (!bet.hasCashedOut) {
                // User lost their bet
                await this.processLoss(userId, bet);
            }
        }

        // Store round result
        await db.ref(`rounds/${this.currentRound.roundId}`).update({
            finalMultiplier: this.currentRound.multiplier,
            endTime: Date.now(),
            status: 'completed',
            serverSeed: this.currentRound.serverSeed // Reveal for provably fair
        });

        // Broadcast round end
        this.broadcast({
            type: 'round_end',
            roundId: this.currentRound.roundId,
            crashPoint: this.currentRound.crashPoint,
            finalMultiplier: this.currentRound.multiplier,
            serverSeed: this.currentRound.serverSeed
        });

        // Schedule next round in 5 seconds
        setTimeout(async () => {
            await this.startNewRound();
        }, 5000);
    }

    // Process bet placement (called from API)
    async placeBet(userId, betAmount, extraMultiplier = 1.0) {
        // Validate round is active
        if (!this.currentRound || !this.currentRound.isActive) {
            return { success: false, error: 'No active round' };
        }

        // Check if user already has bet in this round
        const roundBets = this.activeBets.get(this.currentRound.roundId) || new Map();
        if (roundBets.has(userId)) {
            return { success: false, error: 'Bet already placed this round' };
        }

        // Get user balance from Firebase (source of truth)
        const balance = await this.getUserBalance(userId);
        
        if (betAmount > balance) {
            return { success: false, error: 'Insufficient balance' };
        }

        // Deduct bet amount
        const newBalance = balance - betAmount;
        await this.updateUserBalance(userId, newBalance, {
            type: 'bet',
            amount: betAmount,
            roundId: this.currentRound.roundId,
            multiplierAtBet: this.currentRound.multiplier
        });

        // Store bet
        const bet = {
            userId: userId,
            amount: betAmount,
            extraMultiplier: extraMultiplier,
            hasCashedOut: false,
            betTime: Date.now(),
            multiplierAtBet: this.currentRound.multiplier,
            roundId: this.currentRound.roundId
        };

        roundBets.set(userId, bet);
        this.activeBets.set(this.currentRound.roundId, roundBets);

        // Store bet in Firebase for audit
        const betId = `${this.currentRound.roundId}_${userId}`;
        await db.ref(`bets/${betId}`).set(bet);

        console.log(`[BET] User ${userId} bet $${betAmount} (x${extraMultiplier})`);

        return {
            success: true,
            balance: newBalance,
            betAmount: betAmount,
            currentMultiplier: this.currentRound.multiplier
        };
    }

    // Process cashout
    async cashOut(userId) {
        // Validate round is active
        if (!this.currentRound || !this.currentRound.isActive) {
            return { success: false, error: 'No active round' };
        }

        // Get user's bet
        const roundBets = this.activeBets.get(this.currentRound.roundId);
        if (!roundBets || !roundBets.has(userId)) {
            return { success: false, error: 'No active bet found' };
        }

        const bet = roundBets.get(userId);
        
        if (bet.hasCashedOut) {
            return { success: false, error: 'Already cashed out' };
        }

        // Calculate payout SERVER-SIDE
        const cashoutMultiplier = this.currentRound.multiplier * bet.extraMultiplier;
        const winAmount = bet.amount * cashoutMultiplier;

        // Mark as cashed out
        bet.hasCashedOut = true;
        bet.cashoutMultiplier = cashoutMultiplier;
        bet.cashoutTime = Date.now();
        bet.payoutAmount = winAmount;

        // Update user balance with winnings
        const currentBalance = await this.getUserBalance(userId);
        const newBalance = currentBalance + winAmount;
        
        await this.updateUserBalance(userId, newBalance, {
            type: 'cashout',
            betAmount: bet.amount,
            winAmount: winAmount,
            multiplier: cashoutMultiplier,
            roundId: this.currentRound.roundId
        });

        // Update bet record
        await db.ref(`bets/${bet.roundId}_${userId}`).update({
            hasCashedOut: true,
            cashoutMultiplier: cashoutMultiplier,
            cashoutTime: bet.cashoutTime,
            payoutAmount: winAmount
        });

        console.log(`[CASHOUT] User ${userId} won $${winAmount.toFixed(2)} at ${cashoutMultiplier}x`);

        return {
            success: true,
            winAmount: winAmount,
            multiplier: cashoutMultiplier,
            balance: newBalance
        };
    }

    // Process loss (no cashout)
    async processLoss(userId, bet) {
        await this.updateUserBalance(userId, null, {
            type: 'loss',
            betAmount: bet.amount,
            roundId: this.currentRound.roundId,
            crashedAt: this.currentRound.multiplier
        });

        // Update bet record
        await db.ref(`bets/${bet.roundId}_${userId}`).update({
            crashedAt: this.currentRound.multiplier,
            status: 'lost'
        });

        console.log(`[LOSS] User ${userId} lost $${bet.amount}`);
    }

    // Get user balance from Firebase
    async getUserBalance(userId) {
        const snapshot = await db.ref(`users/${userId}/balance`).once('value');
        return snapshot.val() || 1000;
    }

    // Update user balance (ONLY backend can do this)
    async updateUserBalance(userId, newBalance, transaction = null) {
        if (newBalance !== null) {
            await db.ref(`users/${userId}/balance`).set(newBalance);
        }
        
        // Log transaction for audit trail
        if (transaction) {
            const auditRef = db.ref(`transactions/${Date.now()}_${userId}`);
            await auditRef.set({
                userId: userId,
                ...transaction,
                timestamp: Date.now(),
                serverProcessed: true
            });
        }

        // Notify user via WebSocket
        const ws = this.wsClients.get(userId);
        if (ws && ws.readyState === 1) { // WebSocket.OPEN
            ws.send(JSON.stringify({
                type: 'balance_update',
                balance: newBalance !== null ? newBalance : await this.getUserBalance(userId)
            }));
        }
    }

    // Get current game state
    getGameState(userId = null) {
        const state = {
            roundActive: this.currentRound ? this.currentRound.isActive : false,
            roundId: this.currentRound ? this.currentRound.roundId : null,
            currentMultiplier: this.currentRound ? this.currentRound.multiplier : 1.00,
            serverSeedHash: this.currentRound ? this.currentRound.serverSeedHash : null
        };

        // Add user's bet info if requested
        if (userId && this.currentRound && this.currentRound.isActive) {
            const roundBets = this.activeBets.get(this.currentRound.roundId);
            if (roundBets && roundBets.has(userId)) {
                const bet = roundBets.get(userId);
                state.userBet = {
                    amount: bet.amount,
                    extraMultiplier: bet.extraMultiplier,
                    hasCashedOut: bet.hasCashedOut,
                    potentialPayout: bet.hasCashedOut ? null : 
                        (this.currentRound.multiplier * bet.extraMultiplier * bet.amount)
                };
            }
        }

        return state;
    }

    // Register WebSocket client
    registerClient(userId, ws) {
        this.wsClients.set(userId, ws);
        
        // Send current game state on connection
        ws.send(JSON.stringify({
            type: 'game_state',
            ...this.getGameState(userId)
        }));
    }

    // Unregister WebSocket client
    unregisterClient(userId) {
        this.wsClients.delete(userId);
    }

    // Broadcast to all connected clients
    broadcast(message) {
        const data = JSON.stringify(message);
        for (const [userId, ws] of this.wsClients.entries()) {
            if (ws.readyState === 1) { // WebSocket.OPEN
                ws.send(data);
            }
        }
    }

    // Start the game engine
    async start() {
        if (this.isRunning) return;
        this.isRunning = true;
        await this.startNewRound();
        console.log('[ENGINE] Game engine started');
    }
}

module.exports = new GameEngine();