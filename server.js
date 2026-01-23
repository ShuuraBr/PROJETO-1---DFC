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

const getProximoDiaUtil = (dataInput) => {
    let data = new Date(dataInput);
    // Ajuste para evitar problemas de fuso horário local na conversão
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

app.post('/api/usuarios', async (req, res) => {
    const { nome, email, departamentoId, role, nivel } = req.body;
    try {
        const [check] = await pool.query('SELECT Email FROM usuarios WHERE Email = ?', [email]);
        if (check.length > 0) return res.status(400).json({ success: false, message: 'Email já existe' });
        
        await pool.query(
            `INSERT INTO usuarios (ID, Nome, Email, Senha, Senha_prov, Pk_dep, Role, Nivel) 
             VALUES ((SELECT IFNULL(MAX(ID),0)+1 FROM usuarios AS U_temp), ?, ?, ?, ?, ?, ?, ?)`,
            [nome, email, SENHA_PADRAO, SENHA_PADRAO, departamentoId, role, nivel]
        );
        res.json({ success: true, message: 'Criado com sucesso' });
    } catch (e) { res.status(500).json({ success: false }); }
});

app.post('/api/definir-senha', async (req, res) => {
    const { email, novaSenha } = req.body;
    try {
        await pool.query('UPDATE usuarios SET Senha = ?, Senha_prov = NULL WHERE Email = ?', [novaSenha, email]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false }); }
});

app.get('/api/departamentos', async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT Id_dep, Nome_dep FROM departamentos');
        res.json(rows);
    } catch (e) { res.status(500).json([]); }
});

app.get('/api/anos', async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT DISTINCT Ano FROM dfc_analitica WHERE Ano IS NOT NULL ORDER BY Ano DESC');
        res.json(rows);
    } catch (e) { res.status(500).json([]); }
});

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
        // Busca um range de 2 anos para capturar boletos que podem transbordar o ano
        if (ano) { queryReal += ' AND (Ano = ? OR Ano = ?)'; paramsReal.push(ano, parseInt(ano) + 1); }
        queryReal += ' ORDER BY Dt_mov';

        const [resRealRaw] = await pool.query(queryReal, paramsReal);
        const mapRealizado = {};
        
        resRealRaw.forEach(r => {
            let mesAlvo = r.Mes;
            let anoAlvo = r.Ano;

            // Condição para Boletos - Afeta a competência (mês/ano)
            if (r.Nome && r.Nome.toLowerCase().includes('boleto') && r.Dt_mov) {
                const dataUtil = getProximoDiaUtil(r.Dt_mov);
                mesAlvo = dataUtil.getMonth() + 1;
                anoAlvo = dataUtil.getFullYear();
            }

            // Atribui ao mapa apenas se, após a postergação, pertencer ao ano filtrado
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
                const nomeColunaBanco = colunasBanco[index];
                const mesNumero = index + 1;
                let valOrcado = parseFloat(row[nomeColunaBanco]) || 0;
                if (ocultarOrcado) valOrcado = 0;
                const valRealizado = mapRealizado[`${codigo}-${mesNumero}`] || 0;
                const diferenca = valOrcado - valRealizado;
                dadosMesesItem[chaveFront] = { orcado: valOrcado, realizado: valRealizado, diferenca: diferenca };

                grupos[depto].dados[chaveFront].orcado += valOrcado;
                grupos[depto].dados[chaveFront].realizado += valRealizado;
                grupos[depto].dados[chaveFront].diferenca += diferenca;
            });
            grupos[depto].detalhes.push({ conta: contaFormatada, tipo: 'item', dados: dadosMesesItem });
        });

        // Lógica de Ordenação Crescente Numérica (Aba Orçamento)
        Object.values(grupos).forEach(grupo => {
            grupo.detalhes.sort((a, b) => a.conta.localeCompare(b.conta, undefined, { numeric: true, sensitivity: 'base' }));
        });

        res.json(Object.values(grupos));
    } catch (e) { 
        console.error(e);
        res.status(500).json({ error: 'Erro ao processar orçamento' }); 
    }
});


// =========================================================================
// FINANCEIRO (Dashboard) — Tabela de Previsões (somente quando Tipo de Visão = "Todos")
// Regras:
// - Baixa IS NULL
// - Financeiro IS NOT NULL
// - Agrupar por Codigo_plano/Nome e por mês
// - Hierarquia:
//   1- Previsões a Receber: 1.001.006 - BOLETOS
//   2- Previsões a Pagar:  2.001.001 / 2.001.002 / 2.001.003
// =========================================================================
app.get('/api/financeiro-dashboard', async (req, res) => {
    try {
        const { ano } = req.query;
        const params = [];

        // Regras:
        // - Baixa IS NULL
        // - Financeiro IS NOT NULL
        // - Valores por mês (jan..dez)
        // - Hierarquia: Grupo -> Plano (igual comportamento de clique da DFC, mas tabela separada)
        let sql = `
            SELECT 
                Codigo_plano,
                Nome,
                Mes,
                Ano,
                Valor_mov
            FROM dfc_analitica
            WHERE Baixa IS NULL
              AND Financeiro IS NOT NULL
        `;

        if (ano) {
            sql += ' AND Ano = ?';
            params.push(ano);
        }

        const [rows] = await pool.query(sql, params);

        const columns = ['jan','fev','mar','abr','mai','jun','jul','ago','set','out','nov','dez'];
        const headers = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
        const mapaMes = { 1:'jan',2:'fev',3:'mar',4:'abr',5:'mai',6:'jun',7:'jul',8:'ago',9:'set',10:'out',11:'nov',12:'dez' };

        const zerar = () => {
            const o = {};
            columns.forEach(c => o[c] = 0);
            return o;
        };

        const grupos = {
            receber: { conta: '1- Previsões a Receber', tipo: 'grupo', total: zerar(), planosMap: {} },
            pagar:   { conta: '2- Previsões a Pagar',   tipo: 'grupo', total: zerar(), planosMap: {} }
        };

        const planosReceber = new Set(['1.001.006']);
        const planosPagar   = new Set(['2.001.001','2.001.002','2.001.003']);

        rows.forEach(r => {
            const codigo = (r.Codigo_plano || '').toString().trim();
            const codigoBase = codigo.split(' ')[0]; // segurança
            const nome = (r.Nome || '').toString().trim();
            const mesKey = mapaMes[parseInt(r.Mes, 10)];
            if (!mesKey) return;

            const valor = parseFloat(r.Valor_mov) || 0;

            let grupoKey = null;
            if (planosReceber.has(codigoBase)) grupoKey = 'receber';
            else if (planosPagar.has(codigoBase)) grupoKey = 'pagar';
            else return;

            const g = grupos[grupoKey];

            if (!g.planosMap[codigoBase]) {
                g.planosMap[codigoBase] = { conta: `${codigoBase} - ${nome}`, tipo: 'item', ...zerar() };
            }

            g.planosMap[codigoBase][mesKey] += valor;
            g.total[mesKey] += valor;
        });

        // Monta rows hierárquicas (Grupo -> Planos)
        const rowsOut = [];
        const ordem = ['receber','pagar'];
        ordem.forEach(k => {
            const g = grupos[k];
            const detalhes = Object.values(g.planosMap)
                .sort((a,b) => a.conta.localeCompare(b.conta, undefined, { numeric:true, sensitivity:'base' }));

            // Grupo com totais (opcional, como DFC). Mantém "mesma forma" visual.
            rowsOut.push({ conta: g.conta, tipo: 'grupo', ...g.total, detalhes });
        });

        return res.json({ tabela: { rows: rowsOut, columns, headers } });
    } catch (err) {
        console.error('Erro /api/financeiro-dashboard:', err);
        return res.status(500).json({ error: 'Erro Financeiro Dashboard' });
    }
});



app.get('/api/dashboard', async (req, res) => {
    try {
        const { ano, view, status } = req.query; 
        
        let query = 'SELECT Origem_DFC, Nome_2, Codigo_plano, Nome, Mes, Ano, Valor_mov, Natureza, Dt_mov, Baixa FROM dfc_analitica WHERE 1=1';
        const params = [];

        // Buscamos um ano antes para capturar boletos de 31/12 que pulam para 01/01
        if (view !== 'anual' && ano) {
            query += ' AND (Ano = ? OR ( (Nome LIKE "%BOLETO%" OR Nome LIKE "%CARTÕES (DÉBITO E CRÉDITO)%") AND Ano = ?))';
            params.push(ano, parseInt(ano) - 1);
        }

        // --- FILTRO POR STATUS (REALIZADO / EM ABERTO) ---
        if (status === 'realizado') {
            query += ' AND (NOT (Nome LIKE "%BOLETO%" OR Nome LIKE "%CARTÕES (DÉBITO E CRÉDITO)%") OR Baixa IS NOT NULL)';
        } else if (status === 'aberto') {
            query += ' AND (NOT (Nome LIKE "%BOLETO%" OR Nome LIKE "%CARTÕES (DÉBITO E CRÉDITO)%") OR Baixa IS NULL)';
        }

        const [rawData] = await pool.query(query, params);

        let colunasKeys = [];
        let colunasLabels = [];

        if (view === 'anual') {
            const anosUnicos = [...new Set(rawData.map(r => r.Ano))].sort((a,b) => a - b);
            colunasKeys = anosUnicos.map(a => a.toString());
            colunasLabels = colunasKeys;
        } else if (view === 'trimestral') {
            colunasKeys = ['Q1', 'Q2', 'Q3', 'Q4'];
            colunasLabels = ['1º Trim', '2º Trim', '3º Trim', '4º Trim'];
        } else {
            colunasKeys = ['jan','fev','mar','abr','mai','jun','jul','ago','set','out','nov','dez'];
            colunasLabels = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
        }

        const mapaMeses = { 1: 'jan', 2: 'fev', 3: 'mar', 4: 'abr', 5: 'mai', 6: 'jun', 7: 'jul', 8: 'ago', 9: 'set', 10: 'out', 11: 'nov', 12: 'dez' };
        
        const zerarColunas = () => {
            const obj = {};
            colunasKeys.forEach(k => obj[k] = 0);
            return obj;
        };

        const normalizar = (str) => {
            if (!str) return '';
            return str
                .toString()
                .trim()
                .toLowerCase()
                .normalize('NFD')                 // separa acentos
                .replace(/[\u0300-\u036f]/g, '')  // remove acentos
                .replace(/\s*-\s*/g, '-')         // padroniza hífen: "04 - Ativo" => "04-Ativo"
                .replace(/\s+/g, ' ')             // espaços múltiplos
                .trim();
        };

        // Mapeamento robusto (chaves normalizadas). Isso evita sumir o "04- Ativo Imobilizado"
        // quando o banco vier como "04-Ativo Imobilizado", "04 - Ativo Imobilizado", etc.
        const configCategorias = {
            [normalizar('01- Entradas Operacionais')]: '01- Entradas Operacionais',
            [normalizar('02- Saídas Operacionais')]: '02- Saídas Operacionais',
            [normalizar('03- Operações Financeiras')]: '03- Operações Financeiras',
            [normalizar('04- Ativo Imobilizado')]: '04- Ativo Imobilizado',
            [normalizar('06- Movimentações de Sócios')]: '06- Movimentações de Sócios',
            [normalizar('07- Caixas da Loja')]: '07- Caixas da Loja'
        };

        let grupos = {};
        let FluxoGlobal = zerarColunas(); 
        let FluxoOperacional = zerarColunas();
        
        rawData.forEach(row => {
            let numMes = row.Mes;
            let numAno = row.Ano;

            // Lógica de Boletos: Próximo Dia Útil (Define a competência do mês/ano)
            if (row.Nome && row.Nome.toLowerCase().includes('boleto') && row.Dt_mov) {
                const dataUtil = getProximoDiaUtil(row.Dt_mov);
                numMes = dataUtil.getMonth() + 1;
                numAno = dataUtil.getFullYear();
            }

            // Filtro final: ignora se após postergar o boleto ele saiu do ano selecionado
            if (view !== 'anual' && ano && numAno.toString() !== ano.toString()) return;

            let chaveColuna = '';
            if (view === 'anual') {
                chaveColuna = numAno.toString();
            } else if (view === 'trimestral') {
                chaveColuna = `Q${Math.ceil(numMes / 3)}`;
            } else {
                chaveColuna = mapaMeses[numMes];
            }

            if (!colunasKeys.includes(chaveColuna)) return;

            const valorAbsoluto = parseFloat(row.Valor_mov) || 0; 
            const natureza = row.Natureza ? row.Natureza.trim().toLowerCase() : '';
            const ehSaida = natureza.includes('saída') || natureza.includes('saida');
            let valorParaTabela = ehSaida ? -Math.abs(valorAbsoluto) : Math.abs(valorAbsoluto);

            FluxoGlobal[chaveColuna] += valorParaTabela;

            if (row.Origem_DFC) {
                const chaveBanco = normalizar(row.Origem_DFC);
                let tituloGrupo = configCategorias[chaveBanco];

                if (tituloGrupo) {
                    if (!grupos[tituloGrupo]) grupos[tituloGrupo] = { titulo: tituloGrupo, total: zerarColunas(), subgruposMap: {} };
                    const grupo = grupos[tituloGrupo];
                    
                    const nome2 = row.Nome_2 ? row.Nome_2.trim() : 'Outros';
                    const cod = row.Codigo_plano || '';
                    const nom = row.Nome || '';
                    const itemChave = `${cod} - ${nom}`;

                    grupo.total[chaveColuna] += valorParaTabela;

                    if (!grupo.subgruposMap[nome2]) grupo.subgruposMap[nome2] = { conta: nome2, ...zerarColunas(), itensMap: {} };
                    grupo.subgruposMap[nome2][chaveColuna] += valorParaTabela;
                    
                    if (!grupo.subgruposMap[nome2].itensMap[itemChave]) grupo.subgruposMap[nome2].itensMap[itemChave] = { conta: itemChave, ...zerarColunas(), tipo: 'item' };
                    grupo.subgruposMap[nome2].itensMap[itemChave][chaveColuna] += valorParaTabela;

                    if (tituloGrupo.includes('01') || tituloGrupo.includes('02')) {
                        FluxoOperacional[chaveColuna] += valorParaTabela;
                    }
                }
            }
        });

        const ordemDesejada = ['01- Entradas Operacionais', '02- Saídas Operacionais', '03- Operações Financeiras', '04- Ativo Imobilizado', '06- Movimentações de Sócios', '07- Caixas da Loja'];

        let tabelaRows = [{ conta: 'Saldo Inicial', ...zerarColunas(), tipo: 'info' }];

        ordemDesejada.forEach(titulo => {
            const g = grupos[titulo];
            if (g) {
                const arraySubgrupos = Object.values(g.subgruposMap).map(sub => {
                    const arrayItens = Object.values(sub.itensMap);
                    arrayItens.sort((a, b) => a.conta.localeCompare(b.conta, undefined, { numeric: true }));
                    return { conta: sub.conta, ...sub, tipo: 'subgrupo', detalhes: arrayItens };
                });
                arraySubgrupos.sort((a, b) => a.conta.localeCompare(b.conta, undefined, { numeric: true }));
                tabelaRows.push({ conta: g.titulo, ...g.total, tipo: 'grupo', detalhes: arraySubgrupos });
            }
        });

        const totalEntradasOperacionais = grupos['01- Entradas Operacionais'] ? Object.values(grupos['01- Entradas Operacionais'].total).reduce((a, b) => a + b, 0) : 0;
        const totalSaidasOperacionais = grupos['02- Saídas Operacionais'] ? Math.abs(Object.values(grupos['02- Saídas Operacionais'].total).reduce((a, b) => a + b, 0)) : 0;

        const linhaSaldoFinal = zerarColunas();
        const graficoData = [];
        colunasKeys.forEach(col => {
            linhaSaldoFinal[col] = FluxoGlobal[col];
            graficoData.push(FluxoOperacional[col]);
        });

        tabelaRows.push({ conta: 'Saldo Final', ...linhaSaldoFinal, tipo: 'saldo' });
        const totalSuperavitDeficit = Object.values(FluxoOperacional).reduce((a, b) => a + b, 0);

        res.json({
            cards: {
                saldoInicial: 0, 
                entrada: totalEntradasOperacionais, 
                saida: totalSaidasOperacionais,
                deficitSuperavit: totalSuperavitDeficit,
                saldoFinal: Object.values(FluxoGlobal).reduce((a, b) => a + b, 0)
            },
            grafico: { labels: colunasLabels, data: graficoData },
            tabela: { rows: tabelaRows, columns: colunasKeys, headers: colunasLabels }
        });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Erro interno" });
    }
});

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Servidor rodando na porta http://192.168.3.67:${PORT}`));