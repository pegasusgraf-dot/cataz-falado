const express = require('express');
const { Pool } = require('pg');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Conexão com o Banco Neon
const pool = new Pool({
    connectionString: 'postgresql://neondb_owner:npg_VRkNhKFvSr17@ep-noisy-fog-b4p6p3pc-pooler.c-6.us-east-2.aws.neon.tech/neondb?sslmode=require',
});

// Criar tabelas automaticamente se não existirem e injetar o master
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
        
        // Verificar e criar o usuário master padrão caso não exista nenhum
        const checkMaster = await pool.query("SELECT * FROM usuarios WHERE nome = 'master'");
        if (checkMaster.rows.length === 0) {
            await pool.query(
                "INSERT INTO usuarios (nome, senha, tipo) VALUES ('master', '123456', 'master')"
            );
            console.log('✅ Usuário master criado com sucesso! (master / 123456)');
        } else {
            console.log('ℹ️ Usuário master já existe no banco.');
        }
    } catch (err) {
        console.error('❌ Erro ao inicializar tabelas:', err);
    }
}

// Inicializa o banco ao subir o servidor
inicializarBanco();

// Rota de Login (compatível com 'usuario', 'nome' ou 'login' vindo do front-end)
app.post('/api/login', async (req, res) => {
    console.log('--- NOVA TENTATIVA DE LOGIN ---');
    console.log('Dados recebidos no req.body:', req.body);

    const nomeUsuario = req.body.usuario || req.body.nome || req.body.login;
    const { senha } = req.body;

    if (!nomeUsuario || !senha) {
        console.log('❌ Falha: Usuário ou senha não informados.');
        return res.status(400).json({ sucesso: false, mensagem: 'Informe o usuário e a senha.' });
    }

    try {
        const resultado = await pool.query(
            'SELECT * FROM usuarios WHERE nome = $1 AND senha = $2',
            [String(nomeUsuario).trim(), String(senha).trim()]
        );
        
        if (resultado.rows.length > 0) {
            console.log(`✅ Login bem-sucedido para o usuário: "${nomeUsuario}"`);
            res.json({ sucesso: true, usuario: resultado.rows[0] });
        } else {
            console.log(`❌ Falha: Credenciais inválidas para o usuário: "${nomeUsuario}"`);
            res.status(401).json({ sucesso: false, mensagem: 'Usuário ou senha incorretos.' });
        }
    } catch (error) {
        console.error('❌ Erro interno no servidor durante o login:', error);
        res.status(500).json({ sucesso: false, mensagem: 'Erro interno no servidor.' });
    }
});

// Rota para cadastrar novo usuário
app.post('/api/usuarios', async (req, res) => {
    const nomeUsuario = req.body.usuario || req.body.nome;
    const { senha, tipo } = req.body;

    try {
        const novo = await pool.query(
            'INSERT INTO usuarios (nome, senha, tipo) VALUES ($1, $2, $3) RETURNING id, nome, tipo',
            [String(nomeUsuario).trim(), String(senha).trim(), tipo || 'comum']
        );
        console.log(`✅ Usuário cadastrado com sucesso: ${nomeUsuario}`);
        res.json({ sucesso: true, usuario: novo.rows[0] });
    } catch (error) {
        console.error('❌ Erro ao cadastrar usuário:', error);
        res.status(400).json({ sucesso: false, mensagem: 'Erro ao cadastrar. O nome de usuário já pode existir.' });
    }
});

// Rota para listar usuários
app.get('/api/usuarios', async (req, res) => {
    try {
        const lista = await pool.query('SELECT id, nome, tipo, created_at FROM usuarios ORDER BY id DESC');
        res.json({ sucesso: true, usuarios: lista.rows });
    } catch (error) {
        console.error('❌ Erro ao buscar usuários:', error);
        res.status(500).json({ sucesso: false, mensagem: 'Erro ao buscar usuários.' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Servidor rodando na porta ${PORT}`);
});
