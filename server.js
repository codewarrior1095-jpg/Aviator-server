const express = require('express');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Simple test route for the root
app.get('/', (req, res) => {
    res.json({ message: 'Aviator Backend is running!' });
});

// Your crash point endpoint
app.get('/api/crash-point', (req, res) => {
    const randomBytes = crypto.randomBytes(4);
    const randomValue = randomBytes.readUInt32BE() / 0xFFFFFFFF;
    
    let crashPoint = 0.99 / (1 - randomValue);
    if (crashPoint < 1.00) crashPoint = 1.00;
    if (crashPoint > 100) crashPoint = 100;
    
    res.json({ 
        success: true, 
        crashPoint: parseFloat(crashPoint.toFixed(2)),
        timestamp: Date.now()
    });
});

app.get('/api/health', (req, res) => {
    res.json({ status: 'alive', time: Date.now() });
});

app.listen(PORT, () => {
    console.log(`✅ Server running on port ${PORT}`);
});
