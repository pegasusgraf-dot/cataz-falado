const express = require('express');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Aumentando o limite para permitir upload de arquivos de áudio em Base64
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error('DATABASE_URL não configurada. Defina a variável de ambiente no Vercel antes do redeploy.');
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
  if (!pool) {
    console.error('Banco não inicializado porque DATABASE_URL não foi configurada.');
    return;
  }

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
        audio_data TEXT NOT NULL,
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
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);

    const checkMaster = await pool.query("SELECT 1 FROM usuarios WHERE LOWER(email) = LOWER('master') LIMIT 1");
    if (checkMaster.rows.length === 0) {
      await pool.query(
        "INSERT INTO usuarios (nome, email, senha, tipo, status) VALUES ('Master', 'master', '1234', 'master', 'aprovado')"
      );
      console.log('Usuário master criado com sucesso! (master / 1234)');
    }

    console.log('Banco inicializado com sucesso.');
  } catch (err) {
    console.error('Erro ao inicializar tabelas:', err);
  }
}

inicializarBanco();

function normalizarStatus(status) {
  if (!status) return 'pendente';
  const v = String(status).trim().toLowerCase();
  if (['aprovado', 'rejeitado', 'pendente'].includes(v)) return v;
  return 'pendente';
}

app.get('/api/health', async (req, res) => {
  if (!pool) return bancoIndisponivel(res, 'DATABASE_URL não configurada.');
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, message: 'Banco conectado' });
  } catch (error) {
    res.status(500).json({ ok: false, message: 'Falha de conexão com o banco' });
  }
});

// --- ROTAS DE USUÁRIOS E LOGIN ---
app.post('/api/login', async (req, res) => {
  if (!pool) return bancoIndisponivel(res);
  const { email, usuario, senha } = req.body || {};
  const emailLogin = String(email || usuario || '').trim();

  try {
    const resultado = await pool.query(
      'SELECT id, nome, email, senha, tipo, status, created_at FROM usuarios WHERE LOWER(email) = LOWER($1) AND senha = $2',
      [emailLogin, String(senha).trim()]
    );

    if (resultado.rows.length === 0) {
      return res.status(401).json({ sucesso: false, mensagem: 'Usuário ou senha incorretos.' });
    }

    const usuarioLogado = resultado.rows[0];
    if (usuarioLogado.status !== 'aprovado' && usuarioLogado.tipo !== 'master') {
      return res.status(403).json({ sucesso: false, mensagem: 'Sua conta está pendente de aprovação.' });
    }

    return res.json({ sucesso: true, usuario: usuarioLogado });
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
      `INSERT INTO usuarios (nome, email, senha, tipo, status) VALUES ($1, $2, $3, $4, $5) RETURNING id, nome, email, tipo, status`,
      [String(nome).trim(), String(email).trim(), String(senha).trim(), String(tipo || 'comum').trim(), 'pendente']
    );
    return res.status(201).json({ sucesso: true, usuario: novo.rows[0] });
  } catch (error) {
    console.error('Erro ao cadastrar usuário:', error);
    return res.status(500).json({ sucesso: false, mensagem: 'Erro ao cadastrar usuário (E-mail já existe?).' });
  }
});

app.patch('/api/usuarios/:id/status', async (req, res) => {
  if (!pool) return bancoIndisponivel(res);
  const { id } = req.params;
  const { status } = req.body || {};
  try {
    const atualizacao = await pool.query(
      'UPDATE usuarios SET status = $1 WHERE id = $2 RETURNING id, nome, email, tipo, status',
      [normalizarStatus(status), id]
    );
    return res.json({ sucesso: true, usuario: atualizacao.rows[0] });
  } catch (error) {
    return res.status(500).json({ sucesso: false, mensagem: 'Erro ao atualizar status.' });
  }
});

app.delete('/api/usuarios/:id', async (req, res) => {
  if (!pool) return bancoIndisponivel(res);
  const { id } = req.params;
  try {
    await pool.query('DELETE FROM anuncios WHERE usuario_id = $1', [id]);
    await pool.query('DELETE FROM vozes WHERE usuario_id = $1', [id]);
    const removido = await pool.query('DELETE FROM usuarios WHERE id = $1 RETURNING id', [id]);
    return res.json({ sucesso: true, id: removido.rows[0]?.id });
  } catch (error) {
    return res.status(500).json({ sucesso: false, mensagem: 'Erro ao remover usuário.' });
  }
});

// --- ROTAS DE VOZES ---
app.get('/api/vozes', async (req, res) => {
  if (!pool) return bancoIndisponivel(res);
  try {
    const lista = await pool.query('SELECT id, nome, descricao, tipo_locucao, created_at FROM vozes ORDER BY id DESC');
    return res.json({ sucesso: true, vozes: lista.rows });
  } catch (error) {
    return res.status(500).json({ sucesso: false, mensagem: 'Erro ao buscar vozes.' });
  }
});

app.get('/api/vozes/:id/audio', async (req, res) => {
  if (!pool) return bancoIndisponivel(res);
  try {
    const resultado = await pool.query('SELECT audio_data, nome FROM vozes WHERE id = $1', [req.params.id]);
    if (resultado.rows.length === 0) return res.status(404).json({ sucesso: false, mensagem: 'Voz não encontrada.' });
    return res.json({ sucesso: true, audio_data: resultado.rows[0].audio_data, nome: resultado.rows[0].nome });
  } catch (error) {
    return res.status(500).json({ sucesso: false, mensagem: 'Erro ao carregar áudio da voz.' });
  }
});

app.post('/api/vozes', async (req, res) => {
  if (!pool) return bancoIndisponivel(res);
  const { nome, descricao, tipo_locucao, audio_data, usuario_id } = req.body || {};

  if (!nome || !audio_data) {
    return res.status(400).json({ sucesso: false, mensagem: 'Nome da voz e o arquivo de áudio são obrigatórios.' });
  }

  try {
    const novaVoz = await pool.query(
      `INSERT INTO vozes (nome, descricao, tipo_locucao, audio_data, usuario_id)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, nome, descricao, tipo_locucao, created_at`,
      [String(nome).trim(), descricao || '', tipo_locucao || 'Padrao', audio_data, usuario_id ? Number(usuario_id) : null]
    );
    return res.status(201).json({ sucesso: true, voz: novaVoz.rows[0] });
  } catch (error) {
    console.error('Erro ao salvar voz:', error);
    return res.status(500).json({ sucesso: false, mensagem: 'Erro ao salvar voz no banco.' });
  }
});

app.delete('/api/vozes/:id', async (req, res) => {
  if (!pool) return bancoIndisponivel(res);
  try {
    await pool.query('DELETE FROM vozes WHERE id = $1', [req.params.id]);
    return res.json({ sucesso: true });
  } catch (error) {
    return res.status(500).json({ sucesso: false, mensagem: 'Erro ao excluir voz.' });
  }
});

// --- ROTAS DE ANÚNCIOS ---
app.get('/api/anuncios', async (req, res) => {
  if (!pool) return bancoIndisponivel(res);
  try {
    const lista = await pool.query(`
      SELECT a.*, u.nome AS usuario_nome, v.nome AS voz_nome, v.tipo_locucao
      FROM anuncios a
      LEFT JOIN usuarios u ON u.id = a.usuario_id
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
  const { produto, texto, voz_id, usuario_id } = req.body || {};

  if (!produto || !texto) {
    return res.status(400).json({ sucesso: false, mensagem: 'Produto e texto são obrigatórios.' });
  }

  try {
    const item = await pool.query(
      `INSERT INTO anuncios (produto, texto, voz_id, usuario_id) VALUES ($1, $2, $3, $4) RETURNING *`,
      [String(produto).trim(), String(texto).trim(), voz_id ? Number(voz_id) : null, usuario_id ? Number(usuario_id) : null]
    );
    return res.status(201).json({ sucesso: true, anuncio: item.rows[0] });
  } catch (error) {
    return res.status(500).json({ sucesso: false, mensagem: 'Erro ao salvar anúncio.' });
  }
});

app.delete('/api/anuncios/:id', async (req, res) => {
  if (!pool) return bancoIndisponivel(res);
  const { id } = req.params;
  try {
    await pool.query('DELETE FROM anuncios WHERE id = $1', [id]);
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
