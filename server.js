const express = require('express');
const { Pool } = require('pg');
const path = require('path');

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Conexão com o Banco Neon
const pool = new Pool({
    connectionString: 'postgresql://neondb_owner:npg_VRkNhKFvSr17@ep-noisy-fog-b4p6p3pc-pooler.c-6.us-east-2.aws.neon.tech/neondb?sslmode=require',
});

// Criar tabelas automaticamente e garantir o usuário master
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
        
        // Garante que o master sempre exista com a senha 123456
        await pool.query(`
            INSERT INTO usuarios (nome, senha, tipo) 
            VALUES ('master', '123456', 'master')
            ON CONFLICT (nome) DO UPDATE SET senha = '123456', tipo = 'master';
        `);
        
        console.log('✅ Banco pronto! Usuário master garantido (master / 123456)');
    } catch (err) {
        console.error('❌ Erro ao inicializar tabelas:', err);
    }
}

inicializarBanco();

// Rota de Login ultra-flexível (aceita qualquer nome de campo do front-end)
app.post('/api/login', async (req, res) => {
    console.log('--- REQUISIÇÃO DE LOGIN RECEBIDA ---', req.body);

    const identificador = req.body.usuario || req.body.nome || req.body.login || req.body.email;
    const senha = req.body.senha || req.body.password;

    if (!identificador || !senha) {
        return res.status(400).json({ sucesso: false, mensagem: 'Preencha o usuário e a senha.' });
    }

    try {
        // Busca ignorando maiúsculas/minúsculas no nome ou e-mail
        const resultado = await pool.query(
            'SELECT * FROM usuarios WHERE (LOWER(nome) = LOWER($1)) AND senha = $2',
            [String(identificador).trim(), String(senha).trim()]
        );
        
        if (resultado.rows.length > 0) {
            console.log(`✅ Login autorizado para: ${identificador}`);
            return res.json({ sucesso: true, usuario: resultado.rows[0] });
        } else {
            console.log(`❌ Credenciais inválidas para: ${identificador}`);
            return res.status(401).json({ sucesso: false, mensagem: 'Usuário ou senha incorretos.' });
        }
    } catch (error) {
        console.error('❌ Erro interno no login:', error);
        return res.status(500).json({ sucesso: false, mensagem: 'Erro interno no servidor.' });
    }
});

// Rota de Cadastro de Usuários
app.post('/api/usuarios', async (req, res) => {
    console.log('--- REQUISIÇÃO DE CADASTRO ---', req.body);

    const nomeUsuario = req.body.usuario || req.body.nome || req.body.email;
    const senha = req.body.senha || req.body.password;
    const tipo = req.body.tipo || 'comum';

    if (!nomeUsuario || !senha) {
        return res.status(400).json({ sucesso: false, mensagem: 'Informe o nome/usuário e a senha.' });
    }

    try {
        const novo = await pool.query(
            'INSERT INTO usuarios (nome, senha, tipo) VALUES ($1, $2, $3) RETURNING id, nome, tipo',
            [String(nomeUsuario).trim(), String(senha).trim(), tipo]
        );
        console.log(`✅ Usuário cadastrado com sucesso: ${nomeUsuario}`);
        return res.json({ sucesso: true, usuario: novo.rows[0] });
    } catch (error) {
        console.error('❌ Erro ao cadastrar:', error);
        return res.status(400).json({ sucesso: false, mensagem: 'Erro ao cadastrar. O usuário já pode existir.' });
    }
});

// Rota para listar usuários
app.get('/api/usuarios', async (req, res) => {
    try {
        const lista = await pool.query('SELECT id, nome, tipo, created_at FROM usuarios ORDER BY id DESC');
        return res.json({ sucesso: true, usuarios: lista.rows });
    } catch (error) {
        return res.status(500).json({ sucesso: false, mensagem: 'Erro ao buscar usuários.' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Servidor rodando na porta ${PORT}`);
});
