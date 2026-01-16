const mysql = require('mysql2/promise');
require('dotenv').config();

// Cria o pool de conexões com o MySQL da Hostinger
const pool = mysql.createPool({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10, // Limite seguro para hospedagem compartilhada
    queueLimit: 0
});

// Teste de conexão ao iniciar a aplicação
pool.getConnection()
    .then(connection => {
        console.log(`✅ Conectado ao MySQL Hostinger (${process.env.DB_HOST}) com sucesso!`);
        connection.release();
    })
    .catch(err => {
        console.error('❌ Erro ao conectar no MySQL:', err.message);
        console.error('DICA: Verifique se seu IP está liberado no "MySQL Remoto" da Hostinger.');
    });

module.exports = pool;