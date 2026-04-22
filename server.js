const express = require('express');
const zlib = require('zlib');
const fetch   = require('node-fetch');
const path    = require('path');
const { MongoClient } = require('mongodb');

const app  = express();
const PORT = process.env.PORT || 8080;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MONGODB_URI    = process.env.MONGODB_URI || 'mongodb+srv://colink:Colink2026@cluster0.j9nw5px.mongodb.net/?appName=Cluster0';

const DEFAULT_PRICE_INPUT  = 0.150;
const DEFAULT_PRICE_OUTPUT = 0.600;

app.use(express.json({ limit: '50mb' }));

// ── MongoDB ───────────────────────────────────────────────────────────────────
let db = null;
let dbConnecting = false;

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
  try {
    const cfg = await config().findOne({ key: 'prices' });
    return { input: cfg?.input ?? DEFAULT_PRICE_INPUT, output: cfg?.output ?? DEFAULT_PRICE_OUTPUT };
  } catch(e) {
    return { input: DEFAULT_PRICE_INPUT, output: DEFAULT_PRICE_OUTPUT };
  }
}

// ── API ROUTES ────────────────────────────────────────────────────────────────

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', db: db ? 'connected' : 'connecting', port: PORT, ts: Date.now() });
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
    res.status(500).json({ error: 'Erro ao listar sessoes.' });
  }
});

app.post('/api/sessions', dbReady, async (req, res) => {
  try {
    const { clientName } = req.body;
    if (!clientName || !clientName.trim()) return res.status(400).json({ error: 'Nome obrigatorio.' });
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
    res.status(500).json({ error: 'Erro ao criar sessao.' });
  }
});

app.get('/api/sessions/:id', dbReady, async (req, res) => {
  try {
    const s = await sessions().findOne({ id: req.params.id });
    if (!s) return res.status(404).json({ error: 'Nao encontrada.' });
    res.json(s);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao carregar.' });
  }
});

app.post('/api/chat', dbReady, async (req, res) => {
  try {
    const { messages, max_tokens, sessionId, userDisplayContent } = req.body;

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + OPENAI_API_KEY },
      body: JSON.stringify({ model: 'gpt-4o-mini', max_tokens: max_tokens || 4000, messages })
    });
    const data = await response.json();

    if (sessionId && !data.error) {
      const reply  = data.choices[0].message.content;
      const usage  = data.usage || {};
      const tokIn  = usage.prompt_tokens || 0;
      const tokOut = usage.completion_tokens || 0;
      const userMsg = messages[messages.length - 1];

      await sessions().updateOne(
        { id: sessionId },
        {
          $push: { messages: { $each: [
            { role:'user',
              content: typeof userMsg.content==='string' ? userMsg.content : JSON.stringify(userMsg.content),
              displayContent: userDisplayContent || (typeof userMsg.content==='string' ? userMsg.content : '[arquivo]'),
              timestamp: Date.now() },
            { role:'assistant', content:reply, displayContent:reply,
              tokensInput:tokIn, tokensOutput:tokOut, timestamp:Date.now() }
          ]}},
          $inc: { messageCount:2, tokensInput:tokIn, tokensOutput:tokOut },
          $set: { updatedAt: Date.now() }
        }
      ).catch(e => console.error('Session update error:', e.message));

      getPrices().then(prices => {
        usageLogs().insertOne({
          sessionId, date: new Date().toISOString().slice(0,10), timestamp: Date.now(),
          tokensInput:tokIn, tokensOutput:tokOut,
          costInput:(tokIn/1000000)*prices.input, costOutput:(tokOut/1000000)*prices.output,
          totalCost:(tokIn/1000000)*prices.input+(tokOut/1000000)*prices.output
        }).catch(()=>{});
      });
    }
    res.json(data);
  } catch (err) {
    console.error('Chat error:', err.message);
    res.status(500).json({ error: { message: 'Erro interno.' } });
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
    res.json({ text: '[Erro: ' + err.message + ']' });
  }
});

app.get('/api/analytics', dbReady, async (req, res) => {
  try {
    const prices = await getPrices();
    const totals = await usageLogs().aggregate([
      { $group: { _id:null, totalInput:{$sum:'$tokensInput'}, totalOutput:{$sum:'$tokensOutput'}, totalCost:{$sum:'$totalCost'}, totalCalls:{$sum:1} }}
    ]).toArray();
    const byDay = await usageLogs().aggregate([
      { $group: { _id:'$date', tokensInput:{$sum:'$tokensInput'}, tokensOutput:{$sum:'$tokensOutput'}, cost:{$sum:'$totalCost'}, calls:{$sum:1} }},
      { $sort:{_id:1} }, { $limit:30 }
    ]).toArray();
    const bySession = await sessions().find({},{projection:{messages:0}}).sort({tokensInput:-1}).limit(10).toArray();
    res.json({
      prices,
      totals: totals[0] || {totalInput:0,totalOutput:0,totalCost:0,totalCalls:0},
      byDay,
      bySession: bySession.map(s=>({id:s.id,code:s.code,clientName:s.clientName,tokensInput:s.tokensInput||0,tokensOutput:s.tokensOutput||0,messageCount:s.messageCount||0,updatedAt:s.updatedAt}))
    });
  } catch (err) {
    res.status(500).json({ error: 'Erro analytics.' });
  }
});

app.patch('/api/prices', dbReady, async (req, res) => {
  try {
    const { input, output } = req.body;
    await config().updateOne({key:'prices'},{$set:{key:'prices',input:parseFloat(input),output:parseFloat(output)}},{upsert:true});
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Erro precos.' }); }
});

// ── STATIC ────────────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public'), {
  etag: false,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  }
}));

// Explicit routes for HTML pages
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/admin.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
// relatorios.html served inline (file embedded in server)
const RELATORIOS_GZ = Buffer.from('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', 'base64');
app.get('/relatorios.html', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  zlib.gunzip(RELATORIOS_GZ, (err, buf) => {
    if (err) return res.status(500).send('Error');
    res.send(buf.toString('utf-8'));
  });
});

// SPA fallback — serve index.html for unknown routes (not files)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── START ─────────────────────────────────────────────────────────────────────
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log('Colink na porta ' + PORT);
  connectDB().catch(() => {
    const t = setInterval(async () => {
      try { await connectDB(); clearInterval(t); }
      catch(e) { console.error('DB retry:', e.message); }
    }, 5000);
  });
});

// Increase timeout for long AI calls (report generation can take 30-60s)
server.timeout = 180000;  // 3 min for rich report generation
server.keepAliveTimeout = 120000;

// ── /api/report POST — dedicated endpoint with longer timeout ─────────────────
// Uses gpt-4o-mini with streaming disabled but higher timeout
app.post('/api/report', async (req, res) => {
  res.setTimeout(150000); // 150s just for this endpoint
  try {
    const { messages, type } = req.body;
    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: { message: 'messages required' } });
    }

    // Use 4o-mini with high token limit for reports
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + OPENAI_API_KEY
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        max_tokens: 4000,
        temperature: 0.3,  // lower temp = more consistent structured output
        messages
      })
    });

    const data = await response.json();
    if (data.error) {
      return res.status(500).json({ error: data.error });
    }
    res.json(data);
  } catch (err) {
    console.error('Report error:', err.message);
    res.status(500).json({ error: { message: 'Erro ao gerar relatório: ' + err.message } });
  }
});
