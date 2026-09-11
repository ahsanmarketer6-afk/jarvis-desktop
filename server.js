const express = require('express');
const path = require('path');

const app = express();
const PORT = 3000;
const HOST = '0.0.0.0';

// Serve static assets from renderer directory
const rendererDir = path.join(__dirname, 'renderer');
app.use(express.static(rendererDir));

// Health check endpoint
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', app: 'JARVIS OS', timestamp: new Date().toISOString() });
});

// Single Page Application / Desktop renderer fallback
app.use((_req, res) => {
  res.sendFile(path.join(rendererDir, 'index.html'));
});

app.listen(PORT, HOST, () => {
  console.log(`[JARVIS OS] Server running at http://${HOST}:${PORT}`);
});
