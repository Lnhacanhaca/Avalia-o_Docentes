/**
 * ISPT – Sistema Web de Avaliação Docente (MVP Consolidado)
 * Stack: Node.js (Express) + SQLite (better-sqlite3) + Tailwind (CDN) + Chart.js (CDN)
 * Export: Excel (exceljs), PDF (pdfkit)
 * Extras: Autenticação simples (admin), Ano lectivo, Turma, Importação via Excel
 *
 * Como executar:
 *   1) npm init -y
 *   2) npm i express cookie-parser multer better-sqlite3 body-parser exceljs pdfkit dayjs
 *   3) ADMIN_PASSWORD=coloca-uma-senha node app.js
 *   4) Abrir: http://localhost:3000
 */


const express = require('express');
const bodyParser = require('body-parser');
const cookieParser = require('cookie-parser');
const multer = require('multer');
const Database = require('better-sqlite3');
const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');
const dayjs = require('dayjs');

const app = express();
const db = new Database('avaliacao_ispt.sqlite');

require('dotenv').config();

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'ispt-admin';
const upload = multer({ storage: multer.memoryStorage() });

app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(cookieParser());

// ====== BASE DE DADOS: SCHEMA ======
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
  name TEXT NOT NULL UNIQUE -- ex.: 2025/2026
);
CREATE TABLE IF NOT EXISTS class_group (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE -- ex.: Turma A, Noite, etc.
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
  area TEXT NOT NULL -- ex.: Preparação, Metodologia, Organização, Avaliação, Relação
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
db.exec(schema);

// Índice único para não duplicar a mesma leccionação
db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS ux_teaching
  ON teaching(teacher_id, discipline_id, semester_id, school_year_id, class_group_id);
`);

// tentar adicionar colunas se a BD for antiga
try { db.exec('ALTER TABLE teaching ADD COLUMN school_year_id INTEGER'); } catch {}
try { db.exec('ALTER TABLE teaching ADD COLUMN class_group_id INTEGER'); } catch {}

// ====== DADOS INICIAIS (SEED) ======
function seedOnce() {
  const hasCourses = db.prepare('SELECT COUNT(*) as c FROM course').get().c > 0;
  if (hasCourses) return;

  // Cursos
  const courses = ['Engenharia Informática', 'Engenharia de Minas', 'Processamento Mineral'];
  const insCourse = db.prepare('INSERT INTO course (name) VALUES (?)');
  courses.forEach(c => insCourse.run(c));

  // Semestres / Períodos
  const semesters = ['1º Semestre', '2º Semestre', 'Anual'];
  const insSem = db.prepare('INSERT INTO semester (name) VALUES (?)');
  semesters.forEach(s => insSem.run(s));

  // Anos lectivos
  const years = ['2025'];
  const insYear = db.prepare('INSERT INTO school_year (name) VALUES (?)');
  years.forEach(y => insYear.run(y));

  // Turmas
  const classes = ['Turma A', 'Turma B', 'Única Pós-laboral'];
  const insClass = db.prepare('INSERT INTO class_group (name) VALUES (?)');
  classes.forEach(c => insClass.run(c));

  // Disciplinas
  const discByCourse = {
    'Engenharia Informática': ['Algoritmos', 'Estruturas de Dados', 'Redes de Computadores'],
    'Engenharia de Minas': ['Topografia', 'Perfuração e Desmonte', 'Ventilação de Minas'],
    'Processamento Mineral': ['Cominuição', 'Classificação', 'Flotação']
  };
  const getCourse = db.prepare('SELECT id FROM course WHERE name=?');
  const insDisc = db.prepare('INSERT INTO discipline (course_id, name) VALUES (?,?)');
  Object.entries(discByCourse).forEach(([cname, discs]) => {
    const cid = getCourse.get(cname).id;
    discs.forEach(d => insDisc.run(cid, d));
  });

  // Docentes
  const teachers = ['Docente A', 'Docente B', 'Docente C'];
  const insT = db.prepare('INSERT INTO teacher (name) VALUES (?)');
  teachers.forEach(t => insT.run(t));

  // Ligações ensino (teacher + discipline + semester + ano + turma)
  const allDisc = db.prepare('SELECT id FROM discipline').all();
  const allSem = db.prepare('SELECT id FROM semester').all();
  const allTeach = db.prepare('SELECT id FROM teacher').all();
  const year = db.prepare('SELECT id FROM school_year LIMIT 1').get();
  const klass = db.prepare('SELECT id FROM class_group LIMIT 1').get();
  const insTeach = db.prepare('INSERT INTO teaching (teacher_id, discipline_id, semester_id, school_year_id, class_group_id) VALUES (?,?,?,?,?)');
  allDisc.forEach((d, idx) => {
    const t = allTeach[idx % allTeach.length];
    const s = allSem[idx % allSem.length];
    insTeach.run(t.id, d.id, s.id, year?.id || null, klass?.id || null);
  });

  // Questões (0–2)
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
  return `<!doctype html>
<html lang="pt" class="h-full">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script>
    tailwind.config = {
      theme: {
        extend: {
          colors: {
            ispt: { 50: '#eef8f3', 100: '#d6efe3', 200: '#aee0c8', 300: '#7fd0ac', 400: '#4dbf92', 500: '#25b17b', 600: '#178d63', 700: '#106e4e', 800: '#0e5640', 900: '#0c4735' }
          }
        }
      }
    }
  </script>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <style>
    .card{background:#fff;border-radius:1rem;box-shadow:0 8px 30px rgba(0,0,0,.06);border:1px solid #e2e8f0;padding:1.25rem}
    .btn{display:inline-flex;align-items:center;gap:.5rem;padding:.5rem 1rem;border-radius:.75rem;font-weight:500}
    .btn-primary{background:#0f172a;color:#fff}
    .btn-ghost{background:#f1f5f9}
    .kpi{text-align:center}
    .kpi h3{font-size:.875rem;color:#64748b}
    .kpi .v{font-size:1.75rem;font-weight:700}
    .chip{display:inline-flex;align-items:center;gap:.5rem;padding:.25rem .625rem;border-radius:999px;font-size:.75rem;background:#f1f5f9}
  </style>
  ${extraHead}
</head>
<body class="min-h-full bg-slate-50 text-slate-900">
  <div class="max-w-6xl mx-auto p-4 sm:p-8">
    <header class="mb-6 sticky top-0 bg-slate-50/80 backdrop-blur z-30">
      <div class="flex items-center justify-between py-2">
        <a href="/" class="flex items-center gap-2">
          <div class="w-8 h-8 rounded-full" style="background:#25b17b;display:grid;place-content:center;color:#fff;font-weight:700">i</div>
          <span class="font-semibold">ISPT · Avaliação Docente</span>
        </a>
        <nav class="text-sm flex gap-3 flex-wrap">
          <a class="underline" href="/">Inquérito</a>
          ${isAdmin ? '<a class="underline" href="/admin">Relatório</a>' : ''}
          ${isAdmin ? '<a class="underline" href="/dashboard">Dashboard</a>' : ''}
          ${isAdmin ? '<a class="underline" href="/importar">Importar</a>' : ''}
          ${isAdmin ? '<a class="underline" href="/logout">Sair</a>' : '<a class="underline" href="/login">Entrar</a>'}
        </nav>
      </div>
    </header>
    <main class="card">
      <h1 class="text-2xl sm:text-3xl font-bold mb-4">${title}</h1>
      ${content}
    </main>
    <footer class="mt-8 text-xs text-slate-500 text-center">ISPT · Avaliação Docente · ${new Date().getFullYear()}</footer>
  </div>
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

app.get('/logout', (req, res) => {
  res.clearCookie('ispt_admin');
  res.redirect('/');
});

// ====== ROTA: FORM INQUÉRITO ======
app.get('/', (req, res) => {
  const courses = db.prepare('SELECT * FROM course ORDER BY name').all();
  const semesters = db.prepare('SELECT * FROM semester ORDER BY id').all();
  const years = db.prepare('SELECT * FROM school_year ORDER BY name DESC').all();

  const content = `
    <form method="GET" action="/inquerito" class="grid grid-cols-1 sm:grid-cols-2 gap-4">
      ${select('course_id', 'Curso', courses)}
      ${select('semester_id', 'Semestre/Período lectivo', semesters)}
      <div class="sm:col-span-2">
        ${select('school_year_id', 'Ano lectivo', years)}
      </div>
      <div class="sm:col-span-2">
        <button class="btn btn-primary">Continuar</button>
      </div>
    </form>
    <p class="text-sm text-slate-600 mt-4">Nota: se o mesmo docente leccionar várias disciplinas, preencha um inquérito por disciplina.</p>
  `;
  res.send(renderPage('ISPT – Inquérito a Estudantes', content, '', (req.cookies && req.cookies.ispt_admin==='1')));
});

app.get('/inquerito', (req, res) => {
  const { course_id, semester_id, school_year_id } = req.query;
  if (!course_id || !semester_id || !school_year_id) return res.redirect('/');

  // Disciplinas com leccionação nesse curso/ano/semestre
  const teachRows = db.prepare(`
    SELECT DISTINCT d.id as discipline_id, d.name as discipline_name
    FROM teaching t
    JOIN discipline d ON d.id = t.discipline_id
    WHERE d.course_id = ? AND t.semester_id = ? AND t.school_year_id = ?
    ORDER BY d.name
  `).all(course_id, semester_id, school_year_id);

  // Mapa Disciplina -> Docentes (apenas quem lecciona nessa disciplina/ano/semestre)
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

  // Select de disciplina (a lista válida para o período)
  const disciplines = teachRows.map(r => ({ id: r.discipline_id, name: r.discipline_name }));
  const discSel = select('discipline_id', 'Disciplina', disciplines);

  // Select de docente (preenchido quando escolhe a disciplina)
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
        function fillTeachers(list) {
          teacher.innerHTML = '<option value="" disabled selected>— seleccione —</option>';
          (list || []).forEach(t => {
            const opt = document.createElement('option');
            opt.value = t.id; opt.textContent = t.name; teacher.appendChild(opt);
          });
          teacher.disabled = !(list && list.length);
          teacher.classList.toggle('opacity-50', teacher.disabled);
        }
        disc.addEventListener('change', e => {
          fillTeachers(TEACHER_MAP[e.target.value] || []);
        });
      });
    </script>
  `;

  // Turmas por turno
  const turmaA = db.prepare("SELECT id, name FROM class_group WHERE name = 'Turma A'").get();
  const turmaB = db.prepare("SELECT id, name FROM class_group WHERE name = 'Turma B'").get();
  const posUnica = db.prepare("SELECT id, name FROM class_group WHERE name = 'Única Pós-laboral'").get();

  const turnoSel = `
    <label class="block mb-2 font-medium">Turno</label>
    <select id="turno" name="turno" required class="w-full border rounded-xl p-2 mb-4">
      <option value="" disabled selected>— seleccione —</option>
      <option value="diurno">Diurno</option>
      <option value="pos">Pós-laboral</option>
    </select>
  `;

  const turmaSel = `
    <label class="block mb-2 font-medium">Turma</label>
    <select id="class_group_id" name="class_group_id" required class="w-full border rounded-xl p-2 mb-4 opacity-50" disabled>
      <option value="" disabled selected>— seleccione —</option>
    </select>

    <script>
      const TURMA_A = ${turmaA ? turmaA.id : 'null'};
      const TURMA_B = ${turmaB ? turmaB.id : 'null'};
      const POS_UNICA = ${posUnica ? posUnica.id : 'null'};
      const TURMA_A_NAME = ${JSON.stringify(turmaA ? turmaA.name : 'Turma A')};
      const TURMA_B_NAME = ${JSON.stringify(turmaB ? turmaB.name : 'Turma B')};
      const POS_UNICA_NAME = ${JSON.stringify(posUnica ? posUnica.name : 'Única Pós-laboral')};

      document.addEventListener('DOMContentLoaded', () => {
        const turno = document.getElementById('turno');
        const turma = document.getElementById('class_group_id');
        function fillTurmas(opts) {
          turma.innerHTML = '<option value="" disabled selected>— seleccione —</option>';
          opts.forEach(o => { if (!o || !o.id) return; const opt = document.createElement('option'); opt.value = o.id; opt.textContent = o.name; turma.appendChild(opt); });
          const disabled = opts.length === 0;
          turma.disabled = disabled;
          turma.classList.toggle('opacity-50', disabled);
          turma.classList.toggle('cursor-not-allowed', disabled);
        }
        const diurnoOpts = [
          TURMA_A ? { id: TURMA_A, name: TURMA_A_NAME } : null,
          TURMA_B ? { id: TURMA_B, name: TURMA_B_NAME } : null,
        ].filter(Boolean);
        const posOpts = [ POS_UNICA ? { id: POS_UNICA, name: POS_UNICA_NAME } : null ].filter(Boolean);
        turno.addEventListener('change', (e) => {
          if (e.target.value === 'diurno') fillTurmas(diurnoOpts);
          else if (e.target.value === 'pos') fillTurmas(posOpts);
          else fillTurmas([]);
        });
      });
    </script>
  `;

  // Questões
  const qHtml = questions.map(q => `
    <div class="mb-4">
      <label class="block mb-1 font-medium">
        ${q.code}. ${q.text}
        <span class="text-xs text-slate-500">(0 = Nunca / 1 = Às vezes / 2 = Sempre)</span>
      </label>
      <div class="flex gap-2">
        ${[0,1,2].map(v => `
          <label class="inline-flex items-center gap-2 border rounded-xl px-3 py-2">
            <input type="radio" name="q_${q.id}" value="${v}" required /> ${v}
          </label>
        `).join('')}
      </div>
    </div>
  `).join('');

  const content = `
    <form method="POST" action="/submit" class="space-y-4">
      <input type="hidden" name="course_id" value="${course_id}" />
      <input type="hidden" name="semester_id" value="${semester_id}" />
      <input type="hidden" name="school_year_id" value="${school_year_id}" />

      <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
        ${discSel}
        ${teachSel}
        ${turnoSel}
        ${turmaSel}
      </div>

      <hr class="my-4" />
      <h2 class="text-xl font-semibold mb-2">Questões</h2>
      ${qHtml}

      <label class="block mb-2 font-medium">Comentários (opcional)</label>
      <textarea name="comment" class="w-full border rounded-xl p-2" rows="4" placeholder="Sugestões, críticas construtivas, elogios..."></textarea>

      <button class="btn btn-primary">Submeter</button>
    </form>
  `;

  res.send(renderPage('Responder Inquérito', content, '', (req.cookies && req.cookies.ispt_admin==='1')));
});

// ====== SUBMISSÃO ======
app.post('/submit', (req, res) => {
  let { course_id, semester_id, school_year_id, discipline_id, teacher_id, class_group_id, comment, ...answers } = req.body;
  if (!course_id || !semester_id || !discipline_id || !teacher_id) {
    return res.status(400).send('Dados em falta.');
  }
  class_group_id = class_group_id || null;

  // garantir teaching
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
    const key = `q_${q.id}`;
    const val = Number(answers[key]);
    if (![0,1,2].includes(val)) return;
    insAns.run(responseId, q.id, val);
  });

  const ok = `
    <div class="text-center space-y-2">
      <h2 class="text-xl font-semibold">Obrigado pela sua resposta!</h2>
      <p class="text-slate-600">A sua participação é anónima e ajuda a melhorar a qualidade pedagógica.</p>
      <a href="/" class="btn btn-primary">Novo inquérito</a>
    </div>`;
  res.send(renderPage('Submissão concluída', ok, '', (req.cookies && req.cookies.ispt_admin==='1')));
});

// ====== API: ESTATÍSTICAS (por questão/área) ======
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

// ====== RELATÓRIO (UI) ======
app.get('/admin', requireAuth, (req, res) => {
  const courses = db.prepare('SELECT * FROM course ORDER BY name').all();
  const semesters = db.prepare('SELECT * FROM semester ORDER BY id').all();
  const disciplines = db.prepare('SELECT * FROM discipline ORDER BY name').all();
  const teachers = db.prepare('SELECT * FROM teacher ORDER BY name').all();
  const years = db.prepare('SELECT * FROM school_year ORDER BY name DESC').all();
  const classes = db.prepare('SELECT * FROM class_group ORDER BY name').all();

  const filters = `
    <form id="filtros" class="grid grid-cols-1 md:grid-cols-6 gap-3 mb-4">
      ${select('course_id', 'Curso', courses)}
      ${select('semester_id', 'Semestre/Período', semesters)}
      ${select('discipline_id', 'Disciplina', disciplines)}
      ${select('teacher_id', 'Docente', teachers)}
      ${select('school_year_id', 'Ano lectivo', years)}
      ${select('class_group_id', 'Turma', classes)}
      <div class="md:col-span-6 flex gap-2 flex-wrap">
        <button type="button" id="aplicar" class="btn btn-primary">Aplicar</button>
        <a class="btn btn-ghost" href="/admin">Limpar</a>
        <a class="btn btn-primary" id="exportExcel" href="#">Exportar Excel</a>
        <a class="btn btn-primary" id="exportPDF" href="#">Exportar PDF</a>
      </div>
    </form>
  `;

  const content = `
    ${filters}
    <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <div>
        <h2 class="text-lg font-semibold mb-2">Médias por questão</h2>
        <canvas id="chartPerguntas" height="200"></canvas>
      </div>
      <div>
        <h2 class="text-lg font-semibold mb-2">Médias por área</h2>
        <canvas id="chartAreas" height="200"></canvas>
      </div>
    </div>
    <div class="mt-6">
      <h2 class="text-lg font-semibold mb-2">Comentários (qualitativo)</h2>
      <ul id="comments" class="space-y-2"></ul>
    </div>

    <script>
      function params() {
        const fd = new FormData(document.getElementById('filtros'));
        const p = new URLSearchParams();
        for (const [k,v] of fd.entries()) { if (v) p.append(k, v); }
        return p.toString();
      }

      let chartPerguntas, chartAreas;
      async function load() {
        const res = await fetch('/api/stats?' + params());
        const data = await res.json();

        const map = new Map(data.rows.map(r => [r.question_id, r.avg_val]));
        const labels = data.questions.map(q => q.code);
        const values = data.questions.map(q => map.get(q.id) ?? null);

        const ctx1 = document.getElementById('chartPerguntas').getContext('2d');
        if (chartPerguntas) chartPerguntas.destroy();
        chartPerguntas = new Chart(ctx1, {
          type: 'bar',
          data: { labels, datasets: [{ label: 'Média (0–2)', data: values, borderWidth: 1 }] },
          options: { scales: { y: { suggestedMin: 0, suggestedMax: 2 } } }
        });

        const areaMap = {};
        data.questions.forEach((q, idx) => {
          const v = values[idx];
          if (v == null) return;
          areaMap[q.area] = areaMap[q.area] || { sum: 0, n: 0 };
          areaMap[q.area].sum += v; areaMap[q.area].n += 1;
        });
        const areaLabels = Object.keys(areaMap);
        const areaValues = areaLabels.map(a => (areaMap[a].sum / areaMap[a].n).toFixed(2));

        const ctx2 = document.getElementById('chartAreas').getContext('2d');
        if (chartAreas) chartAreas.destroy();
        chartAreas = new Chart(ctx2, {
          type: 'radar',
          data: { labels: areaLabels, datasets: [{ label: 'Média por Área (0–2)', data: areaValues }] },
          options: { scales: { r: { suggestedMin: 0, suggestedMax: 2 } } }
        });

        // Comentários
        const ul = document.getElementById('comments');
        ul.innerHTML = '';
        if (!data.comments || !data.comments.length) {
          ul.innerHTML = '<li class="text-slate-500">Sem dados para os filtros seleccionados.</li>';
        } else {
          data.comments.forEach(c => {
            const li = document.createElement('li');
            li.className = 'p-3 rounded-xl border';
            const d = new Date(c.submitted_at).toLocaleString();
            li.innerHTML = '<div class="text-sm text-slate-500">' + d + '</div><div>' + (c.comment||'') + '</div>';
            ul.appendChild(li);
          });
        }
      }

      document.getElementById('aplicar').addEventListener('click', load);
      load();

      document.getElementById('exportExcel').addEventListener('click', (e) => {
        e.preventDefault();
        window.location = '/export/excel?' + params();
      });
      document.getElementById('exportPDF').addEventListener('click', (e) => {
        e.preventDefault();
        window.location = '/export/pdf?' + params();
      });
    </script>
  `;
  res.send(renderPage('Relatório', content, '', (req.cookies && req.cookies.ispt_admin==='1')));
});

// ====== IMPORTAR LISTAS (ADMIN) ======
app.get('/importar', requireAuth, (req, res) => {
  const html = `
  <form method="POST" action="/importar" enctype="multipart/form-data" class="space-y-4">
    <p class="text-sm">
      <b>Área restrita a administradores.</b><br/>
      Carregue um Excel com folhas:
      <b>cursos</b> (name),
      <b>docentes</b> (name),
      <b>disciplinas</b> (course, name) e
      <b>leccionacao</b> (course, discipline, teacher, year, semester, class_group).
    </p>
    <label class="inline-flex items-center gap-2 text-sm">
      <input type="checkbox" name="wipe_all" />
      <span>Substituir dados antigos (limpa cursos/disciplinas/docentes/turmas/anos/semestres, respostas e leccionação)</span>
    </label>
    <input type="file" name="file" accept=".xlsx" required />
    <button class="btn btn-primary">Importar</button>
  </form>`;
  res.send(renderPage('Importar Listas', html, '', (req.cookies && req.cookies.ispt_admin==='1')));
});

app.post('/importar', requireAuth, upload.single('file'), async (req, res) => {
  try {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(req.file.buffer);

    // Se marcado, apaga dados antigos antes de importar
    if (req.body.wipe_all === 'on') {
      const wipe = db.transaction(() => {
        db.exec('DELETE FROM survey_answer;');
        db.exec('DELETE FROM survey_response;');
        db.exec('DELETE FROM teaching;');
        db.exec('DELETE FROM discipline;');
        db.exec('DELETE FROM teacher;');
        db.exec('DELETE FROM course;');
        db.exec('DELETE FROM school_year;');
        db.exec('DELETE FROM class_group;');
        db.exec('DELETE FROM semester;');
      });
      wipe();
    }

    // helpers
    const upsertCourse     = db.prepare('INSERT OR IGNORE INTO course (name) VALUES (?)');
    const getCourse        = db.prepare('SELECT id FROM course WHERE name=?');

    const upsertTeacher    = db.prepare('INSERT OR IGNORE INTO teacher (name) VALUES (?)');
    const getTeacher       = db.prepare('SELECT id FROM teacher WHERE name=?');

    const upsertDiscipline = db.prepare('INSERT OR IGNORE INTO discipline (course_id, name) VALUES (?,?)');
    const getDiscipline    = db.prepare('SELECT id FROM discipline WHERE course_id=? AND name=?');

    const upsertYear       = db.prepare('INSERT OR IGNORE INTO school_year (name) VALUES (?)');
    const getYear          = db.prepare('SELECT id FROM school_year WHERE name=?');

    const upsertSem        = db.prepare('INSERT OR IGNORE INTO semester (name) VALUES (?)');
    const getSem           = db.prepare('SELECT id FROM semester WHERE name=?');

    const upsertClass      = db.prepare('INSERT OR IGNORE INTO class_group (name) VALUES (?)');
    const getClass         = db.prepare('SELECT id FROM class_group WHERE name=?');

    const insTeaching      = db.prepare(`
      INSERT OR IGNORE INTO teaching (teacher_id, discipline_id, semester_id, school_year_id, class_group_id)
      VALUES (?,?,?,?,?)
    `);

    // 1) cursos
    const sheetCursos = wb.getWorksheet('cursos');
    if (sheetCursos) {
      sheetCursos.eachRow((row, i) => {
        if (i === 1) return;
        const name = row.getCell(1).value?.toString().trim();
        if (name) upsertCourse.run(name);
      });
    }

    // 2) docentes
    const sheetDoc = wb.getWorksheet('docentes');
    if (sheetDoc) {
      sheetDoc.eachRow((row, i) => {
        if (i === 1) return;
        const name = row.getCell(1).value?.toString().trim();
        if (name) upsertTeacher.run(name);
      });
    }

    // 3) disciplinas
    const sheetDisc = wb.getWorksheet('disciplinas');
    if (sheetDisc) {
      sheetDisc.eachRow((row, i) => {
        if (i === 1) return;
        const courseName = row.getCell(1).value?.toString().trim();
        const discName   = row.getCell(2).value?.toString().trim();
        if (courseName && discName) {
          upsertCourse.run(courseName);
          const c = getCourse.get(courseName);
          if (c) upsertDiscipline.run(c.id, discName);
        }
      });
    }

    // 4) leccionacao (curso + disciplina + docente + ano + semestre + turma)
    const sheetTeach = wb.getWorksheet('leccionacao');
    if (sheetTeach) {
      sheetTeach.eachRow((row, i) => {
        if (i === 1) return;

        const courseName  = row.getCell(1).value?.toString().trim();
        const discName    = row.getCell(2).value?.toString().trim();
        const teacherName = row.getCell(3).value?.toString().trim();
        const yearName    = row.getCell(4).value?.toString().trim();
        const semName     = row.getCell(5).value?.toString().trim();
        const className   = row.getCell(6).value?.toString().trim(); // opcional

        if (!courseName || !discName || !teacherName || !yearName || !semName) return;

        upsertCourse.run(courseName);
        upsertTeacher.run(teacherName);
        upsertYear.run(yearName);
        upsertSem.run(semName);

        const c = getCourse.get(courseName);
        if (!c) return;

        upsertDiscipline.run(c.id, discName);

        const d = getDiscipline.get(c.id, discName);
        const t = getTeacher.get(teacherName);
        const y = getYear.get(yearName);
        const s = getSem.get(semName);

        let cg = null;
        if (className) {
          upsertClass.run(className);
          cg = getClass.get(className);
        }

        if (d && t && y && s) {
          insTeaching.run(t.id, d.id, s.id, y.id, cg ? cg.id : null);
        }
      });
    }

    res.send(renderPage('Importação concluída', '<p>Importação finalizada.</p>', '', (req.cookies && req.cookies.ispt_admin==='1')));
  } catch (e) {
    res.send(renderPage('Erro na importação', `<p class="text-red-600">Falhou a importação: ${e.message}</p>`, '', (req.cookies && req.cookies.ispt_admin==='1')));
  }
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

  const header = [
    'Data/Hora', 'Curso', 'Semestre', 'Ano lectivo', 'Turma', 'Disciplina', 'Docente', ...qRows.map(q => q.code), 'Comentário'
  ];
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
  await wb.xlsx.write(res);
  res.end();
});

// ====== EXPORT: PDF (Resumo) ======
app.get('/export/pdf', requireAuth, (req, res) => {
  const { course_id, semester_id, discipline_id, teacher_id, school_year_id, class_group_id } = req.query;

  const course = course_id ? db.prepare('SELECT name FROM course WHERE id=?').get(course_id) : null;
  const semester = semester_id ? db.prepare('SELECT name FROM semester WHERE id=?').get(semester_id) : null;
  const discipline = discipline_id ? db.prepare('SELECT name FROM discipline WHERE id=?').get(discipline_id) : null;
  const teacher = teacher_id ? db.prepare('SELECT name FROM teacher WHERE id=?').get(teacher_id) : null;
  const schoolYear = school_year_id ? db.prepare('SELECT name FROM school_year WHERE id=?').get(school_year_id) : null;
  const klass = class_group_id ? db.prepare('SELECT name FROM class_group WHERE id=?').get(class_group_id) : null;

  const stats = db.prepare(`
    SELECT q.code, q.text, q.area, AVG(a.value) as avg_val
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
    ORDER BY q.id
  `).all(course_id || null, semester_id || null, discipline_id || null, teacher_id || null, school_year_id || null, class_group_id || null);

  const comments = db.prepare(`
    SELECT r.comment FROM survey_response r
    JOIN teaching t ON t.id = r.teaching_id
    JOIN discipline d ON d.id = t.discipline_id
    WHERE r.comment IS NOT NULL AND r.comment <> ''
      AND (COALESCE(?, d.course_id) = d.course_id)
      AND (COALESCE(?, t.semester_id) = t.semester_id)
      AND (COALESCE(?, t.discipline_id) = t.discipline_id)
      AND (COALESCE(?, t.teacher_id) = t.teacher_id)
      AND (COALESCE(?, t.school_year_id) = t.school_year_id)
      AND (COALESCE(?, t.class_group_id) = t.class_group_id)
    ORDER BY r.submitted_at DESC LIMIT 100
  `).all(course_id || null, semester_id || null, discipline_id || null, teacher_id || null, school_year_id || null, class_group_id || null);

  const doc = new PDFDocument({ margin: 40 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename="relatorio_avaliacao.pdf"');
  doc.pipe(res);

  doc.fontSize(16).text('ISPT – Relatório de Avaliação Docente', { align: 'center' });
  doc.moveDown();
  doc.fontSize(10).text(`Gerado em: ${dayjs().format('YYYY-MM-DD HH:mm')}`);
  if (course) doc.text(`Curso: ${course.name}`);
  if (semester) doc.text(`Semestre: ${semester.name}`);
  if (schoolYear) doc.text(`Ano lectivo: ${schoolYear.name}`);
  if (klass) doc.text(`Turma: ${klass.name}`);
  if (discipline) doc.text(`Disciplina: ${discipline.name}`);
  if (teacher) doc.text(`Docente: ${teacher.name}`);
  doc.moveDown();

  doc.fontSize(12).text('Médias por questão (0–2)');
  doc.moveDown(0.5);
  stats.forEach(s => {
    const v = s.avg_val != null ? Number(s.avg_val).toFixed(2) : '-';
    doc.fontSize(10).text(`${s.code} (${s.area}) – ${v} – ${s.text}`);
  });

  doc.moveDown();
  doc.fontSize(12).text('Comentários (qualitativo)');
  doc.moveDown(0.5);
  if (comments.length === 0) {
    doc.fontSize(10).text('Sem comentários.');
  } else {
    comments.forEach((c) => { doc.fontSize(10).text(`• ${c.comment}`); });
  }

  doc.end();
});

// ====== API: DASHBOARD (agregado) ======
app.get('/api/dashboard', requireAuth, (req, res) => {
  const { course_id, semester_id, discipline_id, teacher_id, school_year_id, class_group_id } = req.query;

  const q = (sql) => db.prepare(sql).all(
    course_id || null, semester_id || null, discipline_id || null, teacher_id || null, school_year_id || null, class_group_id || null
  );

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

  res.json({
    totalResponses: total,
    teachersEvaluated: docentes,
    avgOverall: avgRow?.m ?? null,
    areas,
    timeseries,
    comments
  });
});

// ====== Página: DASHBOARD (UI) ======
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
      <div class="card">
        <h2 class="text-lg font-semibold mb-2">Médias por área</h2>
        <canvas id="chartAreasDash" height="220"></canvas>
      </div>
      <div class="card">
        <h2 class="text-lg font-semibold mb-2">Respostas por dia</h2>
        <canvas id="chartSerieDash" height="220"></canvas>
      </div>
    </div>

    <div class="mt-6 card">
      <h2 class="text-lg font-semibold mb-3">Comentários recentes</h2>
      <ul id="ulComments" class="space-y-2"></ul>
    </div>

    <script>
      let cAreas, cSerie;
      const pct = x => Math.round((x/2)*100);

      function params() {
        const fd = new FormData(document.getElementById('filtrosDash'));
        const p = new URLSearchParams();
        for (const [k,v] of fd.entries()) if (v) p.append(k,v);
        return p.toString();
      }

      async function load() {
        const res = await fetch('/api/dashboard?' + params());
        const d = await res.json();

        // KPIs
        document.getElementById('k_total').textContent = d.totalResponses ?? 0;
        document.getElementById('k_doc').textContent   = d.teachersEvaluated ?? 0;
        document.getElementById('k_media').textContent = d.avgOverall != null ? Number(d.avgOverall).toFixed(2) : '—';
        document.getElementById('k_idx').textContent   = d.avgOverall != null ? pct(d.avgOverall) + '%' : '—';

        // Áreas (bar)
        const aLabels = d.areas.map(x => x.area);
        const aVals   = d.areas.map(x => Number(x.media).toFixed(2));
        if (cAreas) cAreas.destroy();
        cAreas = new Chart(document.getElementById('chartAreasDash').getContext('2d'), {
          type: 'bar',
          data: { labels: aLabels, datasets: [{ label: 'Média (0–2)', data: aVals, borderWidth: 1 }] },
          options: { scales: { y: { suggestedMin: 0, suggestedMax: 2 } } }
        });

        // Série temporal (line)
        const sLabels = d.timeseries.map(x => x.dia);
        const sVals   = d.timeseries.map(x => x.c);
        if (cSerie) cSerie.destroy();
        cSerie = new Chart(document.getElementById('chartSerieDash').getContext('2d'), {
          type: 'line',
          data: { labels: sLabels, datasets: [{ label: 'Respostas/dia', data: sVals, tension: .3, fill: false }] },
          options: { scales: { y: { beginAtZero: true } } }
        });

        // Comentários
        const ul = document.getElementById('ulComments');
        ul.innerHTML = '';
        (d.comments || []).forEach(c => {
          const li = document.createElement('li');
          li.className = 'p-3 rounded-xl border';
          const dt = new Date(c.submitted_at).toLocaleString();
          li.innerHTML = '<div class="text-xs text-slate-500">'+dt+'</div><div>'+c.comment+'</div>';
          ul.appendChild(li);
        });
        if (!d.comments || !d.comments.length) {
          const li = document.createElement('li');
          li.className = 'text-slate-500';
          li.textContent = 'Sem comentários no período/escopo selecionado.';
          ul.appendChild(li);
        }
      }

      document.getElementById('aplicarDash').addEventListener('click', load);
      load();
    </script>
  `;

  res.send(renderPage('Dashboard', html, '', (req.cookies && req.cookies.ispt_admin==='1')));
});

// ====== INICIAR SERVIDOR ======
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`ISPT – Avaliação Docente a correr em http://localhost:${PORT}`));
