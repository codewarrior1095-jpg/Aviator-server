const express = require('express');
const router = express.Router();
const { verifyAuthToken } = require('../auth-middleware');
const gameEngine = require('../game-engine');

router.post('/cashout', verifyAuthToken, async (req, res) => {
    try {
        const userId = req.user.uid;
        
        const result = await gameEngine.cashOut(userId);
        
        if (!result.success) {
            return res.status(400).json(result);
        }
        
        res.json(result);
        
    } catch (error) {
        console.error('Cashout error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

module.exports = router;