const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const { MongoClient } = require('mongodb');

const app = express();
const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://colink:Colink2026@cluster0.j9nw5px.mongodb.net/?appName=Cluster0';

app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Conexão MongoDB ───────────────────────────────────────────────────────────
let db;

async function connectDB() {
  try {
    const client = new MongoClient(MONGODB_URI);
    await client.connect();
    db = client.db('colink');
    console.log('MongoDB conectado!');
  } catch (err) {
    console.error('Erro ao conectar MongoDB:', err.message);
    process.exit(1);
  }
}

function sessions() {
  return db.collection('sessions');
}

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

// ── /api/sessions GET — lista todas ──────────────────────────────────────────
app.get('/api/sessions', async (req, res) => {
  try {
    const list = await sessions()
      .find({}, { projection: { messages: 0 } })
      .sort({ updatedAt: -1 })
      .toArray();

    res.json({ sessions: list.map(s => ({
      id: s.id,
      code: s.code,
      clientName: s.clientName,
      messageCount: s.messageCount || 0,
      updatedAt: s.updatedAt,
      createdAt: s.createdAt
    }))});
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao listar sessões.' });
  }
});

// ── /api/sessions POST — cria nova ────────────────────────────────────────────
app.post('/api/sessions', async (req, res) => {
  try {
    const { clientName } = req.body;
    if (!clientName || !clientName.trim()) {
      return res.status(400).json({ error: 'Nome do cliente é obrigatório.' });
    }
    const id = generateId();
    const code = await generateCode(clientName.trim());
    const session = {
      id, code,
      clientName: clientName.trim(),
      messages: [],
      messageCount: 0,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    await sessions().insertOne(session);
    res.json({ id, code, clientName: session.clientName });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao criar sessão.' });
  }
});

// ── /api/sessions/:id GET — carrega uma sessão ────────────────────────────────
app.get('/api/sessions/:id', async (req, res) => {
  try {
    const session = await sessions().findOne({ id: req.params.id });
    if (!session) return res.status(404).json({ error: 'Sessão não encontrada.' });
    res.json(session);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao carregar sessão.' });
  }
});

// ── /api/chat POST — proxy OpenAI + salva mensagens ──────────────────────────
app.post('/api/chat', async (req, res) => {
  try {
    const { messages, max_tokens, sessionId, userDisplayContent } = req.body;

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({ model: 'gpt-4o-mini', max_tokens: max_tokens || 1500, messages })
    });

    const data = await response.json();

    // Salva no MongoDB se tiver sessionId e não houver erro
    if (sessionId && !data.error) {
      const reply = data.choices[0].message.content;
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
          timestamp: Date.now()
        }
      ];

      await sessions().updateOne(
        { id: sessionId },
        {
          $push: { messages: { $each: newMessages } },
          $inc: { messageCount: 2 },
          $set: { updatedAt: Date.now() }
        }
      );
    }

    res.json(data);
  } catch (err) {
    console.error('Erro /api/chat:', err.message);
    res.status(500).json({ error: { message: 'Erro interno no servidor.' } });
  }
});

// ── /api/extract POST — extrai texto de PDF e Word ───────────────────────────
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
    } else if (['docx', 'doc'].includes(ext)) {
      const mammoth = require('mammoth');
      const result = await mammoth.extractRawText({ buffer });
      text = `=== WORD: ${name} ===\n\n` + result.value;
    } else if (ext === 'txt') {
      text = `=== TXT: ${name} ===\n\n` + buffer.toString('utf-8');
    } else {
      text = `[Tipo nao suportado: ${name}]`;
    }

    res.json({ text: text.slice(0, 30000) });
  } catch (err) {
    console.error('Erro /api/extract:', err.message);
    res.json({ text: `[Erro ao extrair ${name}: ${err.message}]` });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
connectDB().then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Colink rodando na porta ${PORT}`);
  });
});
