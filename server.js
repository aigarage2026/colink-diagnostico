const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const { MongoClient } = require('mongodb');

const app = express();
const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://colink:Colink2026@cluster0.j9nw5px.mongodb.net/?appName=Cluster0';

// Precos padrao GPT-4o-mini por 1M tokens (USD)
const DEFAULT_PRICE_INPUT  = 0.150;
const DEFAULT_PRICE_OUTPUT = 0.600;

app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));



// ── MongoDB ───────────────────────────────────────────────────────────────────
let db;
async function connectDB() {
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  db = client.db('colink');
  console.log('MongoDB conectado!');
}
const sessions  = () => db.collection('sessions');
const usageLogs = () => db.collection('usage_logs');
const config    = () => db.collection('config');

// ── Helpers ───────────────────────────────────────────────────────────────────
function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}
async function generateCode(clientName) {
  const count = await sessions().countDocuments({
    clientName: { $regex: new RegExp(`^${clientName}$`, 'i') }
  });
  return `#${String(count + 1).padStart(3, '0')}`;
}
async function getPrices() {
  const cfg = await config().findOne({ key: 'prices' });
  return {
    input:  cfg?.input  ?? DEFAULT_PRICE_INPUT,
    output: cfg?.output ?? DEFAULT_PRICE_OUTPUT
  };
}

// ── /api/sessions GET ─────────────────────────────────────────────────────────
app.get('/api/sessions', async (req, res) => {
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
  } catch(err) { res.status(500).json({ error: 'Erro ao listar sessões.' }); }
});

// ── /api/sessions POST ────────────────────────────────────────────────────────
app.post('/api/sessions', async (req, res) => {
  try {
    const { clientName } = req.body;
    if (!clientName?.trim()) return res.status(400).json({ error: 'Nome do cliente é obrigatório.' });
    const id = generateId();
    const code = await generateCode(clientName.trim());
    const session = {
      id, code, clientName: clientName.trim(),
      messages: [], messageCount: 0,
      tokensInput: 0, tokensOutput: 0,
      createdAt: Date.now(), updatedAt: Date.now()
    };
    await sessions().insertOne(session);
    res.json({ id, code, clientName: session.clientName });
  } catch(err) { res.status(500).json({ error: 'Erro ao criar sessão.' }); }
});

// ── /api/sessions/:id GET ─────────────────────────────────────────────────────
app.get('/api/sessions/:id', async (req, res) => {
  try {
    const s = await sessions().findOne({ id: req.params.id });
    if (!s) return res.status(404).json({ error: 'Sessão não encontrada.' });
    res.json(s);
  } catch(err) { res.status(500).json({ error: 'Erro ao carregar sessão.' }); }
});

// ── /api/chat POST ────────────────────────────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  try {
    const { messages, max_tokens, sessionId, userDisplayContent } = req.body;

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({ model: 'gpt-4o-mini', max_tokens: max_tokens || 1500, messages })
    });

    const data = await response.json();

    if (sessionId && !data.error) {
      const reply = data.choices[0].message.content;
      const usage = data.usage || {};
      const tokIn  = usage.prompt_tokens     || 0;
      const tokOut = usage.completion_tokens || 0;
      const userMsg = messages[messages.length - 1];

      const newMessages = [
        {
          role: 'user',
          content: typeof userMsg.content === 'string' ? userMsg.content : JSON.stringify(userMsg.content),
          displayContent: userDisplayContent || (typeof userMsg.content === 'string' ? userMsg.content : '[arquivo]'),
          timestamp: Date.now()
        },
        {
          role: 'assistant',
          content: reply,
          displayContent: reply,
          tokensInput: tokIn, tokensOutput: tokOut,
          timestamp: Date.now()
        }
      ];

      // Atualiza sessão
      await sessions().updateOne(
        { id: sessionId },
        {
          $push: { messages: { $each: newMessages } },
          $inc: { messageCount: 2, tokensInput: tokIn, tokensOutput: tokOut },
          $set: { updatedAt: Date.now() }
        }
      );

      // Registra log de uso
      const prices = await getPrices();
      const costInput  = (tokIn  / 1_000_000) * prices.input;
      const costOutput = (tokOut / 1_000_000) * prices.output;
      await usageLogs().insertOne({
        sessionId, date: new Date().toISOString().slice(0, 10),
        timestamp: Date.now(),
        tokensInput: tokIn, tokensOutput: tokOut,
        costInput, costOutput,
        totalCost: costInput + costOutput
      });
    }

    res.json(data);
  } catch(err) {
    console.error('Erro /api/chat:', err.message);
    res.status(500).json({ error: { message: 'Erro interno no servidor.' } });
  }
});

// ── /api/analytics GET ────────────────────────────────────────────────────────
app.get('/api/analytics', async (req, res) => {
  try {
    const prices = await getPrices();

    // Totais gerais
    const totals = await usageLogs().aggregate([
      { $group: {
        _id: null,
        totalInput:  { $sum: '$tokensInput' },
        totalOutput: { $sum: '$tokensOutput' },
        totalCost:   { $sum: '$totalCost' },
        totalCalls:  { $sum: 1 }
      }}
    ]).toArray();

    // Uso por dia (últimos 30 dias)
    const byDay = await usageLogs().aggregate([
      { $group: {
        _id: '$date',
        tokensInput:  { $sum: '$tokensInput' },
        tokensOutput: { $sum: '$tokensOutput' },
        cost:         { $sum: '$totalCost' },
        calls:        { $sum: 1 }
      }},
      { $sort: { _id: 1 } },
      { $limit: 30 }
    ]).toArray();

    // Uso por sessão (top 10)
    const bySession = await sessions()
      .find({}, { projection: { messages: 0 } })
      .sort({ tokensInput: -1 }).limit(10).toArray();

    res.json({
      prices,
      totals: totals[0] || { totalInput: 0, totalOutput: 0, totalCost: 0, totalCalls: 0 },
      byDay,
      bySession: bySession.map(s => ({
        id: s.id, code: s.code, clientName: s.clientName,
        tokensInput: s.tokensInput || 0, tokensOutput: s.tokensOutput || 0,
        messageCount: s.messageCount || 0,
        updatedAt: s.updatedAt
      }))
    });
  } catch(err) {
    console.error('Erro /api/analytics:', err.message);
    res.status(500).json({ error: 'Erro ao carregar analytics.' });
  }
});

// ── /api/prices PATCH — atualiza preços ──────────────────────────────────────
app.patch('/api/prices', async (req, res) => {
  try {
    const { input, output } = req.body;
    await config().updateOne(
      { key: 'prices' },
      { $set: { key: 'prices', input: parseFloat(input), output: parseFloat(output) } },
      { upsert: true }
    );
    res.json({ ok: true });
  } catch(err) { res.status(500).json({ error: 'Erro ao salvar preços.' }); }
});

// ── /api/extract POST ─────────────────────────────────────────────────────────
app.post('/api/extract', async (req, res) => {
  const { name, data } = req.body;
  try {
    const base64 = data.includes(',') ? data.split(',')[1] : data;
    const buffer = Buffer.from(base64, 'base64');
    const ext = name.split('.').pop().toLowerCase();
    let text = '';
    if (ext === 'pdf') {
      const pdfParse = require('pdf-parse');
      const parsed = await pdfParse(buffer);
      text = `=== PDF: ${name} ===\nPaginas: ${parsed.numpages}\n\n` + parsed.text;
    } else if (['docx','doc'].includes(ext)) {
      const mammoth = require('mammoth');
      const result = await mammoth.extractRawText({ buffer });
      text = `=== WORD: ${name} ===\n\n` + result.value;
    } else if (ext === 'txt') {
      text = `=== TXT: ${name} ===\n\n` + buffer.toString('utf-8');
    } else {
      text = `[Tipo nao suportado: ${name}]`;
    }
    res.json({ text: text.slice(0, 30000) });
  } catch(err) {
    res.json({ text: `[Erro ao extrair ${name}: ${err.message}]` });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
connectDB().then(() => {
  app.listen(PORT, '0.0.0.0', () => console.log(`Colink rodando na porta ${PORT}`));
}).catch(err => { console.error(err); process.exit(1); });
