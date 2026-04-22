const express = require('express');
const fetch   = require('node-fetch');
const path    = require('path');
const { MongoClient } = require('mongodb');

const app  = express();
const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MONGODB_URI    = process.env.MONGODB_URI || 'mongodb+srv://colink:Colink2026@cluster0.j9nw5px.mongodb.net/?appName=Cluster0';

const DEFAULT_PRICE_INPUT  = 0.150;
const DEFAULT_PRICE_OUTPUT = 0.600;

app.use(express.json({ limit: '20mb' }));

// ── MongoDB ───────────────────────────────────────────────────────────────────
let db = null;
let dbConnecting = false;

async function connectDB() {
  if (db || dbConnecting) return;
  dbConnecting = true;
  try {
    const client = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
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
  if (!db) return res.status(503).json({ error: 'Banco de dados conectando. Tente em alguns segundos.', retry: true });
  next();
}

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

async function generateCode(clientName) {
  const count = await sessions().countDocuments({
    clientName: { $regex: new RegExp('^' + clientName + '$', 'i') }
  });
  return '#' + String(count + 1).padStart(3, '0');
}

async function getPrices() {
  const cfg = await config().findOne({ key: 'prices' });
  return { input: cfg?.input ?? DEFAULT_PRICE_INPUT, output: cfg?.output ?? DEFAULT_PRICE_OUTPUT };
}

// ── API ROUTES ────────────────────────────────────────────────────────────────
// IMPORTANT: API routes must come BEFORE express.static

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', db: db ? 'connected' : 'connecting', ts: Date.now() });
});

app.get('/api/sessions', dbReady, async (req, res) => {
  try {
    const list = await sessions()
      .find({}, { projection: { messages: 0 } })
      .sort({ updatedAt: -1 }).toArray();
    res.json({ sessions: list.map(s => ({
      id: s.id, code: s.code, clientName: s.clientName,
      messageCount: s.messageCount || 0,
      tokensInput: s.tokensInput || 0, tokensOutput: s.tokensOutput || 0,
      updatedAt: s.updatedAt, createdAt: s.createdAt
    }))});
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao listar sessoes.' });
  }
});

app.post('/api/sessions', dbReady, async (req, res) => {
  try {
    const { clientName } = req.body;
    if (!clientName || !clientName.trim()) return res.status(400).json({ error: 'Nome do cliente e obrigatorio.' });
    const id   = generateId();
    const code = await generateCode(clientName.trim());
    const session = {
      id, code, clientName: clientName.trim(),
      messages: [], messageCount: 0,
      tokensInput: 0, tokensOutput: 0,
      createdAt: Date.now(), updatedAt: Date.now()
    };
    await sessions().insertOne(session);
    res.json({ id, code, clientName: session.clientName });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao criar sessao.' });
  }
});

app.get('/api/sessions/:id', dbReady, async (req, res) => {
  try {
    const s = await sessions().findOne({ id: req.params.id });
    if (!s) return res.status(404).json({ error: 'Sessao nao encontrada.' });
    res.json(s);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao carregar sessao.' });
  }
});

app.post('/api/chat', dbReady, async (req, res) => {
  try {
    const { messages, max_tokens, sessionId, userDisplayContent } = req.body;

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + OPENAI_API_KEY },
      body: JSON.stringify({ model: 'gpt-4o-mini', max_tokens: max_tokens || 1500, messages })
    });
    const data = await response.json();

    if (sessionId && !data.error) {
      const reply  = data.choices[0].message.content;
      const usage  = data.usage || {};
      const tokIn  = usage.prompt_tokens     || 0;
      const tokOut = usage.completion_tokens || 0;
      const userMsg = messages[messages.length - 1];

      await sessions().updateOne(
        { id: sessionId },
        {
          $push: { messages: { $each: [
            {
              role: 'user',
              content: typeof userMsg.content === 'string' ? userMsg.content : JSON.stringify(userMsg.content),
              displayContent: userDisplayContent || (typeof userMsg.content === 'string' ? userMsg.content : '[arquivo]'),
              timestamp: Date.now()
            },
            {
              role: 'assistant', content: reply, displayContent: reply,
              tokensInput: tokIn, tokensOutput: tokOut, timestamp: Date.now()
            }
          ]}},
          $inc: { messageCount: 2, tokensInput: tokIn, tokensOutput: tokOut },
          $set: { updatedAt: Date.now() }
        }
      );

      const prices = await getPrices();
      await usageLogs().insertOne({
        sessionId,
        date: new Date().toISOString().slice(0, 10),
        timestamp: Date.now(),
        tokensInput: tokIn,
        tokensOutput: tokOut,
        costInput:  (tokIn  / 1000000) * prices.input,
        costOutput: (tokOut / 1000000) * prices.output,
        totalCost:  (tokIn  / 1000000) * prices.input + (tokOut / 1000000) * prices.output
      });
    }
    res.json(data);
  } catch (err) {
    console.error('Erro /api/chat:', err.message);
    res.status(500).json({ error: { message: 'Erro interno no servidor.' } });
  }
});

app.post('/api/extract', async (req, res) => {
  const { name, data } = req.body;
  try {
    const base64 = data.includes(',') ? data.split(',')[1] : data;
    const buffer = Buffer.from(base64, 'base64');
    const ext = name.split('.').pop().toLowerCase();
    let text = '';
    if (ext === 'pdf') {
      const pdfParse = require('pdf-parse');
      const parsed   = await pdfParse(buffer);
      text = '=== PDF: ' + name + ' ===\nPaginas: ' + parsed.numpages + '\n\n' + parsed.text;
    } else if (ext === 'docx' || ext === 'doc') {
      const mammoth = require('mammoth');
      const result  = await mammoth.extractRawText({ buffer });
      text = '=== WORD: ' + name + ' ===\n\n' + result.value;
    } else if (ext === 'txt') {
      text = '=== TXT: ' + name + ' ===\n\n' + buffer.toString('utf-8');
    } else {
      text = '[Tipo nao suportado: ' + name + ']';
    }
    res.json({ text: text.slice(0, 30000) });
  } catch (err) {
    res.json({ text: '[Erro ao extrair ' + name + ': ' + err.message + ']' });
  }
});

app.get('/api/analytics', dbReady, async (req, res) => {
  try {
    const prices = await getPrices();
    const totals = await usageLogs().aggregate([
      { $group: { _id: null, totalInput: {$sum:'$tokensInput'}, totalOutput:{$sum:'$tokensOutput'}, totalCost:{$sum:'$totalCost'}, totalCalls:{$sum:1} }}
    ]).toArray();
    const byDay = await usageLogs().aggregate([
      { $group: { _id:'$date', tokensInput:{$sum:'$tokensInput'}, tokensOutput:{$sum:'$tokensOutput'}, cost:{$sum:'$totalCost'}, calls:{$sum:1} }},
      { $sort: { _id: 1 } },
      { $limit: 30 }
    ]).toArray();
    const bySession = await sessions().find({}, { projection: { messages: 0 } }).sort({ tokensInput: -1 }).limit(10).toArray();
    res.json({
      prices,
      totals: totals[0] || { totalInput: 0, totalOutput: 0, totalCost: 0, totalCalls: 0 },
      byDay,
      bySession: bySession.map(s => ({
        id: s.id, code: s.code, clientName: s.clientName,
        tokensInput: s.tokensInput || 0, tokensOutput: s.tokensOutput || 0,
        messageCount: s.messageCount || 0, updatedAt: s.updatedAt
      }))
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao carregar analytics.' });
  }
});

app.patch('/api/prices', dbReady, async (req, res) => {
  try {
    const { input, output } = req.body;
    await config().updateOne(
      { key: 'prices' },
      { $set: { key: 'prices', input: parseFloat(input), output: parseFloat(output) } },
      { upsert: true }
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Erro ao salvar precos.' }); }
});

// ── STATIC FILES (AFTER all API routes) ──────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// SPA fallback — for any non-API route serve index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── START ─────────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log('Colink rodando na porta ' + PORT);
  // Connect DB in background — server is already responding
  connectDB().catch(() => {
    const retryInterval = setInterval(async () => {
      try {
        await connectDB();
        clearInterval(retryInterval);
      } catch (e) {
        console.error('DB retry:', e.message);
      }
    }, 5000);
  });
});
