const express = require('express');
const router = express.Router();
const { verifyAuthToken } = require('../auth-middleware');
const gameEngine = require('../game-engine');

router.get('/game-state', verifyAuthToken, async (req, res) => {
    try {
        const userId = req.user.uid;
        const state = gameEngine.getGameState(userId);
        
        // Get user balance
        const balance = await gameEngine.getUserBalance(userId);
        
        res.json({
            success: true,
            ...state,
            balance: balance
        });
        
    } catch (error) {
        console.error('Game state error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

module.exports = router;