/* ============================================================================
   DFC bootstrap helpers (stabilize + safe refactor)
   - Não altera regra/SQL/cálculo: apenas utilitários, cache e guardrails.
   ============================================================================ */

// Fallback seguro para formatar moeda (evita ReferenceError em formatCurrency)
const formatCurrency = (v) => (window.Utils && Utils.fmtBRL)
  ? Utils.fmtBRL(v)
  : new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(v || 0));

// cssEscape nem sempre existe (alguns navegadores / webviews)
const cssEscape = (s) => {
  const str = String(s ?? '');
  if (window.CSS && typeof window.cssEscape === 'function') return window.cssEscape(str);
  // fallback simples (suficiente p/ seletor [data-parent="..."])
  return str.replace(/["\\]/g, '\\$&');
};

// Debounce simples para reduzir loops no input de busca
const debounce = (fn, wait = 200) => {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
};

// Fetch wrapper: timeout + erro padronizado
const apiFetchJson = async (url, opts = {}) => {
  const ctrl = new AbortController();
  const timeoutMs = Number(opts.timeoutMs || 20000);
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    const contentType = res.headers.get('content-type') || '';
    const isJson = contentType.includes('application/json');
    const data = isJson ? await res.json() : await res.text();
    if (!res.ok) {
      const msg = (data && data.message) ? data.message : (typeof data === 'string' ? data : `HTTP ${res.status}`);
      throw new Error(msg);
    }
    return data;
  } finally {
    clearTimeout(t);
  }
};

// Cache simples de promises para evitar duplicação de requests (anos/deps/orçamento)
const ApiCache = (() => {
  const store = new Map(); // key -> { ts, ttl, promise }
  const get = (key) => {
    const it = store.get(key);
    if (!it) return null;
    if (Date.now() - it.ts > it.ttl) { store.delete(key); return null; }
    return it.promise;
  };
  const set = (key, promise, ttl = 60_000) => store.set(key, { ts: Date.now(), ttl, promise });
  const clearPrefix = (prefix) => { for (const k of store.keys()) if (k.startsWith(prefix)) store.delete(k); };
  return { get, set, clearPrefix };
})();

function renderFinanceiroDashboard(payload) {
    const tbody = document.querySelector('#financeiro-table tbody');
    if (!tbody) return;

    tbody.innerHTML = '';

    if (!payload || !Array.isArray(payload.rows)) return;

    // rows: [{ key, label, values:{1:..}, children:[{label, values}] }]
    payload.rows.forEach((row) => {
        const tr = document.createElement('tr');
        tr.classList.add('hover-row', 'grupo'); // nível 1 em negrito (CSS)
        tr.dataset.key = row.key || row.label;

        // Coluna 1
        const td0 = document.createElement('td');
        td0.style.cursor = (row.children && row.children.length) ? 'pointer' : 'default';

        const hasChildren = Array.isArray(row.children) && row.children.length > 0;
        const icon = document.createElement('span');
        icon.className = 'toggle-icon';
        icon.textContent = hasChildren ? '▸' : '';
        td0.appendChild(icon);

        const label = document.createElement('span');
        label.textContent = row.label || '';
        td0.appendChild(label);

        tr.appendChild(td0);

        // Meses 1..12
        for (let mes = 1; mes <= 12; mes++) {
            const td = document.createElement('td');
            const v = row.values && row.values[mes] != null ? row.values[mes] : 0;
            td.textContent = formatCurrency(v);
            tr.appendChild(td);
        }

        tbody.appendChild(tr);

        // children rows (hidden by default)
        if (hasChildren) {
            const __childRows = [];
            row.children.forEach((child) => {
                const ctr = document.createElement('tr');
                ctr.classList.add('child-row', 'hover-row');
                ctr.dataset.parent = tr.dataset.key;
                ctr.style.display = 'none';

                const ctd0 = document.createElement('td');
                ctd0.textContent = child.label || '';
                ctr.appendChild(ctd0);

                for (let mes = 1; mes <= 12; mes++) {
                    const ctd = document.createElement('td');
                    const cv = child.values && child.values[mes] != null ? child.values[mes] : 0;
                    ctd.textContent = formatCurrency(cv);
                    ctr.appendChild(ctd);
                }
                tbody.appendChild(ctr);
                __childRows.push(ctr);
            });
            tr.__childRows = __childRows;

            // toggle click
            tr.addEventListener('click', () => {
                const open = tr.dataset.open === '1';
                tr.dataset.open = open ? '0' : '1';
                icon.textContent = open ? '▸' : '▾';

                const childs = tr.__childRows || [];
                for (const r of childs) r.style.display = open ? 'none' : '';
            });
        }
    });
}

async function fetchFinanceiroDashboard(ano) {
    const url = `/api/financeiro?ano=${encodeURIComponent(ano)}`;
    return await apiFetchJson(url);
}
// ARQUIVO: public/script.js

const ANO_ATUAL = new Date().getFullYear();

const app = {
    user: null,
    chart: null,
    orcamentoChart: null,
    
    // --- ESTADO 2FA ---
    emailTemp: null,
    timer: null, // Novo estado para controlar o relógio

    // ESTADO INICIAL
    yearDashboard: ANO_ATUAL, 
    yearOrcamento: ANO_ATUAL,
    orcamentoView: 'orcamento',
    orcamentoMesSel: 0,
    viewType: "mensal", 
    
    // CACHE
    dadosOrcamentoCache: null,

    init: () => {
        const usuarioSalvo = sessionStorage.getItem('dfc_user');
        // Ativa botões de mostrar/ocultar senha
        app.bindPasswordToggles();
        app.__debouncedSearch = debounce(app.searchDashboardTable, 180);
        
        app.carregarAnosDisponiveis();

        // Recalcula alturas de sticky (Saldo Inicial/Final) quando a janela muda
        window.addEventListener('resize', () => {
            if (document.getElementById('finance-table')) {
                app.setupFinanceStickyRows();
                if (app.syncDfcFinanceiroColumns) app.syncDfcFinanceiroColumns();
            }
        });

        // Listeners Globais
        const loginForm = document.getElementById('loginForm');
        if(loginForm) loginForm.addEventListener('submit', app.login);

        // --- LISTENER NOVO PARA TOKEN ---
        const tokenForm = document.getElementById('tokenForm');
        if(tokenForm) tokenForm.addEventListener('submit', app.validarToken);

        const btnCancelarToken = document.getElementById('btn-cancelar-token');
        if(btnCancelarToken) btnCancelarToken.addEventListener('click', app.resetLoginUI);
        // ---------------------------------

        const btnLogout = document.getElementById('btn-logout');
        if(btnLogout) btnLogout.addEventListener('click', app.logout);

        const formCadastro = document.getElementById('form-cadastro');
        if(formCadastro) formCadastro.addEventListener('submit', app.cadastrarUsuario);
        
        const formReset = document.getElementById('form-reset');
        if(formReset) formReset.addEventListener('submit', app.confirmarResetSenha);

        const searchInput = document.getElementById('dashboard-search');
        const clearBtn = document.getElementById('btn-clear-search');

        if (searchInput) {
            searchInput.addEventListener('input', (e) => {
                const val = e.target.value;
                if (clearBtn) {
                    if (val.length > 0) clearBtn.classList.remove('hidden');
                    else clearBtn.classList.add('hidden');
                }
                app.__debouncedSearch(val);
            });
        }

        if (clearBtn) {
            clearBtn.addEventListener('click', () => {
                if(searchInput) {
                    searchInput.value = '';
                    searchInput.focus();
                }
                clearBtn.classList.add('hidden');
                app.resetDashboardTable(); 
            });
        }

        const viewSelect = document.getElementById('dashboard-view-type');
        if(viewSelect) {
            viewSelect.addEventListener('change', (e) => {
                app.viewType = e.target.value;
                app.toggleYearFilterVisibility();
                app.fetchData(); 
            });
        }

        // --- NOVO LISTENER PARA FILTRO DE STATUS (REALIZADO/ABERTO) ---
        const statusSelect = document.getElementById('dashboard-status-view');
        if(statusSelect) {
            statusSelect.addEventListener('change', () => {
                app.fetchData();
            });
        }
        
        const filtroDept = document.getElementById('filtro-dep-orcamento');
        if(filtroDept) {
            filtroDept.addEventListener('change', () => {
                app.aplicarFiltrosOrcamento();
            });


// --- LISTENER: Tipo de Visão (Todos / Receita / Orçamento) ---
const filtroView = document.getElementById('orcamento-view');
if (filtroView) {
    filtroView.addEventListener('change', (e) => {
        app.orcamentoView = e.target.value || 'orcamento';
        app.updateOrcamentoUIForView(app.orcamentoView);
        // Visão muda a base (receita/despesa/todos) -> recarrega do servidor
        app.loadOrcamento();
    });
}

// --- LISTENER: Mês (impacta KPIs/termômetro do orçamento) ---
const filtroMesOrc = document.getElementById('orcamento-month');
if (filtroMesOrc) {
    filtroMesOrc.addEventListener('change', (e) => {
        app.orcamentoMesSel = Number(e.target.value || 0);
        app.aplicarFiltrosOrcamento();
    });
}
        }

        document.querySelectorAll('.nav-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                if (btn.id === 'btn-logout' || btn.closest('#btn-logout')) return;
                const target = btn.dataset.target;
                if (target) app.switchTab(target);
            });
        });

        if (usuarioSalvo) {
            try {
                app.user = JSON.parse(usuarioSalvo);
                if (app.user.Senha_prov) {
                    document.getElementById('view-login').classList.add('hidden');
                    document.getElementById('modal-reset').classList.remove('hidden');
                } else {
                    app.showApp();
                }
            } catch (e) {
                console.error("Erro ao restaurar sessão:", e);
                sessionStorage.removeItem('dfc_user'); 
                app.showLogin();
            }
        } else {
            app.showLogin();
        }
    },

    toggleYearFilterVisibility: () => {
        const anoFilter = document.getElementById('ano-dashboard');
        if(!anoFilter) return;

        if (app.viewType === 'anual') {
            anoFilter.classList.add('hidden');
        } else {
            anoFilter.classList.remove('hidden');
        }
    },

    resetDashboardTable: () => {
        const tbody = document.querySelector('#finance-table tbody');
        if (!tbody) return;

        const rows = (app.__dashIndex && app.__dashIndex.rows) ? app.__dashIndex.rows : Array.from(tbody.querySelectorAll('tr'));
        
        rows.forEach(row => {
            row.classList.remove('highlight-row');
            if (row.classList.contains('child-row')) {
                row.classList.add('hidden');
            }
            const icon = row.querySelector('.toggle-icon');
            if (icon) {
                icon.style.transform = 'rotate(0deg)';
            }
        });
    },
buildDashboardSearchIndex: () => {
    const tbody = document.querySelector('#finance-table tbody');
    if (!tbody) { app.__dashIndex = null; return; }

    const rows = Array.from(tbody.querySelectorAll('tr'));
    const parentRowById = new Map();

    // rows de grupo (nível 1) têm onclick="app.toggleGroup('L1-x', this)"
    for (const r of rows) {
        const on = r.getAttribute('onclick');
        if (!on) continue;
        const m = on.match(/toggleGroup\('([^']+)'/);
        if (m && m[1]) parentRowById.set(m[1], r);
    }

    app.__dashIndex = { rows, parentRowById };
},

    searchDashboardTable: (term) => {
        const tbody = document.querySelector('#finance-table tbody');
        if (!tbody) return;

        const termo = term.toLowerCase().trim();
        if (termo.length < 2) {
            app.resetDashboardTable();
            return;
        }

        const rows = (app.__dashIndex && app.__dashIndex.rows) ? app.__dashIndex.rows : Array.from(tbody.querySelectorAll('tr'));
        rows.forEach(r => r.classList.remove('highlight-row'));

        let encontrouAlgo = false;

        const abrirPai = (classePai) => {
            const idAlvo = classePai.replace('pai-', '');
            const rowPai = (app.__dashIndex && app.__dashIndex.parentRowById)
                ? app.__dashIndex.parentRowById.get(idAlvo)
                : rows.find(r => r.getAttribute('onclick') && r.getAttribute('onclick').includes(`'${idAlvo}'`));
            
            if (rowPai) {
                const icon = rowPai.querySelector('.toggle-icon');
                if (icon) icon.style.transform = 'rotate(90deg)';
                rowPai.classList.remove('hidden');
                const classesPai = Array.from(rowPai.classList);
                const classeAvo = classesPai.find(c => c.startsWith('pai-')); 
                if (classeAvo) abrirPai(classeAvo);
            }
        };

        rows.forEach(row => {
            const cellText = row.cells[0] ? row.cells[0].innerText.toLowerCase() : '';
            if (!row.classList.contains('child-row') && !row.getAttribute('onclick')) return; 
            
            if (cellText.includes(termo)) {
                encontrouAlgo = true;
                row.classList.add('highlight-row');
                row.classList.remove('hidden');
                const classes = Array.from(row.classList);
                const classePai = classes.find(c => c.startsWith('pai-'));
                if (classePai) abrirPai(classePai);
            }
        });

        if (encontrouAlgo) {
            const primeiro = tbody.querySelector('.highlight-row');
            if (primeiro) primeiro.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
    },

    carregarAnosDisponiveis: async () => {
        let anos = [2025]; 
        
        try {
            const key = 'GET:/api/anos';
            let promise = ApiCache.get(key);
            if (!promise) {
                promise = apiFetchJson('/api/anos');
                ApiCache.set(key, promise, 10 * 60_000);
            }
            const dados = await promise;
            if (Array.isArray(dados) && dados.length > 0) {
                anos = dados.map(d => parseInt(d.Ano || d));
            }
        } catch (error) {
            console.log("API de anos offline, usando padrão.");
        }

        if (!anos.includes(ANO_ATUAL)) {
            anos.push(ANO_ATUAL);
        }

        anos = [...new Set(anos)].sort((a, b) => a - b);

        app.setupYearFilters(anos);
        
        if (app.user && !document.getElementById('page-dashboard').classList.contains('hidden')) {
            app.fetchData();
        }
    },

    setupYearFilters: (anosDisponiveis) => {
        const selects = [
            { id: 'ano-dashboard', context: 'dashboard' },
            { id: 'ano-orcamento', context: 'orcamento' }
        ];
        
        let anoAlvo = ANO_ATUAL;
        
        if (!anosDisponiveis.includes(ANO_ATUAL) && anosDisponiveis.length > 0) {
            anoAlvo = anosDisponiveis[anosDisponiveis.length - 1];
        }

        app.yearDashboard = anoAlvo;
        app.yearOrcamento = anoAlvo;

        selects.forEach(obj => {
            const el = document.getElementById(obj.id);
            if(el) {
                el.innerHTML = '';
                
                anosDisponiveis.forEach(ano => {
                    const opt = document.createElement('option');
                    opt.value = ano;
                    opt.innerText = ano;
                    
                    if (ano === anoAlvo) {
                        opt.setAttribute('selected', 'selected');
                        opt.selected = true;
                    }
                    
                    el.appendChild(opt);
                });

                el.value = anoAlvo;

                // evita duplicação de listeners sem recriar o elemento
                el.onchange = null;
                el.value = anoAlvo;

                el.addEventListener('change', (e) => {
                    const valor = parseInt(e.target.value);
                    
                    if (obj.context === 'dashboard') {
                        app.yearDashboard = valor;
                        app.fetchData(); 
                    } else {
                        app.yearOrcamento = valor;
                        app.loadOrcamento(); 
                    }
                });
            }
        });
    },

    setLoading: (show) => {
        const el = document.getElementById('loader');
        if(el) show ? el.classList.remove('hidden') : el.classList.add('hidden');
    },

    showLogin: () => {
        const viewLogin = document.getElementById('view-login');
        const viewApp = document.getElementById('view-app');
        const modalReset = document.getElementById('modal-reset');
        if(viewLogin) viewLogin.classList.remove('hidden');
        if(viewApp) viewApp.classList.add('hidden');
        if(modalReset) modalReset.classList.add('hidden');
        app.user = null;
    },

    login: async (e) => {
        e.preventDefault();
        const email = document.getElementById('email').value;
        const password = document.getElementById('password').value;
        const err = document.getElementById('msg-error');
        
        app.setLoading(true);
        err.innerText = "";
        
        try {
            const res = await fetch('/api/login', {
                method: 'POST', headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ email, password })
            });
            const data = await res.json();
if (data.success && data.require2fa) {
                app.emailTemp = data.email;
                document.getElementById('loginForm').classList.add('hidden');
                document.getElementById('tokenForm').classList.remove('hidden');
                document.getElementById('token-input').value = "";
                document.getElementById('token-input').focus();
                
                app.startCountdown();

            } else if (!data.success) { 
                err.innerText = data.message; 
                err.style.color = 'var(--danger)';
            }
        } catch (e) { 
            err.innerText = "Erro de conexão."; 
            err.style.color = 'var(--danger)';
        } finally { 
            app.setLoading(false); 
        }
    },

    startCountdown: () => {
        const err = document.getElementById('msg-error');
        let timeLeft = 60;
        
        if (app.timer) clearInterval(app.timer);
        
        err.innerText = `Código enviado! Válido por ${timeLeft}s`;
        err.style.color = '#2563eb'; 

        app.timer = setInterval(() => {
            timeLeft--;
            if (timeLeft <= 0) {
                clearInterval(app.timer);
                err.innerText = "Tempo esgotado. Solicite novo código.";
                err.style.color = '#ef4444'; 
            } else {
                err.innerText = `Código enviado! Válido por ${timeLeft}s`;
            }
        }, 1000);
    },

    validarToken: async (e) => {
        e.preventDefault();
        const token = document.getElementById('token-input').value;
        const err = document.getElementById('msg-error');

        if(!token || token.length < 6) {
            err.innerText = "Digite o código completo.";
            err.style.color = '#ef4444';
            return;
        }

        app.setLoading(true);

        try {
            const res = await fetch('/api/validar-token', {
                method: 'POST', headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ email: app.emailTemp, token: token })
            });
            const data = await res.json();

            if (data.success) {
                if (app.timer) clearInterval(app.timer); 
                
                app.user = data.user;
                sessionStorage.setItem('dfc_user', JSON.stringify(app.user));
                
                document.getElementById('password').value = "";
                app.resetLoginUI();

                if (app.user.Senha_prov) {
                    document.getElementById('view-login').classList.add('hidden');
                    document.getElementById('modal-reset').classList.remove('hidden'); 
                } else { app.showApp(); }
            } else {
                err.innerText = data.message; 
                err.style.color = '#ef4444';
            }
        } catch (e) {
            err.innerText = "Erro ao validar token.";
            err.style.color = '#ef4444';
        } finally {
            app.setLoading(false);
        }
    },

    resetLoginUI: () => {
        if (app.timer) clearInterval(app.timer); 
        
        document.getElementById('loginForm').classList.remove('hidden');
        document.getElementById('tokenForm').classList.add('hidden');
        document.getElementById('msg-error').innerText = "";
        app.emailTemp = null;
    },

    confirmarResetSenha: async (e) => {
        e.preventDefault();
        const s1 = document.getElementById('nova-senha').value;
        const s2 = document.getElementById('confirma-senha').value;
        const msg = document.getElementById('msg-reset');
        if (s1 !== s2) { msg.innerText = "As senhas não coincidem!"; return; }

        app.setLoading(true);
        // evita render duplicado por chamadas concorrentes (dashboard)
        app.__dashReqId = (app.__dashReqId || 0) + 1;
        const __reqId = app.__dashReqId;
        try {
            const res = await fetch('/api/definir-senha', {
                method: 'POST', headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ email: app.user.Email, novaSenha: s1 })
            });
            const data = await res.json();
            if (data.success) {
                alert("Senha atualizada!");
                document.getElementById('modal-reset').classList.add('hidden');
                app.user.Senha_prov = null; 
                sessionStorage.setItem('dfc_user', JSON.stringify(app.user));
                app.showApp();
            } else { msg.innerText = data.message; }
        } catch (err) { msg.innerText = "Erro ao atualizar senha."; } 
        finally { app.setLoading(false); }
    },

    showApp: () => {
        document.getElementById('view-login').classList.add('hidden');
        document.getElementById('modal-reset').classList.add('hidden');
        document.getElementById('view-app').classList.remove('hidden');
        
        const nome = app.user.Nome ? app.user.Nome.split(' ')[0] : 'User';
        const depto = app.user.Departamento || 'Geral';
        const textoUsuario = `${nome} | ${depto}`;

        const elDash = document.getElementById('user-info');
        if(elDash) {
            elDash.innerText = textoUsuario;
            document.getElementById('user-avatar').innerText = nome.charAt(0).toUpperCase();
        }

        const elOrc = document.getElementById('user-info-orcamento');
        if(elOrc) {
            elOrc.innerText = textoUsuario;
        }

        const role = app.user.Role; 
        const nivel = parseInt(app.user.Nivel || 0);

        const isSuperAdmin = (role === 'admin' && nivel === 1);
        const isGestor = (role === 'admin' && (nivel === 1 || nivel === 2));

        document.querySelectorAll('.restricted').forEach(el => {
            el.style.setProperty('display', isSuperAdmin ? 'flex' : 'none', 'important');
        });

        const btnDashboard = document.querySelector('.nav-btn[data-target="dashboard"]');
        if (btnDashboard) {
            btnDashboard.style.display = isGestor ? 'flex' : 'none';
        }

        if(isSuperAdmin) app.loadDepartamentos();
        
        if (isGestor) {
            app.switchTab('dashboard');
            setTimeout(() => app.fetchData(), 100);
        } else {
            app.switchTab('reports');
        }
    },

    logout: () => { 
        if (app.timer) clearInterval(app.timer);
        app.user = null; 
        sessionStorage.removeItem('dfc_user');
        app.showLogin(); 
    },

    switchTab: (tab) => {
        document.querySelectorAll('.page-section').forEach(p => p.classList.remove('active'));
        document.querySelectorAll('.nav-btn').forEach(n => n.classList.remove('active'));
        
        const targetSection = document.getElementById(`page-${tab}`);
        if(targetSection) targetSection.classList.add('active');
        
        const btn = document.querySelector(`.nav-btn[data-target="${tab}"]`);
        if(btn) btn.classList.add('active');

        if (tab !== 'dashboard' && app.chart) {
            app.chart.destroy();
            app.chart = null;
        }
        if (tab !== 'reports' && app.orcamentoChart) {
            app.orcamentoChart.destroy();
            app.orcamentoChart = null;
        }

        if (tab === 'reports') {
            app.updateOrcamentoUIForView(app.orcamentoView);
            app.loadOrcamento();
        } else if (tab === 'dashboard') {
            app.fetchData();
        }
    },


updateOrcamentoUIForView: (view) => {
    const v = (view || app.orcamentoView || 'orcamento').toLowerCase();
    const title = document.getElementById('orcamento-title');
    const subtitle = document.getElementById('orcamento-subtitle');
    if (title) {
        if (v === 'receita') title.textContent = 'Metas vs Realizado';
        else if (v === 'todos') title.textContent = 'Receitas vs Despesas';
        else title.textContent = 'Orçado vs Realizado';
    }
    if (subtitle) {
        if (v === 'receita') subtitle.textContent = 'Visão de receitas (metas e realizado).';
        else if (v === 'todos') subtitle.textContent = 'Comparativo de receitas e despesas (realizado).';
        else subtitle.textContent = 'Visão de despesas (orçado e realizado).';
    }
    // Atualiza cabeçalhos da tabela (Planejado/Metas/Orçado)
    const thPlanejado = document.querySelector('#orcamento-table thead th.th-planejado');
    if (thPlanejado) {
        if (v === 'receita') thPlanejado.textContent = 'Metas';
        else if (v === 'todos') thPlanejado.textContent = 'Planejado';
        else thPlanejado.textContent = 'Orçado';
    }
    const thReal = document.querySelector('#orcamento-table thead th.th-realizado');
    if (thReal) thReal.textContent = 'Realizado';


// Sublinhado do título conforme tipo de visão
if (title) {
    title.classList.remove('view-receita', 'view-orcamento', 'view-todos');
    if (v === 'receita') title.classList.add('view-receita');
    else if (v === 'todos') title.classList.add('view-todos');
    else title.classList.add('view-orcamento');
}

},

toggleThermometer: (show) => {
    // Corrigido: seu HTML usa class="thermometer-section"
    const el = document.querySelector('#page-reports .thermometer-section');
    if (!el) return;
    el.classList.toggle('hidden', !show);
},

    loadOrcamento: async () => {
        app.setLoading(true);
        // evita render duplicado por chamadas concorrente (orcamento)
        app.__orcReqId = (app.__orcReqId || 0) + 1;
        const __reqId = app.__orcReqId;
        const tbody = document.querySelector('#orcamento-table tbody');
        const kpiContainer = document.getElementById('kpi-orcamento-container');

        if(tbody) tbody.innerHTML = '<tr><td colspan="49" style="text-align:center; padding:20px;">Carregando dados...</td></tr>';
        if(kpiContainer) kpiContainer.innerHTML = ''; 

        try {
            const email = app.user.Email;
            const anoParam = app.yearOrcamento; 
            
                        const dept = (document.getElementById('filtro-dep-orcamento')?.value) || '';
                        const url = `/api/orcamento?email=${encodeURIComponent(email)}&ano=${anoParam}&visao=${encodeURIComponent(app.orcamentoView || 'orcamento')}&dept=${encodeURIComponent(dept)}`;
                        const key = `GET:${url}`;
                        let promise = ApiCache.get(key);
                        if (!promise) { promise = apiFetchJson(url); ApiCache.set(key, promise, 20_000); }
                        const data = await promise;
// ignora respostas antigas (caso tenha mais de uma requisição em paralelo)
                        if (__reqId !== app.__orcReqId) return;
                        if (data && data.error) throw new Error(data.error);

                        const grupos = Array.isArray(data) ? data : (data.grupos || []);
                        app.dadosOrcamentoMeta = Array.isArray(data) ? null : (data.meta || null);

                        app.dadosOrcamentoCache = grupos;
                        app.updateOrcamentoUIForView(app.orcamentoView);
                        app.povoarFiltroDepartamentos(grupos);
                        app.aplicarFiltrosOrcamento();


        } catch (err) {
            console.error(err);
            if(tbody) tbody.innerHTML = `<tr><td colspan="49" style="text-align:center; color:red; padding:20px;">Erro: ${err.message}</td></tr>`;
        } finally {
            app.setLoading(false);
        }
    },

    povoarFiltroDepartamentos: (data) => {
        const select = document.getElementById('filtro-dep-orcamento');
        if(!select) return;

        const valorAtual = select.value;
        select.innerHTML = '<option value="">Todos Departamentos</option>';
        const departamentos = [...new Set(data.map(d => d.conta))].sort();
        
        departamentos.forEach(dep => {
            const opt = document.createElement('option');
            opt.value = dep;
            opt.innerText = dep;
            select.appendChild(opt);
        });

        if(departamentos.includes(valorAtual)) {
            select.value = valorAtual;
        }
    },

    
    toggleOrcamentoColumns: () => {
        const mesSel = app.orcamentoMesSel || 0; // 0 = Auto (mostrar todas)
        const table = document.getElementById('orcamento-table');
        if (!table) return;
        const cells = table.querySelectorAll('[data-mes]');
        cells.forEach(c => {
            const m = Number(c.getAttribute('data-mes'));
            if (mesSel === 0 || m === mesSel) {
                c.classList.remove('hide-col');
            } else {
                c.classList.add('hide-col');
            }
        });
    },
    
    aplicarFiltrosOrcamento: () => {
    if (!app.dadosOrcamentoCache) return;

    const select = document.getElementById('filtro-dep-orcamento');
    const deptSelecionado = select ? select.value : "";

    let dadosFiltrados = app.dadosOrcamentoCache;

    if (deptSelecionado !== "") {
        dadosFiltrados = app.dadosOrcamentoCache.filter(grupo => grupo.conta === deptSelecionado);
    }

    app.updateOrcamentoTableHeader();
    app.renderOrcamentoTable(dadosFiltrados);
    app.renderOrcamentoKPIs(dadosFiltrados);

    const view = (app.orcamentoView || 'orcamento').toLowerCase();
    app.renderOrcamentoChart(dadosFiltrados, view);

    // Termômetro não deve aparecer na visão "Todos"
    if (view === 'todos') {
        app.toggleThermometer(false);
    } else {
        app.toggleThermometer(true);
        app.renderThermometer(dadosFiltrados, view);
    }

    // Mantém lógica existente de colunas (se houver)
    if (typeof app.toggleOrcamentoColumns === 'function') {
        app.toggleOrcamentoColumns();
    }
    },

    renderThermometer: (data, view) => {
        const v = (view || app.orcamentoView || 'orcamento').toLowerCase();
        const fillEl = document.getElementById('thermometer-fill');
        const bulbEl = document.getElementById('thermometer-bulb-color');
        const titleGoal = document.getElementById('thermometer-goal-title');
        const vView = (view || app.orcamentoView || 'orcamento').toLowerCase();
        if (titleGoal) titleGoal.textContent = (vView === 'receita') ? 'Meta de Receitas (Mês)' : 'Meta Orçamentária (Mês)';
        const tooltipLeft = document.getElementById('tooltip-left');
        const tooltipRight = document.getElementById('tooltip-right');
        const lblPercent = document.getElementById('lbl-porcentagem');
        const lblValue = document.getElementById('lbl-valor');

        if (!fillEl || !data) return;

        const hoje = new Date();
        const mesIndex = (app.orcamentoMesSel && app.orcamentoMesSel >= 1 && app.orcamentoMesSel <= 12) ? (app.orcamentoMesSel - 1) : hoje.getMonth(); 
        const mesChaves = ['jan','fev','mar','abr','mai','jun','jul','ago','set','out','nov','dez'];
        const chaveMes = mesChaves[mesIndex];
        const anoAtual = hoje.getFullYear();
        const anoFiltro = app.yearOrcamento || anoAtual;

        let totalOrcado = 0;
        let totalRealizado = 0;

        data.forEach(grupo => {
            if (grupo.dados && grupo.dados[chaveMes]) {
                totalOrcado += Math.abs(grupo.dados[chaveMes].orcado || 0);
                totalRealizado += Math.abs(grupo.dados[chaveMes].realizado || 0);
            }
        });

        const fmtMoney = (v) => Utils.fmtBRL(v, {min:0,max:0});

        if(titleGoal) titleGoal.innerText = `FinanCheck: ${fmtMoney(totalOrcado)}`;

        const dias = app.getDiasUteis(mesIndex, anoFiltro);
        const diasTotais = dias.totais || 1;
        const diasDecorridos = dias.decorridos || 1; 
        const diasRestantes = diasTotais - diasDecorridos;

        const badgeVal = document.getElementById('dias-uteis-value');
        if (badgeVal) badgeVal.textContent = `${diasDecorridos}/${diasTotais}`;

        let gastoDiario = totalRealizado / diasDecorridos;
        let projecaoTotal = (gastoDiario * diasRestantes) + totalRealizado;

        if (totalOrcado === 0) {
            fillEl.style.height = '0%';
            fillEl.style.backgroundColor = '#e5e7eb';
            if(bulbEl) bulbEl.style.backgroundColor = '#e5e7eb';
            if(lblPercent) lblPercent.innerText = "0%";
            if(lblValue) lblValue.innerText = fmtMoney(totalRealizado);
            if(tooltipLeft) tooltipLeft.style.bottom = '45px';
            if(tooltipRight) tooltipRight.style.bottom = '45px';
            return;
        }

        let porcentagem = (totalRealizado / totalOrcado) * 100;
        let alturaVisual = porcentagem > 100 ? 100 : porcentagem;
        if (alturaVisual < 0) alturaVisual = 0;

        let cor = '';
        if (porcentagem < 80) cor = '#3b82f6'; 
        else if (porcentagem >= 80 && porcentagem < 95) cor = '#10b981'; 
        else if (porcentagem >= 95 && porcentagem <= 100) cor = '#f59e0b'; 
        else cor = '#ef4444'; 

        fillEl.style.height = `${alturaVisual}%`;
        fillEl.style.backgroundColor = cor;
        if(bulbEl) bulbEl.style.backgroundColor = cor;
        
        if(lblPercent) lblPercent.innerText = `${porcentagem.toFixed(0)}%`;
        if(lblValue) lblValue.innerText = fmtMoney(totalRealizado);

        const alturaBulboOffset = 45; 
        const alturaTubo = 220; 
        const pixelHeight = (alturaVisual / 100) * alturaTubo;
        const totalBottomPx = pixelHeight + alturaBulboOffset;

        if(tooltipLeft) tooltipLeft.style.bottom = `${totalBottomPx}px`;
        if(tooltipRight) tooltipRight.style.bottom = `${totalBottomPx}px`;
    },

    getFeriadosPorAno: (ano) => {
        const fixos = ['01/01', '21/04', '01/05', '07/09', '12/10', '02/11', '15/11', '25/12'];
        const moveis = {
            2024: ['13/02', '29/03', '30/05'],
            2025: ['04/03', '18/04', '19/06'],
            2026: ['17/02', '03/04', '04/06'],
            2027: ['09/02', '26/03', '27/05']
        };
        return fixos.concat(moveis[ano] || []);
    },

    getDiasUteis: (mes, ano) => {
        if (!ano) return { totais: 0, decorridos: 0 };
        const feriados = app.getFeriadosPorAno(ano);
        const ultimoDiaMes = new Date(ano, mes + 1, 0).getDate();
        const hoje = new Date();
        const diaAtual = hoje.getDate(); 
        const mesAtualReal = hoje.getMonth();
        const anoAtualReal = hoje.getFullYear();

        let uteisTotais = 0;
        let uteisDecorridos = 0;

        for (let dia = 1; dia <= ultimoDiaMes; dia++) {
            const dataCheck = new Date(ano, mes, dia);
            const diaSemana = dataCheck.getDay(); 
            const diaStr = String(dia).padStart(2, '0');
            const mesStr = String(mes + 1).padStart(2, '0');
            const dataFormatada = `${diaStr}/${mesStr}`;

            const ehFimDeSemana = (diaSemana === 0 || diaSemana === 6);
            const ehFeriado = feriados.includes(dataFormatada);

            if (!ehFimDeSemana && !ehFeriado) {
                uteisTotais++;
                if (ano < anoAtualReal) {
                    uteisDecorridos++; 
                } else if (ano === anoAtualReal) {
                    if (mes < mesAtualReal) {
                        uteisDecorridos++; 
                    } else if (mes === mesAtualReal) {
                        if (dia <= diaAtual) uteisDecorridos++;
                    }
                }
            }
        }
        return { totais: uteisTotais, decorridos: uteisDecorridos };
    },

    renderOrcamentoKPIs: (data) => {
        const container = document.getElementById('kpi-orcamento-container');
        if (!container || !data) return;

        const hoje = new Date();
        const mesIndex = (app.orcamentoMesSel && app.orcamentoMesSel >= 1 && app.orcamentoMesSel <= 12) ? (app.orcamentoMesSel - 1) : hoje.getMonth(); 
        const anoAnalise = app.yearOrcamento; 
        
        const chavesMeses = ['jan','fev','mar','abr','mai','jun','jul','ago','set','out','nov','dez'];
        const nomesMeses = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
        const nomeMes = nomesMeses[mesIndex];
        const keyMes = chavesMeses[mesIndex];
        const fmt = v => Utils.fmtBRL(v);
        const fmtPerc = v => Utils.fmtPerc(v, 1);


        const view = (app.orcamentoView || 'orcamento').toLowerCase();
        const labelPlanejado = (view === 'receita') ? 'Metas' : (view === 'todos') ? 'Planejado' : 'Orçado';

// KPIs específicos para "Todos" (5 KPIs): 2 Receitas, 2 Despesas, 1 Diferença (Metas Realizadas - Despesas Realizadas)
if (view === 'todos') {
    const meta = app.dadosOrcamentoMeta && app.dadosOrcamentoMeta.series ? app.dadosOrcamentoMeta.series : null;
    const safe = (v) => {
        const n = Number(v || 0);
        return Number.isFinite(n) ? n : 0;
    };

    const metasMes = meta && meta.receita ? Math.abs(safe(meta.receita.planejado[mesIndex])) : 0;
    const metasRealizadasMes = meta && meta.receita ? Math.abs(safe(meta.receita.realizado[mesIndex])) : 0;

    const despesasMes = meta && meta.despesa ? Math.abs(safe(meta.despesa.planejado[mesIndex])) : 0;
    const despesasRealizadasMes = meta && meta.despesa ? Math.abs(safe(meta.despesa.realizado[mesIndex])) : 0;

    const diferenca = metasRealizadasMes - despesasRealizadasMes;
    const corDif = diferenca < 0 ? 'text-green' : (diferenca > 0 ? 'text-red' : '');

    const mkCardLocal = (titulo, valor, corTexto) => `
        <div class="card">
            <div class="card-title">${titulo}</div>
            <div class="card-value ${corTexto || ''}">${valor}</div>
        </div>`;

    container.innerHTML =
        mkCardLocal('Metas (Mês atual)', fmt(metasMes), 'col-orc') +
        mkCardLocal('Metas Realizadas (Mês atual)', fmt(metasRealizadasMes), 'col-real') +
        mkCardLocal('Despesas (Mês atual)', fmt(despesasMes), 'col-orc') +
        mkCardLocal('Despesas Realizadas (Mês atual)', fmt(despesasRealizadasMes), 'col-real') +
        mkCardLocal('Diferença (Metas Realizadas - Despesas Realizadas)', fmt(diferenca), corDif);

    return;
}

        let totalOrcado = 0;
        let totalRealizado = 0;

        data.forEach(grupo => {
            if (grupo.dados && grupo.dados[keyMes]) {
                totalOrcado += Math.abs(grupo.dados[keyMes].orcado || 0);
                totalRealizado += Math.abs(grupo.dados[keyMes].realizado || 0);
            }
        });

        const diferencaValor = totalOrcado - totalRealizado; 
        let diferencaPerc = 0;
        if (totalOrcado !== 0) {
            diferencaPerc = (diferencaValor / totalOrcado) * 100;
        } else if (totalRealizado > 0) {
            diferencaPerc = -100; 
        }

        const corDif = (view === 'receita')
            ? (diferencaValor <= 0 ? 'text-green' : 'text-red')
            : (diferencaValor >= 0 ? 'text-red' : 'text-green');

        let cardDias = '---';
        let cardMeta = '---';
        let cardGasto = '---';
        let cardProj = '---';
        let corGasto = '';
        let rodapeDias = 'Selecione um ano';

        if (anoAnalise) {
            const dias = app.getDiasUteis(mesIndex, anoAnalise);
            rodapeDias = 'Decorridos / Totais';
            cardDias = `${dias.decorridos} / ${dias.totais}`;
            
            const diasRestantes = dias.totais - dias.decorridos;

            let metaDiaria = 0;
            if (dias.totais > 0) metaDiaria = totalOrcado / dias.totais;

            let gastoDiario = 0;
            if (dias.decorridos > 0) gastoDiario = totalRealizado / dias.decorridos;

            let projecaoTotal = (gastoDiario * diasRestantes) + totalRealizado;

            cardMeta = fmt(metaDiaria);
            cardGasto = fmt(gastoDiario);
            cardProj = fmt(projecaoTotal);
            corGasto = (gastoDiario > metaDiaria) ? 'text-red' : 'text-green';
        }

        const mkCard = (titulo, valor, corTexto, rodape = '') => `
            <div class="card">
                <div class="card-title">${titulo}</div>
                <div class="card-value ${corTexto}">${valor}</div>
                ${rodape ? `<div style="font-size:11px; color:#6b7280; margin-top:5px; padding-top:4px; border-top:1px solid #f3f4f6;">${rodape}</div>` : ''}
            </div>
        `;

        const labelMes = anoAnalise ? `(${nomeMes})` : '(Geral)';

        container.innerHTML = 
            mkCard(`${labelPlanejado} ${labelMes}`, fmt(totalOrcado), 'col-orc') +
            mkCard(`Realizado ${labelMes}`, fmt(totalRealizado), 'col-real') +
            mkCard(`Diferença R$`, fmt(Math.abs(diferencaValor)), corDif) +
            mkCard(`Diferença %`, fmtPerc(Math.abs(diferencaPerc)), corDif) +
            mkCard(`Dias Úteis (${anoAnalise || '-'})`, cardDias, 'text-dark', rodapeDias) +
            mkCard(`Meta Diária`, cardMeta, 'col-orc', 'Teto de gasto') +
            mkCard(`Gasto Diário`, cardGasto, corGasto, 'Média realizada') +
            mkCard(`Projeção Final`, cardProj, 'text-primary', 'Tendência');
    },

    renderOrcamentoChart: (data, view) => {
    const canvas = document.getElementById('orcamentoChart');
    if (!canvas) return;
    if (typeof Chart === 'undefined') return;

    const customLegend = document.getElementById('custom-chart-legend');
    if (customLegend) customLegend.remove();

    const existingChart = Chart.getChart(canvas);
    if (existingChart) existingChart.destroy();
    if (app.orcamentoChart) { app.orcamentoChart.destroy(); app.orcamentoChart = null; }

    const v = (view || app.orcamentoView || 'orcamento').toLowerCase();
    const labels = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];

    // REGRA: filtro de "Mês" NÃO altera o gráfico (gráfico sempre mostra 12 meses).
    // Os demais filtros (Departamento, Ano, Tipo de Visão) continuam valendo via meta.series.
    // Portanto aqui ignoramos app.orcamentoMesSel propositalmente.

    const toSafeNumber = (x) => {
        const n = Number(x || 0);
        return Number.isFinite(n) ? n : 0;
    };

    const formatCompactBRL = (value) => {
        const v = Math.abs(Number(value || 0));
        if (!Number.isFinite(v) || v === 0) return 'R$ 0';

        if (v >= 1_000_000) {
            const mi = v / 1_000_000;
            const txt = (mi % 1 === 0) ? String(Math.round(mi)) : mi.toFixed(1).replace('.', ',');
            return `R$ ${txt} mi`;
        }
        if (v >= 1_000) {
            const mil = v / 1_000;
            const txt = (mil % 1 === 0) ? String(Math.round(mil)) : mil.toFixed(1).replace('.', ',');
            return `R$ ${txt} mil`;
        }
        return Utils.fmtBRL(v);
    };

    const meta = app.dadosOrcamentoMeta || null;
    const series = meta && meta.series ? meta.series : null;

    let datasetReal = new Array(12).fill(0);
    let datasetOrc = new Array(12).fill(0);

    let labelReal = 'Realizado';
    let labelOrc = 'Orçado';

    if (v === 'receita') {
        const sReal = series && series.receita && series.receita.realizado;
        const sOrc = series && series.receita && series.receita.planejado;
        datasetReal = (Array.isArray(sReal) && sReal.length === 12) ? sReal.map(x => Math.abs(toSafeNumber(x))) : datasetReal;
        datasetOrc  = (Array.isArray(sOrc) && sOrc.length === 12) ? sOrc.map(x => Math.abs(toSafeNumber(x))) : datasetOrc;
        labelReal = 'Realizado';
        labelOrc = 'Metas';
    } else if (v === 'orcamento') {
        const sReal = series && series.despesa && series.despesa.realizado;
        const sOrc = series && series.despesa && series.despesa.planejado;
        datasetReal = (Array.isArray(sReal) && sReal.length === 12) ? sReal.map(x => Math.abs(toSafeNumber(x))) : datasetReal;
        datasetOrc  = (Array.isArray(sOrc) && sOrc.length === 12) ? sOrc.map(x => Math.abs(toSafeNumber(x))) : datasetOrc;
        labelReal = 'Realizado';
        labelOrc = 'Orçado';
    } else {
        // TODOS: Azul = Metas Realizadas (Receitas); Verde (área) = Despesas Realizadas
        const sRec = series && series.receita && series.receita.realizado;
        const sDesp = series && series.despesa && series.despesa.realizado;
        datasetReal = (Array.isArray(sRec) && sRec.length === 12) ? sRec.map(x => Math.abs(toSafeNumber(x))) : datasetReal;
        datasetOrc  = (Array.isArray(sDesp) && sDesp.length === 12) ? sDesp.map(x => Math.abs(toSafeNumber(x))) : datasetOrc;
        labelReal = 'Metas Realizadas';
        labelOrc = 'Despesas Realizadas';
    }

    if (typeof ChartDataLabels !== 'undefined') { try { Chart.register(ChartDataLabels); } catch(e){} }

    const ctx = canvas.getContext('2d');

    // Gradiente verde (área)
    const gradGreen = ctx.createLinearGradient(0, 0, 0, 420);
    gradGreen.addColorStop(0, 'rgba(34, 197, 94, 0.30)');
    gradGreen.addColorStop(1, 'rgba(34, 197, 94, 0.06)');

    app.orcamentoChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels,
            datasets: [
                {
                    label: labelReal,
                    data: datasetReal,
                    borderColor: '#2563eb',
                    backgroundColor: 'rgba(37, 99, 235, 0.10)',
                    borderWidth: 3,
                    tension: 0.45,
                    fill: false,
                    pointRadius: 4,
                    pointHoverRadius: 5,
                    pointBackgroundColor: '#ffffff',
                    pointBorderColor: '#2563eb',
                    pointBorderWidth: 2
                },
                {
                    label: labelOrc,
                    data: datasetOrc,
                    borderColor: '#16a34a',
                    backgroundColor: gradGreen,
                    borderWidth: 2,
                    tension: 0.45,
                    fill: true,
                    pointRadius: 4,
                    pointHoverRadius: 5,
                    pointBackgroundColor: '#ffffff',
                    pointBorderColor: '#16a34a',
                    pointBorderWidth: 2
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            layout: { padding: { top: 6, bottom: 6, left: 6, right: 6 } },
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: {
                    display: true,
                    position: 'top',
                    align: 'center',
                    labels: {
                        usePointStyle: true,
                        pointStyle: 'circle',
                        boxWidth: 10,
                        boxHeight: 10,
                        padding: 16
                    }
                },
                tooltip: { enabled: false },
                datalabels: {
                    display: () => window.innerWidth > 900,
                    align: 'top',
                    anchor: 'end',
                    offset: 8,
                    clamp: true,
                    font: { weight: '700', size: 12 },
                    color: (ctx) => (ctx.datasetIndex === 0 ? '#2563eb' : '#16a34a'),
                    formatter: (value) => formatCompactBRL(value)
                }
            },
            scales: {
                x: { grid: { display: false } },
                y: {
                    beginAtZero: true,
                    grace: '10%',
                    grid: { color: '#eef2f7' },
                    ticks: {
                        callback: (val) => {
                            const v = Number(val || 0);
                            if (!Number.isFinite(v)) return val;
                            if (Math.abs(v) >= 1_000_000) return `R$ ${(v / 1_000_000).toFixed(0)} mi`;
                            if (Math.abs(v) >= 1_000) return `R$ ${(v / 1_000).toFixed(0)} mil`;
                            return `R$ ${v}`;
                        }
                    }
                }
            }
        }
    });
},




// Mantém "Saldo Inicial" fixo no topo (abaixo do cabeçalho) e "Saldo Final" fixo no rodapé dentro do scroll da tabela
setupFinanceStickyRows: () => {
    const table = document.getElementById('finance-table');
    if (!table) return;

    const thead = table.querySelector('thead');
    const tbody = table.querySelector('tbody');
    if (!thead || !tbody) return;

    // Calcula a altura real do cabeçalho para posicionar o "Saldo Inicial" logo abaixo
    const theadH = Math.ceil(thead.getBoundingClientRect().height);
    document.documentElement.style.setProperty('--finance-thead-h', `${theadH}px`);

    // Marca as linhas de saldo para ficarem sticky
    const rows = Array.from(tbody.querySelectorAll('tr'));
    rows.forEach(tr => {
        tr.classList.remove('sticky-saldo-top', 'sticky-saldo-bottom');

        const firstCell = tr.querySelector('td:first-child');
        if (!firstCell) return;

        const txt = (firstCell.innerText || '').trim().toLowerCase();
        if (txt === 'saldo inicial') tr.classList.add('sticky-saldo-top');
        if (txt === 'saldo final') tr.classList.add('sticky-saldo-bottom');
    });
},

    renderTable: (data) => {
        const rows = data.rows;
        const columns = data.columns; 
        const headers = data.headers;

        const tbody = document.querySelector('#finance-table tbody');
        const thead = document.querySelector('#finance-table thead');
        
        if(!tbody || !thead) return;

        let thHtml = `<tr>
            <th>Plano Financeiro</th>`;
        headers.forEach(h => {
            thHtml += `<th>${h}</th>`;
        });
        thHtml += `</tr>`;
        thead.innerHTML = thHtml;

        if(!rows || rows.length===0) { tbody.innerHTML='<tr><td colspan="15">Sem dados</td></tr>'; return; }

        const fmt = v => v ? Utils.fmtBRL(v) : '-';

        let html = '';
        rows.forEach((row, idx1) => {
            const idNivel1 = `L1-${idx1}`; 
            let trStyle = ''; 
            let tdClass = ''; 
            let icon = '';
            let clickAction = '';
            let rowClass = '';

            if (row.tipo === 'saldo' || row.tipo === 'info') {
                trStyle = 'background-color: #eff6ff; font-weight: 800; color: #1e3a8a; border-top: 2px solid #bfdbfe;';
            } else if (row.tipo === 'grupo') {
                rowClass = 'hover-row';
                trStyle = 'font-weight: 600; cursor: pointer; background-color: #fff;'; 
                icon = '<i class="fa-solid fa-chevron-right toggle-icon"></i> ';
                clickAction = `onclick="app.toggleGroup('${idNivel1}', this)"`;
                if (row.conta.includes('Entradas')) tdClass = 'text-green';
                if (row.conta.includes('Saídas')) tdClass = 'text-red';
            }

            let tdsValores = '';
            columns.forEach(colKey => {
                tdsValores += `<td class="${tdClass}">${fmt(row[colKey])}</td>`;
            });

            html += `<tr style="${trStyle}" class="${rowClass}" ${clickAction}>
                    <td style="text-align:left; padding-left:10px;">${icon}<span class="${tdClass}">${row.conta}</span></td>
                    ${tdsValores}
                </tr>`;

            if (row.detalhes && row.detalhes.length > 0) {
                row.detalhes.forEach((subgrupo, idx2) => {
                    const idNivel2 = `L2-${idx1}-${idx2}`; 
                    
                    let tdsSub = '';
                    columns.forEach(colKey => {
                        tdsSub += `<td>${fmt(subgrupo[colKey])}</td>`;
                    });

                    html += `<tr class="child-row hidden pai-${idNivel1} hover-row" onclick="app.toggleSubGroup('${idNivel2}', this)" style="cursor: pointer;">
                            <td style="text-align:left; padding-left: 25px; font-weight: 600;">
                                <i class="fa-solid fa-chevron-right toggle-icon"></i> ${subgrupo.conta}
                            </td>
                            ${tdsSub}
                        </tr>`;
                    if (subgrupo.detalhes) {
                        subgrupo.detalhes.forEach(item => {
                            let tdsItem = '';
                            columns.forEach(colKey => {
                                tdsItem += `<td>${fmt(item[colKey])}</td>`;
                            });

                            html += `<tr class="child-row hidden pai-${idNivel2} avo-${idNivel1}">
                                    <td style="text-align:left; padding-left: 50px; color: #555;">${item.conta}</td>
                                    ${tdsItem}
                                </tr>`;
                        });
                    }
                });
            }
        });
        tbody.innerHTML = html;
        // index para busca rápida na tabela (evita varrer DOM repetidamente)
        app.buildDashboardSearchIndex();
        // Aplica sticky nas linhas de saldo após renderizar
        requestAnimationFrame(() => app.setupFinanceStickyRows());
    },

    
updateOrcamentoTableHeader: () => {
    const thead = document.querySelector('#orcamento-table thead');
    if (!thead) return;

    const view = (app.orcamentoView || 'orcamento').toLowerCase();
    const monthNames = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
    const selected = (app.orcamentoMesSel && app.orcamentoMesSel >= 1 && app.orcamentoMesSel <= 12) ? app.orcamentoMesSel : 0;

    let html = '';
    html += '<tr class="header-months">';
    html += '<th class="sticky-col" rowspan="2">Departamento</th>';

    if (selected) {
        html += `<th colspan="4">${monthNames[selected-1]}</th>`;
    } else {
        for (let i = 0; i < 12; i++) html += `<th colspan="4">${monthNames[i]}</th>`;
    }
    html += '</tr>';

    html += '<tr class="header-sub">';
    const repeat = selected ? 1 : 12;

    for (let i = 0; i < repeat; i++) {
        if (view === 'receita') {
            html += '<th>Metas</th><th>Realizado</th><th>Diferença</th><th>Diferença %</th>';
        } else if (view === 'orcamento') {
            html += '<th>Despesas</th><th>Realizado</th><th>Diferença</th><th>Diferença %</th>';
        } else if (view === 'todos') {
            html += '<th>Metas Realizadas</th><th>Despesas Realizadas</th><th>Diferença</th><th>Diferença %</th>';
        } else {
            html += '<th>Orç.</th><th>Real.</th><th>Dif.</th><th>Dif.%</th>';
        }
    }

    html += '</tr>';
    thead.innerHTML = html;
},


    renderOrcamentoTable: (data) => {
        const tbody = document.querySelector('#orcamento-table tbody');
        if(!tbody) return;
        if (!data || data.length === 0) {
    const selectedMonth = (app.orcamentoMesSel && app.orcamentoMesSel >= 1 && app.orcamentoMesSel <= 12) ? app.orcamentoMesSel : 0;
    const colspan = 1 + (selectedMonth ? 4 : 48);
    tbody.innerHTML = `<tr><td colspan="${colspan}" style="text-align:center; padding:20px;">Nenhum registro encontrado.</td></tr>`;
    return;
}
const fmt = v => new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v);

const viewAtual = (app.orcamentoView || 'orcamento').toLowerCase();
const fmtV = (v) => fmt(viewAtual === 'todos' ? Math.abs(v || 0) : (v || 0));
        const fmtAbs = (v) => fmt(Math.abs(v || 0));
        const fmtSigned = (v) => fmt(v || 0);
        const fmtPerc = v => Utils.fmtPerc(v, 1);
        const mesesAll = ['jan','fev','mar','abr','mai','jun','jul','ago','set','out','nov','dez'];
        const selectedMonth = (app.orcamentoMesSel && app.orcamentoMesSel >= 1 && app.orcamentoMesSel <= 12) ? app.orcamentoMesSel : 0;
        const meses = selectedMonth ? [mesesAll[selectedMonth-1]] : mesesAll;

        // Helpers para visão "Todos": separar Receitas (>=0) e Despesas (<0) a partir do REALIZADO
        const getTodosValues = (row, mesKey) => {
            let receita = 0;
            let despesa = 0;

            // Grupo: soma pelos detalhes
            if (row && Array.isArray(row.detalhes) && row.detalhes.length) {
                row.detalhes.forEach(it => {
                    const v = (it && it.dados && it.dados[mesKey]) ? Number(it.dados[mesKey].realizado || 0) : 0;
                    if (v >= 0) receita += v;
                    else despesa += Math.abs(v);
                });
            } else {
                // Item: classifica pelo sinal
                const v = (row && row.dados && row.dados[mesKey]) ? Number(row.dados[mesKey].realizado || 0) : 0;
                if (v >= 0) receita = v;
                else despesa = Math.abs(v);
            }

            const dif = receita - despesa;
            const difPerc = receita !== 0 ? ((dif / receita) * 100) : 0;
            const cls = dif < 0 ? 'text-green' : (dif > 0 ? 'text-red' : '');

            return { receita, despesa, dif, difPerc, cls };
        };

        let html = '';
        data.forEach((grupo, idx) => {
            const idGrupo = `orc-g-${idx}`;
            let colsHtmlGrupo = '';
            meses.forEach(m => {
                if (viewAtual === 'todos') {
                    const tv = getTodosValues(grupo, m);
                    colsHtmlGrupo += `
                        <td class="col-real">${fmtAbs(tv.receita)}</td>
                        <td class="col-real">${fmtAbs(tv.despesa)}</td>
                        <td class="col-dif ${tv.cls}">${fmtSigned(tv.dif)}</td>
                        <td class="col-perc ${tv.cls}">${fmtPerc(tv.difPerc)}</td>
                    `;
                    return;
                }

                const vals = (grupo.dados && grupo.dados[m]) ? grupo.dados[m] : { orcado: 0, realizado: 0, diferenca: 0 };
                const orc = (vals && vals.orcado !== undefined) ? vals.orcado : 0;
                const real = (vals && vals.realizado !== undefined) ? vals.realizado : 0;
                const dif = (vals && vals.diferenca !== undefined) ? vals.diferenca : 0;
                const view = (app.orcamentoView || 'orcamento').toLowerCase();
                let clsDif;
                if (view === 'receita') {
                    // RECEITA: acima da meta (dif < 0) = verde | abaixo (dif > 0) = vermelho
                    clsDif = dif < 0 ? 'text-green' : (dif > 0 ? 'text-red' : '');
                } else {
                    // ORÇAMENTO: acima das despesas (dif < 0) = vermelho | abaixo (dif > 0) = verde
                    clsDif = dif < 0 ? 'text-red' : (dif > 0 ? 'text-green' : '');
                }
                let difPerc = orc !== 0 ? ((dif / orc) * 100) : (real > 0 ? -100 : 0);

                colsHtmlGrupo += `
                    <td class="col-orc" style="font-weight:bold;">${fmtV(orc)}</td>
                    <td class="col-real" style="font-weight:bold;">${fmtV(real)}</td>
                    <td class="col-dif ${clsDif}" style="font-weight:bold;">${fmt(Math.abs(dif))}</td>
                    <td class="col-perc ${clsDif}">${fmtPerc(Math.abs(difPerc))}</td>
                `;
            });

            html += `<tr class="hover-row" onclick="app.toggleGroup('${idGrupo}', this)" style="cursor: pointer; background-color: #f8fafc;">
                    <td class="sticky-col" style="font-weight: 700; color: #1e3a8a; background-color: #f8fafc !important;"><i class="fa-solid fa-chevron-right toggle-icon"></i> ${grupo.conta}</td>
                    ${colsHtmlGrupo}
                </tr>`;

            if(grupo.detalhes) {
                grupo.detalhes.forEach(item => {
                    let colsHtmlItem = '';
                    meses.forEach(m => {
                        if (viewAtual === 'todos') {
                            const tv = getTodosValues(item, m);
                            colsHtmlItem += `
                                <td class="col-real">${fmtAbs(tv.receita)}</td>
                                <td class="col-real">${fmtAbs(tv.despesa)}</td>
                                <td class="col-dif ${tv.cls}">${fmtSigned(tv.dif)}</td>
                                <td class="col-perc ${tv.cls}">${fmtPerc(tv.difPerc)}</td>
                            `;
                            return;
                        }

                        const vals = (item.dados && item.dados[m]) ? item.dados[m] : { orcado: 0, realizado: 0, diferenca: 0 };
                        const orc = (vals && vals.orcado !== undefined) ? vals.orcado : 0;
                        const real = (vals && vals.realizado !== undefined) ? vals.realizado : 0;
                        const dif = (vals && vals.diferenca !== undefined) ? vals.diferenca : 0;
                        const view = (app.orcamentoView || 'orcamento').toLowerCase();
                        let clsDif;
                if (view === 'receita') {
                    // RECEITA: acima da meta (dif < 0) = verde | abaixo (dif > 0) = vermelho
                    clsDif = dif < 0 ? 'text-green' : (dif > 0 ? 'text-red' : '');
                } else {
                    // ORÇAMENTO: acima das despesas (dif < 0) = vermelho | abaixo (dif > 0) = verde
                    clsDif = dif < 0 ? 'text-red' : (dif > 0 ? 'text-green' : '');
                }
                        let difPerc = orc !== 0 ? ((dif / orc) * 100) : (real > 0 ? -100 : 0);

                        colsHtmlItem += `
                            <td class="col-orc" style="background-color:#fff;">${fmtV(orc)}</td>
                            <td class="col-real" style="background-color:#f9fafb;">${fmtV(real)}</td>
                            <td class="col-dif ${clsDif}">${fmt(Math.abs(dif))}</td>
                            <td class="col-perc ${clsDif}">${fmtPerc(Math.abs(difPerc))}</td>
                        `;
                    });
                    html += `<tr class="child-row hidden pai-${idGrupo}">
                            <td class="sticky-col" style="padding-left: 30px !important; color: #4b5563;">${item.conta}</td>
                            ${colsHtmlItem}
                        </tr>`;
                });
            }
        });
        tbody.innerHTML = html;
        // index para busca rápida na tabela (evita varrer DOM repetidamente)
        app.buildDashboardSearchIndex();
        // Aplica sticky nas linhas de saldo após renderizar
        requestAnimationFrame(() => app.setupFinanceStickyRows());
    },

    loadDepartamentos: async () => {
        try {
            const key = 'GET:/api/departamentos';
            let promise = ApiCache.get(key);
            if (!promise) { promise = apiFetchJson('/api/departamentos'); ApiCache.set(key, promise, 10 * 60_000); }
            const deps = await promise;
const select = document.getElementById('cad-departamento');
            if(select) {
                select.innerHTML = '<option value="">Selecione...</option>';
                deps.forEach(d => { select.innerHTML += `<option value="${d.Id_dep}">${d.Nome_dep}</option>`; });
            }
        } catch (err) { console.error(err); }
    },

    cadastrarUsuario: async (e) => {
        e.preventDefault();
        const msg = document.getElementById('cad-mensagem');
        msg.innerText = "Enviando..."; msg.style.color = "blue";
        
        const prefixo = document.getElementById('cad-email-prefix').value.trim();
        const emailFinal = `${prefixo}@objetivaatacadista.com.br`;

        const dados = {
            nome: document.getElementById('cad-nome').value,
            email: emailFinal,
            departamentoId: document.getElementById('cad-departamento').value,
            role: document.getElementById('cad-role').value,
            nivel: document.getElementById('cad-nivel').value 
        };
        
        try {
            const res = await fetch('/api/usuarios', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(dados)
            });
            const result = await res.json();
            if (result.success) {
                msg.innerText = "✅ " + result.message; msg.style.color = "green";
                document.getElementById('form-cadastro').reset();
                if(document.getElementById('cad-nivel')) document.getElementById('cad-nivel').value = '1';
            } else { msg.innerText = "❌ " + result.message; msg.style.color = "red"; }
        } catch (err) { msg.innerText = "Erro ao conectar."; msg.style.color = "red"; }
    },

    fetchData: async () => {
        app.setLoading(true);
        // evita render duplicado por chamadas concorrentes (dashboard)
        app.__dashReqId = (app.__dashReqId || 0) + 1;
        const __reqId = app.__dashReqId;
        try {
            const anoParam = app.yearDashboard; 
            const viewParam = app.viewType || 'mensal';
            // --- CAPTURA O VALOR DO NOVO FILTRO DE STATUS ---
            const statusSelect = document.getElementById('dashboard-status-view');
            const statusParam = statusSelect ? statusSelect.value : 'todos';
            
            const url = `/api/dashboard?ano=${anoParam}&view=${viewParam}&status=${statusParam}`;
            const key = `GET:${url}`;
            let promise = ApiCache.get(key);
            if (!promise) { promise = apiFetchJson(url); ApiCache.set(key, promise, 15_000); }
            const data = await promise;
            // ignora respostas antigas (caso tenha mais de uma requisição em paralelo)
            if (__reqId !== app.__dashReqId) return;
            if(data.error) throw new Error(data.error);
            
            app.renderKPIs(data.cards);
            app.renderTable(data.tabela);
        // Guarda as colunas atuais para a tabela Financeiro acompanhar exatamente a DFC
        window.__dashboardCols = { keys: data.tabela.columns, labels: data.tabela.headers };

        // Atualiza visibilidade/render da tabela Financeiro (só quando Tipo de Visão = Todos)
        if (typeof window.refreshFinanceiroIfNeeded === 'function') {
            window.refreshFinanceiroIfNeeded({ skipFetch: true });
        }
 
            
            if (typeof app.fetchFinanceiroData === 'function') { await app.fetchFinanceiroData(); }
requestAnimationFrame(() => app.renderChart(data.grafico));
        } catch (err) { console.error(err); } 
        finally { app.setLoading(false); }
    },

    renderKPIs: (c) => {
        const fmt = v => Utils.fmtBRL(v);
        const ct = document.getElementById('kpi-container');
        if(!ct) return;
        const mk = (l, v, cl) => `<div class="card"><div class="card-title">${l}</div><div class="card-value ${cl}">${fmt(v)}</div></div>`;
        const labelResultado = c.deficitSuperavit >= 0 ? 'Superávit' : 'Déficit';
        ct.innerHTML = mk('Saldo Inicial',c.saldoInicial,'') + 
                       mk('Entradas',c.entrada,'text-green') + 
                       mk('Saídas',c.saida,'text-red') + 
                       mk(labelResultado, c.deficitSuperavit, c.deficitSuperavit>=0?'text-green':'text-red') + 
                       mk('Fluxo Caixa Livre - FCL',c.saldoFinal,'bold');
    },

    toggleGroup: (idPai, el) => {
        const filhos = document.getElementsByClassName(`pai-${idPai}`);
        if(filhos.length === 0) return;
        const estaEscondido = filhos[0].classList.contains('hidden');
        const icon = el.querySelector('.toggle-icon');
        if(icon) icon.style.transform = estaEscondido ? 'rotate(90deg)' : 'rotate(0deg)';
        Array.from(filhos).forEach(row => { row.classList.toggle('hidden', !estaEscondido); });
        
        if (!estaEscondido) { 
            const netos = document.getElementsByClassName(`avo-${idPai}`);
            if (netos.length > 0) {
                Array.from(netos).forEach(neto => neto.classList.add('hidden'));
                Array.from(filhos).forEach(rowL2 => {
                    const iconL2 = rowL2.querySelector('.toggle-icon');
                    if(iconL2) iconL2.style.transform = 'rotate(0deg)';
                });
            }
        }
    },

    toggleSubGroup: (idL2, el) => {
        const filhosNivel3 = document.getElementsByClassName(`pai-${idL2}`);
        if(filhosNivel3.length === 0) return;
        const estaEscondido = filhosNivel3[0].classList.contains('hidden');
        const icon = el.querySelector('.toggle-icon');
        if(icon) icon.style.transform = estaEscondido ? 'rotate(90deg)' : 'rotate(0deg)';
        Array.from(filhosNivel3).forEach(row => { row.classList.toggle('hidden', !estaEscondido); });
    },

    renderChart: (d) => {
        const canvas = document.getElementById('mainChart');
        if(!canvas) return;
        const ctx = canvas.getContext('2d');
        if (typeof Chart === 'undefined') return;

        const existingChart = Chart.getChart(canvas);
        if (existingChart) existingChart.destroy();
        if (app.chart) { app.chart.destroy(); app.chart = null; }

        if (typeof ChartDataLabels !== 'undefined') { try { Chart.register(ChartDataLabels); } catch(e){} }

        function getGradient(context, isBackground) {
            const chart = context.chart;
            const {ctx, chartArea, scales} = chart;
            if (!chartArea) return isBackground ? 'rgba(16, 185, 129, 0.1)' : '#10b981';
            const yAxis = scales.y;
            const yZero = yAxis.getPixelForValue(0); 
            const height = chartArea.bottom - chartArea.top;
            let offset = (chartArea.bottom - yZero) / height;
            if (!Number.isFinite(offset)) offset = 0.5;
            offset = Math.min(Math.max(offset, 0), 1);
            const gradient = ctx.createLinearGradient(0, chartArea.bottom, 0, chartArea.top);
            if (isBackground) {
                gradient.addColorStop(0, 'rgba(239, 68, 68, 0.4)');     
                gradient.addColorStop(offset, 'rgba(239, 68, 68, 0.05)'); 
                gradient.addColorStop(offset, 'rgba(16, 185, 129, 0.05)'); 
                gradient.addColorStop(1, 'rgba(16, 185, 129, 0.4)');    
            } else {
                gradient.addColorStop(0, '#ef4444');      
                gradient.addColorStop(offset, '#ef4444'); 
                gradient.addColorStop(offset, '#10b981'); 
                gradient.addColorStop(1, '#10b981');      
            }
            return gradient;
        }

        app.chart = new Chart(ctx, {
            type: 'line',
            data: { 
                labels: d.labels, 
                datasets: [{
                    label: 'Fluxo', data: d.data, fill: true, tension: 0.4, borderWidth: 2,
                    pointBackgroundColor: '#fff', pointBorderWidth: 2, pointRadius: 5, 
                    borderColor: function(c) { return getGradient(c, false); },
                    backgroundColor: function(c) { return getGradient(c, true); },
                    pointBorderColor: function(c) { return c.raw >= 0 ? '#10b981' : '#ef4444'; }
                }] 
            },
            options: { 
                responsive: true, maintainAspectRatio: false, 
                layout: { padding: { top: 30, bottom: 10, left: 20, right: 30 } },
                interaction: { mode: 'index', intersect: false },
                plugins: {
                    legend: { display: false }, tooltip: { enabled: false }, 
                    datalabels: {
                        display: function(context) { return window.innerWidth > 768; },
                        align: 'top', anchor: 'end', offset: 8, clamp: true,       
                        color: function(context) { return context.dataset.data[context.dataIndex] >= 0 ? '#059669' : '#dc2626'; },
                        font: { weight: 'bold', size: 12 },
                        formatter: function(value) { return Utils.fmtBRL(value); }
                    }
                }, 
                scales: {
                    x: { grid: { display: false }, offset: true }, 
                    y: { 
                        grid: { borderDash: [5,5] }, grace: '10%',
                        ticks: { padding: 10, callback: function(value) { return Utils.fmtBRL(value); } }
                    }
                } 
            }
        });
    
    },

    // =====================================================
    // FINANCEIRO (Dashboard) — tabela separada, com expand/recolhe independente
    // Regras:
    // - Só aparece quando Tipo de Visão = "todos"
    // =====================================================
    fetchFinanceiroData: async () => {
        // evita render duplicado por chamadas concorrentes
        app.__finReqId = (app.__finReqId || 0) + 1;
        const __reqId = app.__finReqId;
        try {
            const statusSelect = document.getElementById('dashboard-status-view');
            const statusParam = statusSelect ? statusSelect.value : 'todos';

            const painel = document.getElementById('financeiro-panel');
            const tbody = document.querySelector('#financeiro-table tbody');
            const thead = document.querySelector('#financeiro-table thead');

            if (statusParam !== 'todos') {
                if (painel) painel.style.setProperty('display', 'none', 'important');
                if (tbody) tbody.innerHTML = '';
                if (thead) thead.innerHTML = '';
                return;
            }

            if (painel) painel.style.setProperty('display', 'flex', 'important');

            const anoParam = app.yearDashboard;
            const viewParam = app.viewType || 'mensal';

            const res = await fetch(`/api/financeiro-dashboard?ano=${encodeURIComponent(anoParam)}&view=${encodeURIComponent(viewParam)}`);
            const data = await res.json();
            if (data.error) throw new Error(data.error);

            if (data && data.tabela) {
                app.renderFinanceiroTable(data.tabela);
            }
        } catch (err) {
            console.error('Erro Financeiro Dashboard:', err);
        }
    },

    renderFinanceiroTable: (tabela) => {
        const rows = tabela.rows || [];
        const columns = tabela.columns || [];
        const headers = tabela.headers || [];

        const tbody = document.querySelector('#financeiro-table tbody');
        const thead = document.querySelector('#financeiro-table thead');
        if (!tbody || !thead) return;

        // Cabeçalho
        let thHtml = `<tr><th>Plano Financeiro</th>`;
        headers.forEach(h => thHtml += `<th>${h}</th>`);
        thHtml += `</tr>`;
        thead.innerHTML = thHtml;

        const fmt = (v) => (Number(v || 0)).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

        // Corpo (2 níveis: grupo -> itens)
        let html = '';
        rows.forEach((grupo, idx) => {
            const idPai = `fin-${idx}`;
            const hasChildren = Array.isArray(grupo.detalhes) && grupo.detalhes.length > 0;

            html += `<tr class="grupo" data-id="${idPai}" onclick="app.toggleFinanceiroGroup('${idPai}', this)">
                        <td>
                          ${hasChildren ? '<span class="toggle-icon">▸</span>' : '<span class="toggle-icon" style="opacity:.0">▸</span>'}
                          ${grupo.conta || ''}
                        </td>`;

            columns.forEach(c => {
                html += `<td>${fmt(grupo[c] ?? 0)}</td>`;
            });
            html += `</tr>`;

            if (hasChildren) {
                grupo.detalhes.forEach(item => {
                    html += `<tr class="item fpai-${idPai} hidden">
                                <td style="padding-left: 28px;">${item.conta || ''}</td>`;
                    columns.forEach(c => {
                        html += `<td>${fmt(item[c] ?? 0)}</td>`;
                    });
                    html += `</tr>`;
                });
            }
        });

        tbody.innerHTML = html;
        setTimeout(() => { if (app.syncDfcFinanceiroColumns) app.syncDfcFinanceiroColumns(); }, 0);
    },
    syncDfcFinanceiroColumns: () => {
        const dfc = document.getElementById('finance-table');
        const fin = document.getElementById('financeiro-table');
        if (!dfc || !fin) return;

        const dfcThs = dfc.querySelectorAll('thead th');
        const finThs = fin.querySelectorAll('thead th');
        if (!dfcThs.length || finThs.length !== dfcThs.length) return;

        // Usa as larguras reais da DFC como referência
        const widths = Array.from(dfcThs).map(th => th.getBoundingClientRect().width);

        finThs.forEach((th, i) => { th.style.width = widths[i] + 'px'; });
        // aplica também nas células do corpo (1ª linha é suficiente para fixar table-layout)
        const finFirstRow = fin.querySelector('tbody tr');
        if (finFirstRow) {
            const tds = finFirstRow.children;
            for (let i = 0; i < tds.length; i++) {
                if (widths[i]) tds[i].style.width = widths[i] + 'px';
            }
        }
    },


    toggleFinanceiroGroup: (idPai, trEl) => {
        const filhos = document.querySelectorAll(`.fpai-${idPai}`);
        if (!filhos || filhos.length === 0) return;

        const icon = trEl ? trEl.querySelector('.toggle-icon') : null;
        const estaFechado = filhos[0].classList.contains('hidden');

        filhos.forEach(r => r.classList.toggle('hidden', !estaFechado));
        if (icon) icon.classList.toggle('rotated', estaFechado);
    },

    // --- Toggle de visibilidade de senha (Login e Alteração) ---
    bindPasswordToggles: () => {
        document.querySelectorAll('.btn-toggle-password').forEach(btn => {
            btn.addEventListener('click', () => {
                const targetId = btn.getAttribute('data-target');
                const input = document.getElementById(targetId);
                if (!input) return;
                const icon = btn.querySelector('i');
                const isHidden = input.type === 'password';
                input.type = isHidden ? 'text' : 'password';
                if (icon) {
                    icon.classList.toggle('fa-eye', !isHidden);
                    icon.classList.toggle('fa-eye-slash', isHidden);
                }
                btn.setAttribute('aria-label', isHidden ? 'Ocultar senha' : 'Exibir senha');
            });
        });
    },
};

document.addEventListener('DOMContentLoaded', app.init);


/* =========================================================
   PATCH FINAL — VISIBILIDADE DO FINANCEIRO (DASHBOARD)
   - Mostra Financeiro apenas quando Tipo de Visão = "Todos"
   - Em outros valores, esconde o painel e não deixa "sobrar" box
   - Não altera sua lógica existente; só garante o toggle
   ========================================================= */
(function () {
    // ============================================================
    // TABELA "FINANCEIRO" (Dashboard) — independente da DFC
    // Regras:
    // - Só aparece quando Tipo de Visão = "Todos" (dashboard-status-view = "todos")
    // - Mesmas colunas (mesmo período/headers) da DFC
    // - Expande/recolhe igual a DFC (grupo -> itens)
    // ============================================================

    const financeiroPanel = document.getElementById('financeiro-panel');
    const financeiroTable = document.getElementById('financeiro-table');

    const fallbackKeys = ['jan','fev','mar','abr','mai','jun','jul','ago','set','out','nov','dez'];
    const fallbackLabels = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];

    function getAnoSelecionado() {
        const el = document.getElementById('ano-dashboard');
        return el && el.value ? el.value : String(new Date().getFullYear());
    }

    function getStatusSelecionado() {
        const el = document.getElementById('dashboard-status-view');
        return el && el.value ? el.value : 'todos';
    }

    function getColsFromDashboard() {
        const keys = (window.__dashboardCols && Array.isArray(window.__dashboardCols.keys)) ? window.__dashboardCols.keys : fallbackKeys;
        const labels = (window.__dashboardCols && Array.isArray(window.__dashboardCols.labels)) ? window.__dashboardCols.labels : fallbackLabels;
        return { keys, labels };
    }

    function setFinanceiroVisible(show) {
        if (!financeiroPanel) return;
        // usa display: none; para o painel todo (some o "box" também)
        financeiroPanel.style.display = show ? '' : 'none';
    }

    async function fetchFinanceiroDashboard() {
        const ano = getAnoSelecionado();
        const status = getStatusSelecionado(); // aqui esperamos "todos" ou "realizado"
        const qs = new URLSearchParams({ ano, status });

        const resp = await fetch(`/api/financeiro-dashboard?${qs.toString()}`);
        if (!resp.ok) throw new Error('Falha ao buscar Financeiro.');
        return resp.json();
    }

    function formatBRL(value) {
        const n = Number(value || 0);
        return n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    }

    function clearFinanceiroTable() {
        if (!financeiroTable) return;
        const thead = financeiroTable.querySelector('thead');
        const tbody = financeiroTable.querySelector('tbody');
        if (thead) thead.innerHTML = '';
        if (tbody) tbody.innerHTML = '';
    }

    function renderFinanceiroDashboard(payload) {
        if (!financeiroTable) return;

        const thead = financeiroTable.querySelector('thead');
        const tbody = financeiroTable.querySelector('tbody');
        if (!thead || !tbody) return;

        const cols = getColsFromDashboard();
        const colKeys = cols.keys;
        const colLabels = cols.labels;

        // Header
        thead.innerHTML = `
            <tr>
                <th>Plano Financeiro</th>
                ${colLabels.map(h => `<th>${h}</th>`).join('')}
            </tr>
        `;

        // Body
        tbody.innerHTML = '';

        const rows = payload && payload.rows ? payload.rows : [];
        let rowId = 0;

        const createRow = ({ conta, dados, tipo, level, hasChildren, parentId }) => {
            const tr = document.createElement('tr');
            tr.className = 'hover-row';
            if (tipo === 'grupo') tr.classList.add('grupo');
            if (tipo === 'item') tr.classList.add('child-row');
            tr.dataset.rowId = String(++rowId);
            if (parentId) tr.dataset.parentId = parentId;

            // Primeira célula com toggle
            const td0 = document.createElement('td');
            td0.style.cursor = hasChildren ? 'pointer' : 'default';

            const indent = '&nbsp;'.repeat(level * 4);

            const toggle = hasChildren
                ? `<span class="toggle-icon" data-role="toggle">▶</span>`
                : `<span class="toggle-icon" style="opacity:0">▶</span>`;

            td0.innerHTML = `${toggle}${indent}<span class="conta-text">${conta || ''}</span>`;
            tr.appendChild(td0);

            // Valores por coluna
            colKeys.forEach(k => {
                const td = document.createElement('td');
                const v = dados && Object.prototype.hasOwnProperty.call(dados, k) ? dados[k] : 0;
                td.textContent = formatBRL(v);
                tr.appendChild(td);
            });

            // Clique para expandir/recolher
            if (hasChildren) {
                tr.dataset.expanded = 'false';
                tr.addEventListener('click', (ev) => {
                    // evita colidir com seleção de texto
                    ev.preventDefault();
                    const expanded = tr.dataset.expanded === 'true';
                    const newState = !expanded;
                    tr.dataset.expanded = newState ? 'true' : 'false';

                    // gira ícone
                    const icon = tr.querySelector('[data-role="toggle"]');
                    if (icon) {
                        icon.textContent = newState ? '▼' : '▶';
                    }

                    // mostra/oculta filhos imediatos (e se ocultar, recolhe todos abaixo)
                    const myId = tr.dataset.rowId;
                    const children = tbody.querySelectorAll(`tr[data-parent-id="${myId}"]`);
                    children.forEach(child => {
                        child.style.display = newState ? '' : 'none';
                        if (!newState) {
                            // recolhe descendentes também
                            const childId = child.dataset.rowId;
                            const descendants = tbody.querySelectorAll(`tr[data-parent-id="${childId}"]`);
                            descendants.forEach(d => d.style.display = 'none');
                            child.dataset.expanded = 'false';
                            const cIcon = child.querySelector('[data-role="toggle"]');
                            if (cIcon) cIcon.textContent = '▶';
                        }
                    });
                });
            }

            tbody.appendChild(tr);
            return tr.dataset.rowId;
        };

        rows.forEach(gr => {
            // grupo
            const grupoId = createRow({
                conta: gr.conta,
                dados: gr.dados || {},
                tipo: 'grupo',
                level: 0,
                hasChildren: Array.isArray(gr.detalhes) && gr.detalhes.length > 0,
                parentId: null
            });

            // itens (inicialmente escondidos)
            if (Array.isArray(gr.detalhes)) {
                gr.detalhes.forEach(item => {
                    const itemId = createRow({
                        conta: item.conta,
                        dados: item.dados || {},
                        tipo: 'item',
                        level: 1,
                        hasChildren: false,
                        parentId: grupoId
                    });
                    // começa escondido
                    const tr = tbody.querySelector(`tr[data-row-id="${itemId}"]`);
                    if (tr) tr.style.display = 'none';
                });
            }
        });
    }

    async function refreshFinanceiroIfNeeded(opts) {
        const status = getStatusSelecionado();
        const shouldShow = (status === 'todos');

        setFinanceiroVisible(shouldShow);

        // Não "limpa" a tabela aqui para evitar piscar (flicker). A limpeza/ocultação é tratada
        // pela lógica principal (app.fetchFinanceiroData) quando necessário.
        if (!shouldShow) return;

        // Quando chamado por mudanças de filtros (e não pelo fetch principal), atualiza os dados.
        const skipFetch = opts && opts.skipFetch;
        if (skipFetch) return;

        try {
            if (window.app && typeof window.app.fetchFinanceiroData === 'function') {
                await window.app.fetchFinanceiroData();
                return;
            }
            // Fallback: mantém comportamento antigo se a função principal não existir
            const data = await fetchFinanceiroDashboard();
            renderFinanceiroDashboard(data);
        } catch (e) {
            console.error('[Financeiro] Erro ao atualizar:', e);
            // não limpar tabela para não piscar
        }
    }

    // Expor para o restante do script (fetchData chama isso após atualizar colunas)
    window.refreshFinanceiroIfNeeded = refreshFinanceiroIfNeeded;

    // Garantir atualização ao trocar filtros relevantes
    document.addEventListener('DOMContentLoaded', () => {
        const st = document.getElementById('dashboard-status-view');
        const ano = document.getElementById('ano-dashboard');
        const periodo = document.getElementById('dashboard-view');

        if (st) st.addEventListener('change', () => refreshFinanceiroIfNeeded());
        if (ano) ano.addEventListener('change', () => refreshFinanceiroIfNeeded());
        if (periodo) periodo.addEventListener('change', () => refreshFinanceiroIfNeeded());
    });
})();




/* ============================================================
   PATCH FINAL (Dashboard + Orçamento nomenclaturas + 304 fix)
   - Não remove nada do código original: só adiciona/override seguro
   ============================================================ */
(function () {
  // ---------- 1) FIX DEFINITIVO: resposta 304 sem body (tabela vazia) ----------
  // Se o backend responder 304 (Not Modified), refaz a requisição com no-store para obter JSON.
  const _origFetch = window.fetch ? window.fetch.bind(window) : null;
  if (_origFetch) {
    window.fetch = async function patchedFetch(input, init) {
      try {
        const url = (typeof input === "string") ? input : (input && input.url) ? input.url : "";
        const isApi =
          url.includes("/api/dashboard") ||
          url.includes("/api/financeiro-dashboard") ||
          url.includes("/api/anos") ||
          url.includes("/api/departamentos") ||
          url.includes("/api/orcamento") ||
          url.includes("/api/dashgooogle") ||
          url.includes("/api/dashgoogle") ||
          url.includes("/api/"); // fallback: para não quebrar outros endpoints do app

        // Primeiro tenta normalmente
        const res = await _origFetch(input, init);

        // Se veio 304, refaz com no-store (sem alterar sua lógica original)
        if (isApi && res && res.status === 304) {
          const retryInit = Object.assign({}, init || {}, { cache: "no-store" });
          // Evita manter headers condicionais, se houver
          if (retryInit.headers && typeof retryInit.headers === "object") {
            const h = { ...retryInit.headers };
            delete h["If-None-Match"];
            delete h["If-Modified-Since"];
            retryInit.headers = h;
          }
          return _origFetch(url, retryInit);
        }

        return res;
      } catch (e) {
        // Se algo deu errado no patch, cai pro fetch original
        return _origFetch(input, init);
      }
    };
  }

  // ---------- 2) Correções de nomenclatura (KPIs + Tabela) ----------
  // Garante app
  if (typeof window.app !== "object" || window.app === null) window.app = {};

  // Helpers seguros
  const fmt = (v) => {
    const n = Number(v || 0);
    const val = Number.isFinite(n) ? n : 0;
    try {
      return val.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
    } catch {
      return "R$ " + val.toFixed(2).replace(".", ",");
    }
  };

  const mkCardSafe = (title, value, extraClass) => {
    // Tenta usar mkCard do código original, se existir
    try {
      if (typeof window.mkCard === "function") return window.mkCard(title, value, extraClass);
    } catch {}
    const cls = extraClass ? ` ${extraClass}` : "";
    return `
      <div class="kpi-card${cls}">
        <div class="kpi-title">${title}</div>
        <div class="kpi-value">${value}</div>
      </div>
    `;
  };

  // Override seguro: apenas para corrigir textos/cores conforme suas regras
  if (typeof window.app.renderOrcamentoKPIs === "function") {
    const _oldKPIs = window.app.renderOrcamentoKPIs.bind(window.app);

    window.app.renderOrcamentoKPIs = function patchedRenderOrcamentoKPIs(data) {
      try {
        const container = document.getElementById("kpi-orcamento-container");
        const view = (window.app.orcamentoView || "orcamento").toLowerCase();

        // Se for "Todos", renderizamos exatamente os 5 KPIs pedidos
        if (container && view === "todos") {
          const hoje = new Date();
          const mesIndex = (window.app.orcamentoMesSel && window.app.orcamentoMesSel >= 1 && window.app.orcamentoMesSel <= 12)
            ? (window.app.orcamentoMesSel - 1)
            : hoje.getMonth();
          const anoAnalise = window.app.yearOrcamento;

          const nomesMeses = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
          const nomeMes = nomesMeses[mesIndex];
          const labelMes = `(${nomeMes})`;

          const meta = window.app.dadosOrcamentoMeta && window.app.dadosOrcamentoMeta.series ? window.app.dadosOrcamentoMeta.series : null;
          const safe = (v) => {
            const n = Number(v || 0);
            return Number.isFinite(n) ? n : 0;
          };

          const metasMes = meta && meta.receita ? Math.abs(safe(meta.receita.planejado[mesIndex])) : 0;
          const metasRealizadasMes = meta && meta.receita ? Math.abs(safe(meta.receita.realizado[mesIndex])) : 0;

          const despesasMes = meta && meta.despesa ? Math.abs(safe(meta.despesa.planejado[mesIndex])) : 0;
          const despesasRealizadasMes = meta && meta.despesa ? Math.abs(safe(meta.despesa.realizado[mesIndex])) : 0;

          const diferenca = metasRealizadasMes - despesasRealizadasMes; // aqui é o que você pediu
          const corDif = diferenca < 0 ? "text-green" : "text-red";

          container.innerHTML =
            mkCardSafe(`Metas (Mês atual) ${labelMes}`, fmt(metasMes), "col-orc") +
            mkCardSafe(`Metas Realizadas (Mês atual) ${labelMes}`, fmt(metasRealizadasMes), "col-real") +
            mkCardSafe(`Despesas (Mês atual) ${labelMes}`, fmt(despesasMes), "col-orc") +
            mkCardSafe(`Despesas Realizadas (Mês atual) ${labelMes}`, fmt(despesasRealizadasMes), "col-real") +
            mkCardSafe(`Diferença (Receitas - Despesas)`, fmt(diferenca), corDif);

          return; // não deixa o original renderizar KPIs extras
        }

        // Para Receita/Orçamento: deixa o original fazer as contas, e só corrige textos/cores no DOM
        _oldKPIs(data);

        if (!container) return;

// ======= NOVAS NOMENCLATURAS + CORES DOS KPIs =======
const titles = container.querySelectorAll(".kpi-title");
const values = container.querySelectorAll(".kpi-value");
if (!titles || !titles.length) return;

const normalize = (s) => (s || "").toLowerCase();

if (view === "receita") {
  // ----- NOMENCLATURAS (RECEITA) -----
  titles.forEach((el) => {
    const t = normalize(el.textContent);

    if (t.includes("orçado") || t.includes("orcado") || t.includes("planejado"))
      el.textContent = "Metas (Mês atual)";

    if (t.includes("real"))
      el.textContent = "Realizado (Mês atual)";

    if (t.includes("diferen"))
      el.textContent = "Diferença";

    if (t.includes("%"))
      el.textContent = "Diferença %";

    if (t.includes("dias"))
      el.textContent = "Dias úteis";

    if (t.includes("meta") && t.includes("di"))
      el.textContent = "Meta diária";

    if (t.includes("ganho") || t.includes("ganhos"))
      el.textContent = "Ganhos Diários";

    if (t.includes("proje"))
      el.textContent = "Projeção final";
  });

  // ----- CORES (RECEITA) -----
  values.forEach((vEl, idx) => {
    const title = titles[idx] ? normalize(titles[idx].textContent) : "";
    const raw = (vEl.textContent || "")
      .replace(/\./g, "")
      .replace(",", ".")
      .replace(/[^\d\-\+\.]/g, "");
    const num = Number(raw);

    if (!Number.isFinite(num)) return;

    // Diferença: abaixo = vermelho / acima = verde
    if (title.includes("diferença")) {
      vEl.classList.toggle("text-green", num < 0);
      vEl.classList.toggle("text-red", num >= 0);
    }

    // Ganhos Diários: acima da meta = verde / abaixo = vermelho
    if (title.includes("ganhos")) {
      vEl.classList.toggle("text-red", num > 0);
      vEl.classList.toggle("text-green", num <= 0);
    }
  });
}

if (view === "orcamento") {
  // ----- NOMENCLATURAS (ORÇAMENTO) -----
  titles.forEach((el) => {
    const t = normalize(el.textContent);

    if (t.includes("orçado") || t.includes("orcado") || t.includes("planejado") || t.includes("metas"))
      el.textContent = "Orçado (Mês atual)";

    if (t.includes("real"))
      el.textContent = "Realizado (Mês atual)";

    if (t.includes("diferen"))
      el.textContent = "Diferença";

    if (t.includes("%"))
      el.textContent = "Diferença %";

    if (t.includes("dias"))
      el.textContent = "Dias úteis";

    if (t.includes("meta") && t.includes("di"))
      el.textContent = "Meta diária";

    if (t.includes("gasto") || t.includes("gastos"))
      el.textContent = "Gastos Diários";

    if (t.includes("proje"))
      el.textContent = "Projeção final";
  });

  // ----- CORES (ORÇAMENTO) -----
  values.forEach((vEl, idx) => {
    const title = titles[idx] ? normalize(titles[idx].textContent) : "";
    const raw = (vEl.textContent || "")
      .replace(/\./g, "")
      .replace(",", ".")
      .replace(/[^\d\-\+\.]/g, "");
    const num = Number(raw);

    if (!Number.isFinite(num)) return;

    // Diferença: abaixo = verde / acima = vermelho
    if (title.includes("diferença")) {
      vEl.classList.toggle("text-green", num < 0);
      vEl.classList.toggle("text-red", num >= 0);
    }

    // Gastos Diários: acima da meta = vermelho / abaixo = verde
    if (title.includes("gastos")) {
      vEl.classList.toggle("text-green", num > 0);
      vEl.classList.toggle("text-red", num <= 0);
    }
  });
}

      } catch (e) {
        // Se o patch falhar por algum motivo, usa o original para não quebrar
        try { return _oldKPIs(data); } catch {}
      }
    };
  }

  // Cabeçalho da tabela (colunas)
  if (typeof window.app.updateOrcamentoTableHeader === "function") {
    const _oldHdr = window.app.updateOrcamentoTableHeader.bind(window.app);
    window.app.updateOrcamentoTableHeader = function patchedHeader() {
      try { _oldHdr(); } catch {}
      const view = (window.app.orcamentoView || "orcamento").toLowerCase();
      const ths = document.querySelectorAll("#orcamento-table thead th");
      if (!ths || ths.length < 5) return;

      // Assumindo estrutura: [Plano, Jan, Fev, ...] no mensal, mas a tabela de detalhes
      // costuma ter colunas [Plano, Orç, Real, Dif, Dif%]. Ajustamos apenas essas quando existirem.
      // Procuramos por THs com texto padrão.
      ths.forEach((th) => {
        const t = (th.textContent || "").trim().toLowerCase();
        if (view === "receita") {
          if (t === "orç." || t === "orc." || t === "orçado" || t === "orcado" || t === "metas") th.textContent = "Metas";
          if (t === "real." || t === "realizado") th.textContent = "Realizado";
          if (t.startsWith("dif")) th.textContent = "Diferença";
          if (t.includes("%")) th.textContent = "Diferença %";
        } else if (view === "todos") {
          if (t === "orç." || t === "orc." || t === "orçado" || t === "orcado" || t === "metas" || t === "planejado") th.textContent = "Metas Realizadas";
          if (t === "real." || t === "realizado") th.textContent = "Despesas Realizadas";
          if (t.startsWith("dif")) th.textContent = "Diferença";
          if (t.includes("%")) th.textContent = "Diferença %";
        } else {
          // orçamento
          if (t === "orç." || t === "orc." || t === "orçado" || t === "orcado" || t === "metas") th.textContent = "Despesas";
          if (t === "real." || t === "realizado") th.textContent = "Realizado";
          if (t.startsWith("dif")) th.textContent = "Diferença";
          if (t.includes("%")) th.textContent = "Diferença %";
        }
      });
    };
  }

})();


// --- KPI: GASTO DIÁRIO -> GANHOS (regra solicitada pelo usuário) ---
function atualizarKPI_Gastos(valorRealizado, metaDiaria) {
  const titulo = document.getElementById("kpi-title");
  const valor = document.getElementById("kpi-valor");

  if (titulo) titulo.innerText = "Ganhos Diários";

  if (valor) {
    valor.innerText = new Intl.NumberFormat("pt-BR", {
      style: "currency",
      currency: "BRL"
    }).format(valorRealizado);

    if (valorRealizado < metaDiaria) {
      valor.classList.remove("kpi-verde");
      valor.classList.add("kpi-vermelho");
    } else {
      valor.classList.remove("kpi-vermelho");
      valor.classList.add("kpi-verde");
    }
  }
}
