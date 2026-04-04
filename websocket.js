const WebSocket = require('ws');
const { verifyWebSocketToken } = require('./auth-middleware');
const gameEngine = require('./game-engine');

function setupWebSocketServer(server) {
    const wss = new WebSocket.Server({ server });

    wss.on('connection', async (ws, req) => {
        // Extract token from query string
        const url = new URL(req.url, `http://${req.headers.host}`);
        const token = url.searchParams.get('token');
        
        if (!token) {
            ws.close(1008, 'No authentication token');
            return;
        }

        const userId = await verifyWebSocketToken(token);
        
        if (!userId) {
            ws.close(1008, 'Invalid authentication token');
            return;
        }

        console.log(`[WS] User ${userId} connected`);
        gameEngine.registerClient(userId, ws);

        ws.on('close', () => {
            console.log(`[WS] User ${userId} disconnected`);
            gameEngine.unregisterClient(userId);
        });

        ws.on('error', (error) => {
            console.error(`[WS] Error for user ${userId}:`, error);
        });
    });

    return wss;
}

module.exports = setupWebSocketServer;