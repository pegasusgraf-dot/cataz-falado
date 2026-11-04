const express = require('express');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error('DATABASE_URL não configurada.');
}

const pool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: { rejectUnauthorized: false }
    })
  : null;

function bancoIndisponivel(res, mensagem = 'Banco de dados indisponível.') {
  return res.status(500).json({ sucesso: false, mensagem });
}

async function inicializarBanco() {
  if (!pool) return;
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS usuarios (
        id SERIAL PRIMARY KEY,
        nome VARCHAR(100) NOT NULL,
        email VARCHAR(150) UNIQUE NOT NULL,
        senha VARCHAR(100) NOT NULL,
        tipo VARCHAR(30) NOT NULL DEFAULT 'comum',
        status VARCHAR(20) NOT NULL DEFAULT 'pendente',
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS vozes (
        id SERIAL PRIMARY KEY,
        nome VARCHAR(100) NOT NULL,
        descricao VARCHAR(255),
        tipo_locucao VARCHAR(50) DEFAULT 'Padrao',
        arquivo_base64 TEXT,
        usuario_id INTEGER REFERENCES usuarios(id),
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS anuncios (
        id SERIAL PRIMARY KEY,
        produto VARCHAR(200) NOT NULL,
        texto TEXT NOT NULL,
        voz_id INTEGER REFERENCES vozes(id) ON DELETE SET NULL,
        usuario_id INTEGER REFERENCES usuarios(id),
        audio_data TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);

    const checkMaster = await pool.query("SELECT 1 FROM usuarios WHERE LOWER(email) = LOWER('master') LIMIT 1");
    if (checkMaster.rows.length === 0) {
      await pool.query(
        "INSERT INTO usuarios (nome, email, senha, tipo, status) VALUES ('Master', 'master', '1234', 'master', 'aprovado')"
      );
    }
  } catch (err) {
    console.error('Erro na inicialização:', err);
  }
}

inicializarBanco();

function normalizarStatus(status) {
  if (!status) return 'pendente';
  const v = String(status).trim().toLowerCase();
  return ['aprovado', 'rejeitado', 'pendente'].includes(v) ? v : 'pendente';
}

// --- ROTAS DE USUÁRIOS E AUTH ---
app.post('/api/login', async (req, res) => {
  if (!pool) return bancoIndisponivel(res);
  const { email, usuario, senha } = req.body || {};
  const emailLogin = String(email || usuario || '').trim();

  try {
    const r = await pool.query(
      'SELECT id, nome, email, senha, tipo, status FROM usuarios WHERE LOWER(email) = LOWER($1) AND senha = $2',
      [emailLogin, String(senha).trim()]
    );

    if (r.rows.length === 0) return res.status(401).json({ sucesso: false, mensagem: 'Usuário ou senha incorretos.' });

    const u = r.rows[0];
    if (u.status !== 'aprovado' && u.tipo !== 'master') {
      return res.status(403).json({ sucesso: false, mensagem: 'Conta pendente de aprovação pelo Administrador.' });
    }

    return res.json({ sucesso: true, usuario: u });
  } catch (error) {
    return res.status(500).json({ sucesso: false, mensagem: 'Erro interno no servidor.' });
  }
});

app.get('/api/usuarios', async (req, res) => {
  if (!pool) return bancoIndisponivel(res);
  try {
    const lista = await pool.query('SELECT id, nome, email, tipo, status, created_at FROM usuarios ORDER BY id DESC');
    return res.json({ sucesso: true, usuarios: lista.rows });
  } catch (error) {
    return res.status(500).json({ sucesso: false, mensagem: 'Erro ao buscar usuários.' });
  }
});

app.post('/api/usuarios', async (req, res) => {
  if (!pool) return bancoIndisponivel(res);
  const { nome, email, senha, tipo } = req.body || {};
  try {
    const novo = await pool.query(
      `INSERT INTO usuarios (nome, email, senha, tipo, status) VALUES ($1, $2, $3, $4, 'aprovado') RETURNING id, nome, email, tipo, status`,
      [String(nome).trim(), String(email).trim(), String(senha).trim(), String(tipo || 'comum').trim()]
    );
    return res.status(201).json({ sucesso: true, usuario: novo.rows[0] });
  } catch (error) {
    return res.status(500).json({ sucesso: false, mensagem: 'Erro ao cadastrar usuário.' });
  }
});

app.patch('/api/usuarios/:id/status', async (req, res) => {
  if (!pool) return bancoIndisponivel(res);
  try {
    const statusNovo = normalizarStatus(req.body.status);
    const att = await pool.query('UPDATE usuarios SET status = $1 WHERE id = $2 RETURNING id, nome, email, tipo, status', [statusNovo, req.params.id]);
    return res.json({ sucesso: true, usuario: att.rows[0] });
  } catch (error) {
    return res.status(500).json({ sucesso: false, mensagem: 'Erro ao atualizar status do usuário.' });
  }
});

app.delete('/api/usuarios/:id', async (req, res) => {
  if (!pool) return bancoIndisponivel(res);
  try {
    await pool.query('DELETE FROM anuncios WHERE usuario_id = $1', [req.params.id]);
    await pool.query('DELETE FROM vozes WHERE usuario_id = $1', [req.params.id]);
    await pool.query('DELETE FROM usuarios WHERE id = $1', [req.params.id]);
    return res.json({ sucesso: true });
  } catch (error) {
    return res.status(500).json({ sucesso: false, mensagem: 'Erro ao remover usuário.' });
  }
});

// --- GERENCIAMENTO DE VOZES (COM SUPORTE A UPLOAD DE ÁUDIO) ---
app.get('/api/vozes', async (req, res) => {
  if (!pool) return bancoIndisponivel(res);
  try {
    const r = await pool.query('SELECT id, nome, descricao, tipo_locucao, created_at FROM vozes ORDER BY id DESC');
    return res.json({ sucesso: true, vozes: r.rows });
  } catch (error) {
    return res.status(500).json({ sucesso: false, mensagem: 'Erro ao buscar vozes.' });
  }
});

app.post('/api/clonar-voz', async (req, res) => {
  if (!pool) return bancoIndisponivel(res);
  const { nome, tipo_locucao, arquivo_base64, usuario_id } = req.body || {};

  if (!nome) {
    return res.status(400).json({ sucesso: false, mensagem: 'Nome da voz é obrigatório.' });
  }

  try {
    const novaVoz = await pool.query(
      `INSERT INTO vozes (nome, tipo_locucao, arquivo_base64, usuario_id) VALUES ($1, $2, $3, $4) RETURNING *`,
      [nome, tipo_locucao || 'Padrão', arquivo_base64 || null, usuario_id ? Number(usuario_id) : null]
    );

    return res.status(201).json({ sucesso: true, voz: novaVoz.rows[0] });
  } catch (err) {
    console.error('Erro ao salvar voz:', err);
    return res.status(500).json({ sucesso: false, mensagem: 'Erro interno ao processar cadastro de voz.' });
  }
});

app.delete('/api/vozes/:id', async (req, res) => {
  if (!pool) return bancoIndisponivel(res);
  try {
    await pool.query('DELETE FROM anuncios WHERE voz_id = $1', [req.params.id]);
    await pool.query('DELETE FROM vozes WHERE id = $1', [req.params.id]);
    return res.json({ sucesso: true });
  } catch (error) {
    return res.status(500).json({ sucesso: false, mensagem: 'Erro ao remover voz.' });
  }
});

// --- NARRAR TEXTO (GOOGLE TRANSLATE TTS) ---
app.post('/api/gerar-locucao', async (req, res) => {
  const { texto } = req.body || {};

  if (!texto) {
    return res.status(400).json({ sucesso: false, mensagem: 'Texto é obrigatório.' });
  }

  try {
    const encodedText = encodeURIComponent(texto.substring(0, 200));
    const googleTtsUrl = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodedText}&tl=pt&client=tw-ob`;

    const response = await fetch(googleTtsUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
      }
    });

    if (!response.ok) {
      return res.status(500).json({ sucesso: false, mensagem: 'Erro ao gerar áudio no Google TTS.' });
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const audioBase64 = `data:audio/mpeg;base64,${buffer.toString('base64')}`;

    return res.json({ sucesso: true, audio_data: audioBase64 });
  } catch (error) {
    console.error('Erro na locução:', error);
    return res.status(500).json({ sucesso: false, mensagem: 'Falha de conexão com o sintetizador.' });
  }
});

// --- ROTAS DE ANÚNCIOS ---
app.get('/api/anuncios', async (req, res) => {
  if (!pool) return bancoIndisponivel(res);
  try {
    const lista = await pool.query(`
      SELECT a.*, v.nome AS voz_nome
      FROM anuncios a
      LEFT JOIN vozes v ON v.id = a.voz_id
      ORDER BY a.id DESC
    `);
    return res.json({ sucesso: true, anuncios: lista.rows });
  } catch (error) {
    return res.status(500).json({ sucesso: false, mensagem: 'Erro ao buscar anúncios.' });
  }
});

app.post('/api/anuncios', async (req, res) => {
  if (!pool) return bancoIndisponivel(res);
  const { produto, texto, voz_id, usuario_id, audio_data } = req.body || {};

  if (!produto || !texto) {
    return res.status(400).json({ sucesso: false, mensagem: 'Produto e texto são obrigatórios.' });
  }

  try {
    const item = await pool.query(
      `INSERT INTO anuncios (produto, texto, voz_id, usuario_id, audio_data) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [String(produto).trim(), String(texto).trim(), voz_id ? Number(voz_id) : null, usuario_id ? Number(usuario_id) : null, audio_data || null]
    );
    return res.status(201).json({ sucesso: true, anuncio: item.rows[0] });
  } catch (error) {
    console.error('Erro ao salvar anúncio:', error);
    return res.status(500).json({ sucesso: false, mensagem: 'Erro ao salvar anúncio no banco.' });
  }
});

app.delete('/api/anuncios/:id', async (req, res) => {
  if (!pool) return bancoIndisponivel(res);
  try {
    await pool.query('DELETE FROM anuncios WHERE id = $1', [req.params.id]);
    return res.json({ sucesso: true });
  } catch (error) {
    return res.status(500).json({ sucesso: false, mensagem: 'Erro ao remover anúncio.' });
  }
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.use((req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
