# ISPT – Sistema Web de Avaliação Docente (MVP)

## Stack
- Node.js (Express)
- SQLite (better-sqlite3)
- Tailwind via CDN + Chart.js
- Export: Excel (exceljs) e PDF (pdfkit)

## Executar local
```bash
npm i
cp .env.example .env
# edita ADMIN_PASSWORD
node app.js
# abre http://localhost:3000
