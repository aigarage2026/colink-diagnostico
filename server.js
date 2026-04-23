const express = require('express');
const fetch   = require('node-fetch');
const path    = require('path');
const fs      = require('fs');
const { MongoClient } = require('mongodb');

const app  = express();
const PORT = process.env.PORT || 8080;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://colink:Colink2026@cluster0.j9nw5px.mongodb.net/?appName=Cluster0';

app.use(express.json({ limit: '50mb' }));

// ── MongoDB ───────────────────────────────────────────────────────────────────
let db = null, dbConnecting = false;

async function connectDB() {
  if (db || dbConnecting) return;
  dbConnecting = true;
  try {
    const client = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
    await client.connect();
    db = client.db('colink');
    dbConnecting = false;
    console.log('MongoDB conectado!');
  } catch (err) {
    dbConnecting = false;
    console.error('MongoDB erro:', err.message);
    throw err;
  }
}

const sessions  = () => db.collection('sessions');
const usageLogs = () => db.collection('usage_logs');
const config    = () => db.collection('config');

function dbReady(req, res, next) {
  if (!db) return res.status(503).json({ error: 'DB conectando. Tente novamente.', retry: true });
  next();
}

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

async function generateCode(clientName) {
  const count = await sessions().countDocuments({ clientName: { $regex: new RegExp('^' + clientName + '$', 'i') } });
  return '#' + String(count + 1).padStart(3, '0');
}

async function getPrices() {
  try {
    const cfg = await config().findOne({ key: 'prices' });
    return { input: cfg?.input ?? 0.150, output: cfg?.output ?? 0.600 };
  } catch(e) { return { input: 0.150, output: 0.600 }; }
}

// ── API ROUTES ────────────────────────────────────────────────────────────────

app.get('/api/health', (req, res) => {
  const pub = path.join(__dirname, 'public');
  let files = [];
  try { files = fs.readdirSync(pub); } catch(e) { files = ['err: ' + e.message]; }
  res.json({ ok: true, dir: __dirname, public: pub, files, indexExists: fs.existsSync(path.join(pub, 'index.html')) });
});

app.get('/api/sessions', dbReady, async (req, res) => {
  try {
    const list = await sessions().find({}, { projection: { messages: 0 } }).sort({ updatedAt: -1 }).toArray();
    res.json({ sessions: list.map(s => ({ id: s.id, code: s.code, clientName: s.clientName, messageCount: s.messageCount || 0, updatedAt: s.updatedAt, createdAt: s.createdAt })) });
  } catch (err) { res.status(500).json({ error: 'Erro listar sessoes.' }); }
});

app.post('/api/sessions', dbReady, async (req, res) => {
  try {
    const { clientName } = req.body;
    if (!clientName?.trim()) return res.status(400).json({ error: 'Nome obrigatorio.' });
    const id = generateId();
    const code = await generateCode(clientName.trim());
    await sessions().insertOne({ id, code, clientName: clientName.trim(), messages: [], messageCount: 0, tokensInput: 0, tokensOutput: 0, createdAt: Date.now(), updatedAt: Date.now() });
    res.json({ id, code, clientName: clientName.trim() });
  } catch (err) { res.status(500).json({ error: 'Erro criar sessao.' }); }
});

app.get('/api/sessions/:id', dbReady, async (req, res) => {
  try {
    const s = await sessions().findOne({ id: req.params.id });
    if (!s) return res.status(404).json({ error: 'Nao encontrada.' });
    res.json(s);
  } catch (err) { res.status(500).json({ error: 'Erro carregar.' }); }
});

app.post('/api/chat', dbReady, async (req, res) => {
  try {
    const { messages, max_tokens, sessionId, userDisplayContent } = req.body;
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + OPENAI_API_KEY },
      body: JSON.stringify({ model: 'gpt-4o-mini', max_tokens: max_tokens || 2000, messages })
    });
    const data = await response.json();
    if (sessionId && !data.error) {
      const reply = data.choices[0].message.content;
      const usage = data.usage || {};
      const tokIn = usage.prompt_tokens || 0;
      const tokOut = usage.completion_tokens || 0;
      const userMsg = messages[messages.length - 1];
      sessions().updateOne({ id: sessionId }, {
        $push: { messages: { $each: [
          { role: 'user', content: typeof userMsg.content === 'string' ? userMsg.content : JSON.stringify(userMsg.content), displayContent: userDisplayContent || '[mensagem]', timestamp: Date.now() },
          { role: 'assistant', content: reply, displayContent: reply, tokensInput: tokIn, tokensOutput: tokOut, timestamp: Date.now() }
        ]}},
        $inc: { messageCount: 2, tokensInput: tokIn, tokensOutput: tokOut },
        $set: { updatedAt: Date.now() }
      }).catch(e => console.error('Session update:', e.message));
      getPrices().then(prices => {
        usageLogs().insertOne({ sessionId, date: new Date().toISOString().slice(0,10), timestamp: Date.now(), tokensInput: tokIn, tokensOutput: tokOut, totalCost: (tokIn/1e6)*prices.input + (tokOut/1e6)*prices.output }).catch(() => {});
      });
    }
    res.json(data);
  } catch (err) { console.error('Chat:', err.message); res.status(500).json({ error: { message: 'Erro interno.' } }); }
});

app.post('/api/extract', async (req, res) => {
  const { name, data } = req.body;
  try {
    const buf = Buffer.from(data.includes(',') ? data.split(',')[1] : data, 'base64');
    const ext = name.split('.').pop().toLowerCase();
    let text = '';
    if (ext === 'pdf') { const p = require('pdf-parse'); const r = await p(buf); text = '=== PDF: ' + name + ' ===\n' + r.text; }
    else if (ext === 'docx' || ext === 'doc') { const m = require('mammoth'); const r = await m.extractRawText({ buffer: buf }); text = '=== WORD: ' + name + ' ===\n' + r.value; }
    else if (ext === 'txt') { text = buf.toString('utf-8'); }
    else { text = '[Tipo nao suportado: ' + name + ']'; }
    res.json({ text: text.slice(0, 30000) });
  } catch (err) { res.json({ text: '[Erro: ' + err.message + ']' }); }
});

app.get('/api/analytics', dbReady, async (req, res) => {
  try {
    const prices = await getPrices();
    const totals = await usageLogs().aggregate([{ $group: { _id: null, totalInput: {$sum:'$tokensInput'}, totalOutput: {$sum:'$tokensOutput'}, totalCost: {$sum:'$totalCost'}, totalCalls: {$sum:1} }}]).toArray();
    const byDay = await usageLogs().aggregate([{ $group: { _id:'$date', tokensInput:{$sum:'$tokensInput'}, tokensOutput:{$sum:'$tokensOutput'}, cost:{$sum:'$totalCost'}, calls:{$sum:1} }}, { $sort:{_id:1} }, { $limit:30 }]).toArray();
    const bySession = await sessions().find({},{projection:{messages:0}}).sort({tokensInput:-1}).limit(10).toArray();
    res.json({ prices, totals: totals[0] || {totalInput:0,totalOutput:0,totalCost:0,totalCalls:0}, byDay, bySession });
  } catch (err) { res.status(500).json({ error: 'Erro analytics.' }); }
});

app.patch('/api/prices', dbReady, async (req, res) => {
  try {
    const { input, output } = req.body;
    await config().updateOne({ key:'prices' }, { $set: { key:'prices', input: parseFloat(input), output: parseFloat(output) } }, { upsert: true });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Erro precos.' }); }
});

app.post('/api/report', async (req, res) => {
  try {
    const { messages } = req.body;
    if (!messages || !Array.isArray(messages)) return res.status(400).json({ error: { message: 'messages required' } });
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + OPENAI_API_KEY },
      body: JSON.stringify({ model: 'gpt-4o-mini', max_tokens: 3000, temperature: 0.3, messages })
    });
    const data = await response.json();
    if (data.error) return res.status(500).json({ error: data.error });
    res.json(data);
  } catch (err) { res.status(500).json({ error: { message: 'Erro report: ' + err.message } }); }
});

// ── STATIC ────────────────────────────────────────────────────────────────────
// Try public/ subdir first, then root dir (handles both Railway structures)
const PUBLIC_DIR = fs.existsSync(path.join(__dirname, 'public', 'index.html'))
  ? path.join(__dirname, 'public')
  : __dirname;

console.log('PUBLIC_DIR:', PUBLIC_DIR);
console.log('index.html found:', fs.existsSync(path.join(PUBLIC_DIR, 'index.html')));

app.use(express.static(PUBLIC_DIR));
app.get('*', (req, res) => {
  const f = path.join(PUBLIC_DIR, 'index.html');
  if (fs.existsSync(f)) return res.sendFile(f);
  // Debug: list files
  let debug = 'index.html not found. __dirname=' + __dirname + ' PUBLIC_DIR=' + PUBLIC_DIR;
  try { debug += ' | root: ' + fs.readdirSync(__dirname).slice(0,20).join(','); } catch(e) {}
  res.status(500).send(debug);
});

// ── START ─────────────────────────────────────────────────────────────────────
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log('Colink porta', PORT);
  connectDB().catch(() => {
    const t = setInterval(async () => {
      try { await connectDB(); clearInterval(t); } catch(e) { console.error('DB retry:', e.message); }
    }, 5000);
  });
});
server.timeout = 180000;
server.keepAliveTimeout = 120000;
