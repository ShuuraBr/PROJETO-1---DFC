require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const pool = require('./db'); 
const nodemailer = require('nodemailer');
const crypto = require('crypto');

const app = express();

// Configurações do Express
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const SENHA_PADRAO = 'Obj@2026';

// --- LOGICA DE FERIADOS E DIAS ÚTEIS (NOVA) ---
const getFeriados = (ano) => {
    const fixos = ['01-01', '04-21', '05-01', '09-07', '10-12', '11-02', '11-15', '12-25'];
    const moveis = {
        2024: ['02-13', '03-29', '05-30'],
        2025: ['03-04', '04-18', '06-19'],
        2026: ['02-17', '04-03', '06-04'],
        2027: ['02-09', '03-26', '05-27'],
        2028: ['02-29', '04-14', '06-15']
    };
    return fixos.map(f => `${ano}-${f}`).concat(moveis[ano] || []);
};

// Função auxiliar para identificar tipos especiais que sofrem postergação
const ehTipoEspecial = (nome) => {
    if (!nome) return false;
    const n = nome.toUpperCase();
    return n.includes('BOLETO') || n.includes('CARTÕES (DÉBITO E CRÉDITO)');
};

const getProximoDiaUtil = (dataInput) => {
    let data = new Date(dataInput);
    if (typeof dataInput === 'string' && !dataInput.includes('T')) {
        data = new Date(dataInput + 'T12:00:00');
    }

    const ehDiaUtil = (d) => {
        const ano = d.getFullYear();
        const mes = String(d.getMonth() + 1).padStart(2, '0');
        const dia = String(d.getDate()).padStart(2, '0');
        const dataFormatada = `${ano}-${mes}-${dia}`;
        const diaSemana = d.getDay(); // 0 = Domingo, 6 = Sábado
        const feriados = getFeriados(ano);
        return diaSemana !== 0 && diaSemana !== 6 && !feriados.includes(dataFormatada);
    };

    while (!ehDiaUtil(data)) {
        data.setDate(data.getDate() + 1);
    }
    return data;
};

// --- Configuração do Nodemailer ---
const transporter = nodemailer.createTransport({
    host: 'smtp.hostinger.com',
    port: 465,
    secure: true,
    auth: {
        user: 'no-reply@dfc.objetivaatacadista.com.br', 
        pass: process.env.EMAIL_PASS 
    }
});

// =========================================================================
// ROTAS DE AUTENTICAÇÃO (2FA - 60 Segundos via MySQL)
// =========================================================================

app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    console.log(`[LOGIN 1/2] Tentativa para: ${email}`);

    try {
        const query = `
            SELECT U.Email, U.Nome, U.Role, U.Nivel, U.Senha_prov, D.Nome_dep as Departamento 
            FROM usuarios U 
            LEFT JOIN departamentos D ON U.Pk_dep = D.Id_dep 
            WHERE U.Email = ? AND U.Senha = ?
        `;

        const [rows] = await pool.query(query, [email, password]);

        if (rows.length > 0) {
            const token = crypto.randomInt(100000, 999999).toString();
            await pool.query(
                `INSERT INTO tokens_acesso (email, token, expira_em) 
                 VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 60 SECOND))`,
                [email, token]
            );

            try {
                await transporter.sendMail({
                    from: '"Segurança DFC" <no-reply@dfc.objetivaatacadista.com.br>',
                    to: email,
                    subject: 'Seu Código de Acesso - DFC',
                    html: `
                        <div style="font-family: Arial, sans-serif; padding: 20px; color: #333;">
                            <h2>Código de Verificação</h2>
                            <p>Seu código de acesso é:</p>
                            <h1 style="color: #2563eb; letter-spacing: 5px;">${token}</h1>
                            <p>Válido por <strong>60 segundos</strong>.</p>
                        </div>
                    `
                });
                res.json({ success: true, require2fa: true, email: email });

            } catch (mailErr) {
                console.error("Erro ao enviar email:", mailErr);
                res.status(500).json({ success: false, message: 'Erro envio email.' });
            }

        } else {
            res.status(401).json({ success: false, message: 'Credenciais inválidas' });
        }
    } catch (e) {
        console.error("[LOGIN] Erro:", e.message);
        res.status(500).json({ success: false, message: 'Erro BD.' });
    }
});

app.post('/api/validar-token', async (req, res) => {
    const { email, token } = req.body;
    try {
        const [tokens] = await pool.query(
            `SELECT * FROM tokens_acesso WHERE email = ? AND token = ? AND expira_em > NOW() ORDER BY id DESC LIMIT 1`,
            [email, token]
        );

        if (tokens.length > 0) {
            const queryUser = `
                SELECT U.Email, U.Nome, U.Role, U.Nivel, U.Senha_prov, D.Nome_dep as Departamento 
                FROM usuarios U LEFT JOIN departamentos D ON U.Pk_dep = D.Id_dep WHERE U.Email = ?
            `;
            const [users] = await pool.query(queryUser, [email]);
            const u = users[0];
            await pool.query('DELETE FROM tokens_acesso WHERE id = ?', [tokens[0].id]);
            res.json({ success: true, user: { ...u, Nome: u.Nome || 'Usuário', Role: u.Role || 'user' } });
        } else {
            res.status(401).json({ success: false, message: 'Token inválido/expirado.' });
        }
    } catch (e) { res.status(500).json({ success: false }); }
});

// =========================================================================
// ROTAS DO SISTEMA
// =========================================================================

app.get('/api/orcamento', async (req, res) => {
    const { email, ano } = req.query;
    try {
        const [users] = await pool.query(
            'SELECT Role, D.Nome_dep FROM usuarios U LEFT JOIN departamentos D ON U.Pk_dep = D.Id_dep WHERE Email = ?', 
            [email]
        );
        if (users.length === 0) return res.status(401).json({ error: 'Usuário não encontrado' });
        
        const user = users[0];
        const departamentoUsuario = user.Nome_dep || '';
        const isSuperUser = user.Role === 'admin' || (departamentoUsuario && departamentoUsuario.toLowerCase().includes('planejamento'));

        let queryOrc = `SELECT Plano, Nome, Departamento1, Janeiro, Fevereiro, Marco, Abril, Maio, Junho, Julho, Agosto, Setembro, Outubro, Novembro, Dezembro FROM orcamento WHERE 1=1 `;
        const paramsOrc = [];
        if (!isSuperUser) { queryOrc += ' AND Departamento1 = ?'; paramsOrc.push(departamentoUsuario); }
        queryOrc += ' ORDER BY Departamento1, Plano';

        const [orcamentoData] = await pool.query(queryOrc, paramsOrc);

        let queryReal = `SELECT Codigo_plano, Nome, Mes, Ano, Dt_mov, Valor_mov FROM dfc_analitica WHERE 1=1 `;
        const paramsReal = [];
        if (ano) { queryReal += ' AND (Ano = ? OR Ano = ?)'; paramsReal.push(ano, parseInt(ano) + 1); }
        queryReal += ' ORDER BY Dt_mov';

        const [resRealRaw] = await pool.query(queryReal, paramsReal);
        const mapRealizado = {};
        
        resRealRaw.forEach(r => {
            let mesAlvo = r.Mes;
            let anoAlvo = r.Ano;

            if (ehTipoEspecial(r.Nome) && r.Dt_mov) {
                const dataUtil = getProximoDiaUtil(r.Dt_mov);
                mesAlvo = dataUtil.getMonth() + 1;
                anoAlvo = dataUtil.getFullYear();
            }

            if (!ano || anoAlvo.toString() === ano.toString()) {
                const chave = `${r.Codigo_plano}-${mesAlvo}`;
                mapRealizado[chave] = (mapRealizado[chave] || 0) + (parseFloat(r.Valor_mov) || 0);
            }
        });

        const colunasBanco = ['Janeiro', 'Fevereiro', 'Marco', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
        const chavesFrontend = ['jan','fev','mar','abr','mai','jun','jul','ago','set','out','nov','dez'];
        const grupos = {};
        const ocultarOrcado = (ano && ano.toString() === '2025');

        orcamentoData.forEach(row => {
            const codigo = row.Plano;
            const nome = row.Nome;
            const depto = row.Departamento1 || 'Sem Departamento';
            const contaFormatada = `${codigo} - ${nome}`;

            if (!grupos[depto]) {
                grupos[depto] = { conta: depto, tipo: 'grupo', dados: {}, detalhes: [] };
                chavesFrontend.forEach(k => grupos[depto].dados[k] = { orcado: 0, realizado: 0, diferenca: 0 });
            }
            const dadosMesesItem = {};
            chavesFrontend.forEach((chaveFront, index) => {
                const orcado = ocultarOrcado ? 0 : parseFloat(row[colunasBanco[index]]) || 0;
                const realizado = mapRealizado[`${codigo}-${index+1}`] || 0;
                dadosMesesItem[chaveFront] = { orcado, realizado, diferenca: orcado - realizado };
                grupos[depto].dados[chaveFront].orcado += orcado;
                grupos[depto].dados[chaveFront].realizado += realizado;
                grupos[depto].dados[chaveFront].diferenca += (orcado - realizado);
            });
            grupos[depto].detalhes.push({ conta: contaFormatada, tipo: 'item', dados: dadosMesesItem });
        });

        Object.values(grupos).forEach(grupo => {
            grupo.detalhes.sort((a, b) => a.conta.localeCompare(b.conta, undefined, { numeric: true }));
        });

        res.json(Object.values(grupos));
    } catch (e) { 
        console.error(e);
        res.status(500).json({ error: 'Erro ao processar orçamento' }); 
    }
});

app.get('/api/dashboard', async (req, res) => {
    try {
        const { ano, view, status } = req.query; 
        
        let query = 'SELECT Origem_DFC, Nome_2, Codigo_plano, Nome, Mes, Ano, Valor_mov, Natureza, Dt_mov, Baixa FROM dfc_analitica WHERE 1=1';
        const params = [];

        if (view !== 'anual' && ano) {
            query += ' AND (Ano = ? OR ( (Nome LIKE "%BOLETO%" OR Nome LIKE "%CARTÕES (DÉBITO E CRÉDITO)%") AND Ano = ?))';
            params.push(ano, parseInt(ano) - 1);
        }

        // --- LÓGICA DE FILTRO POR STATUS (REALIZADO / EM ABERTO) ---
        if (status === 'realizado') {
            // Traz tudo que NÃO é especial OU itens especiais que possuem data de baixa preenchida
            query += ' AND (NOT (Nome LIKE "%BOLETO%" OR Nome LIKE "%CARTÕES (DÉBITO E CRÉDITO)%") OR Baixa IS NOT NULL)';
        } else if (status === 'aberto') {
            // Traz tudo que NÃO é especial (fluxo normal) + itens especiais SEM baixa
            query += ' AND (NOT (Nome LIKE "%BOLETO%" OR Nome LIKE "%CARTÕES (DÉBITO E CRÉDITO)%") OR Baixa IS NULL)';
        }

        const [rawData] = await pool.query(query, params);

        let colKeys = (view === 'anual') ? [...new Set(rawData.map(r => r.Ano))].sort() : (view === 'trimestral' ? ['Q1','Q2','Q3','Q4'] : ['jan','fev','mar','abr','mai','jun','jul','ago','set','out','nov','dez']);
        const mapaMeses = { 1: 'jan', 2: 'fev', 3: 'mar', 4: 'abr', 5: 'mai', 6: 'jun', 7: 'jul', 8: 'ago', 9: 'set', 10: 'out', 11: 'nov', 12: 'dez' };
        
        const zerarColunas = () => {
            const obj = {};
            colKeys.forEach(k => obj[k] = 0);
            return obj;
        };

        const normalizar = (str) => str ? str.trim().toLowerCase().replace(/\s+/g, ' ') : '';
        const configCategorias = { '01-entradas operacionais': '01- Entradas Operacionais', '02- saidas operacionais': '02- Saídas Operacionais', '03- operações financeiras': '03- Operações Financeiras', '04- ativo imobilizado': '04- Ativo Imobilizado', '06- movimentações de socios': '06- Movimentações de Sócios', '07- caixas da loja': '07- Caixas da Loja' };

        let grupos = {};
        let FluxoGlobal = zerarColunas(); 
        let FluxoOperacional = zerarColunas();
        
        rawData.forEach(row => {
            let numMes = row.Mes, numAno = row.Ano;

            if (ehTipoEspecial(row.Nome) && row.Dt_mov) {
                const dataUtil = getProximoDiaUtil(row.Dt_mov);
                numMes = dataUtil.getMonth() + 1;
                numAno = dataUtil.getFullYear();
            }

            if (view !== 'anual' && ano && numAno.toString() !== ano.toString()) return;

            let col = (view === 'anual') ? numAno.toString() : (view === 'trimestral' ? `Q${Math.ceil(numMes/3)}` : mapaMeses[numMes]);
            if (!colKeys.includes(col)) return;

            const val = parseFloat(row.Valor_mov) || 0;
            const ehSaida = row.Natureza && row.Natureza.toLowerCase().includes('saida');
            let valTab = ehSaida ? -val : val;

            FluxoGlobal[col] += valTab;

            if (row.Origem_DFC) {
                const chaveBanco = normalizar(row.Origem_DFC);
                let tituloGrupo = configCategorias[chaveBanco] || Object.values(configCategorias).find(v => normalizar(v).includes(chaveBanco));

                if (tituloGrupo) {
                    if (!grupos[tituloGrupo]) grupos[tituloGrupo] = { titulo: tituloGrupo, total: zerarColunas(), subMap: {} };
                    grupos[tituloGrupo].total[col] += valTab;
                    const n2 = row.Nome_2 || 'Outros', itemChave = `${row.Codigo_plano} - ${row.Nome}`;
                    if (!grupos[tituloGrupo].subMap[n2]) grupos[tituloGrupo].subMap[n2] = { conta: n2, ...zerarColunas(), itemMap: {} };
                    grupos[tituloGrupo].subMap[n2][col] += valTab;
                    if (!grupos[tituloGrupo].subMap[n2].itemMap[itemChave]) grupos[tituloGrupo].subMap[n2].itemMap[itemChave] = { conta: itemChave, ...zerarColunas(), tipo: 'item' };
                    grupos[tituloGrupo].subMap[n2].itemMap[itemChave][col] += valTab;
                    if (tituloGrupo.includes('01') || tituloGrupo.includes('02')) FluxoOperacional[col] += valTab;
                }
            }
        });

        let tabelaRows = [{ conta: 'Saldo Inicial', ...zerarColunas(), tipo: 'info' }];
        ['01- Entradas Operacionais', '02- Saídas Operacionais', '03- Operações Financeiras', '04- Ativo Imobilizado', '06- Movimentações de Sócios', '07- Caixas da Loja'].forEach(titulo => {
            if (grupos[titulo]) {
                const arraySub = Object.values(grupos[titulo].subMap).map(sub => {
                    const its = Object.values(sub.itemMap).sort((a,b) => a.conta.localeCompare(b.conta, undefined, { numeric: true }));
                    return { conta: sub.conta, ...sub, detalhes: its };
                }).sort((a,b) => a.conta.localeCompare(b.conta, undefined, { numeric: true }));
                tabelaRows.push({ conta: titulo, ...grupos[titulo].total, tipo: 'grupo', detalhes: arraySub });
            }
        });

        res.json({
            cards: { saldoInicial: 0, entrada: grupos['01- Entradas Operacionais'] ? Object.values(grupos['01- Entradas Operacionais'].total).reduce((a, b) => a + b, 0) : 0, saida: grupos['02- Saídas Operacionais'] ? Math.abs(Object.values(grupos['02- Saídas Operacionais'].total).reduce((a, b) => a + b, 0)) : 0, deficitSuperavit: Object.values(FluxoOperacional).reduce((a, b) => a + b, 0), saldoFinal: Object.values(FluxoGlobal).reduce((a, b) => a + b, 0) },
            grafico: { labels: colKeys, data: Object.values(FluxoOperacional) },
            tabela: { rows: tabelaRows, columns: colKeys, headers: colKeys }
        });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Erro interno" });
    }
});

app.get('*', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'index.html')); });
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Servidor rodando na porta http://192.168.3.67:${PORT}`));