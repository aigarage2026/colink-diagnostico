const express = require('express');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// /api/chat — proxy OpenAI
app.post('/api/chat', async (req, res) => {
  try {
    const { messages, max_tokens } = req.body;
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({ model: 'gpt-4o-mini', max_tokens: max_tokens || 1500, messages })
    });
    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error('Erro /api/chat:', err.message);
    res.status(500).json({ error: { message: 'Erro interno no servidor.' } });
  }
});

// /api/extract — extrai texto de PDF e Word
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

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Colink rodando na porta ${PORT}`);
});

