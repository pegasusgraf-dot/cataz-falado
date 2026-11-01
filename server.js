const express = require('express');
const { Pool } = require('pg');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Conexão com o seu banco Neon
const pool = new Pool({
    connectionString: 'postgresql://neondb_owner:npg_VRkNhKFvSr17@ep-noisy-fog-b4p6p3pc-pooler.c-6.us-east-2.aws.neon.tech/neondb?sslmode=require',
});

// Rota para Cadastrar Usuário
app.post('/api/registrar', async (req, res) => {
    const { usuario, senha } = req.body;
    try {
        const query = 'INSERT INTO usuarios (nome, email) VALUES ($1, $2) RETURNING *';
        // Usando o campo 'usuario' como nome e gerando um email temporário para teste se não houver
        const emailTemp = `${usuario.toLowerCase().replace(/\s+/g, '')}@syncstore.com`;
        
        const novoUsuario = await pool.query(query, [usuario, emailTemp]);
        res.json({ sucesso: true, usuario: novoUsuario.rows[0] });
    } catch (error) {
        console.error(error);
        res.status(500).json({ sucesso: false, mensagem: 'Erro ao cadastrar usuário no banco.' });
    }
});

// Rota para Login
app.post('/api/login', async (req, res) => {
    const { usuario } = req.body;
    try {
        const resultado = await pool.query('SELECT * FROM usuarios WHERE nome = $1', [usuario]);
        if (resultado.rows.length > 0) {
            res.json({ sucesso: true, usuario: resultado.rows[0] });
        } else {
            // Se não existir, cadastra automaticamente para facilitar
            const emailTemp = `${usuario.toLowerCase().replace(/\s+/g, '')}@syncstore.com`;
            const novo = await pool.query('INSERT INTO usuarios (nome, email) VALUES ($1, $2) RETURNING *', [usuario, emailTemp]);
            res.json({ sucesso: true, usuario: novo.rows[0] });
        }
    } catch (error) {
        console.error(error);
        res.status(500).json({ sucesso: false, mensagem: 'Erro ao conectar ao banco de dados.' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
});
