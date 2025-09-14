// app.js — ISPT – Sistema Web de Avaliação Docente (FINAL corrigido)
// Stack: Node.js (Express) + SQLite (better-sqlite3) + Tailwind (CDN) + Chart.js (CDN)
// Export: Excel (exceljs), PDF (pdfkit)
// Extras: .env (dotenv), Autenticação simples (admin), Ano lectivo, Turma, Importação via Excel
// Como executar:
// 1) npm init -y
// 2) npm i express cookie-parser multer better-sqlite3 body-parser exceljs pdfkit dayjs dotenv
// 3) mkdir public && (coloque um logo em public/logo.png se quiser)
// 4) ADMIN_PASSWORD=coloca-uma-senha node app.js   (ou use .env)
// 5) Abrir: http://localhost:3000

const express = require('express');
const bodyParser = require('body-parser');
const cookieParser = require('cookie-parser');
const multer = require('multer');
const Database = require('better-sqlite3');
const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');
const dayjs = require('dayjs');
const fs = require('fs');
require('dotenv').config();

// ====== APP & DB ======
const app = express();
const db = new Database('avaliacao_ispt.sqlite');
const upload = multer({ storage: multer.memoryStorage() });

// ====== ENV ======
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'ispt-admin';
const LOGO_PATH = process.env.LOGO_PATH || 'logo.jpg';
const RESPONDENTS_TARGET = Number(process.env.RESPONDENTS_TARGET || 0);

// ====== MIDDLEWARES ======
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(cookieParser());
app.use(express.static('public'));

// ====== SCHEMA ======
const schema = `
CREATE TABLE IF NOT EXISTS course (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS semester (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS discipline (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  UNIQUE(course_id, name),
  FOREIGN KEY(course_id) REFERENCES course(id)
);
CREATE TABLE IF NOT EXISTS teacher (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS school_year (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS class_group (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS teaching (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  teacher_id INTEGER NOT NULL,
  discipline_id INTEGER NOT NULL,
  semester_id INTEGER NOT NULL,
  school_year_id INTEGER,
  class_group_id INTEGER,
  FOREIGN KEY(teacher_id) REFERENCES teacher(id),
  FOREIGN KEY(discipline_id) REFERENCES discipline(id),
  FOREIGN KEY(semester_id) REFERENCES semester(id),
  FOREIGN KEY(school_year_id) REFERENCES school_year(id),
  FOREIGN KEY(class_group_id) REFERENCES class_group(id)
);
CREATE TABLE IF NOT EXISTS survey_question (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL,
  text TEXT NOT NULL,
  area TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS survey_response (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  teaching_id INTEGER NOT NULL,
  submitted_at TEXT NOT NULL,
  comment TEXT,
  FOREIGN KEY(teaching_id) REFERENCES teaching(id)
);
CREATE TABLE IF NOT EXISTS survey_answer (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  response_id INTEGER NOT NULL,
  question_id INTEGER NOT NULL,
  value INTEGER NOT NULL CHECK(value IN (0,1,2)),
  FOREIGN KEY(response_id) REFERENCES survey_response(id),
  FOREIGN KEY(question_id) REFERENCES survey_question(id)
);
`;

// create/upgrade
db.exec(schema);
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ux_teaching ON teaching(teacher_id, discipline_id, semester_id, school_year_id, class_group_id);`);
try { db.exec('ALTER TABLE teaching ADD COLUMN school_year_id INTEGER'); } catch {}
try { db.exec('ALTER TABLE teaching ADD COLUMN class_group_id INTEGER'); } catch {}

// ====== SEED ======
function seedOnce() {
  const hasCourses = db.prepare('SELECT COUNT(*) c FROM course').get().c > 0;
  if (hasCourses) return;
  const courses = ['Engenharia Informática', 'Engenharia de Minas', 'Processamento Mineral'];
  const insCourse = db.prepare('INSERT INTO course (name) VALUES (?)');
  courses.forEach(c => insCourse.run(c));

  const semesters = ['1º Semestre', '2º Semestre', 'Anual'];
  const insSem = db.prepare('INSERT INTO semester (name) VALUES (?)');
  semesters.forEach(s => insSem.run(s));

  const years = ['2025'];
  const insYear = db.prepare('INSERT INTO school_year (name) VALUES (?)');
  years.forEach(y => insYear.run(y));

  const classes = ['Turma A', 'Turma B', 'Única Pós-laboral'];
  const insClass = db.prepare('INSERT INTO class_group (name) VALUES (?)');
  classes.forEach(c => insClass.run(c));

  const discByCourse = {
    'Engenharia Informática': ['Algoritmos','Estruturas de Dados','Redes de Computadores'],
    'Engenharia de Minas': ['Topografia','Perfuração e Desmonte','Ventilação de Minas'],
    'Processamento Mineral': ['Cominuição','Classificação','Flotação']
  };
  const getCourse = db.prepare('SELECT id FROM course WHERE name=?');
  const insDisc = db.prepare('INSERT INTO discipline (course_id, name) VALUES (?,?)');
  Object.entries(discByCourse).forEach(([cname, discs]) => {
    const cid = getCourse.get(cname).id;
    discs.forEach(d => insDisc.run(cid, d));
  });

  const teachers = ['Docente A','Docente B','Docente C'];
  const insT = db.prepare('INSERT INTO teacher (name) VALUES (?)');
  teachers.forEach(t => insT.run(t));

  const allDisc = db.prepare('SELECT id FROM discipline').all();
  const allSem = db.prepare('SELECT id FROM semester').all();
  const allTeach = db.prepare('SELECT id FROM teacher').all();
  const year = db.prepare('SELECT id FROM school_year LIMIT 1').get();
  const klass = db.prepare('SELECT id FROM class_group LIMIT 1').get();
  const insTeach = db.prepare('INSERT INTO teaching (teacher_id, discipline_id, semester_id, school_year_id, class_group_id) VALUES (?,?,?,?,?)');
  allDisc.forEach((d, i) => {
    const t = allTeach[i % allTeach.length];
    const s = allSem[i % allSem.length];
    insTeach.run(t.id, d.id, s.id, year?.id || null, klass?.id || null);
  });

  const questions = [
    { code: 'Q1', text: 'Chega a tempo às aulas.', area: 'Preparação' },
    { code: 'Q2', text: 'Comparece regularmente às aulas.', area: 'Preparação' },
    { code: 'Q3', text: 'Responde efectivamente às questões formuladas.', area: 'Metodologia' },
    { code: 'Q4', text: 'Ministra as aulas com segurança na matéria.', area: 'Metodologia' },
    { code: 'Q5', text: 'Distribui o programa analítico e temático.', area: 'Metodologia' },
    { code: 'Q6', text: 'Respeita os horários (pontualidade).', area: 'Organização' },
    { code: 'Q7', text: 'Cumpre com o programa analítico e temático.', area: 'Organização' },
    { code: 'Q8', text: 'Disponibiliza horário para consultas.', area: 'Avaliação' },
    { code: 'Q9', text: 'Realiza consultas de acompanhamento.', area: 'Avaliação' },
    { code: 'Q10', text: 'Avalia a matéria leccionada.', area: 'Avaliação' },
    { code: 'Q11', text: 'Divulga as notas após os testes.', area: 'Avaliação' },
    { code: 'Q12', text: 'Fornece o guião de correcção.', area: 'Relação' },
    { code: 'Q13', text: 'Entrega os testes para reclamação.', area: 'Relação' },
  ];
  const insQ = db.prepare('INSERT INTO survey_question (code, text, area) VALUES (?,?,?)');
  questions.forEach(q => insQ.run(q.code, q.text, q.area));
}
seedOnce();

// ====== HELPERS ======
function renderPage(title, content, extraHead = '', isAdmin = false) {
    const ANON = (typeof ANON_THRESHOLD !== 'undefined' ? ANON_THRESHOLD : 5);
    return `<!doctype html>
  <html lang="pt" class="h-full">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
      .card{background:#fff;border-radius:1rem;box-shadow:0 8px 30px rgba(0,0,0,.06);border:1px solid #e2e8f0;padding:1.25rem}
      .btn{display:inline-flex;align-items:center;gap:.5rem;padding:.5rem 1rem;border-radius:.75rem;font-weight:500}
      .btn-primary{background:#0f172a;color:#fff}
      .btn-ghost{background:#f1f5f9}
      .kpi{text-align:left}
      .kpi h3{font-size:.875rem;color:#64748b;text-align:left}
      .kpi .v{font-size:1.75rem;font-weight:800;color:#0f172a;letter-spacing:-.01em}
      canvas{max-height:260px !important}
  
      /* Navbar desktop */
      .nav-link{position:relative;border-radius:9999px;padding:0.375rem 0.6rem}
      .nav-link:hover{background:rgba(15,23,42,.06)}
      .nav-link.active{color:#0f172a;background:rgba(15,23,42,.08)}
  
      /* Dropdown */
      .menu{min-width:220px}
      .menu a{display:block;padding:.5rem .75rem;border-radius:.5rem}
      .menu a:hover{background:#f1f5f9}
  
      /* Mobile drawer animations */
      @media (prefers-reduced-motion:no-preference){
        .drawer{transform:translateY(-6px);opacity:0;transition:transform .18s ease, opacity .18s ease}
        .drawer.open{transform:translateY(0);opacity:1}
        .backdrop{opacity:0;transition:opacity .18s ease}
        .backdrop.open{opacity:1}
      }
  
      /* Header shadow on scroll */
      .header-shadow{box-shadow:0 10px 30px -12px rgba(0,0,0,.15)}
  
      /* Avatar */
      .avatar{width:28px;height:28px;border-radius:9999px;display:inline-flex;align-items:center;justify-content:center;font-weight:700}
  
      /* Modal helpers */
      .modal-open { overflow:hidden }
    </style>
    ${extraHead}
  </head>
  <body class="min-h-full bg-slate-50 text-slate-900">
    <div class="max-w-6xl mx-auto p-4 sm:p-8">
      <!-- HEADER -->
      <header id="siteHeader" class="sticky top-0 bg-slate-50/80 backdrop-blur z-30 border-b border-slate-200/60 transition-shadow">
        <div class="flex items-center justify-between py-3">
          <!-- Brand -->
          <a href="/" class="flex items-center gap-3">
            <img src="/logo.png" alt="Logo" class="w-10 h-10 object-contain" onerror="this.style.display='none'"/>
            <div class="leading-tight">
              <div class="font-semibold tracking-tight">ISPT · Avaliação Docente</div>
              <div class="text-xs text-slate-500 hidden sm:block">Sistema Web de Inquérito a Estudantes</div>
            </div>
          </a>
  
          <!-- Right cluster (DESKTOP): nav + bell + avatar + sair -->
          <div class="hidden md:flex items-center gap-2">
            <!-- Desktop nav COLADO ao sino -->
            <nav class="flex items-center gap-1">
              <a href="/" class="nav-link text-sm">Inquérito</a>
              ${isAdmin ? `
              <div class="relative">
                <button id="btnAdmin" class="nav-link text-sm inline-flex items-center gap-1" aria-haspopup="true" aria-expanded="false">
                  Administração
                  <svg width="16" height="16" viewBox="0 0 20 20" fill="none"><path d="M6 8l4 4 4-4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
                </button>
                <div id="menuAdmin" class="menu absolute right-0 mt-2 bg-white border border-slate-200 rounded-xl shadow-2xl p-2 hidden">
                  <a href="/admin">Relatório</a>
                  <a href="/dashboard">Dashboard</a>
                  <a href="/importar">Importar / Backup</a>
                </div>
              </div>` : ''}
              ${isAdmin ? '' : '<a href="/login" class="nav-link text-sm">Entrar</a>'}
            </nav>
  
            <!-- Notifications (logo imediatamente à direita do menu) -->
            <a href="/admin" class="relative inline-flex items-center justify-center w-10 h-10 rounded-xl border border-slate-300 bg-white" title="Notificações">
              <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                <path stroke-width="2" d="M15 17h5l-1.4-1.4A2 2 0 0 1 18 14.2V11a6 6 0 1 0-12 0v3.2c0 .5-.2 1-.6 1.4L4 17h5m6 0v1a3 3 0 1 1-6 0v-1m6 0H9"/>
              </svg>
              <span id="notifBadge" class="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 rounded-full text-[10px] font-bold flex items-center justify-center bg-rose-600 text-white hidden">0</span>
            </a>
  
            <!-- Session badge + avatar -->
            <div class="flex items-center gap-2 px-2 py-1 rounded-lg border ${isAdmin ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-slate-200 bg-white text-slate-600'}">
              <span class="avatar ${isAdmin ? 'bg-emerald-600 text-white' : 'bg-slate-200 text-slate-700'}" id="userAvatar" data-name="${isAdmin ? 'Admin' : 'Convidado'}"></span>
              <span class="text-xs">${isAdmin ? 'Admin' : 'Convidado'}</span>
            </div>
  
            ${isAdmin ? '<a class="nav-link text-sm" href="/logout">Sair</a>' : ''}
          </div>
  
          <!-- Mobile trigger -->
          <button id="navToggle" class="md:hidden inline-flex items-center justify-center w-10 h-10 rounded-xl border border-slate-300 bg-white"
                  aria-label="Abrir menu" aria-haspopup="true" aria-expanded="false">
            <!-- hamburger -->
            <svg id="iconOpen" xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor">
              <path stroke-width="2" stroke-linecap="round" d="M4 7h16M4 12h16M4 17h16"/>
            </svg>
            <!-- close -->
            <svg id="iconClose" xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 hidden" viewBox="0 0 24 24" fill="none" stroke="currentColor">
              <path stroke-width="2" stroke-linecap="round" d="M6 6l12 12M18 6l-12 12"/>
            </svg>
          </button>
        </div>
  
        <!-- Mobile drawer -->
        <div id="navBackdrop" class="backdrop fixed inset-0 bg-black/40 opacity-0 hidden z-40"></div>
        <div id="navDrawer" class="drawer md:hidden absolute left-0 right-0 px-4 pb-4 z-50 hidden">
          <div class="bg-white border border-slate-200 rounded-2xl shadow-2xl">
            <nav class="p-2">
              <a href="/" class="block px-3 py-2 rounded-lg text-sm hover:bg-slate-100">Inquérito</a>
              ${isAdmin ? `
              <div class="px-3 py-1 text-xs uppercase tracking-wide text-slate-400">Administração</div>
              <a href="/admin" class="block px-3 py-2 rounded-lg text-sm hover:bg-slate-100">Relatório</a>
              <a href="/dashboard" class="block px-3 py-2 rounded-lg text-sm hover:bg-slate-100">Dashboard</a>
              <a href="/importar" class="block px-3 py-2 rounded-lg text-sm hover:bg-slate-100">Importar / Backup</a>
              <a href="/logout" class="block px-3 py-2 rounded-lg text-sm hover:bg-slate-100">Sair</a>
              ` : '<a href="/login" class="block px-3 py-2 rounded-lg text-sm hover:bg-slate-100">Entrar</a>'}
            </nav>
          </div>
        </div>
  
        <!-- BREADCRUMB -->
        <div class="px-1 py-2 text-sm text-slate-500">
          <nav class="flex items-center gap-1">
            <a href="/" class="hover:underline">Início</a>
            <span>›</span>
            <span class="text-slate-700">${title}</span>
          </nav>
        </div>
      </header>
  
      <!-- MAIN -->
      <main class="card mt-4">
        <h1 class="text-2xl sm:text-3xl font-bold mb-4 text-left">${title}</h1>
        ${content}
      </main>
  
      <footer class="mt-8 text-xs text-slate-500 text-center">ISPT · ${new Date().getFullYear()}</footer>
    </div>
  
    <!-- Consentimento / Anonimato Modal -->
    <div id="consentOverlay" class="fixed inset-0 bg-black/40 hidden items-center justify-center p-4 z-50">
      <div class="w-full max-w-2xl bg-white rounded-2xl shadow-2xl border border-slate-200">
        <div class="p-5 border-b border-slate-100">
          <h2 class="text-lg font-semibold text-slate-900">Aviso de Anonimato e Consentimento</h2>
        </div>
        <div class="p-5 space-y-3 text-slate-700 text-sm leading-relaxed">
          <p><b>Este inquérito é anónimo</b> e destina-se exclusivamente à melhoria pedagógica.</p>
          <p>Não recolhemos qualquer identificação pessoal. As respostas são <b>agregadas</b> e os resultados apenas são apresentados quando existem <b>pelo menos ${ANON} respostas (n≥${ANON})</b> para proteger o anonimato.</p>
          <p>O comentário é opcional. Evite incluir nomes ou elementos que identifiquem pessoas.</p>
          <p>Ao prosseguir, declara que compreende e consente a recolha e tratamento dos dados nos termos aqui descritos.</p>
        </div>
        <div class="px-5 pb-5 pt-3 flex flex-wrap gap-2 justify-end">
          <button id="consentDecline" class="btn btn-ghost">Cancelar</button>
          <button id="consentAccept" class="btn btn-primary">Aceito e quero continuar</button>
        </div>
      </div>
    </div>
  
    <!-- Nav / UI + Consent + Notificações -->
    <script>
      (function(){
        const header = document.getElementById('siteHeader');
  
        // sombra ao rolar
        const onScroll = () => {
          if (window.scrollY > 4) header.classList.add('header-shadow');
          else header.classList.remove('header-shadow');
        };
        onScroll();
        window.addEventListener('scroll', onScroll, { passive: true });
  
        // Desktop dropdown
        const btnAdmin = document.getElementById('btnAdmin');
        const menuAdmin = document.getElementById('menuAdmin');
        if (btnAdmin && menuAdmin) {
          const open = (v) => {
            btnAdmin.setAttribute('aria-expanded', v ? 'true' : 'false');
            menuAdmin.classList.toggle('hidden', !v);
          };
          let inside = false;
  
          btnAdmin.addEventListener('click', (e)=> {
            e.stopPropagation();
            open(menuAdmin.classList.contains('hidden'));
          });
          btnAdmin.addEventListener('mouseenter', ()=> { open(true); inside = true; });
          btnAdmin.addEventListener('mouseleave', ()=> { inside = false; setTimeout(()=> { if(!inside) open(false); }, 120); });
          menuAdmin.addEventListener('mouseenter', ()=> { inside = true; open(true); });
          menuAdmin.addEventListener('mouseleave', ()=> { inside = false; setTimeout(()=> { if(!inside) open(false); }, 120); });
          document.addEventListener('click', (e)=> {
            if (!menuAdmin.contains(e.target) && e.target !== btnAdmin) open(false);
          });
          document.addEventListener('keydown', (e)=> { if(e.key === 'Escape') open(false); });
        }
  
        // Mobile drawer
        const toggle = document.getElementById('navToggle');
        const drawer = document.getElementById('navDrawer');
        const backdrop = document.getElementById('navBackdrop');
        const iconOpen = document.getElementById('iconOpen');
        const iconClose = document.getElementById('iconClose');
  
        function setOpen(isOpen){
          toggle?.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
          drawer?.classList.toggle('hidden', !isOpen);
          backdrop?.classList.toggle('hidden', !isOpen);
          drawer?.classList.toggle('open', isOpen);
          backdrop?.classList.toggle('open', isOpen);
          iconOpen?.classList.toggle('hidden', isOpen);
          iconClose?.classList.toggle('hidden', !isOpen);
          if(isOpen){
            const link = drawer.querySelector('a');
            setTimeout(()=> link && link.focus(), 10);
          }
        }
  
        toggle?.addEventListener('click', ()=> setOpen(toggle.getAttribute('aria-expanded') !== 'true'));
        backdrop?.addEventListener('click', ()=> setOpen(false));
        document.addEventListener('keydown', (e)=> { if(e.key === 'Escape') setOpen(false); });
  
        // Active link
        const path = location.pathname.replace(/\\/$/, '');
        document.querySelectorAll('nav a').forEach(a => {
          const href = a.getAttribute('href')?.replace(/\\/$/, '') || '';
          if (href && href === path) a.classList.add('active');
        });
  
        // Avatar iniciais
        const $avatar = document.getElementById('userAvatar');
        if ($avatar) {
          const name = ($avatar.dataset.name || '').trim();
          const initials = name ? name.split(/\\s+/).map(p=>p[0]).slice(0,2).join('').toUpperCase() : 'CV';
          $avatar.textContent = initials;
        }
  
        // Notificações – fetch automático
        const $badge = document.getElementById('notifBadge');
        function setNotificationCount(n){
          const num = Number(n) || 0;
          if (!$badge) return;
          if (num <= 0) { $badge.classList.add('hidden'); $badge.textContent = '0'; }
          else { $badge.classList.remove('hidden'); $badge.textContent = String(num); }
        }
        async function pollNotif(){
          try{
            const r = await fetch('/api/notifications', { cache:'no-store' });
            if(!r.ok) throw 0;
            const j = await r.json();
            setNotificationCount(j.count || 0);
          }catch(_){}
        }
        setNotificationCount(0);
        pollNotif();
        setInterval(pollNotif, 30000); // a cada 30s
  
        // ===== Consentimento / Anonimato =====
        const PATH = location.pathname;
        const isSurveyArea = PATH === '/' || PATH === '/inquerito'; // mostra apenas no inquérito
        const getCookie = (k) => document.cookie.split('; ').find(x=>x.startsWith(k+'='))?.split('=')[1];
        const setCookieDays = (k,v,days=180) => {
          const d = new Date(); d.setTime(d.getTime() + (days*24*60*60*1000));
          document.cookie = k + '=' + v + '; expires=' + d.toUTCString() + '; path=/; SameSite=Lax';
        };
  
        const overlay = document.getElementById('consentOverlay');
        const btnAccept = document.getElementById('consentAccept');
        const btnDecline = document.getElementById('consentDecline');
  
        function openModal(){
          overlay?.classList.remove('hidden');
          overlay?.classList.add('flex');
          document.documentElement.classList.add('modal-open');
        }
        function closeModal(){
          overlay?.classList.add('hidden');
          overlay?.classList.remove('flex');
          document.documentElement.classList.remove('modal-open');
        }
  
        // Mostrar modal se necessário
        if (isSurveyArea && getCookie('ispt_consent') !== '1') {
          openModal();
        }
  
        // Aceitar
        btnAccept?.addEventListener('click', () => {
          setCookieDays('ispt_consent', '1', 180);
          closeModal();
        });
  
        // Cancelar -> volta para home (se já estiver na home, só fecha)
        btnDecline?.addEventListener('click', () => {
          if (PATH !== '/') location.href = '/';
          else closeModal();
        });
  
        // Bloquear submissão do formulário do inquérito sem consentimento
        document.addEventListener('submit', (e) => {
          const form = e.target;
          if (!form || !(form instanceof HTMLFormElement)) return;
          // só bloquear no formulário de inquérito (tem action /inquerito ou /submit)
          const action = (form.getAttribute('action')||'');
          const isSurveyForm = action.includes('/inquerito') || action.includes('/submit');
          if (isSurveyForm && getCookie('ispt_consent') !== '1') {
            e.preventDefault();
            openModal();
          }
        });
  
        // Se o utilizador tentar navegar para /inquerito de forma direta sem consentir
        if (PATH === '/inquerito' && getCookie('ispt_consent') !== '1') {
          openModal();
        }
      })();
    </script>
  </body>
  </html>`;
  }
  
  
  

function select(name, label, options, valueField = 'id', labelField = 'name') {
  const opts = options.map(o => `<option value="${o[valueField]}">${o[labelField]}</option>`).join('');
  return `
    <label class="block mb-2 font-medium">${label}</label>
    <select name="${name}" class="w-full border rounded-xl p-2 mb-2">
      <option value="">— Todos —</option>
      ${opts}
    </select>
  `;
}

function requireAuth(req, res, next) {
  const ok = req.cookies && req.cookies.ispt_admin === '1';
  if (ok) return next();
  return res.redirect('/login');
}

// ====== AUTENTICAÇÃO ======
app.get('/login', (req, res) => {
  const html = `
    <form method="POST" action="/login" class="space-y-4">
      <label class="block mb-2 font-medium">Palavra-passe de administrador</label>
      <input type="password" name="password" class="w-full border rounded-xl p-2" required />
      <button class="btn btn-primary">Entrar</button>
    </form>`;
  res.send(renderPage('Iniciar sessão', html, '', (req.cookies && req.cookies.ispt_admin==='1')));
});

app.post('/login', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) {
    res.cookie('ispt_admin', '1', { httpOnly: true, sameSite: 'lax' });
    return res.redirect('/admin');
  }
  const html = `<p class="mb-4 text-red-600">Palavra-passe inválida.</p>
  <a href="/login" class="underline">Tentar novamente</a>`;
  res.send(renderPage('Erro de autenticação', html, '', (req.cookies && req.cookies.ispt_admin==='1')));
});

app.get('/logout', (req, res) => { res.clearCookie('ispt_admin'); res.redirect('/'); });

// ====== HOME / INQUÉRITO ======
app.get('/', (req, res) => {
  const courses = db.prepare('SELECT * FROM course ORDER BY name').all();
  const semesters = db.prepare('SELECT * FROM semester ORDER BY id').all();
  const years = db.prepare('SELECT * FROM school_year ORDER BY name DESC').all();

  const content = `
    <form method="GET" action="/inquerito" class="grid grid-cols-1 sm:grid-cols-2 gap-4">
      ${select('course_id', 'Curso', courses)}
      ${select('semester_id', 'Semestre/Período lectivo', semesters)}
      <div class="sm:col-span-2">${select('school_year_id', 'Ano lectivo', years)}</div>
      <div class="sm:col-span-2"><button class="btn btn-primary">Continuar</button></div>
    </form>
    <p class="text-sm text-slate-600 mt-4">Nota: se o mesmo docente leccionar várias disciplinas, preencha um inquérito por disciplina.</p>`;
  res.send(renderPage('ISPT – Inquérito a Estudantes', content, '', (req.cookies && req.cookies.ispt_admin==='1')));
});

app.get('/inquerito', (req, res) => {
  const { course_id, semester_id, school_year_id } = req.query;
  if (!course_id || !semester_id || !school_year_id) return res.redirect('/');

  const teachRows = db.prepare(`
    SELECT DISTINCT d.id as discipline_id, d.name as discipline_name
    FROM teaching t
    JOIN discipline d ON d.id = t.discipline_id
    WHERE d.course_id = ? AND t.semester_id = ? AND t.school_year_id = ?
    ORDER BY d.name
  `).all(course_id, semester_id, school_year_id);

  const teachMapRows = db.prepare(`
    SELECT d.id as discipline_id, te.id as teacher_id, te.name as teacher_name
    FROM teaching t
    JOIN discipline d ON d.id = t.discipline_id
    JOIN teacher te ON te.id = t.teacher_id
    WHERE d.course_id = ? AND t.semester_id = ? AND t.school_year_id = ?
    ORDER BY d.name, te.name
  `).all(course_id, semester_id, school_year_id);

  const teacherMap = {};
  teachMapRows.forEach(r => {
    teacherMap[r.discipline_id] = teacherMap[r.discipline_id] || [];
    teacherMap[r.discipline_id].push({ id: r.teacher_id, name: r.teacher_name });
  });

  const questions = db.prepare('SELECT * FROM survey_question ORDER BY id').all();

  const disciplines = teachRows.map(r => ({ id: r.discipline_id, name: r.discipline_name }));
  const discSel = select('discipline_id', 'Disciplina', disciplines);

  const teachSel = `
    <label class="block mb-2 font-medium">Docente</label>
    <select id="teacher_id" name="teacher_id" required class="w-full border rounded-xl p-2 mb-4" disabled>
      <option value="" disabled selected>— seleccione —</option>
    </select>
    <script>
      const TEACHER_MAP = ${JSON.stringify(teacherMap)};
      document.addEventListener('DOMContentLoaded', () => {
        const disc = document.querySelector('select[name="discipline_id"]');
        const teacher = document.getElementById('teacher_id');
        function fillTeachers(list){
          teacher.innerHTML = '<option value="" disabled selected>— seleccione —</option>';
          (list||[]).forEach(t => { const opt=document.createElement('option'); opt.value=t.id; opt.textContent=t.name; teacher.appendChild(opt); });
          teacher.disabled = !(list && list.length);
          teacher.classList.toggle('opacity-50', teacher.disabled);
        }
        disc.addEventListener('change', e => fillTeachers(TEACHER_MAP[e.target.value]||[]));
      });
    </script>`;

  const turmaA = db.prepare("SELECT id, name FROM class_group WHERE name = 'Turma A'").get();
  const turmaB = db.prepare("SELECT id, name FROM class_group WHERE name = 'Turma B'").get();
  const posUnica = db.prepare("SELECT id, name FROM class_group WHERE name = 'Única Pós-laboral'").get();

  const turnoSel = `
    <label class="block mb-2 font-medium">Turno</label>
    <select id="turno" name="turno" required class="w-full border rounded-xl p-2 mb-4">
      <option value="" disabled selected>— seleccione —</option>
      <option value="diurno">Diurno</option>
      <option value="pos">Pós-laboral</option>
    </select>`;

  const turmaSel = `
    <label class="block mb-2 font-medium">Turma</label>
    <select id="class_group_id" name="class_group_id" required class="w-full border rounded-xl p-2 mb-4 opacity-50" disabled>
      <option value="" disabled selected>— seleccione —</option>
    </select>
    <script>
      const TURMA_A=${turmaA?turmaA.id:'null'}; const TURMA_B=${turmaB?turmaB.id:'null'}; const POS_UNICA=${posUnica?posUnica.id:'null'};
      const TURMA_A_NAME=${JSON.stringify(turmaA?turmaA.name:'Turma A')};
      const TURMA_B_NAME=${JSON.stringify(turmaB?turmaB.name:'Turma B')};
      const POS_UNICA_NAME=${JSON.stringify(posUnica?posUnica.name:'Única Pós-laboral')};
      document.addEventListener('DOMContentLoaded',()=>{
        const turno=document.getElementById('turno'); const turma=document.getElementById('class_group_id');
        function fill(opts){ turma.innerHTML='<option value="" disabled selected>— seleccione —</option>'; (opts||[]).forEach(o=>{ if(!o||!o.id) return; const op=document.createElement('option'); op.value=o.id; op.textContent=o.name; turma.appendChild(op);});
          const dis=(opts||[]).length===0; turma.disabled=dis; turma.classList.toggle('opacity-50',dis); turma.classList.toggle('cursor-not-allowed',dis); }
        const diurno=[TURMA_A?{id:TURMA_A,name:TURMA_A_NAME}:null, TURMA_B?{id:TURMA_B,name:TURMA_B_NAME}:null].filter(Boolean);
        const pos=[POS_UNICA?{id:POS_UNICA,name:POS_UNICA_NAME}:null].filter(Boolean);
        turno.addEventListener('change',e=>{ if(e.target.value==='diurno') fill(diurno); else if(e.target.value==='pos') fill(pos); else fill([]); });
      });
    </script>`;

  const qHtml = questions.map(q => `
    <div class="mb-4">
      <label class="block mb-1 font-medium">${q.code}. ${q.text} <span class="text-xs text-slate-500">(0 = Nunca / 1 = Às vezes / 2 = Sempre)</span></label>
      <div class="flex gap-2">
        ${[0,1,2].map(v => `<label class=\"inline-flex items-center gap-2 border rounded-xl px-3 py-2\"><input type=\"radio\" name=\"q_${q.id}\" value=\"${v}\" required /> ${v}</label>`).join('')}
      </div>
    </div>`).join('');

  const content = `
    <form method="POST" action="/submit" class="space-y-4">
      <input type="hidden" name="course_id" value="${course_id}" />
      <input type="hidden" name="semester_id" value="${semester_id}" />
      <input type="hidden" name="school_year_id" value="${school_year_id}" />
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">${discSel}${teachSel}${turnoSel}${turmaSel}</div>
      <hr class="my-4" />
      <h2 class="text-xl font-semibold mb-2">Questões</h2>
      ${qHtml}
      <label class="block mb-2 font-medium">Comentários (opcional)</label>
      <textarea name="comment" class="w-full border rounded-xl p-2" rows="4" placeholder="Sugestões, críticas construtivas, elogios..."></textarea>
      <button class="btn btn-primary">Submeter</button>
    </form>`;

  res.send(renderPage('Responder Inquérito', content, '', (req.cookies && req.cookies.ispt_admin==='1')));
});

// ====== SUBMISSÃO ======
app.post('/submit', (req, res) => {
  let { course_id, semester_id, school_year_id, discipline_id, teacher_id, class_group_id, comment, ...answers } = req.body;
  if (!course_id || !semester_id || !discipline_id || !teacher_id) {
    return res.status(400).send('Dados em falta.');
  }
  class_group_id = class_group_id || null;

  let teaching = db.prepare(`
    SELECT * FROM teaching
    WHERE teacher_id=? AND discipline_id=? AND semester_id=?
      AND (school_year_id IS ? OR school_year_id = ?)
      AND (class_group_id IS ? OR class_group_id = ?)
  `).get(teacher_id, discipline_id, semester_id, school_year_id || null, school_year_id || null, class_group_id || null, class_group_id || null);

  if (!teaching) {
    const info = db.prepare('INSERT INTO teaching (teacher_id, discipline_id, semester_id, school_year_id, class_group_id) VALUES (?,?,?,?,?)')
                   .run(teacher_id, discipline_id, semester_id, school_year_id || null, class_group_id || null);
    teaching = { id: info.lastInsertRowid };
  }

  const respInfo = db.prepare('INSERT INTO survey_response (teaching_id, submitted_at, comment) VALUES (?,?,?)')
                    .run(teaching.id, dayjs().toISOString(), comment || null);
  const responseId = respInfo.lastInsertRowid;

  const insAns = db.prepare('INSERT INTO survey_answer (response_id, question_id, value) VALUES (?,?,?)');
  const qs = db.prepare('SELECT id FROM survey_question').all();
  qs.forEach(q => {
    const key = `q_${q.id}`; const val = Number(answers[key]);
    if (![0,1,2].includes(val)) return; insAns.run(responseId, q.id, val);
  });

  const ok = `
    <div class="text-center space-y-2">
      <h2 class="text-xl font-semibold">Obrigado pela sua resposta!</h2>
      <p class="text-slate-600">A sua participação é anónima e ajuda a melhorar a qualidade pedagógica.</p>
      <a href="/" class="btn btn-primary">Novo inquérito</a>
    </div>`;
  res.send(renderPage('Submissão concluída', ok, '', (req.cookies && req.cookies.ispt_admin==='1')));
});

// ====== API: ESTATÍSTICAS ======
app.get('/api/stats', requireAuth, (req, res) => {
  const { course_id, semester_id, discipline_id, teacher_id, school_year_id, class_group_id } = req.query;
  const rows = db.prepare(`
    SELECT qa.question_id, AVG(qa.value) as avg_val
    FROM survey_answer qa
    JOIN survey_response r ON r.id = qa.response_id
    JOIN teaching t ON t.id = r.teaching_id
    JOIN discipline d ON d.id = t.discipline_id
    WHERE (COALESCE(?, d.course_id) = d.course_id)
      AND (COALESCE(?, t.semester_id) = t.semester_id)
      AND (COALESCE(?, t.discipline_id) = t.discipline_id)
      AND (COALESCE(?, t.teacher_id) = t.teacher_id)
      AND (COALESCE(?, t.school_year_id) = t.school_year_id)
      AND (COALESCE(?, t.class_group_id) = t.class_group_id)
    GROUP BY qa.question_id
    ORDER BY qa.question_id
  `).all(course_id || null, semester_id || null, discipline_id || null, teacher_id || null, school_year_id || null, class_group_id || null);

  const questions = db.prepare('SELECT id, code, text, area FROM survey_question ORDER BY id').all();
  const comments = db.prepare(`
    SELECT r.comment, r.submitted_at
    FROM survey_response r
    JOIN teaching t ON t.id = r.teaching_id
    JOIN discipline d ON d.id = t.discipline_id
    WHERE r.comment IS NOT NULL AND r.comment <> ''
      AND (COALESCE(?, d.course_id) = d.course_id)
      AND (COALESCE(?, t.semester_id) = t.semester_id)
      AND (COALESCE(?, t.discipline_id) = t.discipline_id)
      AND (COALESCE(?, t.teacher_id) = t.teacher_id)
      AND (COALESCE(?, t.school_year_id) = t.school_year_id)
      AND (COALESCE(?, t.class_group_id) = t.class_group_id)
    ORDER BY r.submitted_at DESC
  `).all(course_id || null, semester_id || null, discipline_id || null, teacher_id || null, school_year_id || null, class_group_id || null);

  res.json({ rows, questions, comments });
});

// ===== API: Disciplinas por Curso =====
app.get('/api/disciplinas', requireAuth, (req, res) => {
    const { course_id } = req.query;
    if (!course_id) return res.json({ items: [] });
    const items = db.prepare(
      'SELECT id, name FROM discipline WHERE course_id = ? ORDER BY name'
    ).all(course_id);
    res.json({ items });
  });
  
  // ===== API: Docentes por Disciplina (a partir de teaching) =====
  app.get('/api/docentes', requireAuth, (req, res) => {
    const { discipline_id } = req.query;
    if (!discipline_id) return res.json({ items: [] });
    const items = db.prepare(`
      SELECT DISTINCT te.id, te.name
      FROM teaching t
      JOIN teacher te ON te.id = t.teacher_id
      WHERE t.discipline_id = ?
      ORDER BY te.name
    `).all(discipline_id);
    res.json({ items });
  });

  // ====== RELATÓRIO (UI) – Curso -> Disciplina -> Docente (via APIs) ======

  // ====== RELATÓRIO (UI) – Curso -> Disciplina -> Docente (via APIs) ======
app.get('/admin', requireAuth, (req, res) => {
    const courses   = db.prepare('SELECT id, name FROM course ORDER BY name').all();
    const semesters = db.prepare('SELECT id, name FROM semester ORDER BY id').all();
    const years     = db.prepare('SELECT id, name FROM school_year ORDER BY name DESC').all();
    const classes   = db.prepare('SELECT id, name FROM class_group ORDER BY name').all();
  
    // Helper local p/ selects simples
    const sel = (name, label, options) => {
      const opts = options.map(o => `<option value="${o.id}">${o.name}</option>`).join('');
      return `
        <label class="block mb-2 font-medium">${label}</label>
        <select name="${name}" class="w-full border rounded-xl p-2">
          <option value="">— Todos —</option>
          ${opts}
        </select>
      `;
    };
  
    // Disciplina & Docente começam vazios (serão preenchidos via fetch)
    const discSelect = `
      <label class="block mb-2 font-medium">Disciplina</label>
      <select name="discipline_id" class="w-full border rounded-xl p-2 opacity-50 cursor-not-allowed" disabled>
        <option value="">— seleccione —</option>
      </select>
    `;
    const teachSelect = `
      <label class="block mb-2 font-medium">Docente</label>
      <select name="teacher_id" class="w-full border rounded-xl p-2 opacity-50 cursor-not-allowed" disabled>
        <option value="">— seleccione —</option>
      </select>
    `;
  
    const filters = `
      <form id="filtros" class="grid grid-cols-1 md:grid-cols-6 gap-3 mb-4">
        ${sel('course_id','Curso',courses)}
        ${sel('semester_id','Semestre/Período',semesters)}
        ${discSelect}
        ${teachSelect}
        ${sel('school_year_id','Ano lectivo',years)}
        ${sel('class_group_id','Turma',classes)}
        <div class="md:col-span-6 flex gap-2 flex-wrap">
          <button type="button" id="aplicar" class="btn btn-primary">Aplicar</button>
          <a class="btn btn-ghost" href="/admin">Limpar</a>
          <a class="btn btn-primary" id="exportExcel" href="#">Exportar Excel</a>
          <a class="btn btn-primary" id="exportPDF" href="#">Exportar PDF</a>
        </div>
      </form>`;
  
    const content = `
      ${filters}
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div>
          <h2 class="text-lg font-semibold mb-2 text-left">Médias por questão</h2>
          <div style="height:220px"><canvas id="chartPerguntas"></canvas></div>
        </div>
        <div>
          <h2 class="text-lg font-semibold mb-2 text-left">Médias por área</h2>
          <div style="height:220px"><canvas id="chartAreas"></canvas></div>
        </div>
      </div>
  
      <div class="mt-6">
        <h2 class="text-lg font-semibold mb-2 text-left">Comentários (qualitativo)</h2>
        <div class="flex items-center gap-2 mb-2">
          <button id="btnKW" class="btn btn-ghost">Palavras-chave</button>
          <button id="btnFull" class="btn btn-ghost">Comentários completos</button>
        </div>
        <div id="kwWrap" class="hidden"></div>
        <ul id="comments" class="space-y-2"></ul>
        <div id="pager" class="mt-2 flex items-center gap-2"></div>
        <p class="text-xs text-slate-500 mt-3">
          Comentários são opcionais e exibidos sem qualquer dado identificativo.
          Conteúdos com dados pessoais, ofensas graves ou acusações específicas podem ser moderados/anonimizados/removidos pela equipa administradora.
          Como os dados são anónimos, não é possível identificar e eliminar respostas individuais; no entanto,
          comentários podem ser removidos se contiverem dados pessoais ou conteúdo impróprio, mediante pedido fundamentado.
        </p>
      </div>
  
      <script>
        // ===== Encadeamento: Curso -> Disciplina -> Docente =====
        (function cascadeFilters(){
          const form = document.getElementById('filtros');
          const selCourse = form.querySelector('select[name="course_id"]');
          const selDisc   = form.querySelector('select[name="discipline_id"]');
          const selTeach  = form.querySelector('select[name="teacher_id"]');
  
          const setDisabled = (el, dis) => {
            el.disabled = dis;
            el.classList.toggle('opacity-50', dis);
            el.classList.toggle('cursor-not-allowed', dis);
          };
          const resetToSelect = (el) => { el.innerHTML = '<option value="">— seleccione —</option>'; };
  
          async function loadDisciplinas(courseId){
            resetToSelect(selDisc); setDisabled(selDisc, true);
            resetToSelect(selTeach); setDisabled(selTeach, true);
            if(!courseId) return;
            const r = await fetch('/api/disciplinas?course_id=' + encodeURIComponent(courseId));
            const data = await r.json();
            const items = data.items || [];
            if (!items.length) return;
            selDisc.innerHTML = '<option value="">— Todos —</option>' + items.map(i => '<option value="'+i.id+'">'+i.name+'</option>').join('');
            setDisabled(selDisc, false);
            if (items.length === 1) selDisc.value = String(items[0].id);
          }
  
          async function loadDocentes(discId){
            resetToSelect(selTeach); setDisabled(selTeach, true);
            if(!discId) return;
            const r = await fetch('/api/docentes?discipline_id=' + encodeURIComponent(discId));
            const data = await r.json();
            const items = (data.items || []);
            if (!items.length) return;
            selTeach.innerHTML = '<option value="">— Todos —</option>' + items.map(i => '<option value="'+i.id+'">'+i.name+'</option>').join('');
            setDisabled(selTeach, false);
            if (items.length === 1) selTeach.value = String(items[0].id);
          }
  
          selCourse.addEventListener('change', e => {
            const cid = e.target.value;
            loadDisciplinas(cid);
            resetToSelect(selTeach); setDisabled(selTeach, true);
          });
          selDisc.addEventListener('change', e => loadDocentes(e.target.value));
  
          if (selCourse.value) loadDisciplinas(selCourse.value).then(()=> {
            if (selDisc.value) loadDocentes(selDisc.value);
          });
        })();
  
        // ===== Utils & estado =====
        const round2 = x => Math.round(Number(x || 0) * 100) / 100;
        function params(){
          const fd=new FormData(document.getElementById('filtros'));
          const p=new URLSearchParams();
          for(const [k,v] of fd.entries()){ if(v) p.append(k,v); }
          return p.toString();
        }
        let chartPerguntas, chartAreas;
  
        function renderNoData(ctx, msg='Sem dados para os filtros seleccionados.'){
          const c = ctx.canvas; const g = c.getContext('2d'); g.clearRect(0,0,c.width,c.height);
          g.font = '12px sans-serif'; g.fillStyle = '#64748b'; g.textAlign = 'center'; g.fillText(msg, c.width/2, c.height/2);
        }
  
        // ===== Comentários: palavras-chave e paginação =====
        let modeKW = true;
        let page = 1;
        const PAGE_SIZE = 20;
        const STOP = new Set(['a','o','os','as','de','da','do','das','dos','e','é','em','no','na','nos','nas','um','uma','que','com','por','para','ao','à','às','aos','se','sem','são','ser','foi','era','eram','já','sua','seu','suas','seus','mais','menos','muito','muita','muitos','muitas','também','como']);
  
        function extractKeywords(comments, topK=30){
          const freq = new Map();
          (comments||[]).forEach(c=>{
            const txt = String(c.comment||'').toLowerCase()
              .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}/ig,' ')
              .replace(/https?:\\/\\/\\S+/g,' ')
              .replace(/[@#]\\w+/g,' ')
              .replace(/[^\\p{L}\\p{N}\\s]/gu,' ');
            txt.split(/\\s+/).forEach(w=>{
              if(!w || w.length<3) return;
              if(STOP.has(w)) return;
              freq.set(w, (freq.get(w)||0)+1);
            });
          });
          return [...freq.entries()].sort((a,b)=> b[1]-a[1]).slice(0, topK).map(([term,count])=>({term,count}));
        }
  
        async function renderKeywordsFrom(data){
          const wrap = document.getElementById('kwWrap');
          const ul = document.getElementById('comments');
          const pager = document.getElementById('pager');
          ul.innerHTML = ''; pager.innerHTML = ''; wrap.classList.remove('hidden');
          const kws = extractKeywords(data.comments, 40);
          if (!kws.length){
            wrap.innerHTML = '<div class="text-slate-500 text-sm">Sem palavras-chave.</div>';
            return;
          }
          wrap.innerHTML = '<div class="flex flex-wrap gap-2">' + kws.map(k =>
            '<span class="inline-flex items-center gap-1 px-2.5 py-1 rounded-full border bg-white"><span class="text-sm">'+k.term+'</span><span class="text-[10px] px-1 rounded bg-slate-900 text-white">'+k.count+'</span></span>'
          ).join('') + '</div>';
        }
  
        function renderCommentsList(data){
          const wrap = document.getElementById('kwWrap');
          const ul = document.getElementById('comments');
          const pager = document.getElementById('pager');
          wrap.classList.add('hidden'); ul.innerHTML=''; pager.innerHTML='';
          const items = data.comments || [];
          if (!items.length){
            ul.innerHTML = '<li class="text-slate-500">Sem comentários.</li>';
            return;
          }
          const total = items.length;
          const maxPage = Math.max(1, Math.ceil(total / PAGE_SIZE));
          page = Math.min(page, maxPage);
          const slice = items.slice((page-1)*PAGE_SIZE, page*PAGE_SIZE);
          slice.forEach(c => {
            const li = document.createElement('li');
            li.className = 'p-3 rounded-xl border';
            const d = new Date(c.submitted_at).toLocaleString();
            li.innerHTML = '<div class="text-sm text-slate-500">'+d+'</div><div>'+(c.comment||'')+'</div>';
            ul.appendChild(li);
          });
          if (maxPage > 1){
            pager.innerHTML = '<span class="text-sm">Página '+page+' / '+maxPage+'</span>';
          }
        }
  
        // ===== Carregar estatísticas =====
        async function load(){
          const res = await fetch('/api/stats?' + params());
          const data = await res.json();
          if (data.insufficient){
            const ctx1 = document.getElementById('chartPerguntas').getContext('2d');
            const ctx2 = document.getElementById('chartAreas').getContext('2d');
            const msg = 'Amostra insuficiente (n='+data.n+' < '+data.threshold+').';
            renderNoData(ctx1, msg); renderNoData(ctx2, msg);
            document.getElementById('comments').innerHTML = '<li class="text-slate-500">'+msg+'</li>';
            return;
          }
          const map = new Map((data.rows||[]).map(r=>[r.question_id, Number(r.avg_val)]));
          const labels = (data.questions||[]).map(q=>q.code);
          const values = (data.questions||[]).map(q=>{const v=map.get(q.id);return Number.isFinite(v)?round2(v):null;});
          const ctx1 = document.getElementById('chartPerguntas').getContext('2d');
          if(chartPerguntas) chartPerguntas.destroy();
          if(values.every(v => v===null)) renderNoData(ctx1);
          else chartPerguntas = new Chart(ctx1,{type:'bar',data:{labels,datasets:[{label:'Média (0–2)',data:values.map(v=>v??0)}]},options:{responsive:true,maintainAspectRatio:false}});
          const areaAgg={}; (data.questions||[]).forEach((q,i)=>{const v=values[i];if(v==null)return;(areaAgg[q.area]||={sum:0,n:0}).sum+=v;(areaAgg[q.area].n++);});
          const areaLabels=Object.keys(areaAgg), areaVals=areaLabels.map(a=>round2(areaAgg[a].sum/areaAgg[a].n));
          const ctx2=document.getElementById('chartAreas').getContext('2d');
          if(chartAreas) chartAreas.destroy();
          if(!areaVals.length) renderNoData(ctx2); else chartAreas=new Chart(ctx2,{type:'radar',data:{labels:areaLabels,datasets:[{label:'Média por Área (0–2)',data:areaVals}]}});
          const totalC=(data.comments||[]).length;
          modeKW=totalC>20;
          if(modeKW) renderKeywordsFrom(data); else renderCommentsList(data);
        }
        document.getElementById('aplicar').addEventListener('click', load);
        load();
        document.getElementById('exportExcel').addEventListener('click',e=>{e.preventDefault();window.location='/export/excel?'+params();});
        document.getElementById('exportPDF').addEventListener('click',e=>{e.preventDefault();window.location='/export/pdf?'+params();});
      </script>`;
  
    res.send(renderPage('Relatório', content, '', (req.cookies && req.cookies.ispt_admin==='1')));
  });
  

// === Helpers de Backup (coloque acima das rotas) ===
const path = require('path');

const zlib = require('zlib');

function getBackupsDir() {
  const dir = path.join(process.cwd(), process.env.BACKUPS_DIR || 'backups');
  try { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); } catch {}
  return dir;
}
function listBackups() {
  const dir = getBackupsDir();
  try {
    return fs.readdirSync(dir)
      .filter(f => /^[\w.\-]+\.(sqlite|sqlite\.gz)$/.test(f))
      .map(f => ({ name: f, full: path.join(dir, f), mtime: fs.statSync(path.join(dir, f)).mtime }))
      .sort((a,b) => b.mtime - a.mtime);
  } catch { return []; }
}
function pruneBackups(maxKeep = Number(process.env.BACKUPS_MAX || 10)) {
  const files = listBackups().filter(f => f.name.endsWith('.sqlite'));
  if (files.length <= maxKeep) return 0;
  const toDelete = files.slice(maxKeep);
  toDelete.forEach(f => {
    try {
      const gz = f.full + '.gz';
      if (fs.existsSync(gz)) fs.unlinkSync(gz);
      fs.unlinkSync(f.full);
    } catch {}
  });
  return toDelete.length;
}

// ====== IMPORTAÇÃO / BACKUP / RESTAURO (UI) ======
app.get('/importar', requireAuth, (req, res) => {
  const backups = listBackups();
  const listHtml = backups.length
    ? `<ul class="text-sm space-y-1">${backups.map(b => `
        <li class="flex items-center justify-between border rounded-xl px-3 py-2">
          <span>${b.name} <span class="text-xs text-slate-500">(${new Date(b.mtime).toLocaleString()})</span></span>
          <a class="btn btn-primary" href="/backup/download?file=${encodeURIComponent(b.name)}">Descarregar</a>
        </li>`).join('')}</ul>`
    : `<p class="text-sm text-slate-600">Sem backups guardados ainda.</p>`;

  const html = `
  <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
    <!-- Importar Excel -->
    <div class="card">
      <h2 class="text-lg font-semibold mb-2 text-left">Importar Excel</h2>
      <form method="POST" action="/importar" enctype="multipart/form-data" class="space-y-3">
        <p class="text-sm"><b>Área restrita a administradores.</b><br/>Carregue um Excel com folhas: <b>cursos</b> (name), <b>docentes</b> (name), <b>disciplinas</b> (course, name) e <b>leccionacao</b> (course, discipline, teacher, year, semester, class_group).</p>
        <label class="inline-flex items-center gap-2 text-sm"><input type="checkbox" name="wipe_all" /><span>Substituir dados antigos</span></label>
        <input type="file" name="file" accept=".xlsx" required />
        <button class="btn btn-primary">Importar</button>
      </form>
    </div>

    <!-- Backup -->
    <div class="card">
      <h2 class="text-lg font-semibold mb-2 text-left">Backup da Base de Dados</h2>
      <form method="POST" action="/backup" class="space-y-3">
        <p class="text-sm text-slate-600">Cria um ficheiro <code>.sqlite</code> e <code>.sqlite.gz</code> em <code>${process.env.BACKUPS_DIR || 'backups'}</code>.</p>
        <button class="btn btn-primary">Criar backup agora</button>
      </form>
      <form method="POST" action="/backup/cleanup" class="mt-3 space-y-2">
  <label class="inline-flex items-center gap-2 text-sm">
    <input type="checkbox" name="wipe_all" />
    <span>Apagar todos os backups</span>
  </label>
  <button class="btn btn-ghost">Limpar backups antigos</button>
  <p class="text-xs text-slate-500">Sem o visto, mantém apenas os ${Number(process.env.BACKUPS_MAX || 10)} mais recentes.</p>
</form>

      <hr class="my-3"/>
      <h3 class="font-medium mb-2">Backups disponíveis</h3>
      ${listHtml}
    </div>

    <!-- Restauro -->
    <div class="card">
      <h2 class="text-lg font-semibold mb-2 text-left">Restaurar de um Backup</h2>
      <form method="POST" action="/restore" enctype="multipart/form-data" class="space-y-3">
        <p class="text-sm text-slate-600">Selecione um ficheiro <code>.sqlite</code> criado pelo sistema (ou descarregado daqui).</p>
        <input type="file" name="backup" accept=".sqlite" required />
        <label class="inline-flex items-center gap-2 text-sm"><input type="checkbox" name="wipe_all" checked /><span>Substituir dados atuais (recomendado)</span></label>
        <button class="btn btn-primary">Restaurar</button>
      </form>
      <p class="mt-2 text-xs text-slate-500">O restauro ocorre em transação, sem reiniciar o servidor.</p>
    </div>
  </div>`;

  res.send(renderPage('Importar / Backup / Restauro', html, '', (req.cookies && req.cookies.ispt_admin==='1')));
});

// ====== IMPORTAÇÃO: POST /importar ======
app.post('/importar', requireAuth, upload.single('file'), async (req, res) => {
    try {
      // só Admin pode importar (se tiver roles, troque para requireRole(['admin']))
      const role = req.cookies?.role || null;
      if (role !== 'admin' && req.cookies?.ispt_admin !== '1') {
        const html = `
          <div class="text-center space-y-2">
            <h2 class="text-xl font-semibold">Acesso negado (403)</h2>
            <p class="text-slate-600">O seu perfil não tem permissões para esta área.</p>
            <a href="/" class="btn btn-primary mt-2">Voltar ao início</a>
          </div>`;
        return res.status(403).send(renderPage('Acesso negado', html, '', role || (req.cookies?.ispt_admin==='1')));
      }
  
      if (!req.file) {
        return res.send(renderPage('Importar Excel', `<p class="text-red-600">Selecione um ficheiro .xlsx.</p><a class="underline" href="/importar">Voltar</a>`, '', role));
      }
  
      const wipeAll = req.body.wipe_all === 'on';
  
      // Ler Excel da memória
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(req.file.buffer);
  
      const getSheet = (name) => wb.worksheets.find(ws => (ws.name || '').toLowerCase() === name);
      const shCursos       = getSheet('cursos');
      const shDocentes     = getSheet('docentes');
      const shDisciplinas  = getSheet('disciplinas');
      const shLeccionacao  = getSheet('leccionacao');
  
      if (!shCursos || !shDocentes || !shDisciplinas || !shLeccionacao) {
        const msg = `Faltam folhas obrigatórias: cursos, docentes, disciplinas, leccionacao.`;
        return res.send(renderPage('Importar Excel', `<p class="text-red-600">${msg}</p><a class="underline" href="/importar">Voltar</a>`, '', role));
      }
  
      // Transação
      const trx = db.transaction(() => {
        if (wipeAll) {
          db.exec(`
            DELETE FROM survey_answer;
            DELETE FROM survey_response;
            DELETE FROM teaching;
            DELETE FROM discipline;
            DELETE FROM teacher;
            DELETE FROM course;
            -- tabelas auxiliares ficam como estão (semester, school_year, class_group, survey_question)
          `);
        }
  
        // Helpers
        const insCourse   = db.prepare('INSERT OR IGNORE INTO course (name) VALUES (?)');
        const insTeacher  = db.prepare('INSERT OR IGNORE INTO teacher (name) VALUES (?)');
        const getCourseId = db.prepare('SELECT id FROM course WHERE name=?');
        const getTeachId  = db.prepare('SELECT id FROM teacher WHERE name=?');
        const insDisc     = db.prepare('INSERT OR IGNORE INTO discipline (course_id, name) VALUES (?,?)');
        const getDisc     = db.prepare('SELECT id FROM discipline WHERE course_id=? AND name=?');
  
        // Cursos (coluna: name)
        shCursos.eachRow((row, idx) => {
          if (idx === 1) return; // header
          const name = String(row.getCell(1).value || '').trim();
          if (name) insCourse.run(name);
        });
  
        // Docentes (coluna: name)
        shDocentes.eachRow((row, idx) => {
          if (idx === 1) return;
          const name = String(row.getCell(1).value || '').trim();
          if (name) insTeacher.run(name);
        });
  
        // Disciplinas (colunas: course, name)
        shDisciplinas.eachRow((row, idx) => {
          if (idx === 1) return;
          const courseName = String(row.getCell(1).value || '').trim();
          const discName   = String(row.getCell(2).value || '').trim();
          if (!courseName || !discName) return;
          insCourse.run(courseName); // garante curso
          const course = getCourseId.get(courseName);
          if (course?.id) insDisc.run(course.id, discName);
        });
  
        // Leccionação (colunas: course, discipline, teacher, year, semester, class_group)
        const insTeach = db.prepare('INSERT OR IGNORE INTO teaching (teacher_id, discipline_id, semester_id, school_year_id, class_group_id) VALUES (?,?,?,?,?)');
  
        const getSemester = db.prepare('SELECT id FROM semester WHERE name=?');
        const getYear     = db.prepare('SELECT id FROM school_year WHERE name=?');
        const getClass    = db.prepare('SELECT id FROM class_group WHERE name=?');
  
        shLeccionacao.eachRow((row, idx) => {
          if (idx === 1) return;
          const courseName = String(row.getCell(1).value || '').trim();
          const discName   = String(row.getCell(2).value || '').trim();
          const teachName  = String(row.getCell(3).value || '').trim();
          const yearName   = String(row.getCell(4).value || '').trim();
          const semName    = String(row.getCell(5).value || '').trim();
          const className  = String(row.getCell(6).value || '').trim();
  
          if (!courseName || !discName || !teachName || !semName) return;
  
          // garantir curso/disciplinas/docentes
          insCourse.run(courseName);
          insTeacher.run(teachName);
          const course = getCourseId.get(courseName);
          if (!course?.id) return;
  
          insDisc.run(course.id, discName);
          const disc = getDisc.get(course.id, discName);
          const teach = getTeachId.get(teachName);
  
          const semester = getSemester.get(semName);
          const year     = yearName ? getYear.get(yearName) : null;
          const klass    = className ? getClass.get(className) : null;
  
          if (teach?.id && disc?.id && semester?.id) {
            insTeach.run(
              teach.id,
              disc.id,
              semester.id,
              year?.id || null,
              klass?.id || null
            );
          }
        });
      });
  
      trx(); // executa
  
      const ok = `
        <div class="space-y-2">
          <h2 class="text-xl font-semibold">Importação concluída</h2>
          <p class="text-slate-600">Os dados do Excel foram processados com sucesso.</p>
          <div class="flex gap-2">
            <a class="btn btn-primary" href="/importar">Voltar</a>
            <a class="btn btn-ghost" href="/admin">Ir ao Relatório</a>
          </div>
        </div>`;
      return res.send(renderPage('Importar Excel', ok, '', role || (req.cookies?.ispt_admin==='1')));
    } catch (e) {
      const errHtml = `
        <p class="text-red-600 mb-2">Falha na importação: ${e.message}</p>
        <a class="underline" href="/importar">Voltar</a>`;
      return res.send(renderPage('Erro na importação', errHtml, '', req.cookies?.role || (req.cookies?.ispt_admin==='1')));
    }
  });
  
// ====== BACKUP: cria .sqlite e .sqlite.gz com timestamp ======
app.post('/backup', requireAuth, async (req, res) => {
    try {
      const dir = getBackupsDir();
      const ts = new Date().toISOString().replace(/[-:T.Z]/g,'').slice(0,14); // YYYYMMDDHHmmss
      const sqlitePath = path.join(dir, `backup_${ts}.sqlite`);
      await db.backup(sqlitePath); // snapshot consistente
  
      // Comprimir para .gz
      const gzPath = sqlitePath + '.gz';
      await new Promise((resolve, reject) => {
        const inp = fs.createReadStream(sqlitePath);
        const out = fs.createWriteStream(gzPath);
        const gz = zlib.createGzip({ level: 9 });
        inp.on('error', reject); out.on('error', reject);
        out.on('finish', resolve);
        inp.pipe(gz).pipe(out);
      });
  
      // Retenção automática
      const removed = pruneBackups();
  
      const html = `
        <p class="mb-3">Backup criado com sucesso:</p>
        <ul class="text-sm mb-3">
          <li><code>${path.basename(sqlitePath)}</code></li>
          <li><code>${path.basename(gzPath)}</code></li>
        </ul>
        <div class="flex gap-2 mb-3">
          <a class="btn btn-primary" href="/backup/download?file=${encodeURIComponent(path.basename(sqlitePath))}">Descarregar .sqlite</a>
          <a class="btn btn-primary" href="/backup/download?file=${encodeURIComponent(path.basename(gzPath))}">Descarregar .sqlite.gz</a>
        </div>
        ${removed ? `<p class="text-xs text-slate-500">Limpeza automática: ${removed} backup(s) removido(s).</p>` : ''}
        <div class="mt-3"><a class="btn btn-ghost" href="/importar">Voltar</a></div>
      `;
      res.send(renderPage('Backup concluído', html, '', (req.cookies && req.cookies.ispt_admin==='1')));
    } catch (e) {
      res.send(renderPage('Erro no backup', `<p class="text-red-600">Falhou o backup: ${e.message}</p><a class="underline" href="/importar">Voltar</a>`, '', (req.cookies && req.cookies.ispt_admin==='1')));
    }
  });
  
  // ====== BACKUP CLEANUP: retenção ou apagar tudo + redirect ======
app.post('/backup/cleanup', requireAuth, (req, res) => {
    try {
      const wipeAll = req.body.wipe_all === 'on';
      let removed = 0;
  
      if (wipeAll) {
        // Apagar todos os backups (.sqlite e .sqlite.gz)
        listBackups().forEach(b => {
          try { fs.unlinkSync(b.full); removed++; } catch {}
          // se for .sqlite e houver par .gz “órfão” com nome diferente, listBackups já o traz também
        });
      } else {
        // Apenas retenção automática (mantém BACKUPS_MAX mais recentes)
        removed = pruneBackups();
      }
  
      // Após limpar, volta para /importar para a lista ser recarregada (e poder aparecer vazia)
      return res.redirect('/importar');
    } catch (e) {
      return res.send(renderPage(
        'Erro na limpeza',
        `<p class="text-red-600">Falhou a limpeza: ${e.message}</p><a class="underline" href="/importar">Voltar</a>`,
        '',
        (req.cookies && req.cookies.ispt_admin==='1')
      ));
    }
  });
  

  // ====== DOWNLOAD de backup (.sqlite ou .sqlite.gz) ======
  app.get('/backup/download', requireAuth, (req, res) => {
    const file = String(req.query.file || '');
    if (!/^[\w.\-]+$/.test(file)) return res.status(400).send('Nome de ficheiro inválido.');
    const full = path.join(getBackupsDir(), file);
    if (!fs.existsSync(full)) return res.status(404).send('Ficheiro não encontrado.');
    res.download(full, file);
  });
  

// ====== EXPORT: EXCEL ======
app.get('/export/excel', requireAuth, async (req, res) => {
  const { course_id, semester_id, discipline_id, teacher_id, school_year_id, class_group_id } = req.query;
  const qRows = db.prepare('SELECT id, code, text, area FROM survey_question ORDER BY id').all();
  const responses = db.prepare(`
    SELECT r.id as response_id, r.submitted_at, r.comment,
           t.teacher_id, t.discipline_id, t.semester_id, t.school_year_id, t.class_group_id,
           d.name as discipline_name, s.name as semester_name,
           te.name as teacher_name, c.name as course_name,
           sy.name as school_year_name, cg.name as class_group_name
    FROM survey_response r
    JOIN teaching t ON t.id = r.teaching_id
    JOIN discipline d ON d.id = t.discipline_id
    JOIN course c ON c.id = d.course_id
    JOIN semester s ON s.id = t.semester_id
    JOIN teacher te ON te.id = t.teacher_id
    LEFT JOIN school_year sy ON sy.id = t.school_year_id
    LEFT JOIN class_group cg ON cg.id = t.class_group_id
    WHERE (COALESCE(?, c.id) = c.id)
      AND (COALESCE(?, t.semester_id) = t.semester_id)
      AND (COALESCE(?, t.discipline_id) = t.discipline_id)
      AND (COALESCE(?, t.teacher_id) = t.teacher_id)
      AND (COALESCE(?, t.school_year_id) = t.school_year_id)
      AND (COALESCE(?, t.class_group_id) = t.class_group_id)
    ORDER BY r.submitted_at DESC
  `).all(course_id || null, semester_id || null, discipline_id || null, teacher_id || null, school_year_id || null, class_group_id || null);

  const ansByResp = db.prepare('SELECT question_id, value FROM survey_answer WHERE response_id=?');
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Respostas');
  const header = ['Data/Hora','Curso','Semestre','Ano lectivo','Turma','Disciplina','Docente', ...qRows.map(q=>q.code), 'Comentário'];
  ws.addRow(header);
  responses.forEach(r => {
    const ans = ansByResp.all(r.response_id);
    const map = new Map(ans.map(a => [a.question_id, a.value]));
    ws.addRow([
      r.submitted_at, r.course_name, r.semester_name, r.school_year_name || '', r.class_group_name || '', r.discipline_name, r.teacher_name,
      ...qRows.map(q => map.get(q.id) ?? ''), r.comment || ''
    ]);
  });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="avaliacao_ispt.xlsx"');
  await wb.xlsx.write(res); res.end();
});


 // ====== EXPORT: PDF (com capa, KPIs coloridos, tabela ordenada, pizza e secções) ======
app.get('/export/pdf', requireAuth, (req, res) => {
    const { course_id, semester_id, discipline_id, teacher_id, school_year_id, class_group_id } = req.query;
  
    const course     = course_id      ? db.prepare('SELECT name FROM course WHERE id=?').get(course_id)           : null;
    const semester   = semester_id    ? db.prepare('SELECT name FROM semester WHERE id=?').get(semester_id)       : null;
    const discipline = discipline_id  ? db.prepare('SELECT name FROM discipline WHERE id=?').get(discipline_id)   : null;
    const teacher    = teacher_id     ? db.prepare('SELECT name FROM teacher WHERE id=?').get(teacher_id)         : null;
    const schoolYear = school_year_id ? db.prepare('SELECT name FROM school_year WHERE id=?').get(school_year_id) : null;
    const klass      = class_group_id ? db.prepare('SELECT name FROM class_group WHERE id=?').get(class_group_id) : null;
  
    // Totais e média global
    const totals = db.prepare(`
      SELECT COUNT(DISTINCT r.id) as total_resp, AVG(a.value) as media_global
      FROM survey_response r
      JOIN survey_answer a ON a.response_id = r.id
      JOIN teaching t ON t.id = r.teaching_id
      JOIN discipline d ON d.id = t.discipline_id
      WHERE (COALESCE(?, d.course_id) = d.course_id)
        AND (COALESCE(?, t.semester_id) = t.semester_id)
        AND (COALESCE(?, t.discipline_id) = t.discipline_id)
        AND (COALESCE(?, t.teacher_id) = t.teacher_id)
        AND (COALESCE(?, t.school_year_id) = t.school_year_id)
        AND (COALESCE(?, t.class_group_id) = t.class_group_id)
    `).get(course_id||null, semester_id||null, discipline_id||null, teacher_id||null, school_year_id||null, class_group_id||null);
  
    // Por questão (contagens e média)
    const byQuestionRaw = db.prepare(`
      SELECT
        q.id, q.code, q.text, q.area,
        SUM(CASE WHEN a.value = 0 THEN 1 ELSE 0 END) AS c0,
        SUM(CASE WHEN a.value = 1 THEN 1 ELSE 0 END) AS c1,
        SUM(CASE WHEN a.value = 2 THEN 1 ELSE 0 END) AS c2,
        COUNT(a.value) AS total,
        AVG(a.value)   AS avg_val
      FROM survey_question q
      LEFT JOIN survey_answer a ON a.question_id = q.id
      LEFT JOIN survey_response r ON r.id = a.response_id
      LEFT JOIN teaching t ON t.id = r.teaching_id
      LEFT JOIN discipline d ON d.id = t.discipline_id
      WHERE (COALESCE(?, d.course_id) = d.course_id)
        AND (COALESCE(?, t.semester_id) = t.semester_id)
        AND (COALESCE(?, t.discipline_id) = t.discipline_id)
        AND (COALESCE(?, t.teacher_id) = t.teacher_id)
        AND (COALESCE(?, t.school_year_id) = t.school_year_id)
        AND (COALESCE(?, t.class_group_id) = t.class_group_id)
      GROUP BY q.id
    `).all(course_id||null, semester_id||null, discipline_id||null, teacher_id||null, school_year_id||null, class_group_id||null);
  
    // Comentários agrupados por frequência (Top 10)
    const comments = db.prepare(`
      SELECT MIN(TRIM(r.comment)) AS sample_comment,
             LOWER(TRIM(r.comment)) AS norm_key,
             COUNT(*) AS freq
      FROM survey_response r
      JOIN teaching t ON t.id = r.teaching_id
      JOIN discipline d ON d.id = t.discipline_id
      WHERE r.comment IS NOT NULL AND r.comment <> ''
        AND (COALESCE(?, d.course_id) = d.course_id)
        AND (COALESCE(?, t.semester_id) = t.semester_id)
        AND (COALESCE(?, t.discipline_id) = t.discipline_id)
        AND (COALESCE(?, t.teacher_id) = t.teacher_id)
        AND (COALESCE(?, t.school_year_id) = t.school_year_id)
        AND (COALESCE(?, t.class_group_id) = t.class_group_id)
      GROUP BY norm_key
      ORDER BY freq DESC
      LIMIT 10
    `).all(course_id||null, semester_id||null, discipline_id||null, teacher_id||null, school_year_id||null, class_group_id||null);
  
    // ===== PDF =====
    const PDFDocument = require('pdfkit');
    
    const dayjs = require('dayjs');
  
    const LOGO_PRIMARY = process.env.LOGO_PRIMARY || '#0f172a';
    const LOGO_ACCENT  = process.env.LOGO_ACCENT  || '#25b17b';
  
    const resolveLogo = () => {
      const tryPaths = [process.env.LOGO_PATH, 'public/logo.png', 'public/logo.jpg', 'logo.png', 'logo.jpg'].filter(Boolean);
      for (const p of tryPaths) { try { if (fs.existsSync(p)) return p; } catch {} }
      return null;
    };
    const pct   = (n, d) => (!d || d <= 0) ? '0%' : `${Math.round((Number(n||0) / Number(d)) * 100)}%`;
    const trunc = (s, n=60) => { const t = String(s||'').trim(); return t.length > n ? t.slice(0, n-1) + '…' : t; };
  
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="relatorio_avaliacao.pdf"');
  
    const margin = 22;
    const doc = new PDFDocument({ size: 'A4', margin });
    doc.pipe(res);
  
   // ===== Capa / Cabeçalho =====
const logoPath = resolveLogo();
if (logoPath) {
  const img = doc.openImage(logoPath);
  const w = Math.min(img.width, doc.page.width - margin * 2);
  const h = (img.height / img.width) * w;
  const x = (doc.page.width - w) / 2;
  const y = doc.y;
  doc.image(logoPath, x, y, { width: w, height: h });
  // título imediatamente abaixo do logo
  doc.y = y + h + 10;
}

// Título genérico (sem curso), centrado
doc.x = margin;
doc.font('Helvetica-Bold').fontSize(16)
   .text('Relatório de Avaliação Docente', margin, doc.y, {
     width: doc.page.width - margin * 2,
     align: 'center'
   });

// espaço pequeno antes dos metadados
doc.moveDown(0.6);

// === Metadados dinâmicos (cada item em uma linha, alinhado à esquerda) ===
// Observação: "turno" vem de query (?turno=diurno|pos)
const turno = (req.query.turno && String(req.query.turno).trim()) || null;

doc.x = margin;
doc.font('Helvetica').fontSize(10).fillColor('#334155');

const metaLines = [];
if (course?.name)     metaLines.push(`Curso: ${course.name}`);
if (schoolYear?.name) metaLines.push(`Ano lectivo: ${schoolYear.name}`);
if (semester?.name)   metaLines.push(`Semestre: ${semester.name}`);
if (klass?.name)      metaLines.push(`Turma: ${klass.name}`);
if (turno)            metaLines.push(`Turno: ${turno === 'pos' ? 'Pós-laboral' : turno}`);
if (discipline?.name) metaLines.push(`Disciplina: ${discipline.name}`);
if (teacher?.name)    metaLines.push(`Docente: ${teacher.name}`);
metaLines.push(`Data: ${dayjs().format('YYYY-MM-DD')}`);

metaLines.forEach(line => {
  doc.text(line, { align: 'left', width: doc.page.width - margin * 2 });
});

doc.moveDown(0.8);

  
    // ===== KPIs (quadrados coloridos, CENTRALIZADOS e mais bonitos) =====
const contentWidth = doc.page.width - margin * 2;
const boxW = 188;           // largura de cada KPI
const boxH = 56;            // altura de cada KPI
const gap  = 18;            // espaçamento entre caixas
const startX = margin + Math.max(0, Math.floor((contentWidth - boxW * 2 + gap) / 2)); // centraliza no conteúdo
const kpiY = doc.y;

// util: decide cor do texto (preto/branco) conforme o fundo
const pickTextColor = (hex) => {
  const h = String(hex || '').replace('#','');
  const r = parseInt(h.substring(0,2),16), g = parseInt(h.substring(2,4),16), b = parseInt(h.substring(4,6),16);
  // luminância relativa sRGB
  const srgb = [r,g,b].map(v => { v/=255; return v<=0.03928 ? v/12.92 : Math.pow((v+0.055)/1.055,2.4); });
  const L = 0.2126*srgb[0] + 0.7152*srgb[1] + 0.0722*srgb[2];
  return L > 0.52 ? '#0f172a' : '#ffffff';
};

const kpiBox = (x, title, value, bg) => {
  const fg = pickTextColor(bg);

  // sombra suave
  doc.save();
  doc.fillColor('#000000').opacity(0.12);
  doc.roundedRect(x + 2, kpiY + 3, boxW, boxH, 10).fill();
  doc.restore();

  // cartão
  doc.save();
  doc.roundedRect(x, kpiY, boxW, boxH, 10).fill(bg);
  // borda sutil por cima
  doc.opacity(1).lineWidth(0.8).strokeColor('#e2e8f0').roundedRect(x, kpiY, boxW, boxH, 10).stroke();

  // “badge” decorativo (anel) no canto direito
  const cx = x + boxW - 16, cy = kpiY + 16, r = 6;
  doc.save();
  doc.lineWidth(1.2).strokeColor(fg === '#ffffff' ? '#ffffff' : '#0f172a').circle(cx, cy, r).stroke();
  doc.restore();

  // texto
  doc.fillColor(fg).font('Helvetica').fontSize(9)
     .text(title, x + 14, kpiY + 10, { width: boxW - 28, align: 'left' });
  doc.font('Helvetica-Bold').fontSize(20)
     .text(String(value ?? '—'), x + 14, kpiY + 24, { width: boxW - 28, align: 'left' });

  doc.restore();
};

const mediaGlobalTxt = totals?.media_global != null ? Number(totals.media_global).toFixed(2) : '—';
kpiBox(startX,             'Total de respostas', totals?.total_resp ?? 0, LOGO_PRIMARY);
kpiBox(startX + boxW + gap,'Média global (0–2)', mediaGlobalTxt,        LOGO_ACCENT);

// avança o cursor e insere um separador fino abaixo
doc.y = kpiY + boxH + 12;
const sep = () => {
  const xL = margin, xR = doc.page.width - margin, y = doc.y;
  doc.moveTo(xL, y).lineTo(xR, y).strokeColor('#e5e7eb').lineWidth(0.8).stroke();
  doc.moveDown(0.6);
};
sep();


    // ===== Metodologia (alinhado à esquerda) =====
    doc.x = margin;
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#0f172a')
       .text('Metodologia', { align: 'left' });
    doc.moveDown(0.1);
    doc.font('Helvetica').fontSize(9.5).fillColor('#334155')
       .text('Inquérito online com anonimato garantido. Escala de respostas: 0 (Nunca), 1 (Às vezes), 2 (Sempre). O período de recolha é definido pela instituição.',
             { width: doc.page.width - margin*2, align: 'justify' });
    sep();
  
    // ===== Tabela de Questões (ordenada por média, com cores) + Pizza Totais =====
    const byQuestion = [...byQuestionRaw].sort((a,b) => (b.avg_val || 0) - (a.avg_val || 0));
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#0f172a').text('Questões (ordenadas por média)');
    doc.moveDown(0.2);
  
    const tableX = margin, tableY = doc.y;
    const col = [
      { key: 'code', w: 44,  label: 'Cód.' },
      { key: 'text', w: 238, label: 'Questão' },
      { key: 'p0',   w: 52,  label: '0 (Nunca)' },
      { key: 'p1',   w: 52,  label: '1 (Às vezes)' },
      { key: 'p2',   w: 52,  label: '2 (Sempre)' },
      { key: 'avg',  w: 52,  label: 'Média' },
    ];
    const totalW = col.reduce((s,c)=>s+c.w,0);
  
    // Cabeçalho da tabela
    doc.save();
    doc.rect(tableX, tableY, (boxW * 2 + gap), 18).fill('#f1f5f9');
    doc.fillColor('#0f172a').font('Helvetica-Bold').fontSize(8);
    let cx = tableX + 4;
    col.forEach(c => { doc.text(c.label, cx, tableY + 5, { width: c.w - 8, align: c.key==='text' ? 'left':'center' }); cx += c.w; });
    doc.restore();
  
    let rowY = tableY + 18;
    let totalC0 = 0, totalC1 = 0, totalC2 = 0, totalRespAll = 0;
  
    byQuestion.forEach((q, idx) => {
      const t = Number(q.total || 0);
      totalC0 += Number(q.c0 || 0);
      totalC1 += Number(q.c1 || 0);
      totalC2 += Number(q.c2 || 0);
      totalRespAll += t;
  
      const avg = Number(q.avg_val || 0);
      let bg = null;
      if (avg >= 1.5) bg = '#eafff1';           // verde claro
      else if (avg >= 1.0) bg = '#fffbe6';      // amarelo claro
      else if (t > 0) bg = '#ffecec';           // vermelho claro
      if (bg) { doc.save(); doc.rect(tableX, rowY, (boxW * 2 + gap), 16).fill(bg); doc.restore(); }
  
      const row = { code:q.code, text:trunc(q.text,60), p0:pct(q.c0,t), p1:pct(q.c1,t), p2:pct(q.c2,t), avg:t?avg.toFixed(2):'—' };
      let x = tableX + 4;
      col.forEach(c => {
        let color = '#334155';
        if (c.key === 'avg' && t) {
          if (avg >= 1.5) color = '#16a34a';
          else if (avg >= 1.0) color = '#ca8a04';
          else color = '#dc2626';
        }
        doc.fillColor(color).font('Helvetica').fontSize(8)
           .text(String(row[c.key] ?? ''), x, rowY + 4, { width: c.w - 8, align: c.key==='text' ? 'left' : 'center' });
        x += c.w;
      });
  
      rowY += 16;
    });
  
    // Linha final: média geral da turma
    doc.save();
    doc.rect(tableX, rowY, (boxW * 2 + gap), 18).fill('#f8fafc');
    doc.fillColor('#0f172a').font('Helvetica-Bold').fontSize(9)
       .text('Média geral da turma', tableX + 6, rowY + 5, { width: boxW * 2 + gap - 120, align: 'left' });
    doc.fillColor('#0f172a').font('Helvetica-Bold').fontSize(9)
       .text(totals?.media_global != null ? Number(totals.media_global).toFixed(2) : '—',
             tableX + boxW * 2 + gap - 60, rowY + 5, { width: 54, align: 'center' });
    doc.restore();
  
    // Totais por texto
    const totalsY = rowY + 22;
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#0f172a').text('Totais absolutos', tableX, totalsY);
    doc.font('Helvetica').fontSize(9).fillColor('#334155')
       .text(`0 (Nunca): ${totalC0}   •   1 (Às vezes): ${totalC1}   •   2 (Sempre): ${totalC2}   •   Total (todas as questões): ${totalRespAll}`,
             tableX, totalsY + 14, { width: boxW * 2 + gap, align: 'left' });
  /*
    // Gráfico de Pizza (à direita)
    (function drawPie() {
      const rightX = tableX + boxW * 2 + gap + 14;
      const areaW  = (doc.page.width - margin) - rightX;
      if (areaW < 80) return; // sem espaço suficiente
      const topY   = tableY + 10;
      const radius = Math.min(70, Math.floor(Math.min(areaW, 160) / 2));
      const cx = rightX + radius, cy = topY + radius;
  
      const sum = totalC0 + totalC1 + totalC2;
      if (sum <= 0) {
        doc.font('Helvetica').fontSize(8).fillColor('#64748b').text('Sem dados para pizza.', rightX, topY);
        return;
      }
  
      const parts = [
        { label: '0 (Nunca)',    value: totalC0, color: '#dc2626' },
        { label: '1 (Às vezes)', value: totalC1, color: '#ca8a04' },
        { label: '2 (Sempre)',   value: totalC2, color: '#16a34a' },
      ];
  
      let start = 0;
      parts.forEach(p => {
        const angle = (p.value / sum) * Math.PI * 2;
        const end = start + angle;
        doc.save();
        doc.moveTo(cx, cy)
           .path(`M ${cx} ${cy} L ${cx + radius*Math.cos(start)} ${cy + radius*Math.sin(start)} A ${radius} ${radius} 0 ${angle>Math.PI?1:0} 1 ${cx + radius*Math.cos(end)} ${cy + radius*Math.sin(end)} Z`)
           .fill(p.color);
        doc.restore();
        start = end;
      });
  
      // legenda
      let ly = cy + radius + 8;
      parts.forEach(p => {
        const perc = Math.round((p.value/sum)*100);
        doc.save().rect(rightX, ly, 8, 8).fill(p.color).restore();
        doc.font('Helvetica').fontSize(8).fillColor('#334155')
           .text(`${p.label}: ${p.value} (${perc}%)`, rightX + 12, ly - 1);
        ly += 12;
      });
    })();
  
    // continuar após pizza
    doc.y = Math.max(doc.y, totalsY + 40);
    sep();
    */
  
 // ===== Principais tendências observadas (DINÂMICAS, com base na tabela) =====
(function renderDynamicTrends(){
    // Garantir base de dados válida
    const items = (byQuestion || [])
      .filter(q => Number(q.total || 0) > 0 && Number.isFinite(Number(q.avg_val)))
      .map(q => ({ code: q.code, avg: Number(q.avg_val) }));
  
    doc.x = margin;
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#0f172a')
       .text('Principais tendências observadas', { align: 'left' });
  
    if (!items.length) {
      doc.font('Helvetica').fontSize(9.5).fillColor('#334155')
         .text('Sem dados suficientes para calcular tendências.', { align: 'justify' });
      sep();
      return;
    }
  
    // Estatísticas simples
    const avgs = items.map(i => i.avg);
    const minAvg = Math.min(...avgs);
    const maxAvg = Math.max(...avgs);
    const mean   = avgs.reduce((s,v)=>s+v,0) / avgs.length;
    const std    = Math.sqrt(avgs.reduce((s,v)=>s+(v-mean)*(v-mean),0) / avgs.length);
  
    // Regras:
    // - Pontos fortes: médias >= 1.5 (ou, se nada atingir, top 3 por média)
    // - Pontos fracos: médias < 1.0 (ou, se nada cair abaixo, bottom 3 por média)
    const STRONG_TH = 1.5;
    const WEAK_TH   = 1.0;
    const TOPK      = 3;
  
    const desc = [...items].sort((a,b)=> b.avg - a.avg);
    const asc  = [...items].sort((a,b)=> a.avg - b.avg);
  
    let strengths = desc.filter(i => i.avg >= STRONG_TH);
    let weaknesses = asc.filter(i => i.avg < WEAK_TH);
  
    if (!strengths.length) strengths = desc.slice(0, TOPK);
    if (!weaknesses.length) weaknesses = asc.slice(0, TOPK);
  
    const fmt = arr => arr.map(i => `${i.code} (${i.avg.toFixed(2)})`).join(', ');
  
    // Texto
    doc.font('Helvetica').fontSize(9.5).fillColor('#334155')
       .list([
         `Resumo: amplitude ${minAvg.toFixed(2)} a ${maxAvg.toFixed(2)} • desvio-padrão ${std.toFixed(2)}.`,
         `Pontos fortes: ${fmt(strengths)}.`,
         `Pontos fracos: ${fmt(weaknesses)}.`
       ], { bulletRadius: 2 });
  
    sep();
  })();
  
    // ===== Comentários (qualitativo) – Top por frequência =====
    doc.x = margin;
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#0f172a').text('Comentários (qualitativo)', { align: 'left' });
    if (!comments.length) {
      doc.font('Helvetica').fontSize(9.5).fillColor('#334155')
         .text('Sem comentários registados pelos estudantes nesta aplicação.', { align: 'justify' });
    } else {
      comments.forEach(c => {
        const line = `• ${c.sample_comment} — ${c.freq}×`;
        doc.font('Helvetica').fontSize(9.5).fillColor('#334155').text(line, { align: 'justify' });
      });
      doc.moveDown(0.2);
      doc.font('Helvetica').fontSize(8).fillColor('#94a3b8')
         .text('Nota: comentários idênticos foram agrupados. A listagem completa continua disponível no Excel.', { align: 'left' });
    }
    sep();
  
   // ===== Conclusões e recomendações (DINÂMICAS com base na tabela) =====
(function renderDynamicConclusions(){
    // Base: usar as mesmas médias e totais já calculados para a tabela
    const items = (byQuestion || [])
      .filter(q => Number(q.total || 0) > 0 && Number.isFinite(Number(q.avg_val)))
      .map(q => ({
        code: q.code,
        text: q.text,
        avg: Number(q.avg_val)
      }));
  
    doc.x = margin;
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#0f172a')
       .text('Conclusões e recomendações', { align: 'left' });
    doc.moveDown(0.2);
  
    if (!items.length) {
      // fallback se não houver dados
      doc.font('Helvetica').fontSize(9.5).fillColor('#334155')
         .text('Sem dados suficientes para gerar conclusões dinâmicas.', { align: 'justify' });
      sep();
      return;
    }
  
    // Parâmetros
    const STRONG_TH = 1.5; // boas práticas: ≥ 1.5
    const WEAK_TH   = 1.0; // áreas de melhoria: < 1.0
    const TOPK_STR  = 5;   // máximos a exibir por bloco (se existirem)
    const TOPK_FALLBACK = 3;
  
    // Ordenações
    const desc = [...items].sort((a,b) => b.avg - a.avg); // maiores primeiro
    const asc  = [...items].sort((a,b) => a.avg - b.avg); // menores primeiro
  
    // Seleções dinâmicas
    let strengths  = desc.filter(i => i.avg >= STRONG_TH).slice(0, TOPK_STR);
    let weaknesses = asc.filter(i => i.avg < WEAK_TH).slice(0, TOPK_STR);
  
    // Fallbacks caso não bata nenhum threshold
    if (!strengths.length)  strengths  = desc.slice(0, TOPK_FALLBACK);
    if (!weaknesses.length) weaknesses = asc.slice(0, TOPK_FALLBACK);
  
    // Formatação de cada bullet (curta, legível)
    const short = (s, n=72) => {
      const t = String(s||'').trim();
      return t.length > n ? t.slice(0, n - 1) + '…' : t;
    };
    const fmt = i => `${i.code} – ${short(i.text)} (média ${i.avg.toFixed(2)})`;
  
    // --- Boas práticas a manter ---
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#0f172a')
       .text('Boas práticas a manter:', { align: 'left' });
    doc.font('Helvetica').fontSize(9.5).fillColor('#334155')
       .list(
         strengths.map(i => `Manter e consolidar: ${fmt(i)}`),
         { bulletRadius: 2 }
       );
  
    // --- Áreas de melhoria ---
    doc.moveDown(0.3);
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#0f172a')
       .text('Áreas de melhoria:', { align: 'left' });
    doc.font('Helvetica').fontSize(9.5).fillColor('#334155')
       .list(
         weaknesses.map(i => `Melhorar/implementar: ${fmt(i)}`),
         { bulletRadius: 2 }
       );
  
    // (Opcional) Nota tática curta
    doc.moveDown(0.2);
    doc.font('Helvetica').fontSize(8.5).fillColor('#94a3b8')
       .text('Sugestão: priorizar um plano de ação para 2–3 itens com menor média no curto prazo.', { align: 'left' });
  
    sep();
  })();
  
    // Rodapé (escala)
    doc.moveDown(0.6);
    doc.font('Helvetica').fontSize(8).fillColor('#94a3b8')
       .text('Escala: 0 (Nunca), 1 (Às vezes), 2 (Sempre).', { align: 'center' });
  
    doc.end();
  });
  
  
   
  
// ====== API: DASHBOARD (agregado) ======
app.get('/api/dashboard', requireAuth, (req, res) => {
  const { course_id, semester_id, discipline_id, teacher_id, school_year_id, class_group_id } = req.query;
  const q = (sql) => db.prepare(sql).all(course_id||null, semester_id||null, discipline_id||null, teacher_id||null, school_year_id||null, class_group_id||null);

  const total = db.prepare(`
    SELECT COUNT(*) as c
    FROM survey_response r
    JOIN teaching t ON t.id = r.teaching_id
    JOIN discipline d ON d.id = t.discipline_id
    WHERE (COALESCE(?, d.course_id) = d.course_id)
      AND (COALESCE(?, t.semester_id) = t.semester_id)
      AND (COALESCE(?, t.discipline_id) = t.discipline_id)
      AND (COALESCE(?, t.teacher_id) = t.teacher_id)
      AND (COALESCE(?, t.school_year_id) = t.school_year_id)
      AND (COALESCE(?, t.class_group_id) = t.class_group_id)
  `).get(course_id||null, semester_id||null, discipline_id||null, teacher_id||null, school_year_id||null, class_group_id||null).c;

  const docentes = db.prepare(`
    SELECT COUNT(DISTINCT t.teacher_id) as c
    FROM survey_response r
    JOIN teaching t ON t.id = r.teaching_id
    JOIN discipline d ON d.id = t.discipline_id
    WHERE (COALESCE(?, d.course_id) = d.course_id)
      AND (COALESCE(?, t.semester_id) = t.semester_id)
      AND (COALESCE(?, t.discipline_id) = t.discipline_id)
      AND (COALESCE(?, t.teacher_id) = t.teacher_id)
      AND (COALESCE(?, t.school_year_id) = t.school_year_id)
      AND (COALESCE(?, t.class_group_id) = t.class_group_id)
  `).get(course_id||null, semester_id||null, discipline_id||null, teacher_id||null, school_year_id||null, class_group_id||null).c;

  const areas = q(`
    SELECT q.area, AVG(a.value) as media
    FROM survey_answer a
    JOIN survey_question q ON q.id = a.question_id
    JOIN survey_response r ON r.id = a.response_id
    JOIN teaching t ON t.id = r.teaching_id
    JOIN discipline d ON d.id = t.discipline_id
    WHERE (COALESCE(?, d.course_id) = d.course_id)
      AND (COALESCE(?, t.semester_id) = t.semester_id)
      AND (COALESCE(?, t.discipline_id) = t.discipline_id)
      AND (COALESCE(?, t.teacher_id) = t.teacher_id)
      AND (COALESCE(?, t.school_year_id) = t.school_year_id)
      AND (COALESCE(?, t.class_group_id) = t.class_group_id)
    GROUP BY q.area
  `);

  const avgRow = db.prepare(`
    SELECT AVG(a.value) as m
    FROM survey_answer a
    JOIN survey_response r ON r.id = a.response_id
    JOIN teaching t ON t.id = r.teaching_id
    JOIN discipline d ON d.id = t.discipline_id
    WHERE (COALESCE(?, d.course_id) = d.course_id)
      AND (COALESCE(?, t.semester_id) = t.semester_id)
      AND (COALESCE(?, t.discipline_id) = t.discipline_id)
      AND (COALESCE(?, t.teacher_id) = t.teacher_id)
      AND (COALESCE(?, t.school_year_id) = t.school_year_id)
      AND (COALESCE(?, t.class_group_id) = t.class_group_id)
  `).get(course_id||null, semester_id||null, discipline_id||null, teacher_id||null, school_year_id||null, class_group_id||null);

  const timeseries = q(`
    SELECT substr(r.submitted_at,1,10) as dia, COUNT(*) as c
    FROM survey_response r
    JOIN teaching t ON t.id = r.teaching_id
    JOIN discipline d ON d.id = t.discipline_id
    WHERE (COALESCE(?, d.course_id) = d.course_id)
      AND (COALESCE(?, t.semester_id) = t.semester_id)
      AND (COALESCE(?, t.discipline_id) = t.discipline_id)
      AND (COALESCE(?, t.teacher_id) = t.teacher_id)
      AND (COALESCE(?, t.school_year_id) = t.school_year_id)
      AND (COALESCE(?, t.class_group_id) = t.class_group_id)
    GROUP BY substr(r.submitted_at,1,10)
    ORDER BY dia
  `);

  const comments = q(`
    SELECT r.comment, r.submitted_at
    FROM survey_response r
    JOIN teaching t ON t.id = r.teaching_id
    JOIN discipline d ON d.id = t.discipline_id
    WHERE r.comment IS NOT NULL AND r.comment <> ''
      AND (COALESCE(?, d.course_id) = d.course_id)
      AND (COALESCE(?, t.semester_id) = t.semester_id)
      AND (COALESCE(?, t.discipline_id) = t.discipline_id)
      AND (COALESCE(?, t.teacher_id) = t.teacher_id)
      AND (COALESCE(?, t.school_year_id) = t.school_year_id)
      AND (COALESCE(?, t.class_group_id) = t.class_group_id)
    ORDER BY r.submitted_at DESC
    LIMIT 12
  `);

  res.json({ totalResponses: total, teachersEvaluated: docentes, avgOverall: avgRow?.m ?? null, areas, timeseries, comments });
});

// ====== DASHBOARD (UI) ======
app.get('/dashboard', requireAuth, (req, res) => {
  const courses = db.prepare('SELECT * FROM course ORDER BY name').all();
  const semesters = db.prepare('SELECT * FROM semester ORDER BY id').all();
  const years = db.prepare('SELECT * FROM school_year ORDER BY name DESC').all();
  const classes = db.prepare('SELECT * FROM class_group ORDER BY name').all();

  function s(name, label, options, v='id', l='name') {
    const opts = options.map(o => `<option value="${o[v]}">${o[l]}</option>`).join('');
    return `
      <label class="block mb-1 text-sm font-medium">${label}</label>
      <select name="${name}" class="w-full border rounded-xl p-2">
        <option value="">— Todos —</option>
        ${opts}
      </select>`;
  }

  const filtros = `
    <form id="filtrosDash" class="grid grid-cols-2 md:grid-cols-6 gap-3 mb-5">
      ${s('course_id','Curso',courses)}
      ${s('semester_id','Semestre',semesters)}
      ${s('school_year_id','Ano lectivo',years)}
      ${s('class_group_id','Turma',classes)}
      <div class="md:col-span-2 flex items-end gap-2">
        <button type="button" id="aplicarDash" class="btn btn-primary">Aplicar</button>
        <a class="btn btn-ghost" href="/dashboard">Limpar</a>
      </div>
    </form>`;

  const html = `
    ${filtros}
    <div class="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
      <div class="card kpi"><h3>Total de respostas</h3><div id="k_total" class="v">—</div></div>
      <div class="card kpi"><h3>Docentes avaliados</h3><div id="k_doc" class="v">—</div></div>
      <div class="card kpi"><h3>Média global (0–2)</h3><div id="k_media" class="v">—</div></div>
      <div class="card kpi"><h3>Índice % (0–100)</h3><div id="k_idx" class="v">—</div></div>
    </div>
    <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <div class="card"><h2 class="text-lg font-semibold mb-2 text-left">Médias por área</h2><div style="height:220px"><canvas id="chartAreasDash"></canvas></div></div>
      <div class="card"><h2 class="text-lg font-semibold mb-2 text-left">Respostas por dia</h2><div style="height:220px"><canvas id="chartSerieDash"></canvas></div></div>
    </div>
    <div class="mt-6 card"><h2 class="text-lg font-semibold mb-3 text-left">Comentários recentes</h2><ul id="ulComments" class="space-y-2"></ul></div>
    <script>
      let cAreas, cSerie; const pct = x => Math.round((Number(x||0)/2)*100); const round2 = x => Math.round(Number(x||0)*100)/100;
      function params(){ const fd=new FormData(document.getElementById('filtrosDash')); const p=new URLSearchParams(); for(const [k,v] of fd.entries()) if(v) p.append(k,v); return p.toString(); }
      function noData(ctx, msg='Sem dados'){ const c=ctx.canvas; const g=c.getContext('2d'); g.clearRect(0,0,c.width,c.height); g.font='12px sans-serif'; g.fillStyle='#64748b'; g.textAlign='center'; g.fillText(msg, c.width/2, c.height/2); }
      async function load(){
        const res = await fetch('/api/dashboard?' + params()); const d = await res.json();
        document.getElementById('k_total').textContent = d.totalResponses ?? 0;
        document.getElementById('k_doc').textContent   = d.teachersEvaluated ?? 0;
        document.getElementById('k_media').textContent = d.avgOverall!=null ? round2(d.avgOverall).toFixed(2) : '—';
        document.getElementById('k_idx').textContent   = d.avgOverall!=null ? pct(d.avgOverall)+'%' : '—';
        const aLabels = (d.areas||[]).map(x=>x.area); const aVals = (d.areas||[]).map(x=> round2(x.media));
        if(cAreas) cAreas.destroy(); const ctxA = document.getElementById('chartAreasDash').getContext('2d');
        if(!aVals.length){ noData(ctxA); } else {
          cAreas = new Chart(ctxA, { type:'bar', data:{ labels:aLabels, datasets:[{ label:'Média (0–2)', data:aVals, borderWidth:1 }] }, options:{ responsive:true, maintainAspectRatio:false, plugins:{legend:{display:false}}, scales:{ y:{ suggestedMin:0, suggestedMax:2 } } } });
        }
        const sLabels = (d.timeseries||[]).map(x=>x.dia); const sVals = (d.timeseries||[]).map(x=> Number(x.c)||0);
        if(cSerie) cSerie.destroy(); const ctxS = document.getElementById('chartSerieDash').getContext('2d');
        if(!sVals.length){ noData(ctxS); } else {
          cSerie = new Chart(ctxS, { type:'line', data:{ labels:sLabels, datasets:[{ label:'Respostas/dia', data:sVals, tension:.3, fill:false }] }, options:{ responsive:true, maintainAspectRatio:false, scales:{ y:{ beginAtZero:true } } } });
        }
        const ul=document.getElementById('ulComments'); ul.innerHTML='';
        (d.comments||[]).forEach(c=>{ const li=document.createElement('li'); li.className='p-3 rounded-xl border'; const dt=new Date(c.submitted_at).toLocaleString(); li.innerHTML='<div class="text-xs text-slate-500">'+dt+'</div><div>'+c.comment+'</div>'; ul.appendChild(li); });
        if(!d.comments||!d.comments.length){ const li=document.createElement('li'); li.className='text-slate-500'; li.textContent='Sem comentários no período/escopo seleccionado.'; ul.appendChild(li);} }
      document.getElementById('aplicarDash').addEventListener('click', load); load();
    </script>`;

  res.send(renderPage('Dashboard', html, '', (req.cookies && req.cookies.ispt_admin==='1')));
});

// ====== START ======
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`ISPT – Avaliação Docente a correr em http://localhost:${PORT}`));