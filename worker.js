// ============================================================
// 土地家屋調査士 合格アプリ — Cloudflare Worker
// ============================================================

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const jsonHeaders = { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' };

// ---- 科目・論点マスタ (Worker側でも保持) ----
const SUBJECTS = {
  '不動産登記法': [
    '表示に関する登記の総則', '土地の表示に関する登記', '建物の表示に関する登記',
    '区分建物の表示に関する登記', '登記手続き', '登記識別情報', '登記官の審査',
  ],
  '土地家屋調査士法': [
    '業務範囲', '資格・登録', '義務・禁止事項', '懲戒',
  ],
  '民法': [
    '不動産物権変動', '共有', '時効', '抵当権', '賃貸借',
  ],
  '不動産登記規則': [
    '添付情報', '地目・地積', '種類・構造・床面積', '建物図面・各階平面図',
  ],
  '筆界特定': [
    '筆界特定制度', '手続き', '筆界特定登記官',
  ],
};

// ---- ソートキー ----
const qOrder = `
  CASE substr(question_id,1,1) WHEN 'H' THEN 1 WHEN 'R' THEN 2 ELSE 9 END,
  CAST(substr(question_id,2,2) AS INTEGER),
  number
`;
const qOrderQ = `
  CASE substr(q.question_id,1,1) WHEN 'H' THEN 1 WHEN 'R' THEN 2 ELSE 9 END,
  CAST(substr(q.question_id,2,2) AS INTEGER),
  q.number
`;

// ============================================================
// メインハンドラ
// ============================================================
export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

    try {
      const url  = new URL(request.url);
      const path = url.pathname;
      const m    = request.method;

      // --- 静的HTML ---
      if (m === 'GET' && path === '/')      return html(STUDY_HTML);
      if (m === 'GET' && path === '/admin') return html(ADMIN_HTML);

      // --- 学習系 API ---
      if (m === 'GET'  && path === '/api/today')          return json(await getToday(env));
      if (m === 'GET'  && path === '/api/answers/wrong')  return json(await getWrongQuestions(env));
      if (m === 'GET'  && path === '/api/stats')          return json(await getStats(env));
      if (m === 'POST' && path === '/api/answers')        return json(await postAnswer(request, env), 201);
      if (m === 'GET'  && path === '/api/daily-tasks')    return json(await getDailyTasks(env, url.searchParams.get('date') || todayJst()));
      if (m === 'POST' && path === '/api/daily-tasks')    return json(await postDailyTask(request, env), 201);

      // --- 問題管理 API ---
      if (m === 'GET'  && path === '/api/questions')            return json(await getQuestions(env, url));
      if (m === 'POST' && path === '/api/questions/link')       return json(await postQuestionLink(request, env), 200);
      if (m === 'POST' && path === '/api/questions/meta')       return json(await postQuestionMeta(request, env), 200);

      // --- PDF管理 API ---
      if (m === 'GET'  && path === '/api/pdf-files')            return json(await getPdfFiles(env));
      if (m === 'POST' && path === '/api/pdf-files')            return json(await postPdfFile(request, env), 201);
      if (m === 'GET'  && path === '/api/pdf-pages')            return json(await getPdfPages(env, url));
      if (m === 'POST' && path === '/api/pdf-pages')            return json(await postPdfPage(request, env), 201);
      if (m === 'POST' && path === '/api/pdf-pages/bulk')       return json(await bulkPostPdfPages(request, env), 200);
      if (m === 'DELETE' && path === '/api/pdf-pages')          return json(await deletePdfPage(request, env), 200);

      // --- マスタ ---
      if (m === 'GET'  && path === '/api/subjects')             return json({ subjects: SUBJECTS });

      return json({ error: 'Not found' }, 404);
    } catch (error) {
      return json({ error: error.message || 'Internal error' }, 500);
    }
  },
};

// ============================================================
// ユーティリティ
// ============================================================
function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: jsonHeaders });
}

function html(body) {
  return new Response(body, { headers: { ...corsHeaders, 'Content-Type': 'text/html; charset=utf-8' } });
}

function todayJst() {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

async function readJson(request) {
  try { return await request.json(); }
  catch { throw new Error('Invalid JSON body'); }
}

function countStreak(days) {
  const set = new Set(days);
  let cursor = new Date(`${todayJst()}T00:00:00+09:00`);
  let count = 0;
  while (set.has(cursor.toISOString().slice(0, 10))) {
    count++;
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return count;
}

// ============================================================
// 学習系
// ============================================================
async function getToday(env) {
  const { results: wrong } = await env.DB.prepare(`
    WITH latest AS (
      SELECT question_id, result, answered_at,
             ROW_NUMBER() OVER (PARTITION BY question_id ORDER BY answered_at DESC, id DESC) AS rn
      FROM answers
    )
    SELECT q.question_id, q.type, q.year_label, q.number,
           q.subject, q.topic, q.video_url, q.pdf_url, q.pdf_page,
           l.answered_at AS last_answered_at
    FROM latest l
    JOIN questions q ON q.question_id = l.question_id
    WHERE l.rn = 1 AND l.result = 'wrong'
    ORDER BY l.answered_at ASC LIMIT 10
  `).all();

  const remaining = Math.max(0, 10 - wrong.length);
  let fill = [];
  if (remaining > 0) {
    const excl = wrong.map(q => q.question_id);
    const ph = excl.map(() => '?').join(',');
    const exc = excl.length ? `WHERE q.question_id NOT IN (${ph})` : '';
    const { results } = await env.DB.prepare(`
      SELECT q.question_id, q.type, q.year_label, q.number,
             q.subject, q.topic, q.video_url, q.pdf_url, q.pdf_page,
             COUNT(a.id) AS attempts, MAX(a.answered_at) AS last_answered_at
      FROM questions q
      LEFT JOIN answers a ON a.question_id = q.question_id
      ${exc}
      GROUP BY q.question_id
      ORDER BY attempts ASC, ${qOrderQ}
      LIMIT ?
    `).bind(...excl, remaining).all();
    fill = results;
  }

  return { date: todayJst(), questions: [...wrong, ...fill].slice(0, 10) };
}

async function getWrongQuestions(env) {
  const { results } = await env.DB.prepare(`
    WITH latest AS (
      SELECT question_id, result, answered_at,
             ROW_NUMBER() OVER (PARTITION BY question_id ORDER BY answered_at DESC, id DESC) AS rn
      FROM answers
    ),
    counts AS (
      SELECT question_id,
             SUM(CASE WHEN result='wrong' THEN 1 ELSE 0 END) AS wrong_count,
             SUM(CASE WHEN result='correct' THEN 1 ELSE 0 END) AS correct_count,
             MAX(CASE WHEN result='wrong' THEN answered_at END) AS last_wrong_at
      FROM answers GROUP BY question_id
    )
    SELECT q.question_id, q.type, q.year_label, q.number,
           q.subject, q.topic, q.video_url, q.pdf_url, q.pdf_page,
           c.wrong_count, c.correct_count, c.last_wrong_at
    FROM latest l
    JOIN questions q ON q.question_id = l.question_id
    JOIN counts c ON c.question_id = q.question_id
    WHERE l.rn = 1 AND l.result = 'wrong'
      AND date(l.answered_at) >= date('now','-30 day')
    ORDER BY c.last_wrong_at DESC, ${qOrderQ}
  `).all();
  return { questions: results };
}

async function getStats(env) {
  const [total, correct, answeredQ, totalQ] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) AS c FROM answers").first(),
    env.DB.prepare("SELECT COUNT(*) AS c FROM answers WHERE result='correct'").first(),
    env.DB.prepare("SELECT COUNT(DISTINCT question_id) AS c FROM answers").first(),
    env.DB.prepare("SELECT COUNT(*) AS c FROM questions").first(),
  ]);
  const { results: byYear } = await env.DB.prepare(`
    SELECT q.year_label,
           COUNT(a.id) AS attempts,
           SUM(CASE WHEN a.result='correct' THEN 1 ELSE 0 END) AS correct,
           ROUND(100.0*SUM(CASE WHEN a.result='correct' THEN 1 ELSE 0 END)/NULLIF(COUNT(a.id),0),1) AS rate
    FROM questions q LEFT JOIN answers a ON a.question_id=q.question_id
    GROUP BY q.year_label
    ORDER BY CASE substr(q.year_label,1,1) WHEN 'H' THEN 1 WHEN 'R' THEN 2 ELSE 9 END,
             CAST(substr(q.year_label,2,2) AS INTEGER)
  `).all();
  const { results: bySubject } = await env.DB.prepare(`
    SELECT q.subject,
           COUNT(a.id) AS attempts,
           SUM(CASE WHEN a.result='correct' THEN 1 ELSE 0 END) AS correct,
           ROUND(100.0*SUM(CASE WHEN a.result='correct' THEN 1 ELSE 0 END)/NULLIF(COUNT(a.id),0),1) AS rate
    FROM questions q LEFT JOIN answers a ON a.question_id=q.question_id
    WHERE q.subject IS NOT NULL
    GROUP BY q.subject
  `).all();
  const { results: days } = await env.DB.prepare(
    "SELECT DISTINCT substr(answered_at,1,10) AS day FROM answers ORDER BY day DESC LIMIT 400"
  ).all();
  const t = total.c || 0, c = correct.c || 0;
  return {
    totals: {
      answers: t, correct: c, wrong: t - c,
      correct_rate: t ? Math.round(c / t * 1000) / 10 : 0,
      answered_questions: answeredQ.c || 0,
      total_questions: totalQ.c || 0,
      streak_days: countStreak(days.map(r => r.day)),
    },
    by_year: byYear,
    by_subject: bySubject,
  };
}

async function postAnswer(request, env) {
  const b = await readJson(request);
  const questionId  = String(b.question_id || '').trim();
  const result      = String(b.result || '').trim();
  const answeredAt  = String(b.answered_at || todayJst()).trim();
  if (!questionId || !['correct','wrong'].includes(result)) throw new Error('question_id and result required');
  const exists = await env.DB.prepare('SELECT 1 FROM questions WHERE question_id=?').bind(questionId).first();
  if (!exists) throw new Error(`Unknown question_id: ${questionId}`);
  const info = await env.DB.prepare(
    'INSERT INTO answers (question_id, result, answered_at) VALUES (?,?,?)'
  ).bind(questionId, result, answeredAt).run();
  return { ok: true, id: info.meta.last_row_id };
}

async function getDailyTasks(env, date) {
  const defaults = [
    { task_id: 'watch_video',    title: '解説動画を1本見る' },
    { task_id: 'solve_questions',title: '択一を10問解く' },
    { task_id: 'review_wrong',   title: '誤答を見直す' },
    { task_id: 'write_note',     title: '分からない点を1つ記録する' },
  ];
  const { results } = await env.DB.prepare('SELECT task_id, done FROM daily_tasks WHERE task_date=?').bind(date).all();
  const saved = new Map(results.map(r => [r.task_id, r.done]));
  return { task_date: date, tasks: defaults.map(t => ({ ...t, done: saved.get(t.task_id) || 0 })) };
}

async function postDailyTask(request, env) {
  const b = await readJson(request);
  const taskDate = String(b.task_date || todayJst()).trim();
  const taskId   = String(b.task_id || '').trim();
  const done     = b.done ? 1 : 0;
  if (!taskDate || !taskId) throw new Error('task_date and task_id required');
  await env.DB.prepare(`
    INSERT INTO daily_tasks (task_date, task_id, done, updated_at) VALUES (?,?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(task_date, task_id) DO UPDATE SET done=excluded.done, updated_at=CURRENT_TIMESTAMP
  `).bind(taskDate, taskId, done).run();
  return { ok: true };
}

// ============================================================
// 問題管理
// ============================================================
async function getQuestions(env, url) {
  const subject = url.searchParams.get('subject') || '';
  const topic   = url.searchParams.get('topic') || '';
  const year    = url.searchParams.get('year') || '';
  const limit   = Math.min(parseInt(url.searchParams.get('limit') || '100', 10), 500);
  const offset  = parseInt(url.searchParams.get('offset') || '0', 10);

  const wheres = [];
  const params = [];
  if (subject) { wheres.push('subject=?');    params.push(subject); }
  if (topic)   { wheres.push('topic=?');      params.push(topic); }
  if (year)    { wheres.push('year_label=?'); params.push(year); }
  const where = wheres.length ? 'WHERE ' + wheres.join(' AND ') : '';

  const { results } = await env.DB.prepare(`
    SELECT question_id, type, year_label, number, subject, topic, video_url, pdf_url, pdf_page
    FROM questions ${where}
    ORDER BY ${qOrder}
    LIMIT ? OFFSET ?
  `).bind(...params, limit, offset).all();

  const countRow = await env.DB.prepare(`SELECT COUNT(*) AS c FROM questions ${where}`)
    .bind(...params).first();

  return { questions: results, total: countRow.c };
}

async function postQuestionLink(request, env) {
  const b = await readJson(request);
  const questionId = String(b.question_id || '').trim();
  const field      = String(b.field || '').trim();
  const value      = String(b.url ?? b.value ?? '').trim();

  const allowed = ['pdf_url','video_url','pdf_page'];
  if (!questionId || !allowed.includes(field)) throw new Error('question_id and valid field required');
  const exists = await env.DB.prepare('SELECT 1 FROM questions WHERE question_id=?').bind(questionId).first();
  if (!exists) throw new Error(`Unknown question_id: ${questionId}`);

  if (field === 'pdf_page') {
    const page = parseInt(value, 10);
    if (isNaN(page) || page < 1) throw new Error('pdf_page must be a positive integer');
    await env.DB.prepare(`UPDATE questions SET pdf_page=? WHERE question_id=?`).bind(page, questionId).run();
  } else {
    await env.DB.prepare(`UPDATE questions SET ${field}=? WHERE question_id=?`).bind(value, questionId).run();
  }
  return { ok: true };
}

async function postQuestionMeta(request, env) {
  const b = await readJson(request);
  const questionId = String(b.question_id || '').trim();
  const subject    = b.subject !== undefined ? String(b.subject).trim() : null;
  const topic      = b.topic   !== undefined ? String(b.topic).trim()   : null;

  if (!questionId) throw new Error('question_id required');
  const exists = await env.DB.prepare('SELECT 1 FROM questions WHERE question_id=?').bind(questionId).first();
  if (!exists) throw new Error(`Unknown question_id: ${questionId}`);

  // subjectやtopicがnullの場合はNULLにリセット
  await env.DB.prepare(`UPDATE questions SET subject=?, topic=? WHERE question_id=?`)
    .bind(subject || null, topic || null, questionId).run();
  return { ok: true };
}

// ============================================================
// PDF管理
// ============================================================
async function getPdfFiles(env) {
  const { results } = await env.DB.prepare(
    'SELECT pdf_id, title, drive_url, total_pages, created_at, updated_at FROM pdf_files ORDER BY created_at DESC'
  ).all();
  return { pdf_files: results };
}

async function postPdfFile(request, env) {
  const b = await readJson(request);
  const pdfId      = String(b.pdf_id || '').trim();
  const title      = String(b.title  || '').trim();
  const driveUrl   = String(b.drive_url   || '').trim() || null;
  const totalPages = b.total_pages ? parseInt(b.total_pages, 10) : null;
  if (!pdfId || !title) throw new Error('pdf_id and title required');
  await env.DB.prepare(`
    INSERT INTO pdf_files (pdf_id, title, drive_url, total_pages)
    VALUES (?,?,?,?)
    ON CONFLICT(pdf_id) DO UPDATE SET
      title=excluded.title, drive_url=excluded.drive_url,
      total_pages=excluded.total_pages, updated_at=CURRENT_TIMESTAMP
  `).bind(pdfId, title, driveUrl, totalPages).run();
  return { ok: true };
}

async function getPdfPages(env, url) {
  const pdfId = url.searchParams.get('pdf_id') || '';
  if (!pdfId) throw new Error('pdf_id required');
  const { results } = await env.DB.prepare(`
    SELECT pp.id, pp.pdf_id, pp.page_no, pp.question_id, pp.label,
           q.year_label, q.number, q.subject, q.topic
    FROM pdf_pages pp
    LEFT JOIN questions q ON q.question_id = pp.question_id
    WHERE pp.pdf_id=?
    ORDER BY pp.page_no
  `).bind(pdfId).all();
  return { pdf_id: pdfId, pages: results };
}

async function postPdfPage(request, env) {
  const b = await readJson(request);
  const pdfId      = String(b.pdf_id || '').trim();
  const pageNo     = parseInt(b.page_no, 10);
  const questionId = b.question_id ? String(b.question_id).trim() : null;
  const label      = b.label ? String(b.label).trim() : null;
  if (!pdfId || isNaN(pageNo)) throw new Error('pdf_id and page_no required');
  await env.DB.prepare(`
    INSERT INTO pdf_pages (pdf_id, page_no, question_id, label) VALUES (?,?,?,?)
    ON CONFLICT(pdf_id, page_no) DO UPDATE SET question_id=excluded.question_id, label=excluded.label
  `).bind(pdfId, pageNo, questionId, label).run();
  return { ok: true };
}

async function bulkPostPdfPages(request, env) {
  const b = await readJson(request);
  const pdfId = String(b.pdf_id || '').trim();
  const pages = Array.isArray(b.pages) ? b.pages : [];
  if (!pdfId || pages.length === 0) throw new Error('pdf_id and pages[] required');

  // D1 batch insert
  const stmts = pages.map(p => {
    const pageNo     = parseInt(p.page_no, 10);
    const questionId = p.question_id ? String(p.question_id).trim() : null;
    const label      = p.label ? String(p.label).trim() : null;
    return env.DB.prepare(`
      INSERT INTO pdf_pages (pdf_id, page_no, question_id, label) VALUES (?,?,?,?)
      ON CONFLICT(pdf_id, page_no) DO UPDATE SET question_id=excluded.question_id, label=excluded.label
    `).bind(pdfId, pageNo, questionId, label);
  });
  await env.DB.batch(stmts);
  return { ok: true, count: pages.length };
}

async function deletePdfPage(request, env) {
  const b = await readJson(request);
  const pdfId  = String(b.pdf_id || '').trim();
  const pageNo = parseInt(b.page_no, 10);
  if (!pdfId || isNaN(pageNo)) throw new Error('pdf_id and page_no required');
  await env.DB.prepare('DELETE FROM pdf_pages WHERE pdf_id=? AND page_no=?').bind(pdfId, pageNo).run();
  return { ok: true };
}

// ============================================================
// 学習画面 HTML (index.html の内容を埋め込み)
// ============================================================
const STUDY_HTML = `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>土地家屋調査士 合格アプリ</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400;600;700;800&display=swap" rel="stylesheet">
  <style>
    :root{--green:#1f6130;--green-2:#2f7a43;--bg:#f4f7f2;--card:#ffffff;--line:#d9e2d7;--text:#203127;--muted:#617066;--danger:#b0392d}
    *{box-sizing:border-box}
    body{margin:0;background:var(--bg);color:var(--text);font-family:"Noto Sans JP",system-ui,sans-serif;line-height:1.6}
    .app{width:min(100%,480px);min-height:100vh;margin:0 auto;background:#fbfdf9;box-shadow:0 0 0 1px rgba(31,97,48,.08)}
    header{padding:18px 16px 12px;background:var(--green);color:#fff}
    header a{color:rgba(255,255,255,.8);font-size:12px;text-decoration:none;border:1px solid rgba(255,255,255,.4);border-radius:6px;padding:4px 10px;float:right;margin-top:2px}
    h1{margin:0;font-size:20px;font-weight:800}
    .sub{margin:4px 0 0;color:rgba(255,255,255,.82);font-size:12px}
    .tabs{position:sticky;top:0;z-index:20;display:grid;grid-template-columns:repeat(4,1fr);background:#fff;border-bottom:1px solid var(--line)}
    .tab{appearance:none;border:0;border-bottom:3px solid transparent;background:#fff;color:var(--muted);padding:10px 4px 8px;font:inherit;font-size:13px;font-weight:700;cursor:pointer}
    .tab.active{color:var(--green);border-bottom-color:var(--green)}
    main{padding:14px 12px 28px}.panel{display:none}.panel.active{display:block}
    .card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:14px;margin:0 0 12px;box-shadow:0 4px 12px rgba(22,43,27,.04)}
    .row{display:flex;align-items:center;justify-content:space-between;gap:10px}
    h2{margin:0 0 10px;font-size:16px;color:var(--green)}h3{margin:0;font-size:16px;font-weight:800}
    .muted{color:var(--muted);font-size:13px}.small{font-size:12px}.status{min-height:20px;margin:8px 0 0;color:var(--muted);font-size:13px}.error{color:var(--danger)}
    .tag{display:inline-block;font-size:11px;padding:2px 7px;border-radius:99px;background:#e8f0e9;color:var(--green);font-weight:700;margin:0 4px 4px 0}
    button,.btn{min-height:40px;border:1px solid var(--green);border-radius:8px;background:var(--green);color:#fff;padding:8px 12px;font:inherit;font-weight:700;text-decoration:none;text-align:center;cursor:pointer;display:inline-block}
    button.secondary,.btn.secondary{background:#fff;color:var(--green)}
    button.danger{border-color:var(--danger);background:var(--danger)}
    button:disabled,.btn.disabled{border-color:#c9d3c8;background:#edf1ec;color:#849083;cursor:not-allowed;pointer-events:none}
    .q-actions{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:12px}
    .task{display:grid;grid-template-columns:26px 1fr;gap:8px;align-items:start;padding:10px 0;border-top:1px solid var(--line)}
    .task:first-child{border-top:0}
    input[type=checkbox]{width:20px;height:20px;accent-color:var(--green)}
    .progress-track{height:10px;border-radius:999px;background:#e4ebe2;overflow:hidden;margin-top:8px}
    .progress-bar{height:100%;width:0;background:var(--green);transition:width .2s}
    .stats-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:8px}
    .stat{padding:10px;border:1px solid var(--line);border-radius:8px;background:#f7faf6}
    .stat b{display:block;font-size:22px;color:var(--green)}
    table{width:100%;border-collapse:collapse;font-size:13px}
    th,td{border-bottom:1px solid var(--line);padding:8px 4px;text-align:left}th{color:var(--muted);font-weight:700}
    .modal{position:fixed;inset:0;z-index:100;display:none}.modal.active{display:block}
    .modal-backdrop{position:absolute;inset:0;background:rgba(0,0,0,.62)}
    .modal-content{position:absolute;inset:5vh 10px;display:flex;flex-direction:column;gap:8px;max-width:720px;margin:0 auto;background:#fff;border-radius:8px;padding:10px}
    .modal iframe{width:100%;flex:1;border:0;border-radius:6px;background:#111}
  </style>
</head>
<body>
<div class="app">
  <header>
    <a href="/admin">管理</a>
    <h1>土地家屋調査士 合格アプリ</h1>
    <p class="sub">過去問から逆算して、毎日10問と誤答復習を機械的に進める</p>
  </header>
  <nav class="tabs">
    <button class="tab active" data-tab="today">今日</button>
    <button class="tab" data-tab="wrong">誤答</button>
    <button class="tab" data-tab="stats">統計</button>
    <button class="tab" data-tab="plan">計画</button>
  </nav>
  <main>
    <section id="today" class="panel active">
      <div class="card">
        <div class="row"><div><h2>今日のノルマ</h2><div id="today-date" class="muted"></div></div><button class="secondary" id="reload-today">更新</button></div>
        <div id="task-list"></div>
        <div class="progress-track"><div class="progress-bar" id="task-progress"></div></div>
        <p class="status" id="today-status"></p>
      </div>
      <div id="today-questions"></div>
    </section>
    <section id="wrong" class="panel">
      <div class="card">
        <div class="row"><div><h2>誤答リスト</h2><p class="muted">最後に間違えた問題を優先表示します。</p></div><button class="secondary" id="reload-wrong">更新</button></div>
      </div>
      <div id="wrong-list"></div>
    </section>
    <section id="stats" class="panel">
      <div class="card">
        <div class="row"><h2>統計</h2><button class="secondary" id="reload-stats">更新</button></div>
        <div class="stats-grid" id="stats-summary"></div>
      </div>
      <div class="card"><h2>年度別</h2><div id="stats-years"></div></div>
      <div class="card"><h2>科目別</h2><div id="stats-subjects"></div></div>
    </section>
    <section id="plan" class="panel">
      <div class="card">
        <h2>フェーズ</h2>
        <div style="display:grid;gap:8px">
          <div style="border-left:4px solid var(--green);padding:8px 10px;background:#f7faf6;border-radius:0 8px 8px 0"><b>Ph1 2026/6/27-2027/1/31</b><br><span class="muted">択一を回し、解説動画で答え合わせ。誤答を翌日へ戻す。</span></div>
          <div style="border-left:4px solid var(--green);padding:8px 10px;background:#f7faf6;border-radius:0 8px 8px 0"><b>Ph2 2027/2/1-2027/6/30</b><br><span class="muted">誤答問題を重点復習。正答率70%超えで次年度へ。</span></div>
          <div style="border-left:4px solid var(--green);padding:8px 10px;background:#f7faf6;border-radius:0 8px 8px 0"><b>Ph3 2027/7/1-2027/8/31</b><br><span class="muted">記述式、複素数、定規を毎日パターン化。</span></div>
          <div style="border-left:4px solid var(--green);padding:8px 10px;background:#f7faf6;border-radius:0 8px 8px 0"><b>Ph4 2027/9/1-2027/10/15</b><br><span class="muted">答練を本番形式。残った誤答だけ潰す。</span></div>
        </div>
      </div>
    </section>
  </main>
</div>
<div class="modal" id="video-modal">
  <div class="modal-backdrop" id="modal-backdrop"></div>
  <div class="modal-content">
    <div class="row"><h2 id="modal-title">解説動画</h2><button class="secondary" id="close-modal">閉じる</button></div>
    <iframe id="video-frame" allow="autoplay; encrypted-media" allowfullscreen></iframe>
  </div>
</div>
<script>
const $=s=>document.querySelector(s);
const $$=s=>Array.from(document.querySelectorAll(s));
const state={tasks:[],today:null};

function todayText(){return new Intl.DateTimeFormat('ja-JP',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit',weekday:'short'}).format(new Date())}
function todayIso(){return new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date())}
function esc(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function driveId(v){v=String(v||'').trim();if(!v)return '';const m=v.match(/\\/d\\/([^/]+)/)||v.match(/[?&]id=([^&]+)/);return m?m[1]:v}
function drivePreview(v){const id=driveId(v);return id?'https://drive.google.com/file/d/'+encodeURIComponent(id)+'/preview':''}
function driveView(v){v=String(v||'').trim();if(!v)return '';if(/^https?:\\/\\//.test(v))return v;return 'https://drive.google.com/file/d/'+encodeURIComponent(v)+'/view?usp=sharing'}
function pdfPageUrl(v,page){const url=driveView(v);const p=parseInt(page,10);if(!url||!p)return url;return url.replace(/#.*$/,'')+'#page='+p}

async function api(path,opt){
  const r=await fetch(path,Object.assign({headers:{'Content-Type':'application/json'}},opt||{}));
  const d=await r.json();if(!r.ok)throw new Error(d.error||'APIエラー');return d;
}

function qCard(q){
  const title=esc(q.year_label)+' 第'+esc(q.number)+'問';
  const pdfUrl=pdfPageUrl(q.pdf_url,q.pdf_page);
  const subTag=q.subject?'<span class="tag">'+esc(q.subject)+'</span>':'';
  const topTag=q.topic?'<span class="tag">'+esc(q.topic)+'</span>':'';
  const wrongBadge=q.wrong_count?'<div class="muted small">誤答 '+q.wrong_count+'回</div>':'';
  return '<article class="card"><div class="row"><div><h3>'+title+'</h3><div class="muted">'+esc(q.question_id)+'</div>'+subTag+topTag+'</div>'+wrongBadge+'</div>'
    +'<div class="q-actions">'
    +(q.video_url?'<button class="secondary" data-video="'+esc(q.video_url)+'" data-title="'+title+'">解説動画</button>':'<button class="secondary" disabled>動画なし</button>')
    +(pdfUrl?'<a class="btn secondary" href="'+esc(pdfUrl)+'" target="_blank" rel="noopener">問題PDF</a>':'<button class="secondary" disabled>PDFなし</button>')
    +'</div><div class="q-actions">'
    +'<button data-answer="'+esc(q.question_id)+'" data-result="correct">正解</button>'
    +'<button class="danger" data-answer="'+esc(q.question_id)+'" data-result="wrong">不正解</button>'
    +'</div></article>';
}

function emptyCard(msg,err){return '<div class="card"><p class="'+(err?'error':'muted')+'">'+esc(msg)+'</p></div>'}
function statBox(label,val){return '<div class="stat"><span class="muted">'+esc(label)+'</span><b>'+esc(String(val))+'</b></div>'}

async function loadToday(){
  $('#today-date').textContent=todayText();
  $('#today-status').textContent='読み込み中...';
  try{
    const[tasks,today]=await Promise.all([api('/api/daily-tasks?date='+todayIso()),api('/api/today')]);
    state.tasks=tasks.tasks;state.today=today;
    renderTasks();
    $('#today-questions').innerHTML=today.questions.map(qCard).join('')||emptyCard('今日の問題がありません。');
    $('#today-status').textContent='今日の出題 '+today.questions.length+'問';
  }catch(e){$('#today-status').innerHTML='<span class="error">'+esc(e.message)+'</span>'}
}

function renderTasks(){
  $('#task-list').innerHTML=state.tasks.map(t=>'<label class="task"><input type="checkbox" data-task="'+esc(t.task_id)+'" '+(t.done?'checked':'')+'><span>'+esc(t.title)+'</span></label>').join('');
  const done=state.tasks.filter(t=>t.done).length;
  $('#task-progress').style.width=Math.round(done/Math.max(state.tasks.length,1)*100)+'%';
}

async function loadWrong(){
  $('#wrong-list').innerHTML=emptyCard('読み込み中...');
  try{const d=await api('/api/answers/wrong');$('#wrong-list').innerHTML=d.questions.map(qCard).join('')||emptyCard('直近30日の誤答はありません。')}
  catch(e){$('#wrong-list').innerHTML=emptyCard(e.message,true)}
}

async function loadStats(){
  try{
    const d=await api('/api/stats');const t=d.totals;
    $('#stats-summary').innerHTML=statBox('正答率',t.correct_rate+'%')+statBox('回答数',t.answers)+statBox('消化問題',t.answered_questions+'/'+t.total_questions)+statBox('連続日数',t.streak_days+'日');
    $('#stats-years').innerHTML='<table><thead><tr><th>年度</th><th>回答</th><th>正解</th><th>率</th></tr></thead><tbody>'
      +d.by_year.map(r=>'<tr><td>'+esc(r.year_label)+'</td><td>'+r.attempts+'</td><td>'+r.correct+'</td><td>'+(r.rate||0)+'%</td></tr>').join('')+'</tbody></table>';
    $('#stats-subjects').innerHTML=d.by_subject.length
      ?'<table><thead><tr><th>科目</th><th>回答</th><th>率</th></tr></thead><tbody>'
        +d.by_subject.map(r=>'<tr><td>'+esc(r.subject||'未分類')+'</td><td>'+r.attempts+'</td><td>'+(r.rate||0)+'%</td></tr>').join('')+'</tbody></table>'
      :'<p class="muted">科目データがまだありません（管理画面で設定）。</p>';
  }catch(e){$('#stats-summary').innerHTML='<p class="error">'+esc(e.message)+'</p>'}
}

document.addEventListener('click',async e=>{
  const tab=e.target.closest('[data-tab]');
  if(tab){$$('.tab').forEach(x=>x.classList.toggle('active',x===tab));$$('.panel').forEach(x=>x.classList.toggle('active',x.id===tab.dataset.tab));if(tab.dataset.tab==='wrong')loadWrong();if(tab.dataset.tab==='stats')loadStats();return}
  const vid=e.target.closest('[data-video]');
  if(vid&&!vid.disabled){const url=drivePreview(vid.dataset.video);if(url){$('#modal-title').textContent=vid.dataset.title||'解説動画';$('#video-frame').src=url;$('#video-modal').classList.add('active')}return}
  const ans=e.target.closest('[data-answer]');
  if(ans){ans.disabled=true;try{await api('/api/answers',{method:'POST',body:JSON.stringify({question_id:ans.dataset.answer,result:ans.dataset.result,answered_at:todayIso()})});await loadToday()}catch(err){alert(err.message);ans.disabled=false}}
});

document.addEventListener('change',async e=>{
  const c=e.target.closest('[data-task]');if(!c)return;c.disabled=true;
  try{await api('/api/daily-tasks',{method:'POST',body:JSON.stringify({task_date:todayIso(),task_id:c.dataset.task,done:c.checked?1:0})});const t=state.tasks.find(x=>x.task_id===c.dataset.task);if(t)t.done=c.checked?1:0;renderTasks()}
  catch(err){alert(err.message);c.checked=!c.checked}finally{c.disabled=false}
});

$('#reload-today').addEventListener('click',loadToday);
$('#reload-wrong').addEventListener('click',loadWrong);
$('#reload-stats').addEventListener('click',loadStats);
$('#close-modal').addEventListener('click',()=>{$('#video-modal').classList.remove('active');$('#video-frame').src=''});
$('#modal-backdrop').addEventListener('click',()=>{$('#video-modal').classList.remove('active');$('#video-frame').src=''});
loadToday();
</script>
</body>
</html>`;

// ============================================================
// 管理画面 HTML (/admin)
// ============================================================
const ADMIN_HTML = `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>管理画面 — 土地家屋調査士</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400;600;700&display=swap" rel="stylesheet">
  <style>
    :root{--green:#1f6130;--bg:#f4f7f2;--card:#fff;--line:#d9e2d7;--text:#203127;--muted:#617066;--danger:#b0392d}
    *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:"Noto Sans JP",system-ui,sans-serif;line-height:1.6}
    .app{max-width:900px;margin:0 auto;padding:16px 12px 40px}
    header{background:var(--green);color:#fff;padding:14px 16px;border-radius:8px;margin-bottom:16px;display:flex;align-items:center;justify-content:space-between}
    header h1{margin:0;font-size:18px}header a{color:rgba(255,255,255,.8);font-size:13px;text-decoration:none;border:1px solid rgba(255,255,255,.4);border-radius:6px;padding:4px 12px}
    .tabs{display:flex;gap:4px;margin-bottom:16px;border-bottom:1px solid var(--line)}
    .tab{padding:10px 18px;border:0;border-bottom:3px solid transparent;background:none;font:inherit;font-size:14px;font-weight:700;color:var(--muted);cursor:pointer}
    .tab.active{color:var(--green);border-bottom-color:var(--green)}
    .panel{display:none}.panel.active{display:block}
    .card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:16px;margin-bottom:14px}
    h2{margin:0 0 12px;font-size:15px;color:var(--green)}
    label{display:block;font-size:13px;font-weight:700;margin:10px 0 4px}
    select,input[type=text],input[type=url],input[type=number]{width:100%;padding:9px 10px;border:1px solid var(--line);border-radius:7px;font:inherit;background:#fff}
    select{cursor:pointer}
    .row{display:flex;gap:10px;align-items:flex-end}
    .row>*{flex:1}.row>button{flex:0 0 auto;min-width:80px}
    button{min-height:40px;border:1px solid var(--green);border-radius:8px;background:var(--green);color:#fff;padding:8px 14px;font:inherit;font-weight:700;cursor:pointer}
    button.secondary{background:#fff;color:var(--green)}button.danger{border-color:var(--danger);background:var(--danger)}
    button:disabled{border-color:#c9d3c8;background:#edf1ec;color:#849083;cursor:not-allowed}
    .status{margin:8px 0 0;font-size:13px;color:var(--muted);min-height:20px}.error{color:var(--danger)}
    table{width:100%;border-collapse:collapse;font-size:13px}
    th,td{border-bottom:1px solid var(--line);padding:7px 6px;text-align:left}th{color:var(--muted);font-weight:700}
    tr:hover td{background:#f9fbf8}
    .tag{display:inline-block;font-size:11px;padding:2px 7px;border-radius:99px;background:#e8f0e9;color:var(--green);font-weight:700}
    .btn-sm{min-height:32px;padding:4px 10px;font-size:12px}
    textarea{width:100%;padding:9px 10px;border:1px solid var(--line);border-radius:7px;font:inherit;font-size:13px;min-height:120px;background:#fff}
    .filter-row{display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;margin-bottom:12px}
    .filter-row>*{flex:1;min-width:120px}
    .filter-row>button{flex:0 0 auto}
    .pagination{display:flex;gap:8px;margin-top:12px;align-items:center;font-size:13px}
    .pdf-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:10px}
  </style>
</head>
<body>
<div class="app">
  <header>
    <h1>管理画面</h1>
    <a href="/">← 学習画面</a>
  </header>
  <div class="tabs">
    <button class="tab active" data-tab="questions">問題管理</button>
    <button class="tab" data-tab="pdf">PDF管理</button>
  </div>

  <!-- ===== 問題管理タブ ===== -->
  <section id="questions" class="panel active">
    <div class="card">
      <h2>絞り込み</h2>
      <div class="filter-row">
        <div><label>科目</label><select id="f-subject"><option value="">すべて</option></select></div>
        <div><label>論点</label><select id="f-topic"><option value="">すべて</option></select></div>
        <div><label>年度</label><select id="f-year"><option value="">すべて</option></select></div>
        <button id="btn-filter">絞り込む</button>
      </div>
    </div>
    <div class="card">
      <h2>問題一覧</h2>
      <div id="q-table-wrap"><p class="muted">読み込み中…</p></div>
      <div class="pagination">
        <button class="secondary btn-sm" id="prev-page">◀ 前</button>
        <span id="page-info"></span>
        <button class="secondary btn-sm" id="next-page">次 ▶</button>
      </div>
    </div>

    <!-- 一括登録フォーム（編集モーダル代替） -->
    <div class="card" id="edit-form" style="display:none">
      <h2 id="edit-title">編集</h2>
      <div class="row">
        <div><label>科目</label><select id="edit-subject"><option value="">未設定</option></select></div>
        <div><label>論点</label><select id="edit-topic"><option value="">未設定</option></select></div>
      </div>
      <div class="row" style="margin-top:10px">
        <div><label>PDFリンク（Google Drive URL or ID）</label><input type="url" id="edit-pdf"></div>
        <div><label>PDFページ番号</label><input type="number" id="edit-pdf-page" min="1"></div>
      </div>
      <div style="margin-top:10px"><label>動画リンク（Google Drive URL or ID）</label><input type="url" id="edit-video"></div>
      <div style="display:flex;gap:8px;margin-top:12px">
        <button id="save-edit">保存</button>
        <button class="secondary" id="cancel-edit">キャンセル</button>
      </div>
      <p class="status" id="edit-status"></p>
    </div>
  </section>

  <!-- ===== PDF管理タブ ===== -->
  <section id="pdf" class="panel">
    <!-- PDFファイル登録 -->
    <div class="card">
      <h2>PDFファイル登録</h2>
      <div class="row">
        <div><label>PDF ID（英数字・ハイフン）</label><input type="text" id="pdf-id" placeholder="takuitsu_H17-R05"></div>
        <div><label>タイトル</label><input type="text" id="pdf-title" placeholder="択一 H17-R05"></div>
      </div>
      <div class="row" style="margin-top:8px">
        <div><label>Google Drive URL</label><input type="url" id="pdf-drive-url" placeholder="https://drive.google.com/..."></div>
        <div><label>総ページ数</label><input type="number" id="pdf-total-pages" min="1"></div>
      </div>
      <button id="btn-save-pdf" style="margin-top:10px">PDFファイル登録</button>
      <p class="status" id="pdf-file-status"></p>
    </div>
    <!-- PDFファイル一覧 -->
    <div class="card">
      <h2>登録済みPDF</h2>
      <div id="pdf-files-list"><p class="muted">読み込み中…</p></div>
    </div>
    <!-- ページ対応表 -->
    <div class="card" id="pdf-pages-card" style="display:none">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
        <h2 id="pdf-pages-title">ページ対応表</h2>
        <button class="secondary btn-sm" id="close-pdf-pages">閉じる</button>
      </div>
      <p class="muted" style="margin:0 0 12px">1行ごとに「ページ番号,問題ID,ラベル」でCSV入力して一括登録できます。</p>
      <label>CSV一括入力（page_no,question_id,label）</label>
      <textarea id="pages-csv" placeholder="1,H1701,H17第1問&#10;2,H1702,H17第2問&#10;21,,表紙"></textarea>
      <div style="display:flex;gap:8px;margin-top:8px">
        <button id="btn-bulk-pages">一括登録</button>
        <button class="secondary" id="btn-reload-pages">再読み込み</button>
      </div>
      <p class="status" id="pages-status"></p>
      <div id="pages-table-wrap" style="margin-top:12px"><p class="muted">読み込み中…</p></div>
    </div>
  </section>
</div>
<script>
const $=s=>document.querySelector(s);
const $$=s=>Array.from(document.querySelectorAll(s));
let subjects={};
let currentQ=null;  // 編集中の問題
let qPage=0;const PAGE=50;
let activePdfId='';

async function api(path,opt){
  const r=await fetch(path,Object.assign({headers:{'Content-Type':'application/json'}},opt||{}));
  const d=await r.json();if(!r.ok)throw new Error(d.error||'APIエラー');return d;
}
function esc(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}

// ---- 科目マスタ読み込み ----
async function initSubjects(){
  const d=await api('/api/subjects');subjects=d.subjects;
  const fSub=$('#f-subject');const editSub=$('#edit-subject');
  for(const s of Object.keys(subjects)){
    fSub.insertAdjacentHTML('beforeend','<option value="'+esc(s)+'">'+esc(s)+'</option>');
    editSub.insertAdjacentHTML('beforeend','<option value="'+esc(s)+'">'+esc(s)+'</option>');
  }
  populateTopics('#f-topic','');
  populateTopics('#edit-topic','');
}
function populateTopics(sel,subject){
  const el=$(sel);const cur=el.value;el.innerHTML='<option value="">未設定</option>';
  const list=subject&&subjects[subject]?subjects[subject]:Object.values(subjects).flat();
  for(const t of list)el.insertAdjacentHTML('beforeend','<option value="'+esc(t)+'">'+esc(t)+'</option>');
  if([...el.options].some(o=>o.value===cur))el.value=cur;
}
$('#f-subject').addEventListener('change',()=>populateTopics('#f-topic',$('#f-subject').value));
$('#edit-subject').addEventListener('change',()=>populateTopics('#edit-topic',$('#edit-subject').value));

// ---- 年度フィルタ初期化 ----
function initYears(){
  const fYear=$('#f-year');
  ['H17','H18','H19','H20','H21','H22','H23','H24','H25','H26','H27','H28','H29','H30','R01','R02','R03','R04','R05'].forEach(y=>{
    fYear.insertAdjacentHTML('beforeend','<option value="'+y+'">'+y+'</option>');
  });
}

// ---- 問題一覧読み込み ----
async function loadQuestions(){
  const subject=$('#f-subject').value;
  const topic=$('#f-topic').value;
  const year=$('#f-year').value;
  const params=new URLSearchParams({limit:PAGE,offset:qPage*PAGE});
  if(subject)params.set('subject',subject);if(topic)params.set('topic',topic);if(year)params.set('year',year);
  $('#q-table-wrap').innerHTML='<p class="muted">読み込み中…</p>';
  try{
    const d=await api('/api/questions?'+params.toString());
    $('#page-info').textContent=(qPage*PAGE+1)+'-'+Math.min((qPage+1)*PAGE,d.total)+' / '+d.total+'件';
    $('#prev-page').disabled=qPage===0;
    $('#next-page').disabled=(qPage+1)*PAGE>=d.total;
    if(!d.questions.length){$('#q-table-wrap').innerHTML='<p class="muted">該当なし</p>';return}
    $('#q-table-wrap').innerHTML='<table><thead><tr><th>ID</th><th>科目</th><th>論点</th><th>PDF</th><th>動画</th><th></th></tr></thead><tbody>'
      +d.questions.map(q=>'<tr>'
        +'<td>'+esc(q.question_id)+'</td>'
        +'<td>'+(q.subject?'<span class="tag">'+esc(q.subject)+'</span>':'<span class="muted">未設定</span>')+'</td>'
        +'<td class="muted" style="font-size:12px">'+esc(q.topic||'')+'</td>'
        +'<td>'+(q.pdf_url?'✓':'')+(q.pdf_page?' p.'+q.pdf_page:'')+'</td>'
        +'<td>'+(q.video_url?'✓':'')+'</td>'
        +'<td><button class="secondary btn-sm" data-edit="'+esc(JSON.stringify(q))+'">編集</button></td>'
        +'</tr>').join('')
      +'</tbody></table>';
  }catch(e){$('#q-table-wrap').innerHTML='<p class="error">'+esc(e.message)+'</p>'}
}

$('#btn-filter').addEventListener('click',()=>{qPage=0;loadQuestions()});
$('#prev-page').addEventListener('click',()=>{if(qPage>0){qPage--;loadQuestions()}});
$('#next-page').addEventListener('click',()=>{qPage++;loadQuestions()});

// ---- 編集フォーム ----
$('#q-table-wrap').addEventListener('click',e=>{
  const btn=e.target.closest('[data-edit]');
  if(!btn)return;
  currentQ=JSON.parse(btn.dataset.edit);
  $('#edit-title').textContent='編集: '+currentQ.question_id;
  $('#edit-subject').value=currentQ.subject||'';
  populateTopics('#edit-topic',currentQ.subject||'');
  $('#edit-topic').value=currentQ.topic||'';
  $('#edit-pdf').value=currentQ.pdf_url||'';
  $('#edit-pdf-page').value=currentQ.pdf_page||'';
  $('#edit-video').value=currentQ.video_url||'';
  $('#edit-status').textContent='';
  $('#edit-form').style.display='block';
  $('#edit-form').scrollIntoView({behavior:'smooth'});
});

$('#cancel-edit').addEventListener('click',()=>{$('#edit-form').style.display='none';currentQ=null});

$('#save-edit').addEventListener('click',async()=>{
  if(!currentQ)return;
  const btn=$('#save-edit');btn.disabled=true;$('#edit-status').textContent='保存中...';
  try{
    const calls=[];
    calls.push(api('/api/questions/meta',{method:'POST',body:JSON.stringify({question_id:currentQ.question_id,subject:$('#edit-subject').value||null,topic:$('#edit-topic').value||null})}));
    if($('#edit-pdf').value)calls.push(api('/api/questions/link',{method:'POST',body:JSON.stringify({question_id:currentQ.question_id,field:'pdf_url',url:$('#edit-pdf').value})}));
    if($('#edit-pdf-page').value)calls.push(api('/api/questions/link',{method:'POST',body:JSON.stringify({question_id:currentQ.question_id,field:'pdf_page',url:$('#edit-pdf-page').value})}));
    if($('#edit-video').value)calls.push(api('/api/questions/link',{method:'POST',body:JSON.stringify({question_id:currentQ.question_id,field:'video_url',url:$('#edit-video').value})}));
    await Promise.all(calls);
    $('#edit-status').textContent='保存しました。';
    loadQuestions();
  }catch(e){$('#edit-status').innerHTML='<span class="error">'+esc(e.message)+'</span>'}
  finally{btn.disabled=false}
});

// ---- PDFファイル管理 ----
async function loadPdfFiles(){
  $('#pdf-files-list').innerHTML='<p class="muted">読み込み中…</p>';
  try{
    const d=await api('/api/pdf-files');
    if(!d.pdf_files.length){$('#pdf-files-list').innerHTML='<p class="muted">登録なし</p>';return}
    $('#pdf-files-list').innerHTML='<div class="pdf-grid">'+d.pdf_files.map(f=>'<div class="card" style="margin:0"><b>'+esc(f.title)+'</b><br><span class="muted" style="font-size:12px">'+esc(f.pdf_id)+'</span>'+(f.total_pages?'<br><span class="muted" style="font-size:12px">'+f.total_pages+'ページ</span>':'')+'<div style="margin-top:8px"><button class="secondary btn-sm" data-open-pdf="'+esc(f.pdf_id)+'">ページ対応表</button></div></div>').join('')+'</div>';
  }catch(e){$('#pdf-files-list').innerHTML='<p class="error">'+esc(e.message)+'</p>'}
}

$('#btn-save-pdf').addEventListener('click',async()=>{
  const btn=$('#btn-save-pdf');btn.disabled=true;$('#pdf-file-status').textContent='';
  try{
    await api('/api/pdf-files',{method:'POST',body:JSON.stringify({pdf_id:$('#pdf-id').value.trim(),title:$('#pdf-title').value.trim(),drive_url:$('#pdf-drive-url').value.trim()||undefined,total_pages:$('#pdf-total-pages').value||undefined})});
    $('#pdf-file-status').textContent='登録しました。';
    loadPdfFiles();
  }catch(e){$('#pdf-file-status').innerHTML='<span class="error">'+esc(e.message)+'</span>'}
  finally{btn.disabled=false}
});

$('#pdf-files-list').addEventListener('click',e=>{
  const btn=e.target.closest('[data-open-pdf]');if(!btn)return;
  activePdfId=btn.dataset.openPdf;
  $('#pdf-pages-title').textContent='ページ対応表: '+activePdfId;
  $('#pdf-pages-card').style.display='block';
  loadPdfPages();
  $('#pdf-pages-card').scrollIntoView({behavior:'smooth'});
});

$('#close-pdf-pages').addEventListener('click',()=>{$('#pdf-pages-card').style.display='none';activePdfId=''});

async function loadPdfPages(){
  if(!activePdfId)return;
  $('#pages-table-wrap').innerHTML='<p class="muted">読み込み中…</p>';
  try{
    const d=await api('/api/pdf-pages?pdf_id='+encodeURIComponent(activePdfId));
    if(!d.pages.length){$('#pages-table-wrap').innerHTML='<p class="muted">登録なし</p>';return}
    $('#pages-table-wrap').innerHTML='<table><thead><tr><th>ページ</th><th>問題ID</th><th>ラベル</th><th>科目</th></tr></thead><tbody>'
      +d.pages.map(p=>'<tr><td>'+p.page_no+'</td><td>'+(p.question_id?esc(p.question_id):'')+'</td><td>'+esc(p.label||'')+'</td><td>'+(p.subject?'<span class="tag">'+esc(p.subject)+'</span>':'')+'</td></tr>').join('')
      +'</tbody></table>';
  }catch(e){$('#pages-table-wrap').innerHTML='<p class="error">'+esc(e.message)+'</p>'}
}

$('#btn-reload-pages').addEventListener('click',loadPdfPages);

$('#btn-bulk-pages').addEventListener('click',async()=>{
  if(!activePdfId){alert('PDFを選択してください');return}
  const csv=$('#pages-csv').value.trim();
  if(!csv)return;
  const pages=csv.split('\\n').map(line=>{
    const parts=line.trim().split(',');
    const page_no=parseInt(parts[0],10);
    if(isNaN(page_no))return null;
    return{page_no,question_id:parts[1]?.trim()||null,label:parts[2]?.trim()||null};
  }).filter(Boolean);
  if(!pages.length){alert('有効な行がありません');return}
  const btn=$('#btn-bulk-pages');btn.disabled=true;$('#pages-status').textContent='登録中…';
  try{
    const d=await api('/api/pdf-pages/bulk',{method:'POST',body:JSON.stringify({pdf_id:activePdfId,pages})});
    $('#pages-status').textContent=d.count+'件登録しました。';
    loadPdfPages();
  }catch(e){$('#pages-status').innerHTML='<span class="error">'+esc(e.message)+'</span>'}
  finally{btn.disabled=false}
});

// ---- タブ切り替え ----
document.addEventListener('click',e=>{
  const tab=e.target.closest('[data-tab]');
  if(!tab)return;
  $$('.tab').forEach(x=>x.classList.toggle('active',x===tab));
  $$('.panel').forEach(x=>x.classList.toggle('active',x.id===tab.dataset.tab));
  if(tab.dataset.tab==='pdf')loadPdfFiles();
});

// ---- 初期化 ----
initSubjects();initYears();loadQuestions();
</script>
</body>
</html>`;
