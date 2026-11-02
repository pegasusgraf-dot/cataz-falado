const express = require('express');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '1mb' }));
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
      CREATE TABLE IF NOT EXISTS anuncios (
        id SERIAL PRIMARY KEY,
        produto VARCHAR(200) NOT NULL,
        texto TEXT NOT NULL,
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
  if (!pool) {
    return bancoIndisponivel(res, 'DATABASE_URL não configurada no ambiente.');
  }

  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, message: 'Banco conectado' });
  } catch (error) {
    console.error('Health check falhou:', error);
    res.status(500).json({ ok: false, message: 'Falha de conexão com o banco' });
  }
});

app.post('/api/login', async (req, res) => {
  if (!pool) {
    return bancoIndisponivel(res, 'Banco de dados não configurado.');
  }

  const { email, usuario, senha } = req.body || {};
  const emailLogin = String(email || usuario || '').trim();

  if (!emailLogin || !senha) {
    return res.status(400).json({ sucesso: false, mensagem: 'E-mail e senha são obrigatórios.' });
  }

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
      return res.status(403).json({
        sucesso: false,
        mensagem: 'Sua conta ainda está pendente de aprovação do usuário master.',
      });
    }

    return res.json({ sucesso: true, usuario: usuarioLogado });
  } catch (error) {
    console.error('Erro no login:', error);
    return res.status(500).json({ sucesso: false, mensagem: 'Erro interno no servidor.' });
  }
});

app.get('/api/usuarios', async (req, res) => {
  if (!pool) {
    return bancoIndisponivel(res, 'Banco de dados não configurado.');
  }

  try {
    const lista = await pool.query(
      'SELECT id, nome, email, tipo, status, created_at FROM usuarios ORDER BY id DESC'
    );
    return res.json({ sucesso: true, usuarios: lista.rows });
  } catch (error) {
    console.error('Erro ao listar usuários:', error);
    return res.status(500).json({ sucesso: false, mensagem: 'Erro ao buscar usuários.' });
  }
});

app.post('/api/usuarios', async (req, res) => {
  if (!pool) {
    return bancoIndisponivel(res, 'Banco de dados não configurado.');
  }

  const { nome, email, usuario, senha, tipo } = req.body || {};
  const emailFinal = String(email || usuario || '').trim();

  if (!nome || !emailFinal || !senha) {
    return res.status(400).json({ sucesso: false, mensagem: 'Nome, e-mail e senha são obrigatórios.' });
  }

  try {
    const existe = await pool.query(
      'SELECT 1 FROM usuarios WHERE LOWER(email) = LOWER($1)',
      [emailFinal]
    );

    if (existe.rows.length > 0) {
      return res.status(409).json({ sucesso: false, mensagem: 'Este usuário já existe.' });
    }

    const novo = await pool.query(
      `INSERT INTO usuarios (nome, email, senha, tipo, status)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, nome, email, tipo, status, created_at`,
      [String(nome).trim(), emailFinal, String(senha).trim(), String(tipo || 'comum').trim(), 'pendente']
    );

    return res.status(201).json({ sucesso: true, usuario: novo.rows[0] });
  } catch (error) {
    console.error('Erro ao cadastrar usuário:', error);
    return res.status(500).json({ sucesso: false, mensagem: 'Erro ao cadastrar usuário.' });
  }
});

app.patch('/api/usuarios/:id/status', async (req, res) => {
  if (!pool) {
    return bancoIndisponivel(res, 'Banco de dados não configurado.');
  }

  const { id } = req.params;
  const { status } = req.body || {};
  const statusNormalizado = normalizarStatus(status);

  try {
    const atualizacao = await pool.query(
      'UPDATE usuarios SET status = $1 WHERE id = $2 RETURNING id, nome, email, tipo, status',
      [statusNormalizado, id]
    );

    if (atualizacao.rows.length === 0) {
      return res.status(404).json({ sucesso: false, mensagem: 'Usuário não encontrado.' });
    }

    return res.json({ sucesso: true, usuario: atualizacao.rows[0] });
  } catch (error) {
    console.error('Erro ao atualizar status do usuário:', error);
    return res.status(500).json({ sucesso: false, mensagem: 'Erro ao atualizar status do usuário.' });
  }
});

app.get('/api/anuncios', async (req, res) => {
  if (!pool) {
    return bancoIndisponivel(res, 'Banco de dados não configurado.');
  }

  try {
    const lista = await pool.query(`
      SELECT a.*, u.nome AS usuario_nome
      FROM anuncios a
      LEFT JOIN usuarios u ON u.id = a.usuario_id
      ORDER BY a.id DESC
    `);

    return res.json({ sucesso: true, anuncios: lista.rows });
  } catch (error) {
    console.error('Erro ao listar anúncios:', error);
    return res.status(500).json({ sucesso: false, mensagem: 'Erro ao buscar anúncios.' });
  }
});

app.post('/api/anuncios', async (req, res) => {
  if (!pool) {
    return bancoIndisponivel(res, 'Banco de dados não configurado.');
  }

  const { produto, texto, usuario_id } = req.body || {};

  if (!produto || !texto) {
    return res.status(400).json({ sucesso: false, mensagem: 'Produto e texto são obrigatórios.' });
  }

  try {
    const item = await pool.query(
      `INSERT INTO anuncios (produto, texto, usuario_id)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [String(produto).trim(), String(texto).trim(), usuario_id ? Number(usuario_id) : null]
    );

    return res.status(201).json({ sucesso: true, anuncio: item.rows[0] });
  } catch (error) {
    console.error('Erro ao salvar anúncio:', error);
    return res.status(500).json({ sucesso: false, mensagem: 'Erro ao salvar anúncio.' });
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
