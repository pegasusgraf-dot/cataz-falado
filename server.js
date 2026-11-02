const express = require('express');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://neondb_owner:npg_wDG0VzA1rTgl@ep-empty-leaf-bdhyrvif-pooler.c-8.us-east-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require';

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function inicializarBanco() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS usuarios (
        id SERIAL PRIMARY KEY,
        nome VARCHAR(100) UNIQUE NOT NULL,
        senha VARCHAR(100) NOT NULL,
        tipo VARCHAR(20) DEFAULT 'comum',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    const checkMaster = await pool.query("SELECT 1 FROM usuarios WHERE nome = 'master'");
    if (checkMaster.rows.length === 0) {
      await pool.query(
        "INSERT INTO usuarios (nome, senha, tipo) VALUES ('master', '123456', 'master')"
      );
      console.log('Usuário master criado com sucesso! (master / 123456)');
    }

    console.log('Banco inicializado com sucesso.');
  } catch (err) {
    console.error('Erro ao inicializar tabelas:', err);
  }
}

inicializarBanco();

app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, message: 'Banco conectado' });
  } catch (error) {
    console.error('Health check falhou:', error);
    res.status(500).json({ ok: false, message: 'Falha de conexão com o banco' });
  }
});

app.post('/api/login', async (req, res) => {
  const { usuario, senha } = req.body;

  try {
    const resultado = await pool.query(
      'SELECT * FROM usuarios WHERE nome = $1 AND senha = $2',
      [usuario, senha]
    );

    if (resultado.rows.length > 0) {
      return res.json({ sucesso: true, usuario: resultado.rows[0] });
    }

    return res.status(401).json({
      sucesso: false,
      mensagem: 'Usuário ou senha incorretos.',
    });
  } catch (error) {
    console.error('Erro no login:', error);
    return res.status(500).json({
      sucesso: false,
      mensagem: 'Erro interno no servidor.',
    });
  }
});

app.post('/api/usuarios', async (req, res) => {
  const { nome, senha, tipo } = req.body;

  try {
    const novo = await pool.query(
      'INSERT INTO usuarios (nome, senha, tipo) VALUES ($1, $2, $3) RETURNING id, nome, tipo',
      [nome, senha, tipo || 'comum']
    );

    return res.json({ sucesso: true, usuario: novo.rows[0] });
  } catch (error) {
    console.error('Erro ao cadastrar usuário:', error);
    return res.status(400).json({
      sucesso: false,
      mensagem: 'Erro ao cadastrar. O nome de usuário já pode existir.',
    });
  }
});

app.get('/api/usuarios', async (req, res) => {
  try {
    const lista = await pool.query('SELECT id, nome, tipo, created_at FROM usuarios ORDER BY id DESC');
    return res.json({ sucesso: true, usuarios: lista.rows });
  } catch (error) {
    console.error('Erro ao listar usuários:', error);
    return res.status(500).json({ sucesso: false, mensagem: 'Erro ao buscar usuários.' });
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
