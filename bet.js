const express = require('express');
const router = express.Router();
const { verifyAuthToken } = require('../auth-middleware');
const gameEngine = require('../game-engine');

router.post('/bet', verifyAuthToken, async (req, res) => {
    try {
        const userId = req.user.uid;
        const { amount, extraMultiplier = false } = req.body;
        
        // Validate bet amount
        const betAmount = parseFloat(amount);
        if (isNaN(betAmount) || betAmount < 0.10 || betAmount > 1000) {
            return res.status(400).json({ 
                success: false, 
                error: 'Invalid bet amount. Must be between $0.10 and $1000' 
            });
        }

        const extra = extraMultiplier ? 1.2 : 1.0;
        
        const result = await gameEngine.placeBet(userId, betAmount, extra);
        
        if (!result.success) {
            return res.status(400).json(result);
        }
        
        res.json(result);
        
    } catch (error) {
        console.error('Bet error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

module.exports = router;