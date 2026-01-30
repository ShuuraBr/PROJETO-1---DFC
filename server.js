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

const PLANOS_CAIXA = new Set(['1.001.001','1.001.008']);

const SENHA_PADRAO = 'Obj@2026';
// --- HASH DE SENHA (scrypt) ---
// Formato armazenado: scrypt$<salt-hex>$<hash-hex>
const hashPasswordScrypt = (plain) => {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(String(plain), salt, 64).toString('hex');
    return `scrypt$${salt}$${hash}`;
};

const verifyPasswordScrypt = (plain, stored) => {
    if (!stored) return false;

    // migração: se for senha em texto puro, compara direto
    if (!String(stored).startsWith('scrypt$')) {
        return String(plain) === String(stored);
    }

    const parts = String(stored).split('$');
    if (parts.length !== 3) return false;
    const salt = parts[1];
    const hash = parts[2];

    const calc = crypto.scryptSync(String(plain), salt, 64).toString('hex');

    // comparação segura
    const a = Buffer.from(hash, 'hex');
    const b = Buffer.from(calc, 'hex');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
};


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
            SELECT U.Email, U.Nome, U.Role, U.Nivel, U.Senha, U.Senha_prov, D.Nome_dep as Departamento 
            FROM usuarios U 
            LEFT JOIN departamentos D ON U.Pk_dep = D.Id_dep 
            WHERE U.Email = ?
        `;

        const [rows] = await pool.query(query, [email]);

        if (rows.length > 0 && verifyPasswordScrypt(password, rows[0].Senha)) {
            // migração automática: se a senha ainda estiver em texto puro, converte para hash
            if (rows[0].Senha && !String(rows[0].Senha).startsWith('scrypt$')) {
                try {
                    await pool.query('UPDATE usuarios SET Senha = ? WHERE Email = ?', [hashPasswordScrypt(password), email]);
                } catch (e) {
                    console.warn('[LOGIN] Falha ao migrar senha para hash:', e.message);
                }
            }

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
            [nome, email, hashPasswordScrypt(SENHA_PADRAO), hashPasswordScrypt(SENHA_PADRAO), departamentoId, role, nivel]
        );
        res.json({ success: true, message: 'Criado com sucesso' });
    } catch (e) { res.status(500).json({ success: false }); }
});

app.post('/api/definir-senha', async (req, res) => {
    const { email, novaSenha } = req.body;
    try {
        await pool.query('UPDATE usuarios SET Senha = ?, Senha_prov = NULL WHERE Email = ?', [hashPasswordScrypt(novaSenha), email]);
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
    const anoSel = Number(ano) || new Date().getFullYear();
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

        let queryReal = `SELECT Codigo_plano, Nome, Mes, Ano, Dt_mov, Valor_mov, Natureza, Baixa FROM dfc_analitica WHERE 1=1 `;
        const paramsReal = [];
        // Buscamos um ano anterior para capturar boletos/cartões de 31/12 que caem no próximo dia útil (01/01)
        queryReal += ' AND (Ano = ? OR (((LOWER(Nome) LIKE "%boleto%") OR (LOWER(Nome) LIKE "%cart%")) AND Ano = ?))';
        paramsReal.push(anoSel, anoSel - 1);
        queryReal += ' AND (Baixa IS NOT NULL OR Codigo_plano IN ("1.001.001","1.001.008"))';
        queryReal += ' ORDER BY Dt_mov';

        const [resRealRaw] = await pool.query(queryReal, paramsReal);
        const mapRealizado = {};
        
        resRealRaw.forEach(r => {
            let mesAlvo = r.Mes;
            let anoAlvo = r.Ano;

            // Condição para Boletos - Afeta a competência (mês/ano)
            if (r.Nome && r.Nome.toLowerCase().includes('boleto') && r.Dt_mov) {
                const dataUtil = getProximoDiaUtil(r.Dt_mov);
                if (dataUtil instanceof Date && !isNaN(dataUtil.getTime())) {
                    mesAlvo = dataUtil.getMonth() + 1;
                    anoAlvo = dataUtil.getFullYear();
                }
            }

            // Atribui ao mapa apenas se, após a postergação, pertencer ao ano filtrado
            if (anoAlvo === anoSel) {
                const chave = `${r.Codigo_plano}-${mesAlvo}`;
                const v = parseFloat(r.Valor_mov) || 0;
                const absV = Math.abs(v);
                const natureza = (r.Natureza || '').toString().toLowerCase();
                const liquido = natureza.startsWith('sa') ? -absV : absV;
                mapRealizado[chave] = (mapRealizado[chave] || 0) + liquido;
            }
        });

        const colunasBanco = ['Janeiro', 'Fevereiro', 'Marco', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
        const chavesFrontend = ['jan','fev','mar','abr','mai','jun','jul','ago','set','out','nov','dez'];
        const grupos = {};
        const ocultarOrcado = (anoSel.toString() === '2025');

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
                const valRealizadoLiquido = mapRealizado[`${codigo}-${mesNumero}`] || 0;
                const valRealizado = Math.abs(valRealizadoLiquido); // neutro: ABS do líquido (entrada/saída)
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
        res.status(500).json({ error: 'Erro ao processar orçamento', detail: String(e && e.message ? e.message : e) }); 
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
// =========================================================================
// FINANCEIRO (Dashboard) — Tabela de Previsões (somente quando Tipo de Visão = "Todos")
// Regras:
// - Baixa IS NULL
// - Financeiro IS NOT NULL
// - Hierarquia:
//   1- Previsões a Receber: 1.001.006 - BOLETOS
//   2- Previsões a Pagar:  02- Saídas Operacionais (apenas este item + total)
// - Respeita filtros: view (mensal/trimestral/anual) e ano (quando aplicável)
// =========================================================================
app.get('/api/financeiro-dashboard', async (req, res) => {
  try {
    const now = new Date();
    const anoSel = Number(req.query.ano) || now.getFullYear();
    const view = String(req.query.view || req.query.periodo || 'mensal').toLowerCase();

    const origem02 = [
      '02- Saídas Operacionais',
      '02- Saidas Operacionais',
      '02- saídas operacionais',
      '02- saidas operacionais',
      '02-saidas operacionais',
      '02-saídas operacionais'
    ];

    // Define colunas/headers e bucket
    let columns = [];
    let headers = [];
    const bucket = (mes, ano) => {
      const m = Number(mes || 0);
      if (view === 'trimestral') return `Q${Math.ceil(m / 3)}`;
      if (view === 'anual') return (ano != null ? String(ano) : null);
      const map = {1:'jan',2:'fev',3:'mar',4:'abr',5:'mai',6:'jun',7:'jul',8:'ago',9:'set',10:'out',11:'nov',12:'dez'};
      return map[m] || null;
    };

    if (view === 'anual') {
      // anual: colunas por ano existente (ignora filtro de ano)
      const [yearsRows] = await pool.query(
        `SELECT DISTINCT Ano
         FROM dfc_analitica
         WHERE Baixa IS NULL
           AND Financeiro IS NOT NULL
           AND (Codigo_plano = '1.001.006' OR (LOWER(TRIM(Origem_DFC)) LIKE '02%' AND LOWER(TRIM(Origem_DFC)) LIKE '%sa%oper%'))
         ORDER BY Ano`
      );
      columns = (yearsRows || []).map(r => String(r.Ano)).filter(Boolean);
      headers = columns.slice();
    } else if (view === 'trimestral') {
      columns = ['Q1','Q2','Q3','Q4'];
      headers = ['1º Trim','2º Trim','3º Trim','4º Trim'];
    } else {
      columns = ['jan','fev','mar','abr','mai','jun','jul','ago','set','out','nov','dez'];
      headers = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
    }

    const sumBuckets = (rows) => {
      const acc = {};
      columns.forEach(c => acc[c] = 0);
      (rows || []).forEach(r => {
        const k = bucket(r.Mes, r.Ano);
        if (!k || acc[k] === undefined) return;
        acc[k] += Number(r.valor || 0);
      });
      return acc;
    };

    // Queries
    let recRows = [];
    let pagRows = [];

    if (view === 'anual') {
      const [r1] = await pool.query(
        `SELECT Ano, Mes, SUM(Valor_mov) AS valor
         FROM dfc_analitica
         WHERE Baixa IS NULL
           AND Financeiro IS NOT NULL
           AND Codigo_plano = '1.001.006'
         GROUP BY Ano, Mes
         ORDER BY Ano, Mes`
      );
      const [r2] = await pool.query(
        `SELECT Ano, Mes, SUM(Valor_mov) AS valor
         FROM dfc_analitica
         WHERE Baixa IS NULL
           AND Financeiro IS NOT NULL
           AND (LOWER(TRIM(Origem_DFC)) LIKE '02%' AND LOWER(TRIM(Origem_DFC)) LIKE '%sa%oper%')
         GROUP BY Ano, Mes
         ORDER BY Ano, Mes`
      );
      recRows = r1;
      pagRows = r2;
    } else {
      const [r1] = await pool.query(
        `SELECT Mes, Ano, SUM(Valor_mov) AS valor
         FROM dfc_analitica
         WHERE Ano = ?
           AND Baixa IS NULL
           AND Financeiro IS NOT NULL
           AND Codigo_plano = '1.001.006'
         GROUP BY Ano, Mes
         ORDER BY Mes`,
        [anoSel]
      );
      const [r2] = await pool.query(
        `SELECT Mes, Ano, SUM(Valor_mov) AS valor
         FROM dfc_analitica
         WHERE Ano = ?
           AND Baixa IS NULL
           AND Financeiro IS NOT NULL
           AND (LOWER(TRIM(Origem_DFC)) LIKE '02%' AND LOWER(TRIM(Origem_DFC)) LIKE '%sa%oper%')
         GROUP BY Ano, Mes
         ORDER BY Mes`,
        [anoSel]
      );
      recRows = r1;
      pagRows = r2;
    }

    const boletos = sumBuckets(recRows);
    const saidas02 = sumBuckets(pagRows);

    const childReceber = { conta: '1.001.006 - BOLETOS', ...boletos, detalhes: [] };
    const childPagar   = { conta: '02- Saídas Operacionais', ...saidas02, detalhes: [] };

    const parentFromChildren = (children) => {
      const out = {};
      columns.forEach(c => out[c] = 0);
      children.forEach(ch => columns.forEach(c => out[c] += Number(ch[c] || 0)));
      return out;
    };

    const groupReceber = { conta: '1- Previsões a Receber', ...parentFromChildren([childReceber]), detalhes: [childReceber] };
    const groupPagar   = { conta: '2- Previsões a Pagar', ...parentFromChildren([childPagar]), detalhes: [childPagar] };

    return res.json({ tabela: { rows: [groupReceber, groupPagar], columns, headers } });
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

        
        // --- FILTRO POR STATUS / TIPO DE VISÃO (TODOS / SOMENTE REALIZADO / EM ABERTO) ---
        // Regras:
        // - Todos: não filtra Baixa
        // - Somente Realizado: Baixa IS NOT NULL
        //   Exceção (Entradas Operacionais): considerar também 1.001.001 (DINHEIRO) e 1.001.008 (PIX) mesmo sem Baixa.
        // - Em Aberto: Baixa IS NULL
        if (status === 'realizado') {
            query += ' AND (Baixa IS NOT NULL OR Codigo_plano IN ("1.001.001","1.001.008","7.001.001","3.002.001"))';
        } else if (status === 'aberto') {
            query += ' AND Baixa IS NULL';
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

        // -----------------------------------------------------------------
// SALDO INICIAL (por coluna) — calculado a partir de movimentos_contas
// - Mensal/Trimestral: saldo acumulado até o início de cada período do ano selecionado
// - Anual: saldo acumulado até o início de cada ano exibido
// -----------------------------------------------------------------
const saldoInicialCols = zerarColunas();

const sqlMov = `
  SELECT Ano, Mes,
         SUM(CASE
             WHEN LOWER(Natureza) LIKE 'sa%' THEN -ABS(valor)
             ELSE ABS(valor)
         END) AS liquido
  FROM movimentos_contas
  WHERE
    (
      ? = 'anual' AND Ano <= ?
    ) OR (
      ? <> 'anual' AND (Ano < ? OR (Ano = ? AND Mes BETWEEN 1 AND 12))
    )
  GROUP BY Ano, Mes
`;

const hoje = new Date();
const anoSel = Number(ano) || hoje.getFullYear();

let movRows = [];
try {
  if (view === 'anual') {
    const years = colunasKeys.map(y => parseInt(y, 10)).filter(Number.isFinite);
    const maxY = years.length ? Math.max(...years) : anoSel;
    const [r] = await pool.query(sqlMov, ['anual', maxY, 'anual', anoSel, anoSel]);
    movRows = r;

    const netByYear = new Map();
    movRows.forEach(x => {
      const y = Number(x.Ano);
      netByYear.set(y, (netByYear.get(y) || 0) + Number(x.liquido || 0));
    });

    let prefix = 0;
    years.sort((a,b)=>a-b).forEach(y => {
      saldoInicialCols[y.toString()] = prefix;
      prefix += (netByYear.get(y) || 0);
    });
  } else if (view === 'trimestral') {
    const [r] = await pool.query(sqlMov, [view || 'mensal', 0, view || 'mensal', anoSel, anoSel]);
    movRows = r;

    let base = 0;
    const netMes = new Map();
    movRows.forEach(x => {
      if (Number(x.Ano) < anoSel) base += Number(x.liquido || 0);
      if (Number(x.Ano) === anoSel) netMes.set(Number(x.Mes), (netMes.get(Number(x.Mes)) || 0) + Number(x.liquido || 0));
    });

    const quarterMonths = { Q1: [1,2,3], Q2: [4,5,6], Q3: [7,8,9], Q4: [10,11,12] };
    let running = base;
    colunasKeys.forEach(q => {
      saldoInicialCols[q] = running;
      const months = quarterMonths[q] || [];
      let netQ = 0;
      months.forEach(m => netQ += (netMes.get(m) || 0));
      running += netQ;
    });
  } else {
    const [r] = await pool.query(sqlMov, [view || 'mensal', 0, view || 'mensal', anoSel, anoSel]);
    movRows = r;

    let base = 0;
    const netMes = new Map();
    movRows.forEach(x => {
      if (Number(x.Ano) < anoSel) base += Number(x.liquido || 0);
      if (Number(x.Ano) === anoSel) netMes.set(Number(x.Mes), (netMes.get(Number(x.Mes)) || 0) + Number(x.liquido || 0));
    });

    let running = base;
    for (let m = 1; m <= 12; m++) {
      const key = mapaMeses[m];
      saldoInicialCols[key] = running;
      running += (netMes.get(m) || 0);
    }
  }
} catch (e) {
  console.error('Erro ao calcular saldo inicial (movimentos_contas):', e.message);
}

let tabelaRows = [{ conta: 'Saldo Inicial', ...saldoInicialCols, tipo: 'info' }];

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

        // -----------------------------------------------------------------
// REPRESENTATIVIDADE DE CAIXA (fixa): soma da coluna exceto "Saldo Inicial"
// OBS: aqui equivale ao movimento líquido do período (FluxoGlobal)
// -----------------------------------------------------------------
const representatividadeCols = zerarColunas();
colunasKeys.forEach(col => {
  representatividadeCols[col] = FluxoGlobal[col];
});
tabelaRows.push({ conta: 'Representatividade de Caixa', ...representatividadeCols, tipo: 'info' });

// -----------------------------------------------------------------
// SALDO FINAL (por coluna) = Saldo Inicial + Movimento Líquido do Período
// -----------------------------------------------------------------
const linhaSaldoFinal = zerarColunas();
const graficoData = [];
colunasKeys.forEach(col => {
  linhaSaldoFinal[col] = (saldoInicialCols[col] || 0) + (FluxoGlobal[col] || 0);
  graficoData.push(FluxoOperacional[col]);
});

tabelaRows.push({ conta: 'Saldo Final', ...linhaSaldoFinal, tipo: 'saldo' });
        const totalSuperavitDeficit = Object.values(FluxoOperacional).reduce((a, b) => a + b, 0);

        res.json({
            cards: {
                saldoInicial: (saldoInicialCols[colunasKeys[0]] || 0), 
                entrada: totalEntradasOperacionais, 
                saida: totalSaidasOperacionais,
                deficitSuperavit: totalSuperavitDeficit,
                saldoFinal: (linhaSaldoFinal[colunasKeys[colunasKeys.length - 1]] || 0)
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
