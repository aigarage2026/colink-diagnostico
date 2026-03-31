const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Pasta onde as sessões ficam salvas
const SESSIONS_DIR = path.join(__dirname, 'sessions');
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Helpers de sessão ─────────────────────────────────────────────────────────

function sessionPath(id) {
  return path.join(SESSIONS_DIR, `${id}.json`);
}

function loadSession(id) {
  const p = sessionPath(id);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

function saveSession(session) {
  session.updatedAt = Date.now();
  fs.writeFileSync(sessionPath(session.id), JSON.stringify(session, null, 2));
}

function listSessions() {
  if (!fs.existsSync(SESSIONS_DIR)) return [];
  return fs.readdirSync(SESSIONS_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      try {
        const s = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf-8'));
        return {
          id: s.id,
          code: s.code,
          clientName: s.clientName,
          messageCount: s.messages ? s.messages.length : 0,
          updatedAt: s.updatedAt,
          createdAt: s.createdAt
        };
      } catch(e) { return null; }
    })
    .filter(Boolean);
}

function generateCode(clientName) {
  // Pega sessões existentes para este cliente e incrementa
  const existing = listSessions().filter(s =>
    s.clientName.toLowerCase() === clientName.toLowerCase()
  );
  const num = existing.length + 1;
  return `#${String(num).padStart(3, '0')}`;
}

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// ── /api/sessions GET — lista todas as sessões ────────────────────────────────
app.get('/api/sessions', (req, res) => {
  try {
    res.json({ sessions: listSessions() });
  } catch(e) {
    res.status(500).json({ error: 'Erro ao listar sessões.' });
  }
});

// ── /api/sessions POST — cria nova sessão ────────────────────────────────────
app.post('/api/sessions', (req, res) => {
  try {
    const { clientName } = req.body;
    if (!clientName || !clientName.trim()) {
      return res.status(400).json({ error: 'Nome do cliente é obrigatório.' });
    }
    const id = generateId();
    const code = generateCode(clientName.trim());
    const session = {
      id, code,
      clientName: clientName.trim(),
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    saveSession(session);
    res.json({ id, code, clientName: session.clientName });
  } catch(e) {
    console.error('Erro ao criar sessão:', e.message);
    res.status(500).json({ error: 'Erro ao criar sessão.' });
  }
});

// ── /api/sessions/:id GET — carrega uma sessão ───────────────────────────────
app.get('/api/sessions/:id', (req, res) => {
  const session = loadSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Sessão não encontrada.' });
  res.json(session);
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

    // Salva na sessão se tiver sessionId
    if (sessionId && !data.error) {
      const session = loadSession(sessionId);
      if (session) {
        const reply = data.choices[0].message.content;
        const userMsg = messages[messages.length - 1];

        // Salva mensagem do usuário
        session.messages.push({
          role: 'user',
          content: typeof userMsg.content === 'string' ? userMsg.content : JSON.stringify(userMsg.content),
          displayContent: userDisplayContent || (typeof userMsg.content === 'string' ? userMsg.content : '[arquivo]'),
          timestamp: Date.now()
        });

        // Salva resposta da IA
        session.messages.push({
          role: 'assistant',
          content: reply,
          displayContent: reply,
          timestamp: Date.now()
        });

        saveSession(session);
      }
    }

    res.json(data);
  } catch(err) {
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
  } catch(err) {
    console.error('Erro /api/extract:', err.message);
    res.json({ text: `[Erro ao extrair ${name}: ${err.message}]` });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Colink rodando na porta ${PORT}`);
});
