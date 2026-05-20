<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no">
  <title>Aviator – Works Perfectly</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script src="https://cdn.socket.io/4.7.2/socket.io.min.js"></script>
  <style>
    body { background: #0a0b0c; font-family: 'Inter', sans-serif; }
    canvas { display: block; width: 100%; height: auto; background: #060b13; border-radius: 1rem; }
    .btn-cashout { background: #f97316 !important; }
    .btn-bet { background: #28a909 !important; }
  </style>
</head>
<body class="flex justify-center items-center min-h-screen p-4">
  <div class="w-full max-w-md bg-[#0a0b0c] rounded-2xl shadow-2xl overflow-hidden">
    <div class="bg-[#101112] px-4 py-3 flex justify-between items-center border-b border-gray-800">
      <span class="text-orange-500 font-black text-2xl italic">AVIATOR</span>
      <div class="flex items-center gap-2">
        <span class="text-green-500 font-bold text-xl" id="balance">0.00</span>
      </div>
    </div>

    <div class="p-3 relative">
      <div class="relative">
        <canvas id="gameCanvas" class="w-full aspect-[4/2.5]"></canvas>
        <div class="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div class="text-6xl sm:text-7xl font-black text-white drop-shadow-lg" id="multiplierDisplay">1.00x</div>
        </div>
        <div id="waitingOverlay" class="absolute inset-0 bg-black/80 flex items-center justify-center rounded-xl hidden">
          <div class="text-center">
            <div class="w-24 h-24 mx-auto mb-3 bg-amber-500 rounded-full flex items-center justify-center text-4xl">✈️</div>
            <div class="text-white text-lg font-bold">Next round starting...</div>
          </div>
        </div>
      </div>
    </div>

    <div class="p-3 bg-[#1b1c1d] mx-3 rounded-xl">
      <div class="flex gap-2">
        <div class="flex-1 bg-black rounded-full flex items-center justify-between px-3 py-2">
          <button id="minusBtn" class="w-8 h-8 rounded-full bg-gray-800 text-white font-bold">-</button>
          <span id="betAmount" class="text-white font-bold text-xl">10.00</span>
          <button id="plusBtn" class="w-8 h-8 rounded-full bg-gray-800 text-white font-bold">+</button>
        </div>
        <button id="actionBtn" class="flex-1 btn-bet text-white font-bold py-3 rounded-full text-xl transition">Bet</button>
      </div>
      <div class="grid grid-cols-4 gap-2 mt-3">
        <button class="quickBet bg-gray-800 py-2 rounded-full text-sm" data-amount="10">10</button>
        <button class="quickBet bg-gray-800 py-2 rounded-full text-sm" data-amount="25">25</button>
        <button class="quickBet bg-gray-800 py-2 rounded-full text-sm" data-amount="50">50</button>
        <button class="quickBet bg-gray-800 py-2 rounded-full text-sm" data-amount="100">100</button>
      </div>
    </div>

    <div class="p-3 mt-2">
      <div class="text-gray-400 text-xs mb-1">LAST CRASHES</div>
      <div id="historyBar" class="flex gap-2 overflow-x-auto pb-2"></div>
    </div>
    <div class="p-3 border-t border-gray-800 mt-2 text-center text-gray-500 text-xs">
      <span>⚡ Real‑time WebSocket | Plane moves with multiplier</span>
    </div>
  </div>

  <script>
    // ---------- CONFIGURATION ----------
    // *** CHANGE THIS TO YOUR VPS IP OR DOMAIN ***
    const BACKEND_URL = 'https://aviator-server-puy9.onrender.com';   // <-- your Render URL
    const API_URL = BACKEND_URL + '/api';
    const WS_URL = BACKEND_URL;

    let currentBetId = null;
    let activeBet = { amount: 0, cashedOut: false };
    let currentBetAmount = 10;
    let balance = 0;

    let gameState = { status: 'WAITING', multiplier: 1, progress: 0 };
    let planeProgress = 0;
    let currentMultiplier = 1;

    // Canvas
    const canvas = document.getElementById('gameCanvas');
    const ctx = canvas.getContext('2d');
    let planeImg = new Image();
    planeImg.src = 'https://cdn-icons-png.flaticon.com/512/194/194632.png';
    let planeLoaded = false;
    planeImg.onload = () => planeLoaded = true;

    function resizeCanvas() {
      const rect = canvas.getBoundingClientRect();
      canvas.width = rect.width * devicePixelRatio;
      canvas.height = rect.height * devicePixelRatio;
    }
    window.addEventListener('resize', resizeCanvas);
    resizeCanvas();

    // ---------- REST API calls ----------
    async function apiCall(endpoint, method = 'GET', body = null) {
      const options = { method, headers: { 'Content-Type': 'application/json' } };
      if (body) options.body = JSON.stringify(body);
      const res = await fetch(API_URL + endpoint, options);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'API error');
      return data;
    }

    async function fetchBalance() {
      try {
        const data = await apiCall('/user/balance');
        balance = data.balance;
        document.getElementById('balance').innerText = balance.toFixed(2);
      } catch(e) { console.warn(e); }
    }

    async function placeBet(amount) {
      if (gameState.status !== 'WAITING') {
        alert('Can only bet before round starts');
        return false;
      }
      try {
        const data = await apiCall('/game/bet', 'POST', { amount });
        currentBetId = data.betId;
        activeBet = { amount, cashedOut: false };
        balance = data.newBalance;
        document.getElementById('balance').innerText = balance.toFixed(2);
        updateActionButton();
        return true;
      } catch(e) {
        alert(e.message);
        return false;
      }
    }

    async function cashOut() {
      if (!currentBetId || activeBet.cashedOut) return;
      try {
        const data = await apiCall('/game/cashout', 'POST', { betId: currentBetId });
        activeBet.cashedOut = true;
        balance = data.newBalance;
        document.getElementById('balance').innerText = balance.toFixed(2);
        updateActionButton();
      } catch(e) {
        alert(e.message);
      }
    }

    async function fetchHistory() {
      try {
        const data = await apiCall('/game/history');
        const historyBar = document.getElementById('historyBar');
        if (!data.length) {
          historyBar.innerHTML = '<span class="text-gray-500 text-xs">No rounds yet</span>';
          return;
        }
        historyBar.innerHTML = data.map(h => `<span class="bg-purple-900/30 px-3 py-1 rounded-full text-purple-400 text-xs">${h.crashPoint.toFixed(2)}x</span>`).join('');
      } catch(e) {}
    }

    function updateActionButton() {
      const btn = document.getElementById('actionBtn');
      if (gameState.status === 'IN_GAME' && currentBetId && !activeBet.cashedOut) {
        const winValue = (activeBet.amount * currentMultiplier).toFixed(2);
        btn.innerHTML = `Cashout ${winValue}`;
        btn.classList.remove('btn-bet');
        btn.classList.add('btn-cashout');
      } else {
        btn.innerHTML = `Bet ${currentBetAmount.toFixed(2)}`;
        btn.classList.remove('btn-cashout');
        btn.classList.add('btn-bet');
      }
    }

    // ---------- WebSocket ----------
    let socket = null;
    function connectWebSocket() {
      socket = io(WS_URL, { transports: ['websocket'] });
      socket.on('connect', () => console.log('✅ WebSocket connected'));
      socket.on('gameState', (data) => {
        console.log('gameState', data);
        gameState.status = data.status;
        gameState.multiplier = data.multiplier;
        gameState.progress = data.progress || 0;
        planeProgress = gameState.progress;
        currentMultiplier = data.multiplier;
        document.getElementById('multiplierDisplay').innerText = data.multiplier.toFixed(2) + 'x';
        const waitingOverlay = document.getElementById('waitingOverlay');
        if (data.status === 'WAITING') {
          waitingOverlay.classList.remove('hidden');
        } else {
          waitingOverlay.classList.add('hidden');
        }
        if (data.status === 'CRASHED') {
          document.getElementById('multiplierDisplay').classList.add('text-red-500');
        } else {
          document.getElementById('multiplierDisplay').classList.remove('text-red-500');
        }
        updateActionButton();
      });
      socket.on('multiplierUpdate', (data) => {
        currentMultiplier = data.multiplier;
        planeProgress = data.progress;
        document.getElementById('multiplierDisplay').innerHTML = data.multiplier.toFixed(2) + 'x';
        updateActionButton();
      });
      socket.on('gameCrashed', (data) => {
        gameState.status = 'CRASHED';
        currentMultiplier = data.crashPoint;
        planeProgress = 1;
        document.getElementById('multiplierDisplay').innerHTML = data.crashPoint.toFixed(2) + 'x';
        document.getElementById('multiplierDisplay').classList.add('text-red-500');
        document.getElementById('waitingOverlay').classList.add('hidden');
        if (currentBetId && !activeBet.cashedOut) {
          currentBetId = null;
          activeBet.cashedOut = true;
        }
        updateActionButton();
        fetchHistory();
      });
      socket.on('disconnect', () => console.warn('WebSocket disconnected'));
    }

    // ---------- Drawing (plane disappears on crash) ----------
    function drawPlane(progress) {
      if (!canvas.width || !canvas.height) return;
      const w = canvas.width, h = canvas.height;
      ctx.clearRect(0, 0, w, h);
      // background dots
      ctx.fillStyle = '#0ea5e9';
      for (let i = 20; i < h-20; i += h*0.15) {
        ctx.beginPath(); ctx.arc(15, i, 3, 0, Math.PI*2); ctx.fill();
      }
      ctx.fillStyle = '#e2e8f0';
      for (let i = 40; i < w; i += w*0.1) {
        ctx.beginPath(); ctx.arc(i, h-15, 3, 0, Math.PI*2); ctx.fill();
      }

      // If crashed (progress >= 1), don't draw the plane
      if (progress >= 0.99) return;

      const startX = 15, startY = h - 15;
      let x = startX + (w * 0.8) * progress;
      let y = startY - (h * 0.4) * progress;
      y += Math.sin(Date.now() * 0.01) * 3 * (1 - progress);

      if (planeLoaded) {
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(-0.3 + progress * 0.2);
        ctx.drawImage(planeImg, -35, -35, 70, 70);
        ctx.restore();
      } else {
        ctx.fillStyle = 'white';
        ctx.beginPath(); ctx.moveTo(x, y-15); ctx.lineTo(x+25, y); ctx.lineTo(x, y+15); ctx.fill();
      }

      // trail
      if (progress > 0.01) {
        ctx.beginPath();
        ctx.moveTo(startX, startY);
        for (let p = 0; p <= progress; p += 0.05) {
          let px = startX + (w * 0.8) * p;
          let py = startY - (h * 0.4) * p;
          ctx.lineTo(px, py);
        }
        ctx.strokeStyle = '#ef4444';
        ctx.lineWidth = 4;
        ctx.stroke();
      }
    }

    function animate() {
      drawPlane(planeProgress);
      requestAnimationFrame(animate);
    }
    animate();

    // ---------- Event listeners ----------
    document.getElementById('actionBtn').addEventListener('click', async () => {
      if (gameState.status === 'IN_GAME' && currentBetId && !activeBet.cashedOut) {
        await cashOut();
      } else if (gameState.status === 'WAITING') {
        await placeBet(currentBetAmount);
      } else {
        alert('Wait for next round');
      }
    });
    document.getElementById('minusBtn').addEventListener('click', () => {
      if (currentBetAmount > 5) currentBetAmount -= 5;
      document.getElementById('betAmount').innerText = currentBetAmount.toFixed(2);
      updateActionButton();
    });
    document.getElementById('plusBtn').addEventListener('click', () => {
      if (currentBetAmount < 5000) currentBetAmount += 5;
      document.getElementById('betAmount').innerText = currentBetAmount.toFixed(2);
      updateActionButton();
    });
    document.querySelectorAll('.quickBet').forEach(btn => {
      btn.addEventListener('click', () => {
        currentBetAmount = parseFloat(btn.getAttribute('data-amount'));
        document.getElementById('betAmount').innerText = currentBetAmount.toFixed(2);
        updateActionButton();
      });
    });

    // ---------- Start ----------
    fetchBalance();
    fetchHistory();
    connectWebSocket();
    setInterval(fetchBalance, 5000);
  </script>
</body>
</html>
