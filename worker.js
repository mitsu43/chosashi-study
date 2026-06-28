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
      if (m === 'POST' && path === '/api/tts')            return json(await googleTts(request, env), 200);

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
  const firstRow = await env.DB.prepare(
    "SELECT MIN(substr(answered_at,1,10)) AS d FROM answers"
  ).first();
  const t = total.c || 0, c = correct.c || 0;
  return {
    totals: {
      answers: t, correct: c, wrong: t - c,
      correct_rate: t ? Math.round(c / t * 1000) / 10 : 0,
      answered_questions: answeredQ.c || 0,
      total_questions: totalQ.c || 0,
      streak_days: countStreak(days.map(r => r.day)),
      first_answer_date: firstRow ? firstRow.d : null,
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
    { task_id: 'solve_questions',title: '択一10問で法規OSの穴を探す' },
    { task_id: 'review_wrong',   title: '誤答1問を「なぜ間違えたか」まで戻す' },
    { task_id: 'write_note',     title: '実務メモを1件残す' },
    { task_id: 'career_bridge',  title: '顧客説明・役所確認・現地確認のどれに使うか分類する' },
  ];  const { results } = await env.DB.prepare('SELECT task_id, done FROM daily_tasks WHERE task_date=?').bind(date).all();
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

async function googleTts(request, env) {
  const key = env.GOOGLE_TTS_KEY;
  if (!key) throw new Error('GOOGLE_TTS_KEY is not set');
  const b = await readJson(request);
  const text = String(b.text || '').trim();
  if (!text) throw new Error('text required');
  if (text.length > 900) throw new Error('text too long');
  const voice = String(b.voice || 'ja-JP-Wavenet-D');
  const speakingRate = Math.max(0.25, Math.min(4.0, Number(b.rate || 1.2)));
  const pitch = Number.isFinite(Number(b.pitch)) ? Number(b.pitch) : -6.0;
  const res = await fetch(`https://texttospeech.googleapis.com/v1/text:synthesize?key=${key}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      input: { text },
      voice: { languageCode: 'ja-JP', name: voice },
      audioConfig: { audioEncoding: 'MP3', speakingRate, pitch },
    }),
  });
  const data = await res.json();
  if (!res.ok || !data.audioContent) {
    throw new Error(data?.error?.message || 'Google TTS error');
  }
  return { audioContent: data.audioContent };
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
  <title>60歳独立準備室</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400;500;700&family=Shippori+Mincho:wght@500;700&display=swap" rel="stylesheet">
  <style>
    :root{
      --sakura:#e8a0b8; --sakura-soft:#f6dde6; --sakura-bg:#fcf4f7;
      --wakaba:#8fb96a; --wakaba-deep:#5d8a3f; --wakaba-soft:#e6f0da;
      --kincha:#c9a24b; --sumi:#3a3a38; --muted:#8a8580;
      --cream:#fdfbf5; --card:#ffffff; --line:#ece5da; --danger:#c2673f;
      --sidebar:#3f5236;
    }
    *{box-sizing:border-box}
    body{margin:0;background:var(--sakura-bg);color:var(--sumi);
      font-family:"Noto Sans JP",system-ui,sans-serif;line-height:1.6}
    .layout{display:grid;grid-template-columns:240px 1fr;min-height:100vh}

    /* ===== 左サイドバー ===== */
    .sidebar{background:var(--sidebar);color:#e8ecdf;padding:22px 16px;
      display:flex;flex-direction:column;position:sticky;top:0;height:100vh}
    .brand{font-family:"Shippori Mincho",serif;font-size:18px;font-weight:700;
      color:#fff;margin-bottom:4px;display:flex;align-items:center;gap:7px}
    .brand .petal{color:var(--sakura);font-size:15px}
    .brand-sub{font-size:11px;color:#a7c3b1;margin-bottom:24px;line-height:1.5}
    .nav-item{display:flex;align-items:center;gap:11px;padding:11px 13px;border-radius:10px;
      color:#cdd8c4;font-size:14px;font-weight:500;cursor:pointer;border:0;background:none;
      width:100%;text-align:left;font-family:inherit;margin-bottom:3px;transition:all .15s}
    .nav-item:hover{background:rgba(255,255,255,.07)}
    .nav-item.active{background:rgba(232,160,184,.22);color:#fff}
    .nav-item .ico{font-size:17px;width:20px;text-align:center}
    .sidebar-foot{margin-top:auto;padding-top:18px;border-top:1px solid rgba(255,255,255,.1)}
    .sidebar-foot a{color:#a7c3b1;font-size:13px;text-decoration:none;display:flex;align-items:center;gap:8px;padding:8px 13px}
    .sidebar-foot a:hover{color:#fff}

    /* ===== 右メイン ===== */
    .main{padding:26px 30px 40px;max-width:1100px}
    .hero{background:linear-gradient(135deg,#f6dde6 0%,#e6f0da 100%);
      border-radius:16px;padding:24px 28px;margin-bottom:22px;border:2px solid #fff;
      display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:16px}
    .hero-left .countdown{font-family:"Shippori Mincho",serif;font-weight:700;font-size:38px;
      color:var(--sumi);line-height:1.2}
    .hero-left .countdown .num{color:var(--wakaba-deep)}
    .hero-left .hero-sub{font-size:14px;color:#7a8a6a;margin:4px 0 0}
    .hero-right{text-align:right}
    .hero-right .big{font-size:30px;font-weight:700;color:var(--wakaba-deep);line-height:1.1}
    .hero-right .big .unit{font-size:14px;color:var(--muted);font-weight:400}
    .hero-right .lbl{font-size:12px;color:#7a8a6a}

    .health-warn{border-radius:12px;padding:14px 18px;margin-bottom:14px;display:flex;align-items:center;gap:13px;font-size:14px}
    .health-warn.lv-ok{background:var(--wakaba-soft);color:var(--wakaba-deep)}
    .health-warn.lv-warn{background:#faf2dd;color:#8a6d1a}
    .health-warn.lv-bad{background:#fae7df;color:#9c4a2a}
    .health-warn .wico{font-size:22px}
    .health-warn b{font-weight:700}
    .health-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:13px;margin-bottom:14px}
    .health-card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:15px 17px}
    .health-head{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--muted);margin-bottom:8px}
    .sig{width:11px;height:11px;border-radius:50%;background:#ccc;display:inline-block}
    .sig.g{background:#6fae4a}.sig.y{background:#d9a82a}.sig.r{background:#c2673f}
    .health-num{font-size:25px;font-weight:700;color:var(--wakaba-deep);line-height:1.2}
    .health-num.warn{color:#b5862a}.health-num.bad{color:var(--danger)}
    .health-num .hu{font-size:14px;color:var(--muted);font-weight:400}
    .health-sub{font-size:12px;color:var(--muted);margin-top:3px}
    .quota-card{margin-bottom:18px}
    .quota-head{font-size:13px;color:var(--muted);margin-bottom:9px}
    .quota-head b{color:var(--sumi);font-size:15px}
    .quota-bar{display:flex;gap:5px}
    .quota-seg{flex:1;height:10px;border-radius:5px;background:#efe9dd}
    .quota-seg.fill{background:linear-gradient(90deg,var(--wakaba),var(--kincha))}
    .grid-2{display:grid;grid-template-columns:1fr 1fr;gap:18px}
    .grid-3{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}
    .col-span{grid-column:1 / -1}
    .card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px 20px;
      box-shadow:0 2px 8px rgba(180,150,120,.05);margin-bottom:18px}
    .os-board{display:grid;grid-template-columns:1.15fr .85fr;gap:16px;margin-bottom:18px}
    .os-title{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:14px}
    .os-title h2{font-family:"Shippori Mincho",serif;font-size:22px;color:var(--sumi);margin:0}
    .os-title p{margin:4px 0 0;color:var(--muted);font-size:13px}
    .os-modules{display:grid;grid-template-columns:1fr 1fr;gap:10px}
    .os-module{border:1px solid var(--line);border-radius:12px;padding:13px;background:linear-gradient(180deg,#fff,#fdfbf5)}
    .os-module b{display:block;color:var(--wakaba-deep);font-size:14px;margin-bottom:4px}
    .os-module span{display:block;color:var(--muted);font-size:12px;line-height:1.55}
    .exit-list{display:grid;gap:9px}
    .exit-item{border-left:4px solid var(--wakaba);background:var(--cream);border-radius:0 10px 10px 0;padding:10px 12px}
    .exit-item b{display:block;font-size:13px;color:var(--sumi)}
    .exit-item span{display:block;font-size:12px;color:var(--muted);margin-top:2px}
    .card-label{font-size:12px;color:var(--kincha);font-weight:700;letter-spacing:.05em;margin-bottom:13px;
      display:flex;align-items:center;gap:7px}
    h2{margin:0 0 4px;font-size:17px;color:var(--wakaba-deep);font-weight:700}
    h3{margin:0;font-size:15px;font-weight:700}
    .muted{color:var(--muted);font-size:13px}.small{font-size:12px}
    .status{min-height:18px;margin:6px 0 0;color:var(--muted);font-size:13px}.error{color:var(--danger)}
    .panel{display:none}.panel.active{display:block}

    .tier{font-size:11px;padding:1px 9px;border-radius:99px;font-weight:700;margin-left:auto}
    .tier-min{background:#f0ece2;color:#8a8055}
    .tier-std{background:var(--wakaba-soft);color:var(--wakaba-deep)}
    .tier-ideal{background:var(--sakura-soft);color:#b25c7a}
    .task{display:flex;align-items:center;gap:12px;padding:11px 0;border-top:1px solid var(--line);
      font-size:14px;cursor:pointer}
    .task:first-child{border-top:0}
    .check{width:21px;height:21px;border:2px solid var(--wakaba);border-radius:6px;flex:0 0 auto;
      display:inline-flex;align-items:center;justify-content:center;color:#fff;font-size:14px;transition:all .15s}
    .task.done .check{background:var(--kincha);border-color:var(--kincha)}
    .task.done .task-text{color:var(--muted);text-decoration:line-through}
    .progress-track{height:9px;border-radius:99px;background:#efe9dd;overflow:hidden;margin-top:14px}
    .progress-bar{height:100%;width:0;background:linear-gradient(90deg,var(--wakaba),var(--kincha));transition:width .3s}

    .memo-prompt{font-family:"Shippori Mincho",serif;font-size:14px;color:#9a8f80;
      line-height:1.7;font-style:italic;margin-bottom:14px}
    .memo-btn{display:block;width:100%;text-align:center;background:linear-gradient(135deg,#f6dde6,#e6f0da);
      border:0;border-radius:11px;padding:13px;font:inherit;font-weight:700;color:var(--sumi);cursor:pointer}

    .stat{background:var(--cream);border:1px solid var(--line);border-radius:12px;padding:15px 17px}
    .stat-label{font-size:12px;color:var(--muted);margin-bottom:4px}
    .stat b{display:block;font-size:28px;font-weight:700;color:var(--wakaba-deep);line-height:1.2}
    .stat .unit{font-size:14px;color:var(--muted);font-weight:400}
    .stat .sub{font-size:11px;color:var(--muted);margin-top:2px}

    .q-card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:15px;margin:0 0 12px}
    .q-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px}
    .tag{display:inline-block;font-size:11px;padding:2px 9px;border-radius:99px;background:var(--wakaba-soft);
      color:var(--wakaba-deep);font-weight:700;margin:5px 4px 0 0}
    .btn{min-height:40px;border:1px solid var(--wakaba);border-radius:9px;background:var(--wakaba-deep);
      color:#fff;padding:8px 14px;font:inherit;font-weight:700;text-align:center;text-decoration:none;
      cursor:pointer;display:inline-block}
    .btn.sec{background:#fff;color:var(--wakaba-deep)}
    .btn.dan{background:var(--danger);border-color:var(--danger)}
    .btn:disabled{border-color:#d8d2c6;background:#efeae0;color:#a59f93;cursor:not-allowed}
    .q-actions{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:11px}
    table{width:100%;border-collapse:collapse;font-size:13px}
    th{text-align:left;color:var(--muted);font-weight:700;padding:7px 6px;border-bottom:1px solid var(--line)}
    td{padding:7px 6px;border-bottom:1px solid var(--line)}

    .modal{position:fixed;inset:0;z-index:100;display:none}.modal.active{display:flex;align-items:center;justify-content:center}
    .modal-bg{position:absolute;inset:0;background:rgba(40,30,30,.6)}
    .modal-box{position:relative;width:min(620px,92vw);max-height:90vh;background:var(--cream);
      border-radius:16px;padding:22px;display:flex;flex-direction:column;gap:11px;overflow-y:auto}
    .modal-box.wide{width:min(900px,94vw);height:88vh}
    .memo-field label{display:block;font-size:13px;color:var(--wakaba-deep);font-weight:700;margin:11px 0 5px}
    .memo-field textarea{width:100%;border:1px solid var(--line);border-radius:9px;padding:10px 12px;
      font:inherit;font-size:13px;min-height:56px;background:#fff;resize:vertical}
    iframe{width:100%;flex:1;border:0;border-radius:9px;background:#fff;min-height:70vh}
    #aid-content{display:none;width:100%;flex:1;overflow:auto;border-radius:9px;background:#fdfbf5;padding:18px;color:#3a3a38;line-height:1.7}
    #aid-content .note{color:#8a8580;font-size:13px}
    #aid-content .grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
    #aid-content .box{background:#fff;border:1px solid #ece5da;border-radius:12px;padding:14px}
    #aid-content h2{margin:0 0 4px;color:#5d8a3f}
    #aid-content h3{margin:0 0 8px;color:#5d8a3f}
    #aid-content .cue{display:grid;grid-template-columns:74px 1fr;gap:8px;border-top:1px solid #ece5da;padding:8px 0;font-size:14px}
    #aid-content .cue:first-child{border-top:0}
    #aid-content time{font-family:Consolas,monospace;color:#c9a24b;font-size:12px}
    #aid-content li{margin:6px 0}
    #aid-content .tts-unit{transition:background .15s}
    #aid-content .tts-unit.tts-reading{background:transparent}
    #aid-content .tts-hl{background:transparent;color:inherit;border-radius:0;font-weight:800}
    #aid-content .tts-word{background:transparent;color:inherit;border-radius:0;padding:0;font-weight:900;box-shadow:none}
    @media(max-width:720px){#aid-content .grid{grid-template-columns:1fr}}
    .aid-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;overflow:auto}
    .aid-box{background:#fff;border:1px solid var(--line);border-radius:12px;padding:14px}
    .aid-box h3{margin:0 0 8px;color:var(--wakaba-deep)}
    .aid-box ul{margin:8px 0 0;padding-left:18px}.aid-box li{margin:6px 0}
    .cue{display:grid;grid-template-columns:74px 1fr;gap:8px;border-top:1px solid var(--line);padding:8px 0;font-size:13px}
    .cue:first-child{border-top:0}.cue time{font-family:Consolas,monospace;color:var(--kincha);font-size:12px}

    @media(max-width:820px){
      .layout{grid-template-columns:1fr}
      .sidebar{position:static;height:auto;flex-direction:row;flex-wrap:wrap;align-items:center;padding:14px}
      .brand,.brand-sub{width:100%}.brand-sub{margin-bottom:10px}
      .nav-item{width:auto}.sidebar-foot{margin:0 0 0 auto;padding:0;border:0}
      .main{padding:18px 14px}.grid-2,.grid-3,.os-board,.os-modules,.aid-grid{grid-template-columns:1fr}
    }
  </style>
</head>
<body>
<div class="layout">
  <!-- ===== サイドバー ===== -->
  <aside class="sidebar">
    <div class="brand"><span class="petal">❀</span> 60歳独立準備室</div>
    <div class="brand-sub">調査士セカンドキャリア作戦室</div>
    <button class="nav-item active" data-tab="today"><span class="ico">▤</span> 今日の一手</button>
    <button class="nav-item" data-tab="wrong"><span class="ico">✕</span> 誤答を潰す</button>
    <button class="nav-item" data-tab="stats"><span class="ico">◆</span> キャリア資産</button>
    <button class="nav-item" data-tab="plan"><span class="ico">▶</span> 60歳までの計画</button>
    <div class="sidebar-foot">
      <a href="/admin">⚙ 教材・問題の管理</a>
    </div>
  </aside>

  <!-- ===== メイン ===== -->
  <main class="main">
    <div class="hero">
      <div class="hero-left">
        <div class="countdown" id="countdown">残り <span class="num">—</span></div>
        <p class="hero-sub">❀ 60歳の独立まで。今日、仕事の武器を1つ増やす。</p>
      </div>
      <div class="hero-right">
        <div class="big" id="hero-rate">—<span class="unit">%</span></div>
        <div class="lbl">択一正答率（合格力）</div>
      </div>
    </div>

    <!-- ヘルスパネル（毎日の健康状態）-->
    <div id="health-warn" class="health-warn" style="display:none"></div>
    <div class="health-grid">
      <div class="health-card">
        <div class="health-head"><span class="sig" id="sig-streak"></span>継続（活動）</div>
        <div class="health-num" id="hp-streak">—<span class="hu">日連続</span></div>
        <div class="health-sub" id="hp-streak-sub">今日やれば伸びる。途切れると0に戻る</div>
      </div>
      <div class="health-card">
        <div class="health-head"><span class="sig" id="sig-balance"></span>貯金／借金（食事）</div>
        <div class="health-num" id="hp-balance">—<span class="hu">問</span></div>
        <div class="health-sub" id="hp-balance-sub">予定に対する実績の差</div>
      </div>
      <div class="health-card">
        <div class="health-head"><span class="sig" id="sig-lap"></span>到達周回（理解）</div>
        <div class="health-num" id="hp-lap">—<span class="hu">周見込</span></div>
        <div class="health-sub" id="hp-lap-sub">今のペースでの本試験までの周回</div>
      </div>
    </div>
    <div class="card quota-card">
      <div class="quota-head">今日のノルマ <b id="quota-n">—</b>問 <span class="muted small" id="quota-formula"></span></div>
      <div class="quota-bar" id="quota-bar"></div>
      <div class="muted small" id="quota-done" style="margin-top:6px"></div>
    </div>

    <!-- 今日 -->
    <section id="today" class="panel active">
      <div class="os-board">
        <div class="card" style="margin:0">
          <div class="os-title">
            <div>
              <h2>法規OSを組み上げる</h2>
              <p>暗記ではなく、土地・建物・境界を扱う判断回路を毎日1つ強くする。</p>
            </div>
            <span class="tier tier-ideal">60歳キャリア</span>
          </div>
          <div class="os-modules">
            <div class="os-module"><b>① 権利前提（民法）</b><span>誰が所有し、誰が処分できるか。共有・相続・対抗要件を申請人判断へつなげる。</span></div>
            <div class="os-module"><b>② 登記総論</b><span>登記所・登記官・登記簿・申請義務。システムの作法と却下リスクを読む。</span></div>
            <div class="os-module"><b>③ 土地表示</b><span>一筆、地番、地目、地積、分筆、合筆。現地と図面と登記を接続する中心領域。</span></div>
            <div class="os-module"><b>④ 建物・区分建物</b><span>建物認定、床面積、滅失、区分建物、敷地権。複雑な物を登記できる形へ整える。</span></div>
          </div>
        </div>
        <div class="card" style="margin:0">
          <div class="card-label">今日の出口</div>
          <div class="exit-list">
            <div class="exit-item"><b>試験出口</b><span>択一10問で、どのモジュールが問われたかを分類する。</span></div>
            <div class="exit-item"><b>記述出口</b><span>申請人・順番・添付情報・図面にどう効くかを1つだけ言語化する。</span></div>
            <div class="exit-item"><b>実務出口</b><span>顧客説明、役所確認、現地確認のどれに使う知識かをメモする。</span></div>
          </div>
        </div>
      </div>
      <div class="grid-2">
        <div class="card" style="margin:0">
          <div class="card-label">▤ 今日の一手</div>
          <div id="task-list"></div>
          <div class="progress-track"><div class="progress-bar" id="task-progress"></div></div>
          <p class="status" id="today-status"></p>
        </div>
        <div class="card" style="margin:0">
          <div class="card-label">✎ 今日の実務メモ</div>
          <div class="memo-prompt">「この論点、現場ではどう使う？ 顧客にどう説明する？ 法務局で何を確認する？」</div>
          <button class="memo-btn" id="open-memo">＋ 実務メモを書く（将来の仕事ノートに変える）</button>
          <p class="status" id="memo-status"></p>
        </div>
      </div>
      <div class="card" style="margin-top:18px">
        <div class="card-label">▦ 今日の問題</div>
        <div id="today-questions" class="q-grid"><p class="muted">読み込み中…</p></div>
      </div>
    </section>

    <!-- 誤答 -->
    <section id="wrong" class="panel">
      <div class="card">
        <h2>誤答リスト</h2>
        <p class="muted">最後に間違えた問題を優先表示。ここを潰すのが合格の最短ルート。</p>
      </div>
      <div id="wrong-list" class="q-grid"></div>
    </section>

    <!-- 資産 -->
    <section id="stats" class="panel">
      <div class="card">
        <div class="card-label">◆ キャリア資産</div>
        <div class="grid-3" id="stats-summary"></div>
      </div>
      <div class="grid-2">
        <div class="card" style="margin:0"><div class="card-label">年度別の合格力</div><div id="stats-years"></div></div>
        <div class="card" style="margin:0"><div class="card-label">科目別の合格力</div><div id="stats-subjects"></div></div>
      </div>
    </section>

    <!-- 計画 -->
    <section id="plan" class="panel">
      <div class="card">
        <div class="card-label">▶ 60歳までのフェーズ</div>
        <div style="display:grid;gap:11px">
          <div style="border-left:4px solid var(--sakura);padding:11px 14px;background:var(--sakura-bg);border-radius:0 10px 10px 0"><b>Ph1 〜2027/1</b> &nbsp;<span class="muted small">択一を回し、解説で答え合わせ。誤答を翌日へ戻す。</span></div>
          <div style="border-left:4px solid var(--wakaba);padding:11px 14px;background:var(--wakaba-soft);border-radius:0 10px 10px 0"><b>Ph2 〜2027/6</b> &nbsp;<span class="muted small">誤答を重点復習。正答率70%超で次へ。</span></div>
          <div style="border-left:4px solid var(--kincha);padding:11px 14px;background:#faf6ea;border-radius:0 10px 10px 0"><b>Ph3 〜2027/8</b> &nbsp;<span class="muted small">記述・複素数・定規を毎日パターン化。</span></div>
          <div style="border-left:4px solid var(--wakaba-deep);padding:11px 14px;background:var(--wakaba-soft);border-radius:0 10px 10px 0"><b>Ph4 〜本試験</b> &nbsp;<span class="muted small">答練を本番形式。残った誤答だけ潰す。</span></div>
          <div style="border-left:4px solid var(--danger);padding:11px 14px;background:#faf0ea;border-radius:0 10px 10px 0"><b>合格後〜60歳</b> &nbsp;<span class="muted small">実務メモを資産化。境界・測量・登記で食える自分へ。</span></div>
        </div>
      </div>
    </section>
  </main>
</div>

<!-- 実務メモ モーダル -->
<div class="modal" id="memo-modal">
  <div class="modal-bg" data-close-memo></div>
  <div class="modal-box">
    <div style="display:flex;align-items:center;justify-content:space-between">
      <h2>実務メモ</h2><button class="btn sec" data-close-memo>閉じる</button>
    </div>
    <div class="muted small" id="memo-context">過去問を解いて気づいたことを、未来の仕事の引き出しに変える。</div>
    <div class="memo-field">
      <label>📍 現場ではどこで使う？</label>
      <textarea id="memo-genba" placeholder="例：境界確定後の分筆依頼。分筆線の測量と地積測量図の作成。"></textarea>
      <label>💬 顧客にどう説明する？</label>
      <textarea id="memo-kokyaku" placeholder="例：土地を分けて売るには分筆登記が必要。境界確定が先。"></textarea>
      <label>⚠️ 見落とすと危ないこと</label>
      <textarea id="memo-risk" placeholder="例：隣地の立会い・印が取れないと確定測量が進まない。"></textarea>
      <label>🏛 役所・法務局で確認すること</label>
      <textarea id="memo-yakusho" placeholder="例：分筆後の地番の振り方、地積測量図の様式を管轄法務局で確認。"></textarea>
    </div>
    <button class="btn" id="save-memo">この1件を実務資産にする</button>
    <p class="status" id="memo-save-status"></p>
    <div id="memo-history"></div>
  </div>
</div>

<!-- 動画モーダル -->
<div class="modal" id="video-modal">
  <div class="modal-bg" data-close-video></div>
  <div class="modal-box wide">
    <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap">
      <h2 id="video-title">解説動画</h2>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <div id="tts-controls" style="display:none;gap:8px;flex-wrap:wrap">
          <button class="btn sec" data-tts-start>Google読み上げ</button>
          <button class="btn sec" data-tts-pause>一時停止/再開</button>
          <button class="btn sec" data-tts-stop>停止</button>
        </div>
        <button class="btn sec" data-close-video>閉じる</button>
      </div>
    </div>
    <iframe id="video-frame" allow="autoplay; encrypted-media" allowfullscreen></iframe>
    <div id="aid-content"></div>
  </div>
</div>

<script>
const $=s=>document.querySelector(s);
const $$=s=>Array.from(document.querySelectorAll(s));
const state={tasks:[],today:null};

const DEFAULT_TARGET='2035-04-03';
function targetDate(){try{return localStorage.getItem('target_date')||DEFAULT_TARGET}catch(e){return DEFAULT_TARGET}}
const STUDY_AIDS={
  H1701:{
    title:'H17 第1問 講義ノート',
    status:'Geminiで動画から抽出した字幕・要点です。聞き取りづらい箇所は今後手直しできます。',
    module:'権利前提モジュール（民法）',
    topic:'共有',
    pattern:'パターン分類：共有者の権限判定',
    asked:'何が問われているか：**共有物について、各共有者が単独でできる行為か、持分価格の過半数が必要な行為か、全員同意が必要な行為かを判別できるか。**',
    image:[
      'この問題は、1つの建物をA・B・Cが3分の1ずつ持っている場面を想像する。',
      '共有者の権限判定とは、「Aひとりで動ける話か、A・Bなど過半数が必要か、A・B・C全員が必要か」を仕分けること。',
      '持分価格とは、人数ではなく持っている割合の重み。3分の1ずつなら2人で3分の2となり、過半数になる。',
      '保存行為とは、壊れた窓を直す、無断占有者を追い出すなど、共有物を守る行為。ひとりでできる。',
      '管理行為とは、貸す、解除する、使い方を決めるなど、共有物の運用を決める行為。持分価格の過半数で決める。',
      '変更・処分行為とは、建物を大きく改造する、売るなど、共有物そのものを大きく動かす行為。原則として全員同意が必要。',
    ],
    core:[
      '**保存行為**：共有物を守る行為。各共有者が単独でできる。',
      '**管理行為**：共有物の利用・収益方法を決める行為。持分価格の過半数で決める。',
      '**変更・処分行為**：共有物そのものを大きく変える、または処分する行為。原則として全員同意が必要。',
      '**自己持分の処分**：共有物全体ではなく自分の持分だけなら、各共有者が自由に処分できる。',
    ],
    cues:[
      ['00:00','17年度問1解説。問題を確認する。'],
      ['00:30','建物の共有がテーマ。保存行為、管理行為、変更行為の区別により、共有者が単独でできるか、どれだけの持分が必要かが変わる。'],
      ['01:00','ABCが甲建物を3分の1ずつ共有。Dが権限なく占有している場合、明渡し請求は保存行為なので共有者1人からできる。'],
      ['01:30','共有者Aは共有物全部を使用する権利を持つため、B・Cの了解がなくても、当然に明渡し請求されるわけではない。'],
      ['02:00','AがGに建物を貸している場合も、Aは共有者として全部を使用する権利があるため、直ちに当然には明渡し請求できない。イとオはセットで押さえる。'],
      ['02:30','ABCがEに貸していて、Eが賃料を長期不払い。賃貸借契約の解除が保存・管理・変更のどれかが問題になる。'],
      ['03:00','共有物の賃貸借契約の解除は管理行為に当たるため、持分価格の過半数で決する。'],
      ['03:30','A単独では持分3分の1にすぎず過半数に達しないため、単独で賃貸借契約を解除できない。'],
      ['04:00','解除権行使は原則として全員から、または全員に対して行う点も併せて押さえる。Aが自己持分に抵当権を設定できるかを見る。'],
      ['04:30','共有者は自己の持分を自由に処分できる。Aは自分の持分について抵当権を設定できる。'],
    ],
    exam:[
      '**第三者の不法占有に対する明渡し請求**は、共有物を守るための保存行為なので、共有者単独でできる。',
      '**共有者本人や共有者から使用を許された者**に対しては、単純に「了解がない」だけで当然に明渡し請求できるわけではない。',
      '**共有物の賃貸借契約の解除**は管理行為。持分価格の過半数が必要で、3分の1のA単独ではできない。',
      '**自己の共有持分への抵当権設定**は、自分の持分の処分なので単独でできる。',
      'この問題は、結論暗記ではなく、各肢を**保存・管理・変更/処分・自己持分処分**に仕分ける問題。',
    ],
    practical:[
      '共有不動産の売却・賃貸・トラブル対応で、各共有者にどこまで権限があるか説明できる。',
      '明渡し、賃貸借解除、持分処分で、単独・過半数・全員同意のどれが必要かを整理して顧客に伝える。',
      '共有者間の合意形成が必要な場面を早めに見抜き、登記や測量の前提条件として確認する。',
    ],
    next:'次はこの形式でH1702以降も追加し、法規OSモジュール別に検索・復習できる形へ広げます。'
  }
};
// ===== ヘルスパネル（毎日の健康状態を定量化）=====
const EXAM_DATE='2027-10-17';   // 本試験（暫定：例年の第3日曜）
const TARGET_LAPS=5;            // 目標周回
const TOTAL_Q=380;
function daysBetween(a,b){return Math.ceil((b-a)/86400000)}
function renderHealth(t){
  const today=new Date(todayIso()+'T00:00:00+09:00');
  const exam=new Date(EXAM_DATE+'T00:00:00+09:00');
  const daysLeft=Math.max(1,daysBetween(today,exam));
  const targetTotal=TOTAL_Q*TARGET_LAPS;
  const quota=targetTotal/daysLeft;                 // 1日ノルマ
  const quotaInt=Math.ceil(quota);

  // 経過日数（初回回答日〜今日）。未回答なら0
  let elapsed=0;
  if(t.first_answer_date){
    const f=new Date(t.first_answer_date+'T00:00:00+09:00');
    elapsed=Math.max(0,daysBetween(f,today));
  }
  const done=t.answers||0;

  // 今日の実績（localStorageで当日カウント）
  const todayDone=todayAnswerCount();
  const remain=Math.max(0,quotaInt-todayDone);

  // 指標1: 継続
  setSig('sig-streak', t.streak_days>0?'g':'r');
  $('#hp-streak').innerHTML=t.streak_days+'<span class="hu">日連続</span>';
  $('#hp-streak-sub').textContent=t.streak_days>0?('今日やれば'+(t.streak_days+1)+'日。途切れると0に戻る'):'今日が再スタート。1問でも解けば点灯';

  // 指標2: 貯金/借金
  const should=quota*elapsed;
  const balance=Math.round(done-should);
  const bEl=$('#hp-balance');
  if(elapsed===0){
    setSig('sig-balance','g');bEl.className='health-num';bEl.innerHTML='0<span class="hu">問</span>';
    $('#hp-balance-sub').textContent='今日スタート。まずノルマ'+quotaInt+'問';
  }else if(balance>=0){
    setSig('sig-balance','g');bEl.className='health-num';bEl.innerHTML='+'+balance+'<span class="hu">問</span>';
    $('#hp-balance-sub').textContent='予定'+Math.round(should)+'問に対し実績'+done+'問。貯金あり';
  }else{
    setSig('sig-balance',balance<-quotaInt*3?'r':'y');bEl.className='health-num '+(balance<-quotaInt*3?'bad':'warn');
    bEl.innerHTML=balance+'<span class="hu">問</span>';
    $('#hp-balance-sub').textContent='予定'+Math.round(should)+'問に対し実績'+done+'問。借金状態';
  }

  // 指標3: 到達周回
  const lapEl=$('#hp-lap');
  if(elapsed===0){
    setSig('sig-lap','g');lapEl.className='health-num';lapEl.innerHTML='—<span class="hu">周見込</span>';
    $('#hp-lap-sub').textContent='数日続けると見込みが出ます';
  }else{
    const pace=done/elapsed;
    const projected=pace*daysLeft/TOTAL_Q;
    const lap=Math.round(projected*10)/10;
    const diff=Math.round((lap-TARGET_LAPS)*10)/10;
    if(lap>=TARGET_LAPS){setSig('sig-lap','g');lapEl.className='health-num';}
    else if(lap>=TARGET_LAPS-1){setSig('sig-lap','y');lapEl.className='health-num warn';}
    else{setSig('sig-lap','r');lapEl.className='health-num bad';}
    lapEl.innerHTML=lap+'<span class="hu">周見込</span>';
    $('#hp-lap-sub').textContent='目標'+TARGET_LAPS+'周に'+(diff>=0?'+':'')+diff+'周。'+(lap>=TARGET_LAPS?'順調':'ペース不足');
  }

  // 警告帯
  const warn=$('#health-warn');
  if(remain<=0){
    warn.style.display='flex';warn.className='health-warn lv-ok';
    warn.innerHTML='<span class="wico">✓</span><div><div style="font-weight:700">今日のノルマ達成</div><div style="font-size:13px">今日'+todayDone+'問。この調子で貯金を作る</div></div>';
  }else{
    const debtDays=Math.round(remain/quota*10)/10;
    warn.style.display='flex';warn.className='health-warn '+(remain>=quotaInt?'lv-bad':'lv-warn');
    warn.innerHTML='<span class="wico">⚠</span><div><div style="font-weight:700">今日まだ'+remain+'問解いていない</div>'
      +'<div style="font-size:13px">このまま寝ると借金が <b>'+remain+'問</b> 増え、5周ラインから <b>'+debtDays+'日分</b> 遠のく</div></div>';
  }

  // ノルマバー
  $('#quota-n').textContent=quotaInt;
  $('#quota-formula').textContent='（残り'+daysLeft+'日 ÷ '+targetTotal.toLocaleString()+'問）';
  const segs=[];for(let i=0;i<quotaInt;i++)segs.push('<div class="quota-seg'+(i<todayDone?' fill':'')+'"></div>');
  $('#quota-bar').innerHTML=segs.join('');
  $('#quota-done').textContent='今日 '+todayDone+' / '+quotaInt+'問 完了';
}
function setSig(id,c){const e=$('#'+id);if(e)e.className='sig '+c}

// 今日の解答数をlocalStorageで記録
function todayAnswerCount(){
  try{const o=JSON.parse(localStorage.getItem('daily_answer_count')||'{}');return o[todayIso()]||0}catch(e){return 0}
}
function bumpTodayAnswer(){
  try{const o=JSON.parse(localStorage.getItem('daily_answer_count')||'{}');o[todayIso()]=(o[todayIso()]||0)+1;localStorage.setItem('daily_answer_count',JSON.stringify(o))}catch(e){}
}

function renderCountdown(){
  const t=new Date(targetDate()+'T00:00:00+09:00');const now=new Date();
  let months=(t.getFullYear()-now.getFullYear())*12+(t.getMonth()-now.getMonth());
  if(now.getDate()>t.getDate())months--;
  const y=Math.floor(months/12), m=months%12;
  const days=Math.max(0,Math.ceil((t-now)/86400000));
  $('#countdown').innerHTML=months>0?'残り <span class="num">'+y+'年'+m+'か月</span>':'残り <span class="num">'+days+'日</span>';
}
function todayIso(){return new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date())}
function esc(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function driveId(v){v=String(v||'').trim();if(!v)return '';const m=v.match(/\\/d\\/([^/]+)/)||v.match(/[?&]id=([^&]+)/);return m?m[1]:v}
function drivePreview(v){const id=driveId(v);return id?'https://drive.google.com/file/d/'+encodeURIComponent(id)+'/preview':''}
function driveView(v){v=String(v||'').trim();if(!v)return '';if(/^https?:\\/\\//.test(v))return v;return 'https://drive.google.com/file/d/'+encodeURIComponent(v)+'/view'}

async function api(path,opt){
  const r=await fetch(path,Object.assign({headers:{'Content-Type':'application/json'}},opt||{}));
  const d=await r.json();if(!r.ok)throw new Error(d.error||'APIエラー');return d;
}

const TIER={watch_video:'std',solve_questions:'std',review_wrong:'std',write_note:'ideal'};
const TIER_LABEL={min:'最低',std:'標準',ideal:'理想'};
const TIER_CLASS={min:'tier-min',std:'tier-std',ideal:'tier-ideal'};

async function loadToday(){
  $('#today-status').textContent='読み込み中…';
  try{
    const[tasks,today]=await Promise.all([api('/api/daily-tasks?date='+todayIso()),api('/api/today')]);
    state.tasks=tasks.tasks;state.today=today;
    renderTasks();
    $('#today-questions').innerHTML=today.questions.map(qCard).join('')||'<p class="muted">今日の問題がありません。</p>';
    $('#today-status').textContent='今日の出題 '+today.questions.length+'問';
  }catch(e){$('#today-status').innerHTML='<span class="error">'+esc(e.message)+'</span>'}
}

function renderTasks(){
  $('#task-list').innerHTML=state.tasks.map(t=>{
    const tier=TIER[t.task_id]||'std';
    return '<div class="task '+(t.done?'done':'')+'" data-task="'+esc(t.task_id)+'">'
      +'<span class="check">✓</span><span class="task-text">'+esc(t.title)+'</span>'
      +'<span class="tier '+TIER_CLASS[tier]+'">'+TIER_LABEL[tier]+'</span></div>';
  }).join('');
  const done=state.tasks.filter(t=>t.done).length;
  $('#task-progress').style.width=Math.round(done/Math.max(state.tasks.length,1)*100)+'%';
}

function qCard(q){
  const title=esc(q.year_label)+' 第'+esc(q.number)+'問';
  const pdfUrl=driveView(q.pdf_url);
  const pdfPage=q.pdf_page?('#page='+q.pdf_page):'';
  const sub=q.subject?'<span class="tag">'+esc(q.subject)+'</span>':'';
  const top=q.topic?'<span class="tag">'+esc(q.topic)+'</span>':'';
  return '<div class="q-card"><div style="display:flex;justify-content:space-between;align-items:flex-start">'
    +'<div><h3>'+title+'</h3><div class="muted small">'+esc(q.question_id)+'</div>'+sub+top+'</div>'
    +(q.wrong_count?'<div class="muted small">誤答'+q.wrong_count+'回</div>':'')+'</div>'
    +'<div class="q-actions">'
    +(q.video_url?'<button class="btn sec" data-video="'+esc(q.video_url)+'" data-title="'+title+'">解説動画</button>':'<button class="btn sec" disabled>動画なし</button>')
    +(STUDY_AIDS[q.question_id]?'<button class="btn sec" data-aid="'+esc(q.question_id)+'">字幕・要点</button>':'')
    +(pdfUrl?'<a class="btn sec" href="'+esc(pdfUrl)+(pdfUrl.includes('/preview')?pdfPage:'')+'" target="_blank" rel="noopener">問題PDF</a>':'<button class="btn sec" disabled>PDFなし</button>')
    +'</div><div class="q-actions">'
    +'<button class="btn" data-answer="'+esc(q.question_id)+'" data-result="correct">正解</button>'
    +'<button class="btn dan" data-answer="'+esc(q.question_id)+'" data-result="wrong">不正解</button>'
    +'</div></div>';
}

async function loadWrong(){
  $('#wrong-list').innerHTML='<p class="muted">読み込み中…</p>';
  try{const d=await api('/api/answers/wrong');
    $('#wrong-list').innerHTML=d.questions.map(qCard).join('')||'<p class="muted">直近30日の誤答はありません。</p>';
  }catch(e){$('#wrong-list').innerHTML='<p class="error">'+esc(e.message)+'</p>'}
}

async function loadStats(){
  try{
    const d=await api('/api/stats');const t=d.totals;
    $('#hero-rate').innerHTML=t.correct_rate+'<span class="unit">%</span>';
    renderHealth(t);
    const memoCount=memoList().length;
    $('#stats-summary').innerHTML=
      statBox('合格力',t.correct_rate+'<span class="unit">%</span>','択一正答率')
     +statBox('実務資産',memoCount+'<span class="unit">件</span>','実務メモ累計')
     +statBox('消化',t.answered_questions+'<span class="unit">/'+t.total_questions+'</span>','解いた問題')
     +statBox('継続',t.streak_days+'<span class="unit">日</span>','連続学習')
     +statBox('回答数',t.answers+'<span class="unit">回</span>','累計の解答')
     +statBox('正解数',t.correct+'<span class="unit">回</span>','累計の正解');
    $('#stats-years').innerHTML='<table><thead><tr><th>年度</th><th>回答</th><th>率</th></tr></thead><tbody>'
      +d.by_year.map(r=>'<tr><td>'+esc(r.year_label)+'</td><td style="text-align:center">'+r.attempts+'</td><td style="text-align:center">'+(r.rate||0)+'%</td></tr>').join('')+'</tbody></table>';
    $('#stats-subjects').innerHTML=d.by_subject.length
      ?'<table><tbody>'+d.by_subject.map(r=>'<tr><td>'+esc(r.subject||'未分類')+'</td><td style="text-align:right">'+(r.rate||0)+'%</td></tr>').join('')+'</tbody></table>'
      :'<p class="muted small">科目データは管理画面で設定できます。</p>';
  }catch(e){$('#stats-summary').innerHTML='<p class="error">'+esc(e.message)+'</p>'}
}
function statBox(label,val,sub){return '<div class="stat"><div class="stat-label">'+label+'</div><b>'+val+'</b><div class="sub">'+sub+'</div></div>'}

function memoList(){try{return JSON.parse(localStorage.getItem('jitsumu_memos')||'[]')}catch(e){return[]}}
function saveMemo(m){const l=memoList();l.unshift(m);try{localStorage.setItem('jitsumu_memos',JSON.stringify(l))}catch(e){}}
function renderMemoHistory(){
  const l=memoList();
  if(!l.length){$('#memo-history').innerHTML='';return}
  $('#memo-history').innerHTML='<div class="card-label" style="margin-top:10px">これまでの実務資産（'+l.length+'件）</div>'
    +l.slice(0,5).map(m=>'<div class="q-card" style="margin-bottom:8px"><div class="muted small">'+esc(m.date)+(m.question_id?' ・ '+esc(m.question_id):'')+'</div>'
      +(m.genba?'<div class="small">📍 '+esc(m.genba)+'</div>':'')
      +(m.kokyaku?'<div class="small">💬 '+esc(m.kokyaku)+'</div>':'')
      +(m.risk?'<div class="small">⚠️ '+esc(m.risk)+'</div>':'')
      +(m.yakusho?'<div class="small">🏛 '+esc(m.yakusho)+'</div>':'')
      +'</div>').join('');
}
function openMemo(qid){
  $('#memo-genba').value='';$('#memo-kokyaku').value='';$('#memo-risk').value='';$('#memo-yakusho').value='';
  $('#memo-save-status').textContent='';
  $('#memo-modal').dataset.qid=qid||'';
  $('#memo-context').textContent=qid?('対象：'+qid):'過去問を解いて気づいたことを、未来の仕事の引き出しに変える。';
  renderMemoHistory();
  $('#memo-modal').classList.add('active');
}

function plainAidText(v){return String(v||'').replaceAll('**','')}
function aidText(v){return esc(v).split('**').map((p,i)=>i%2?'<strong>'+p+'</strong>':p).join('')}
function aidPlain(v){return esc(plainAidText(v))}
function escText(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function ttsReadable(v){
  return plainAidText(v)
    .replaceAll('：','。')
    .replaceAll('・','、')
    .replace(/([。、！？])/g,'$1 ')
    .replace(/\s+/g,' ')
    .trim();
}
function ttsAttr(v){return esc(ttsReadable(v))}
let googleTtsAudio=null,googleTtsUrl='',ttsTraceTimer=null,ttsStopFlag=false,currentTtsUnits=[],currentTtsIndex=0;
function setTtsVisible(on){
  const box=$('#tts-controls');if(box)box.style.display=on?'flex':'none';
}
function aidDoc(){return $('#aid-content')}
function clearTtsTimer(){if(ttsTraceTimer){clearInterval(ttsTraceTimer);ttsTraceTimer=null}}
function releaseTtsUrl(){if(googleTtsUrl){URL.revokeObjectURL(googleTtsUrl);googleTtsUrl=''}}
function resetTtsTrace(){
  clearTtsTimer();
  currentTtsUnits.forEach(el=>{
    if(el&&el.dataset&&el.dataset.originalHtml){el.innerHTML=el.dataset.originalHtml;delete el.dataset.originalHtml}
    if(el&&el.classList)el.classList.remove('tts-reading');
  });
}
function stopSpeech(){
  ttsStopFlag=true;
  if(googleTtsAudio){try{googleTtsAudio.pause();googleTtsAudio.src=''}catch(e){}googleTtsAudio=null}
  releaseTtsUrl();resetTtsTrace();
}
function splitTtsText(text){
  const out=[];let buf='';
  const breaks=new RegExp('(?<=[：。！？、・'+String.fromCharCode(10)+'])');
  String(text||'').split(breaks).forEach(p=>{
    if((buf+p).length>260&&buf){out.push(buf);buf=p}else buf+=p;
  });
  if(buf.trim())out.push(buf);
  return out.length?out:[String(text||'')];
}
function markUnit(el,text,ratio){
  if(!el)return;
  const s=String(text||'');
  if(!el.dataset.originalHtml)el.dataset.originalHtml=el.innerHTML;
  const idx=Math.max(0,Math.min(s.length,Math.floor(s.length*ratio)));
  const cur=s.slice(idx,idx+1);
  el.innerHTML='<span class="tts-hl">'+escText(s.slice(0,idx))+'</span>'
    +(cur?'<span class="tts-word">'+escText(cur)+'</span>':'')
    +escText(s.slice(idx+1));
  const cursor=el.querySelector('.tts-word');if(cursor)cursor.scrollIntoView({behavior:'smooth',block:'center'});
}
function finishUnit(el,text){
  if(!el)return;
  clearTtsTimer();
  el.innerHTML='<span class="tts-hl">'+escText(text)+'</span>';
  el.classList.remove('tts-reading');
}
async function fetchTtsUrl(text){
  const data=await api('/api/tts',{method:'POST',body:JSON.stringify({text,voice:'ja-JP-Wavenet-D',rate:1.15,pitch:-6})});
  const bin=atob(data.audioContent);const bytes=new Uint8Array(bin.length);
  for(let i=0;i<bin.length;i++)bytes[i]=bin.charCodeAt(i);
  return URL.createObjectURL(new Blob([bytes],{type:'audio/mpeg'}));
}
async function playGoogleUnit(index,parts,partIndex){
  if(ttsStopFlag)return;
  const el=currentTtsUnits[index];
  if(!el){currentTtsIndex=index;return}
  currentTtsIndex=index;
  currentTtsUnits.forEach(x=>x.classList.remove('tts-reading'));
  const full=el.dataset.ttsText||el.innerText||'';
  const seq=parts||splitTtsText(full);
  const text=seq[partIndex||0]||'';
  if(!text.trim())return playGoogleUnit(index+1);
  el.classList.add('tts-reading');
  try{
    releaseTtsUrl();
    googleTtsUrl=await fetchTtsUrl(text);
    if(ttsStopFlag)return;
    googleTtsAudio=new Audio(googleTtsUrl);
    googleTtsAudio.onloadedmetadata=()=>{
      const duration=Math.max(1,googleTtsAudio.duration||Math.max(2,text.length/8));
      const started=performance.now();
      clearTtsTimer();
      ttsTraceTimer=setInterval(()=>{
        if(!googleTtsAudio||googleTtsAudio.paused)return;
        const ratio=Math.min(0.98,(performance.now()-started)/(duration*1000));
        markUnit(el,text,ratio);
      },90);
    };
    googleTtsAudio.onended=()=>{
      finishUnit(el,text);
      const nextPart=(partIndex||0)+1;
      if(seq[nextPart])playGoogleUnit(index,seq,nextPart);
      else playGoogleUnit(index+1);
    };
    googleTtsAudio.onerror=()=>{finishUnit(el,text);playGoogleUnit(index+1)};
    markUnit(el,text,0);
    await googleTtsAudio.play();
  }catch(e){
    clearTtsTimer();el.classList.remove('tts-reading');
    const raw=e&&e.message!==undefined?e.message:e;
    const msg=typeof raw==='string'?raw:JSON.stringify(raw);
    alert('Google読み上げでエラーが出ました: '+msg);
  }
}
function startSpeech(){
  const doc=aidDoc();
  currentTtsUnits=doc?Array.from(doc.querySelectorAll('.tts-unit')):[];
  if(!currentTtsUnits.length)return alert('読み上げる要点がありません。');
  stopSpeech();
  ttsStopFlag=false;
  currentTtsIndex=0;
  playGoogleUnit(0);
}
function toggleSpeechPause(){
  if(!googleTtsAudio)return;
  if(googleTtsAudio.paused)googleTtsAudio.play();
  else googleTtsAudio.pause();
}
function openStudyAid(qid){
  const aid=STUDY_AIDS[qid];if(!aid)return;
  $('#video-title').textContent=aid.title;
  stopSpeech();
  const frame=$('#video-frame');
  frame.src='';
  frame.style.display='none';
  const aidBox=$('#aid-content');
  aidBox.style.display='block';
  setTtsVisible(true);
  const rows=aid.cues.map(c=>'<div class="cue"><time>'+esc(c[0])+'</time><div>'+aidText(c[1])+'</div></div>').join('');
  const image=(aid.image||[]).map(x=>'<li>'+aidPlain(x)+'</li>').join('');
  const imageText=(aid.image||[]).join('');
  const core=(aid.core||[]).map(x=>'<li class="tts-unit" data-tts-text="'+ttsAttr(x)+'">'+aidPlain(x)+'</li>').join('');
  const exam=aid.exam.map(x=>'<li class="tts-unit" data-tts-text="'+ttsAttr(x)+'">'+aidPlain(x)+'</li>').join('');
  const practical=aid.practical.map(x=>'<li>'+aidText(x)+'</li>').join('');
  const imageBox=image?'<div class="box" style="margin-top:12px"><h3>実際のイメージ</h3><div class="tts-unit" data-tts-text="'+ttsAttr('実際のイメージ。'+imageText)+'"><ul>'+image+'</ul></div></div>':'';
  const asked='<div class="tts-unit" data-tts-text="'+ttsAttr((aid.pattern||'パターン分類')+'。'+(aid.asked||''))+'">'+aidPlain(aid.asked||'')+'</div>';
  const doc='<!doctype html><html lang="ja"><head><meta charset="utf-8"><style>body{font-family:system-ui,\"Noto Sans JP\",sans-serif;margin:0;padding:18px;background:#fdfbf5;color:#3a3a38;line-height:1.7}.note{color:#8a8580;font-size:13px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}.box{background:#fff;border:1px solid #ece5da;border-radius:12px;padding:14px}h2{margin:0 0 4px;color:#5d8a3f}h3{margin:0 0 8px;color:#5d8a3f}.cue{display:grid;grid-template-columns:74px 1fr;gap:8px;border-top:1px solid #ece5da;padding:8px 0;font-size:14px}.cue:first-child{border-top:0}time{font-family:Consolas,monospace;color:#c9a24b;font-size:12px}li{margin:6px 0}.tts-unit{transition:background .15s}.tts-unit.tts-reading{background:transparent}.tts-hl{background:transparent;color:inherit;border-radius:0;font-weight:800}.tts-word{background:transparent;color:inherit;border-radius:0;padding:0;font-weight:900;box-shadow:none}@media(max-width:720px){.grid{grid-template-columns:1fr}}</style></head><body>'
    +'<h2>'+esc(aid.module)+'</h2><div class="note">'+esc(aid.status)+'</div>'
    +imageBox
    +'<div class="box" style="margin-top:12px"><h3>'+esc(aid.pattern||'パターン分類')+'</h3>'+asked+(core?'<ul>'+core+'</ul>':'')+'</div>'
    +'<div class="grid" style="margin-top:12px"><div class="box"><h3>字幕タイムライン</h3>'+rows+'</div>'
    +'<div><div class="box"><h3 class="tts-unit" data-tts-text="'+ttsAttr('試験で問われるポイント')+'">試験で問われるポイント</h3><ul>'+exam+'</ul></div>'
    +'<div class="box" style="margin-top:12px"><h3>実務への接続</h3><ul>'+practical+'</ul></div></div></div>'
    +'<div class="box" style="margin-top:12px"><h3>次の改善</h3><div>'+esc(aid.next)+'</div></div>'
    +'</body></html>';
  const start=doc.indexOf('<body>')+6,end=doc.lastIndexOf('</body>');
  aidBox.innerHTML=doc.slice(start,end);
  $('#video-modal').classList.add('active');
}

document.addEventListener('click',async e=>{
  const tab=e.target.closest('[data-tab]');
  if(tab){$$('.nav-item').forEach(x=>x.classList.toggle('active',x===tab));
    $$('.panel').forEach(x=>x.classList.toggle('active',x.id===tab.dataset.tab));
    if(tab.dataset.tab==='wrong')loadWrong();if(tab.dataset.tab==='stats')loadStats();return}

  const task=e.target.closest('[data-task]');
  if(task){const id=task.dataset.task;const t=state.tasks.find(x=>x.task_id===id);if(!t)return;
    const nd=t.done?0:1;t.done=nd;renderTasks();
    try{await api('/api/daily-tasks',{method:'POST',body:JSON.stringify({task_date:todayIso(),task_id:id,done:nd})})}
    catch(err){t.done=nd?0:1;renderTasks();alert(err.message)}return}

  if(e.target.closest('#open-memo')){openMemo('');return}
  if(e.target.closest('[data-close-memo]')){$('#memo-modal').classList.remove('active');return}
  if(e.target.closest('#save-memo')){
    const m={date:todayIso(),question_id:$('#memo-modal').dataset.qid||'',
      genba:$('#memo-genba').value.trim(),kokyaku:$('#memo-kokyaku').value.trim(),
      risk:$('#memo-risk').value.trim(),yakusho:$('#memo-yakusho').value.trim()};
    if(!m.genba&&!m.kokyaku&&!m.risk&&!m.yakusho){$('#memo-save-status').innerHTML='<span class="error">1行でも書いてください。</span>';return}
    saveMemo(m);$('#memo-save-status').textContent='実務資産に1件加えました。';
    $('#memo-genba').value='';$('#memo-kokyaku').value='';$('#memo-risk').value='';$('#memo-yakusho').value='';
    renderMemoHistory();return}

  const vid=e.target.closest('[data-video]');
  if(vid&&!vid.disabled){const url=drivePreview(vid.dataset.video);if(url){stopSpeech();setTtsVisible(false);$('#aid-content').style.display='none';$('#video-frame').style.display='block';$('#video-title').textContent=vid.dataset.title||'解説動画';$('#video-frame').src=url;$('#video-modal').classList.add('active')}return}
  const aid=e.target.closest('[data-aid]');
  if(aid&&!aid.disabled){openStudyAid(aid.dataset.aid);return}
  if(e.target.closest('[data-tts-start]')){startSpeech();return}
  if(e.target.closest('[data-tts-pause]')){toggleSpeechPause();return}
  if(e.target.closest('[data-tts-stop]')){stopSpeech();return}
  if(e.target.closest('[data-close-video]')){stopSpeech();setTtsVisible(false);$('#video-modal').classList.remove('active');$('#video-frame').src='';$('#aid-content').innerHTML='';return}

  const ans=e.target.closest('[data-answer]');
  if(ans){ans.disabled=true;
    try{await api('/api/answers',{method:'POST',body:JSON.stringify({question_id:ans.dataset.answer,result:ans.dataset.result,answered_at:todayIso()})});
      bumpTodayAnswer();
      if(ans.dataset.result==='wrong'){openMemo(ans.dataset.answer)}
      await loadToday();await loadStats();
    }catch(err){alert(err.message);ans.disabled=false}}
});

renderCountdown();
loadToday();
loadStats();
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

