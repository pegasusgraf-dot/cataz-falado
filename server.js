const express = require('express');
const { Pool } = require('pg');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Conexão com o Banco Neon otimizada para nuvem (SSL ajustado)
const pool = new Pool({
    connectionString: 'postgresql://neondb_owner:npg_VRkNhKFvSr17@ep-noisy-fog-b4p6p3pc-pooler.c-6.us-east-2.aws.neon.tech/neondb?sslmode=require',
    ssl: {
        rejectUnauthorized: false
    }
});

// Criar tabelas e colunas de forma segura e síncrona para evitar falhas nas primeiras requisições
async function inicializarBanco() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS usuarios (
                id SERIAL PRIMARY KEY,
                nome VARCHAR(100) UNIQUE NOT NULL,
                senha VARCHAR(100) NOT NULL,
                tipo VARCHAR(20) DEFAULT 'comum',
                status VARCHAR(20) DEFAULT 'aprovado',
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );
        `);
        
        await pool.query("ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'aprovado';");

        await pool.query(`
            CREATE TABLE IF NOT EXISTS historico_audios (
                id SERIAL PRIMARY KEY,
                usuario VARCHAR(100) NOT NULL,
                titulo TEXT NOT NULL,
                texto TEXT NOT NULL,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // Criar usuário master padrão (master / 123456) caso não exista nenhum
        const checkMaster = await pool.query("SELECT * FROM usuarios WHERE nome = 'master'");
        if (checkMaster.rows.length === 0) {
            await pool.query(
                "INSERT INTO usuarios (nome, senha, tipo, status) VALUES ('master', '123456', 'master', 'aprovado')"
            );
            console.log('Usuário master criado com sucesso! (master / 123456)');
        }
    } catch (err) {
        console.error('Erro crítico ao inicializar tabelas:', err);
    }
}

// Inicializa o banco antes de escutar as portas
inicializarBanco().then(() => {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
        console.log(`Servidor rodando na porta ${PORT}`);
    });
});

// Rota de Login tratada
app.post('/api/login', async (req, res) => {
    const { usuario, senha } = req.body;
    if (!usuario || !senha) {
        return res.status(400).json({ sucesso: false, mensagem: 'Preencha usuário e senha.' });
    }
    try {
        const resultado = await pool.query(
            'SELECT * FROM usuarios WHERE nome = $1 AND senha = $2',
            [usuario, senha]
        );
        if (resultado.rows.length > 0) {
            const user = resultado.rows[0];
            if (user.status === 'pendente') {
                return res.status(403).json({ sucesso: false, mensagem: 'Sua conta está aguardando aprovação do Administrador Master.' });
            }
            res.json({ sucesso: true, usuario: user });
        } else {
            res.status(401).json({ sucesso: false, mensagem: 'Usuário ou senha incorretos.' });
        }
    } catch (error) {
        console.error('Erro na rota /api/login:', error);
        res.status(500).json({ sucesso: false, mensagem: 'Erro interno no servidor.' });
    }
});

// Rota para cadastrar novo usuário
app.post('/api/usuarios', async (req, res) => {
    const { nome, senha } = req.body;
    if (!nome || !senha) {
        return res.status(400).json({ sucesso: false, mensagem: 'Nome e senha são obrigatórios.' });
    }
    try {
        const novo = await pool.query(
            'INSERT INTO usuarios (nome, senha, tipo, status) VALUES ($1, $2, $3, $4) RETURNING id, nome, tipo, status',
            [nome, senha, 'comum', 'pendente']
        );
        res.json({ sucesso: true, usuario: novo.rows[0] });
    } catch (error) {
        console.error('Erro na rota /api/usuarios:', error);
        res.status(400).json({ sucesso: false, mensagem: 'Erro ao cadastrar. O nome de usuário já pode existir.' });
    }
});

// Rota para listar usuários
app.get('/api/usuarios', async (req, res) => {
    try {
        const lista = await pool.query('SELECT id, nome, tipo, status, created_at FROM usuarios ORDER BY id DESC');
        res.json({ sucesso: true, usuarios: lista.rows });
    } catch (error) {
        console.error('Erro ao buscar usuários:', error);
        res.status(500).json({ sucesso: false, mensagem: 'Erro ao buscar usuários.' });
    }
});

// Rota para Aprovar usuário
app.post('/api/usuarios/aprovar', async (req, res) => {
    const { nome } = req.body;
    try {
        await pool.query("UPDATE usuarios SET status = 'aprovado' WHERE nome = $1", [nome]);
        res.json({ sucesso: true });
    } catch (error) {
        console.error('Erro ao aprovar usuário:', error);
        res.status(500).json({ sucesso: false, mensagem: 'Erro ao aprovar usuário.' });
    }
});

// Rota para Deletar usuário
app.delete('/api/usuarios/:nome', async (req, res) => {
    const { nome } = req.params;
    if (nome === 'master') {
        return res.status(400).json({ sucesso: false, mensagem: 'Não é permitido excluir o usuário master.' });
    }
    try {
        await pool.query('DELETE FROM usuarios WHERE nome = $1', [nome]);
        res.json({ sucesso: true });
    } catch (error) {
        console.error('Erro ao excluir usuário:', error);
        res.status(500).json({ sucesso: false, mensagem: 'Erro ao excluir usuário.' });
    }
});

// Rotas de Histórico de Áudios
app.post('/api/historico', async (req, res) => {
    const { usuario, titulo, texto } = req.body;
    try {
        const novo = await pool.query(
            'INSERT INTO historico_audios (usuario, titulo, texto) VALUES ($1, $2, $3) RETURNING *',
            [usuario, titulo, texto]
        );
        res.json({ sucesso: true, item: novo.rows[0] });
    } catch (error) {
        console.error('Erro ao salvar histórico:', error);
        res.status(500).json({ sucesso: false, mensagem: 'Erro ao salvar histórico.' });
    }
});

app.get('/api/historico', async (req, res) => {
    try {
        const lista = await pool.query('SELECT * FROM historico_audios ORDER BY id DESC LIMIT 50');
        res.json({ sucesso: true, historico: lista.rows });
    } catch (error) {
        console.error('Erro ao buscar histórico:', error);
        res.status(500).json({ sucesso: false, mensagem: 'Erro ao buscar histórico.' });
    }
});
