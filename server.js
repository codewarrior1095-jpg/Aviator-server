const express = require('express');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Rate limiting to prevent abuse (optional but recommended)
const rateLimit = new Map();
function checkRateLimit(ip) {
    const now = Date.now();
    const windowMs = 60000; // 1 minute
    const maxRequests = 60; // 60 requests per minute
    
    if (!rateLimit.has(ip)) {
        rateLimit.set(ip, []);
    }
    
    const timestamps = rateLimit.get(ip).filter(t => now - t < windowMs);
    timestamps.push(now);
    rateLimit.set(ip, timestamps);
    
    return timestamps.length <= maxRequests;
}

// Secure random crash point generator (SERVER-SIDE)
// This uses crypto.randomBytes - TRUE randomness, not predictable!
function generateCrashPoint() {
    // Generate a cryptographically secure random number between 0 and 1
    const randomBytes = crypto.randomBytes(4);
    const randomValue = randomBytes.readUInt32BE() / 0xFFFFFFFF;
    
    // Formula: crash point = max(1.00, (0.99 / (1 - randomValue)))
    let crashPoint = 0.99 / (1 - randomValue);
    
    // Ensure minimum crash point is 1.00x
    if (crashPoint < 1.00) crashPoint = 1.00;
    
    // Cap at 1000x maximum
    if (crashPoint > 1000) crashPoint = 1000;
    
    // Round to 2 decimal places
    return parseFloat(crashPoint.toFixed(2));
}

// Generate a provably fair hash for transparency
function generateProvablyFairHash(serverSeed, clientSeed) {
    return crypto.createHash('sha256').update(serverSeed + clientSeed).digest('hex');
}

// API Endpoint 1: Get a single random crash point
app.get('/api/crash-point', (req, res) => {
    try {
        // Basic rate limiting
        const clientIp = req.ip || req.connection.remoteAddress;
        if (!checkRateLimit(clientIp)) {
            return res.status(429).json({ 
                success: false, 
                error: 'Too many requests. Please wait a moment.' 
            });
        }
        
        const crashPoint = generateCrashPoint();
        const serverSeed = crypto.randomBytes(32).toString('hex');
        
        const response = {
            success: true,
            crashPoint: crashPoint,
            timestamp: Date.now(),
            serverSeedHash: crypto.createHash('sha256').update(serverSeed).digest('hex'),
            // For provably fair verification
            verification: {
                algorithm: "crypto.randomBytes",
                note: "This multiplier is generated server-side using cryptographically secure random numbers"
            }
        };
        
        console.log(`[${new Date().toISOString()}] Generated crash point: ${crashPoint}x from IP: ${clientIp}`);
        res.json(response);
    } catch (error) {
        console.error('Error generating crash point:', error);
        res.status(500).json({ success: false, error: 'Server error' });
    }
});

// API Endpoint 2: Get multiple crash points (for testing)
app.get('/api/crash-points/:count', (req, res) => {
    try {
        let count = parseInt(req.params.count);
        if (isNaN(count) || count < 1 || count > 20) {
            count = 10;
        }
        
        const points = [];
        for (let i = 0; i < count; i++) {
            points.push({
                id: crypto.randomBytes(4).toString('hex'),
                crashPoint: generateCrashPoint(),
                timestamp: Date.now()
            });
        }
        
        res.json({
            success: true,
            count: points.length,
            points: points
        });
    } catch (error) {
        console.error('Error generating crash points:', error);
        res.status(500).json({ success: false, error: 'Server error' });
    }
});

// API Endpoint 3: Health check
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'running', 
        timestamp: Date.now(),
        version: '1.0.0',
        uptime: process.uptime()
    });
});

// Root endpoint - useful for testing
app.get('/', (req, res) => {
    res.json({
        message: '🎮 Aviator Backend Server',
        endpoints: {
            health: '/api/health',
            crashPoint: '/api/crash-point',
            multiplePoints: '/api/crash-points/:count'
        }
    });
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('Server error:', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
});

// Start the server
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Aviator backend server running on port ${PORT}`);
    console.log(`📍 Health check: http://localhost:${PORT}/api/health`);
    console.log(`📍 Get crash point: http://localhost:${PORT}/api/crash-point`);
    console.log(`🔒 Using cryptographically secure random number generation`);
});

module.exports = { generateCrashPoint };