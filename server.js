const express = require('express');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));
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
        audio_data TEXT,
        usuario_id INTEGER,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS anuncios (
        id SERIAL PRIMARY KEY,
        produto VARCHAR(200) NOT NULL,
        texto TEXT NOT NULL,
        voz_id INTEGER,
        audio_data TEXT,
        usuario_id INTEGER,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Remove travas NOT NULL de colunas antigas para evitar o erro de violação de constraint
    await pool.query(`ALTER TABLE vozes ADD COLUMN IF NOT EXISTS arquivo_base64 TEXT;`);
    await pool.query(`ALTER TABLE vozes ADD COLUMN IF NOT EXISTS audio_data TEXT;`);
    await pool.query(`ALTER TABLE vozes ALTER COLUMN audio_data DROP NOT NULL;`);
    await pool.query(`ALTER TABLE anuncios ADD COLUMN IF NOT EXISTS audio_data TEXT;`);
    await pool.query(`ALTER TABLE anuncios ADD COLUMN IF NOT EXISTS voz_id INTEGER;`);

    const checkMaster = await pool.query("SELECT 1 FROM usuarios WHERE LOWER(email) = LOWER('master') LIMIT 1");
    if (checkMaster.rows.length === 0) {
      await pool.query(
        "INSERT INTO usuarios (nome, email, senha, tipo, status) VALUES ('Master', 'master', '1234', 'master', 'aprovado')"
      );
    }
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
  if (!pool) return bancoIndisponivel(res);
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, message: 'Banco conectado' });
  } catch (error) {
    res.status(500).json({ ok: false, message: 'Falha de conexão com o banco' });
  }
});

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
      return res.status(403).json({ sucesso: false, mensagem: 'Sua conta ainda está pendente de aprovação.' });
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
  const { nome, email, usuario, senha, tipo } = req.body || {};
  const emailFinal = String(email || usuario || '').trim();

  try {
    const novo = await pool.query(
      `INSERT INTO usuarios (nome, email, senha, tipo, status) VALUES ($1, $2, $3, $4, 'pendente') RETURNING id, nome, email, tipo, status, created_at`,
      [String(nome).trim(), emailFinal, String(senha).trim(), String(tipo || 'comum').trim()]
    );
    return res.status(201).json({ sucesso: true, usuario: novo.rows[0] });
  } catch (error) {
    return res.status(500).json({ sucesso: false, mensagem: 'Erro ao cadastrar usuário (E-mail já existe?).' });
  }
});

app.patch('/api/usuarios/:id/status', async (req, res) => {
  if (!pool) return bancoIndisponivel(res);
  try {
    const atualizacao = await pool.query(
      'UPDATE usuarios SET status = $1 WHERE id = $2 RETURNING id, nome, email, tipo, status',
      [normalizarStatus(req.body.status), req.params.id]
    );
    return res.json({ sucesso: true, usuario: atualizacao.rows[0] });
  } catch (error) {
    return res.status(500).json({ sucesso: false, mensagem: 'Erro ao atualizar status.' });
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

// --- VOZES (Salva tanto em arquivo_base64 quanto em audio_data para não violar constraint) ---
app.get('/api/vozes', async (req, res) => {
  if (!pool) return bancoIndisponivel(res);
  try {
    const lista = await pool.query(`
      SELECT id, nome, descricao, tipo_locucao, 
             COALESCE(arquivo_base64, audio_data) AS arquivo_base64, 
             created_at 
      FROM vozes 
      ORDER BY id DESC
    `);
    return res.json({ sucesso: true, vozes: lista.rows });
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
    let idUsuarioValido = null;
    if (usuario_id && !isNaN(Number(usuario_id))) {
      const checaUser = await pool.query('SELECT id FROM usuarios WHERE id = $1', [Number(usuario_id)]);
      if (checaUser.rows.length > 0) idUsuarioValido = checaUser.rows[0].id;
    }

    const audioConteudo = arquivo_base64 || '';

    const novaVoz = await pool.query(
      `INSERT INTO vozes (nome, tipo_locucao, arquivo_base64, audio_data, usuario_id) 
       VALUES ($1, $2, $3, $4, $5) RETURNING id, nome, tipo_locucao, created_at`,
      [
        String(nome).trim(),
        String(tipo_locucao || 'Padrão').trim(),
        audioConteudo,
        audioConteudo,
        idUsuarioValido
      ]
    );
    return res.status(201).json({ sucesso: true, voz: novaVoz.rows[0] });
  } catch (error) {
    console.error('Erro ao salvar voz no Neon:', error);
    return res.status(500).json({ sucesso: false, mensagem: 'Erro ao cadastrar voz: ' + error.message });
  }
});

app.delete('/api/vozes/:id', async (req, res) => {
  if (!pool) return bancoIndisponivel(res);
  try {
    await pool.query('UPDATE anuncios SET voz_id = NULL WHERE voz_id = $1', [req.params.id]);
    await pool.query('DELETE FROM vozes WHERE id = $1', [req.params.id]);
    return res.json({ sucesso: true });
  } catch (error) {
    return res.status(500).json({ sucesso: false, mensagem: 'Erro ao remover voz.' });
  }
});

// --- ROTEIRO COM GEMINI (ATUALIZADO PARA gemini-3.8-flash) ---
app.post('/api/gerar-roteiro-ia', async (req, res) => {
  const { produto, valorOriginal, valorPromocional, oferta } = req.body || {};

  if (!produto) {
    return res.status(400).json({ sucesso: false, mensagem: 'Informe o nome do produto.' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ sucesso: false, mensagem: 'GEMINI_API_KEY não configurada na Vercel.' });
  }

  try {
    const promptText = `Você é um locutor profissional de rádio de supermercado e varejo.
Crie um texto de chamada promocional curto, impactante e vendedor (máximo 40 palavras).
Dados da oferta:
- Produto: ${produto}
- De: R$ ${valorOriginal || 'Preço normal'}
- Por: R$ ${valorPromocional || 'Super promoção'}
- Oferta/Destaque: ${oferta || 'Imperdível'}

Regra: Retorne exclusivamente o texto da locução, pronto para narrar. Sem aspas nem comentários.`;

    const url = `
