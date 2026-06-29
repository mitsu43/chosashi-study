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
           q.subject, q.topic, q.video_url, q.pdf_url, q.pdf_page, q.question_text,
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
             q.subject, q.topic, q.video_url, q.pdf_url, q.pdf_page, q.question_text,
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
           q.subject, q.topic, q.video_url, q.pdf_url, q.pdf_page, q.question_text,
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
    SELECT question_id, type, year_label, number, subject, topic, video_url, pdf_url, pdf_page, question_text
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

  const allowed = ['pdf_url','video_url','pdf_page','question_text'];
  if (!questionId || !allowed.includes(field)) throw new Error('question_id and valid field required');
  const exists = await env.DB.prepare('SELECT 1 FROM questions WHERE question_id=?').bind(questionId).first();
  if (!exists) throw new Error(`Unknown question_id: ${questionId}`);

  if (field === 'pdf_page') {
    const page = parseInt(value, 10);
    if (isNaN(page) || page < 1) throw new Error('pdf_page must be a positive integer');
    await env.DB.prepare(`UPDATE questions SET pdf_page=? WHERE question_id=?`).bind(page, questionId).run();
  } else if (field === 'question_text') {
    await env.DB.prepare(`UPDATE questions SET question_text=? WHERE question_id=?`).bind(value || null, questionId).run();
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
    #tts-controls button:disabled{opacity:1;cursor:not-allowed}
    #tts-controls .tts-active{background:#1f6130;color:#fff;border-color:#1f6130}
    #tts-controls .tts-paused{background:#f3efe2;color:#7a5b11;border-color:#d8c681}
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
      'たとえば共有建物に無断で住んでいる第三者がいるなら、これは共有物を守る場面なので、共有者の1人から明渡しを求める説明につながる。',
      '一方で、共有者Aが建物を使っている、またはAが誰かに貸しているだけなら、他の共有者が「自分は了解していない」と言うだけで、当然に追い出せるとは限らない。',
      '賃貸借を解除したい場面では、誰が何割の持分を持っているかを確認する。3分の1ずつなら2人の同意で3分の2となり、過半数を満たす。',
      '共有者が自分の持分だけを担保に入れる場面では、共有物全体を処分しているのではなく自己持分の処分なので、他の共有者の同意はいらない。',
      '実務では、相談を受けた時点で「これは保存か、管理か、変更・処分か、自己持分だけの話か」とメモしておくと、顧客説明と必要な同意集めが速くなる。',
    ],
    next:'次はこの形式でH1702以降も追加し、法規OSモジュール別に検索・復習できる形へ広げます。'
  },
  H1702:{
    title:'H17 第2問 講義ノート',
    status:'科目・論点から作成した要点メモです。過去問本文と照合しながら追記できます。',
    module:'権利前提モジュール（民法）',
    topic:'物権変動',
    pattern:'パターン分類：登記で勝ち負けが決まる相手か',
    asked:'何が問われているか：**不動産の権利変動について、登記がないと誰に対抗できないのか、逆に登記がなくても主張できる相手なのかを判別できるか。**',
    image:[
      'この問題は、同じ土地や建物について「先に買った人」と「後から関わった人」がぶつかる場面を想像する。',
      '物権変動とは、所有権などの権利がAからBへ動くこと。売買、相続、時効取得などで権利の持ち主が変わる。',
      '対抗要件とは、第三者に対して「自分が権利者です」と言うための外向きの札。土地建物では登記がその札になる。',
      '第三者とは、単なる通行人ではなく、その不動産について利害関係を持って入ってきた人。二重譲受人、差押債権者、抵当権者などをイメージする。',
      '試験では「この人は登記を要求できる立場か」「この相手には登記なしで主張できるか」を一人ずつ仕分ける。',
    ],
    core:[
      '**物権変動**：所有権などの権利が動くこと。契約だけで当事者間では効力が生じる。',
      '**対抗要件**：第三者に権利を主張するための条件。不動産では原則として登記が必要。',
      '**第三者性**：登記がないことを主張できる正当な利害関係者かを判定する。',
      '**当事者・包括承継人**：売主や買主本人、相続人などには、第三者とは違う処理になる場面がある。',
    ],
    cues:[
      ['00:00','物権変動は、権利が動いた事実と、それを第三者に主張できるかを分けて考える。'],
      ['00:30','登記は第三者へ見せる札。登記が必要な相手かどうかを判断する。'],
      ['01:00','二重譲渡や差押えなど、同じ不動産に利害関係を持つ人が出てきたら対抗問題を疑う。'],
    ],
    exam:[
      '**当事者間**では、売買契約などで権利変動の効力が生じるが、第三者に勝つには別途登記が問題になる。',
      '**二重譲渡**では、原則として先に登記を備えた者が優先するという発想で整理する。',
      '**第三者に当たるか**を最初に判定する。登記の有無だけを機械的に見ると誤る。',
      '**背信的悪意者などの例外**が出る場合は、登記制度の信頼を利用する正当性があるかを考える。',
    ],
    practical:[
      '売買相談では、契約しただけで安心せず、登記まで終えて初めて第三者に強くなると説明する。',
      '相続後に売却や担保設定が絡む場合、誰の名義で登記されているかを先に確認する。',
      '二重売買や差押えのような紛争では、時系列表を作り、契約日、登記日、差押日を並べると判断しやすい。',
    ],
    next:'登記が必要な相手かどうかを、人物ごとに丸印で仕分ける練習に使う。'
  },
  H1703:{
    title:'H17 第3問 講義ノート',
    status:'科目・論点から作成した要点メモです。過去問本文と照合しながら追記できます。',
    module:'権利前提モジュール（民法）',
    topic:'取得時効・担保物権',
    pattern:'パターン分類：時効で取得できるか、担保権に勝てるか',
    asked:'何が問われているか：**占有の状態、期間、善意悪意、登記や抵当権との関係を整理し、時効取得の成否と対抗関係を判別できるか。**',
    image:[
      'この問題は、長年土地を使ってきた人が「もう自分のものになった」と言えるかを考える場面を想像する。',
      '取得時効とは、一定期間、所有者らしく占有し続けた人に権利取得を認める仕組み。',
      '占有とは、現実に支配している状態。畑として使う、建物を建てて住む、塀で囲うなどがイメージしやすい。',
      '担保物権とは、借金の回収を確保するために不動産につける権利。抵当権はその代表例。',
      '試験では、時効完成の前後で登記や抵当権が入った場合に、誰に対抗できるかが問われやすい。',
    ],
    core:[
      '**取得時効**：所有の意思をもって平穏・公然に一定期間占有することで権利取得が問題になる。',
      '**善意無過失と悪意**：必要期間や評価に影響するため、占有開始時点の認識を見る。',
      '**時効完成前後**：第三者が現れた時期により、登記の要否や勝敗の整理が変わる。',
      '**担保物権**：抵当権など、所有権とは別に不動産へ付着する権利との関係を意識する。',
    ],
    cues:[
      ['00:00','取得時効は、期間だけでなく占有の性質を見る。'],
      ['00:30','登記や抵当権がいつ入ったかで、時効取得者との関係が変わる。'],
      ['01:00','時系列を作り、占有開始、時効完成、登記、抵当権設定を並べる。'],
    ],
    exam:[
      '**占有開始時点**の事情を見る。善意無過失か、所有の意思があるかを確認する。',
      '**時効完成時点**を押さえる。完成前の第三者か、完成後の第三者かで整理が変わる。',
      '**登記の要否**を対抗関係として考える。時効取得しただけで常に誰にでも勝てるわけではない。',
      '**抵当権との関係**では、抵当権設定時期と時効完成時期を必ず比較する。',
    ],
    practical:[
      '古くから使っている土地の相談では、いつから、誰が、どの範囲を、どんな目的で使ってきたかを聞き取る。',
      '境界や時効の相談では、写真、固定資産税、塀、耕作、建物利用など、占有を裏付ける材料を集める。',
      '抵当権が絡む不動産では、登記簿で担保設定日を確認し、時効主張の時系列に入れる。',
    ],
    next:'時系列表を書き、時効完成前後で登場人物を分ける。'
  },
  H1704:{
    title:'H17 第4問 講義ノート',
    status:'科目・論点から作成した要点メモです。過去問本文と照合しながら追記できます。',
    module:'登記総論モジュール（不動産登記法）',
    topic:'総則・登記記録',
    pattern:'パターン分類：登記記録のどこに何を書くか',
    asked:'何が問われているか：**登記記録の構造、表題部と権利部の役割、登記事項の意味を理解し、どの情報がどこで管理されるかを判別できるか。**',
    image:[
      'この問題は、不動産ごとの台帳を法務局が持っていて、その台帳のどの欄に何を書くかを考える場面。',
      '登記記録とは、不動産の身分証明書のようなもの。土地や建物ごとに情報が整理されている。',
      '表題部は、不動産の物理的な姿を書く欄。土地なら所在、地番、地目、地積。建物なら所在、家屋番号、種類、構造、床面積など。',
      '権利部は、誰が所有者か、抵当権があるかなど、権利関係を書く欄。',
      '土地家屋調査士が主に扱うのは、表示に関する登記、つまり表題部を正しく整える仕事。',
    ],
    core:[
      '**登記記録**：不動産ごとの情報を管理する単位。表題部と権利部に分けて理解する。',
      '**表題部**：不動産の物理的状況を示す。土地家屋調査士の中心領域。',
      '**権利部**：所有権や抵当権などの権利関係を示す。',
      '**登記事項**：法律上、登記記録に記録されるべき情報。欄ごとの役割を押さえる。',
    ],
    cues:[
      ['00:00','登記記録は、不動産の情報を整理する台帳として考える。'],
      ['00:30','表題部は物理情報、権利部は権利情報と分ける。'],
      ['01:00','表示に関する登記は、現地と登記記録を一致させるための仕組み。'],
    ],
    exam:[
      '**表題部と権利部**の違いを問われる。物理情報か権利情報かで仕分ける。',
      '**土地の登記事項**と**建物の登記事項**を混同しない。',
      '**表示に関する登記**は、現況を公示するための基礎情報を整えるもの。',
      '**登記記録の構造**を知っていると、申請書や添付情報の意味もつながる。',
    ],
    practical:[
      '現地調査前に登記記録を見て、表題部の地目、地積、家屋番号、床面積などを確認する。',
      '現況と登記記録が違う場合、どの表示登記で直すのかを考える。',
      '顧客には、権利の名義変更と、土地建物の形状や面積を直す登記は別物だと説明する。',
    ],
    next:'登記記録を「物理情報」と「権利情報」に分けて読む。'
  },
  H1705:{
    title:'H17 第5問 講義ノート',
    status:'科目・論点から作成した要点メモです。過去問本文と照合しながら追記できます。',
    module:'登記総論モジュール（不動産登記法）',
    topic:'申請手続き・添付情報',
    pattern:'パターン分類：誰が何を添えて申請するか',
    asked:'何が問われているか：**表示に関する登記の申請で、申請人、申請先、添付情報、申請義務の有無を整理できるか。**',
    image:[
      'この問題は、役所へ届出を出す場面を想像すると分かりやすい。何をしたいのか、誰が出すのか、証拠として何を付けるのかをそろえる。',
      '申請人とは、その登記を出す立場の人。所有者、表題部所有者、相続人など、登記の種類で変わる。',
      '添付情報とは、申請内容が正しいことを支える資料。図面、住所証明、所有権証明、代理権限証明などをイメージする。',
      '表示に関する登記は、物理的な現況を登記記録へ反映させるため、権利登記とは違う申請義務が出る場面がある。',
    ],
    core:[
      '**申請人**：誰が申請できるか、または申請しなければならないかを見る。',
      '**申請情報**：登記の目的、原因、対象不動産、申請人など、申請書の骨格になる情報。',
      '**添付情報**：申請内容を裏付ける資料。登記の種類ごとに必要性を整理する。',
      '**申請義務**：表示に関する登記では、一定期間内の申請義務が問題になることがある。',
    ],
    cues:[
      ['00:00','申請手続は、誰が何を証明して申請するかを考える。'],
      ['00:30','添付情報は申請内容を支える証拠資料として理解する。'],
      ['01:00','表示登記では申請義務や期間もセットで確認する。'],
    ],
    exam:[
      '**申請人適格**を問われる。所有者か、相続人か、代理人かを確認する。',
      '**添付情報の要否**を問われる。図面や証明情報が何のために必要かで判断する。',
      '**申請義務と期間**を問われる場合は、いつ事実が発生したかを見る。',
      '**権利登記との違い**を意識する。表示登記は現況把握の性格が強い。',
    ],
    practical:[
      '受任時は、登記の目的、現況、所有者、必要図面、委任状、証明書をチェックリスト化する。',
      '顧客には、測量や現地確認だけでなく、法務局に出す根拠資料が必要だと説明する。',
      '申請義務がある登記では、事実発生日を聞き取り、期限を意識して作業予定を組む。',
    ],
    next:'申請人、申請情報、添付情報、期限の4点セットで読む。'
  },
  H1706:{
    title:'H17 第6問 講義ノート',
    status:'科目・論点から作成した要点メモです。過去問本文と照合しながら追記できます。',
    module:'登記総論モジュール（不動産登記法）',
    topic:'申請手続き・登記識別情報',
    pattern:'パターン分類：登記識別情報が必要な場面か',
    asked:'何が問われているか：**登記識別情報の意味、通知される場面、提供が必要な場面、提供できない場合の処理を理解できるか。**',
    image:[
      '登記識別情報は、昔の権利証に近い役割を持つ、本人確認と意思確認のための重要情報としてイメージする。',
      'パスワードのようなものなので、持っている人が本人らしいとは言えるが、むやみに見せたり渡したりするものではない。',
      '権利を失う側、たとえば売主や抵当権設定者が関与する登記では、本人の意思確認として問題になりやすい。',
      '表示に関する登記では、常に登記識別情報が中心になるわけではなく、どの登記で必要かを区別する。',
    ],
    core:[
      '**登記識別情報**：登記名義人となった者に通知される、本人確認に関わる重要情報。',
      '**提供場面**：権利に関する登記で、登記義務者の関与を確認するために問題になる。',
      '**通知場面**：新たに登記名義人となる場合に通知されるかを整理する。',
      '**提供できない場合**：事前通知など代替手続が問題になることがある。',
    ],
    cues:[
      ['00:00','登記識別情報は、登記名義人の本人性や意思を確認する情報として考える。'],
      ['00:30','通知される場面と提供する場面を分ける。'],
      ['01:00','表示登記と権利登記で、重要になる場面が異なる。'],
    ],
    exam:[
      '**通知される者**と**提供する者**を混同しない。',
      '**登記義務者**が関与する登記では、登記識別情報の提供が問題になりやすい。',
      '**提供できない場合**の代替手続を押さえる。',
      '**表示に関する登記**では、登記識別情報が不要または中心でない場面もあるため、登記の種類で判断する。',
    ],
    practical:[
      '売買や担保設定が絡む相談では、権利証や登記識別情報の有無を早めに確認する。',
      '顧客には、登記識別情報はパスワードに近いので、写真送付や不用意な共有をしないよう説明する。',
      '紛失している場合は、代替手続に時間や費用がかかる可能性を事前に伝える。',
    ],
    next:'通知、提供、提供不能時の代替という3区分で覚える。'
  },
  H1707:{
    title:'H17 第7問 講義ノート',
    status:'科目・論点から作成した要点メモです。過去問本文と照合しながら追記できます。',
    module:'表示各論・土地モジュール（不動産登記法）',
    topic:'土地の表示に関する登記（地目・地積）',
    pattern:'パターン分類：土地の使われ方と面積をどう登記するか',
    asked:'何が問われているか：**地目の判定、地積の考え方、現況と登記のズレをどの表示登記で整えるかを判断できるか。**',
    image:[
      'この問題は、現地の土地を見て「これは宅地なのか、田なのか、雑種地なのか」「面積はどう扱うのか」を考える場面。',
      '地目とは、土地の主な用途を表すラベル。見た目だけでなく、利用目的や現況から判断する。',
      '地積とは、土地の面積。登記記録上の数字と、測量して分かる実測面積がズレることがある。',
      '土地家屋調査士の仕事では、現地、図面、登記記録を突き合わせて、地目や地積を整える。',
    ],
    core:[
      '**地目**：土地の主たる用途で判定する。現況を重視する。',
      '**地積**：土地の面積。測量や地積測量図との関係を意識する。',
      '**地目変更登記**：利用状況が変わったときに登記記録を現況へ合わせる。',
      '**地積更正登記**：登記地積が実際の面積と異なる場合に問題になる。',
    ],
    cues:[
      ['00:00','土地表示は、現地の状態を登記記録へ反映させる発想で読む。'],
      ['00:30','地目は用途、地積は面積。どちらのズレかを分ける。'],
      ['01:00','現況、登記記録、測量成果の3つを照合する。'],
    ],
    exam:[
      '**地目の判定基準**を問われる。名称ではなく主たる用途で見る。',
      '**地積更正と地目変更**を混同しない。面積の問題か、用途の問題かで分ける。',
      '**現況主義**の発想が重要。登記簿の文字だけで判断しない。',
      '**土地表示登記の種類**を、発生した事実から選べるようにする。',
    ],
    practical:[
      '現地で駐車場、畑、宅地、山林などの使われ方を写真とメモで残す。',
      '測量成果と登記地積が違う場合、単なる誤差か、更正を検討すべき差かを確認する。',
      '顧客には、土地の使い方が変わると登記上の地目も見直しが必要になる場合があると説明する。',
    ],
    next:'地目は用途、地積は面積という軸で、問題文を色分けする。'
  },
  H1708:{
    title:'H17 第8問 講義ノート',
    status:'科目・論点から作成した要点メモです。過去問本文と照合しながら追記できます。',
    module:'表示各論・土地モジュール（不動産登記法）',
    topic:'土地の表示に関する登記（分筆・合筆）',
    pattern:'パターン分類：土地を分けるか、くっつけるか',
    asked:'何が問われているか：**分筆・合筆の意味、できる条件、できない制限、前提として必要な登記を判断できるか。**',
    image:[
      '分筆は、1つの土地を2つ以上に切り分けること。相続で兄弟に分ける、土地の一部を売る場面を想像する。',
      '合筆は、隣り合う複数の土地を1つにまとめること。管理しやすくするために番号をまとめるイメージ。',
      'ただし、何でも自由に合体できるわけではない。地目、所有者、権利関係などが違うと、先に整える必要が出る。',
      '試験では「このまま合筆できるか」「先に地目変更や権利整理が必要か」を問われやすい。',
    ],
    core:[
      '**分筆登記**：一筆の土地を数筆に分ける登記。境界と地積の整理が重要。',
      '**合筆登記**：数筆の土地を一筆にまとめる登記。制限事由を確認する。',
      '**合筆制限**：地目、所有者、持分、権利関係などがそろっているかを見る。',
      '**前提登記**：合筆前に地目変更や更正などを済ませる必要がある場合がある。',
    ],
    cues:[
      ['00:00','分筆は分ける、合筆はまとめるとシンプルに押さえる。'],
      ['00:30','合筆は制限が多いので、できない理由を探す問題になりやすい。'],
      ['01:00','地目、所有者、権利関係をチェックリストで確認する。'],
    ],
    exam:[
      '**分筆と合筆**の効果を混同しない。',
      '**合筆できない条件**を問われる。地目や所有者、権利関係の違いを見る。',
      '**前提登記の必要性**を判断する。たとえば地目が違えば先に地目変更が必要になることがある。',
      '**記述式への接続**として、申請順序を意識する。',
    ],
    practical:[
      '土地の一部売却では、まず分筆が必要になることが多い。境界確認、測量、地積測量図が実務の中心になる。',
      '合筆相談では、登記簿を見て所有者、持分、地目、抵当権などがそろっているかを確認する。',
      '顧客には、「隣同士だからすぐ1つにできる」とは限らず、先に地目や権利の整理が必要な場合があると説明する。',
    ],
    next:'合筆は、地目、所有者、持分、権利関係の4点チェックで読む。'
  },
  H1709:{
    title:'H17 第9問 講義ノート',
    status:'科目・論点から作成した要点メモです。過去問本文と照合しながら追記できます。',
    module:'表示各論・土地モジュール（不動産登記法）',
    topic:'土地の表示に関する登記（地図・地積測量図）',
    pattern:'パターン分類：位置を示す図面か、面積計算を示す図面か',
    asked:'何が問われているか：**地図、地図に準ずる図面、地積測量図の役割を区別し、どの図面が何を示すのかを理解できるか。**',
    image:[
      'この問題は、土地を上から見た図面をどう使い分けるかを考える場面。',
      '地図は、土地の位置や筆界を公的に示す基本図のイメージ。',
      '地図に準ずる図面は、地図が整備されていない地域で補助的に使われる図面として考える。',
      '地積測量図は、特定の土地について、境界点、辺長、求積方法などを示し、面積計算の根拠になる図面。',
      '調査士実務では、登記記録だけでなく、地図、公図、地積測量図、現地を突き合わせて判断する。',
    ],
    core:[
      '**地図**：土地の位置と筆界を示す公的な図面。',
      '**地図に準ずる図面**：地図が備え付けられるまでの補助的な図面。',
      '**地積測量図**：個別土地の形状、境界点、辺長、求積の根拠を示す図面。',
      '**図面の役割分担**：全体の位置関係を見る図面と、個別土地の測量成果を見る図面を分ける。',
    ],
    cues:[
      ['00:00','土地図面は、全体を見る図面と個別土地を見る図面に分ける。'],
      ['00:30','地図や公図は位置関係、地積測量図は面積計算の根拠として見る。'],
      ['01:00','図面だけでなく現地確認とセットで判断する。'],
    ],
    exam:[
      '**地図と地積測量図**を混同しない。',
      '**地図に準ずる図面**の位置づけを押さえる。',
      '**地積測量図の記載内容**として、境界点、辺長、求積などをイメージする。',
      '**分筆や地積更正**では、地積測量図が重要になる。',
    ],
    practical:[
      '現地に行く前に、地図や公図で周辺の筆配置を確認する。',
      '地積測量図がある場合は、境界点や辺長を現地測量の手がかりにする。',
      '古い図面と現地が合わない場合、図面だけで断定せず、隣接地や過去資料も確認する。',
    ],
    next:'地図は場所、地積測量図は個別土地の測量根拠として読む。'
  },
  H1710:{
    title:'H17 第10問 講義ノート',
    status:'科目・論点から作成した要点メモです。過去問本文と照合しながら追記できます。',
    module:'表示各論・建物モジュール（不動産登記法）',
    topic:'建物の表示に関する登記（種類・構造・床面積）',
    pattern:'パターン分類：建物として何をどう特定するか',
    asked:'何が問われているか：**建物の種類、構造、床面積などの表示事項を理解し、現況をどのように登記記録へ表すかを判断できるか。**',
    image:[
      'この問題は、目の前の建物を登記記録上どう表現するかを考える場面。',
      '建物の種類とは、居宅、店舗、事務所、倉庫など、主な用途を表すラベル。',
      '構造とは、木造、鉄骨造、鉄筋コンクリート造、瓦ぶき、陸屋根など、建物の材料や屋根の姿を示す情報。',
      '床面積とは、各階ごとの広さ。どこまでを床面積に入れるか、壁のどこを基準に測るかが問題になる。',
      '建物表題登記では、現地の建物を一個の建物として特定し、種類、構造、床面積を正しく記録する。',
    ],
    core:[
      '**建物の種類**：建物の主たる用途を示す。居宅、店舗、事務所、倉庫など。',
      '**建物の構造**：材料、屋根、階数などで表す。現況を正確に読む。',
      '**床面積**：各階ごとの面積。算入する部分としない部分の判断が重要。',
      '**建物表題登記**：新築建物などを登記記録に初めて載せる登記。',
    ],
    cues:[
      ['00:00','建物表示は、建物を登記記録上どう特定するかを考える。'],
      ['00:30','種類は用途、構造は材料や屋根、床面積は広さとして整理する。'],
      ['01:00','現地の建物と図面を照合し、登記記録に反映する。'],
    ],
    exam:[
      '**種類・構造・床面積**の意味を区別する。',
      '**主たる用途**から種類を判断する。名称だけでなく実際の使われ方を見る。',
      '**床面積の算入判断**が問われる。吹抜け、車庫、ベランダなどは問題になりやすい。',
      '**建物表題登記と変更登記**を、建物が新築か、既存建物の変化かで分ける。',
    ],
    practical:[
      '新築建物の依頼では、建築図面、検査済証、現地写真を確認し、種類、構造、床面積を整理する。',
      '増築や用途変更がある場合、表題部変更登記が必要かを検討する。',
      '顧客には、建築確認上の面積と登記上の床面積が常に同じとは限らないため、登記用の確認が必要だと説明する。',
    ],
    next:'種類は用途、構造は材料と屋根、床面積は算入判断という3軸で読む。'
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
  const qText=String(q.question_text||'').trim();
  return '<div class="q-card"><div style="display:flex;justify-content:space-between;align-items:flex-start">'
    +'<div><h3>'+title+'</h3><div class="muted small">'+esc(q.question_id)+'</div>'+sub+top+'</div>'
    +(q.wrong_count?'<div class="muted small">誤答'+q.wrong_count+'回</div>':'')+'</div>'
    +'<div class="q-actions">'
    +(q.video_url?'<button class="btn sec" data-video="'+esc(q.video_url)+'" data-title="'+title+'">解説動画</button>':'<button class="btn sec" disabled>動画なし</button>')
    +(STUDY_AIDS[q.question_id]?'<button class="btn sec" data-aid="'+esc(q.question_id)+'">字幕・要点</button>':'')
    +(qText?'<button class="btn sec" data-question-read="'+esc(q.question_id)+'" data-title="'+title+'" data-question-text="'+esc(qText)+'">問題文読み上げ</button>':'')
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
function setTtsActive(on,paused){
  const start=$('[data-tts-start]'),pause=$('[data-tts-pause]');
  if(start){
    start.classList.toggle('tts-active',!!on);
    start.textContent=on?'読み上げ中':'Google読み上げ';
    start.disabled=!!on;
  }
  if(pause){
    pause.classList.toggle('tts-paused',!!paused);
    pause.textContent=paused?'再開':'一時停止';
  }
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
  setTtsActive(false,false);
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
  if(el.dataset&&el.dataset.originalHtml){el.innerHTML=el.dataset.originalHtml}
  else el.innerHTML=escText(text);
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
  if(!el){currentTtsIndex=index;setTtsActive(false,false);return}
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
    setTtsActive(false,false);
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
  setTtsActive(true,false);
  playGoogleUnit(0);
}
function toggleSpeechPause(){
  if(!googleTtsAudio)return;
  if(googleTtsAudio.paused){googleTtsAudio.play();setTtsActive(true,false)}
  else{googleTtsAudio.pause();setTtsActive(true,true)}
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
  const practical=aid.practical.map(x=>'<li class="tts-unit" data-tts-text="'+ttsAttr(x)+'">'+aidPlain(x)+'</li>').join('');
  const imageBox=image?'<div class="box" style="margin-top:12px"><h3>実際のイメージ</h3><div class="tts-unit" data-tts-text="'+ttsAttr('実際のイメージ。'+imageText)+'"><ul>'+image+'</ul></div></div>':'';
  const asked='<div class="tts-unit" data-tts-text="'+ttsAttr((aid.pattern||'パターン分類')+'。'+(aid.asked||''))+'">'+aidPlain(aid.asked||'')+'</div>';
  const doc='<!doctype html><html lang="ja"><head><meta charset="utf-8"><style>body{font-family:system-ui,\"Noto Sans JP\",sans-serif;margin:0;padding:18px;background:#fdfbf5;color:#3a3a38;line-height:1.7}.note{color:#8a8580;font-size:13px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}.box{background:#fff;border:1px solid #ece5da;border-radius:12px;padding:14px}h2{margin:0 0 4px;color:#5d8a3f}h3{margin:0 0 8px;color:#5d8a3f}.cue{display:grid;grid-template-columns:74px 1fr;gap:8px;border-top:1px solid #ece5da;padding:8px 0;font-size:14px}.cue:first-child{border-top:0}time{font-family:Consolas,monospace;color:#c9a24b;font-size:12px}li{margin:6px 0}.tts-unit{transition:background .15s}.tts-unit.tts-reading{background:transparent}.tts-hl{background:transparent;color:inherit;border-radius:0;font-weight:800}.tts-word{background:transparent;color:inherit;border-radius:0;padding:0;font-weight:900;box-shadow:none}@media(max-width:720px){.grid{grid-template-columns:1fr}}</style></head><body>'
    +'<h2>'+esc(aid.module)+'</h2><div class="note">'+esc(aid.status)+'</div>'
    +imageBox
    +'<div class="box" style="margin-top:12px"><h3>'+esc(aid.pattern||'パターン分類')+'</h3>'+asked+(core?'<ul>'+core+'</ul>':'')+'</div>'
    +'<div class="grid" style="margin-top:12px"><div class="box"><h3>字幕タイムライン</h3>'+rows+'</div>'
    +'<div><div class="box"><h3 class="tts-unit" data-tts-text="'+ttsAttr('試験で問われるポイント')+'">試験で問われるポイント</h3><ul>'+exam+'</ul></div>'
    +'<div class="box" style="margin-top:12px"><h3 class="tts-unit" data-tts-text="'+ttsAttr('実務への接続')+'">実務への接続</h3><ul>'+practical+'</ul></div></div></div>'
    +'<div class="box" style="margin-top:12px"><h3>次の改善</h3><div>'+esc(aid.next)+'</div></div>'
    +'</body></html>';
  const start=doc.indexOf('<body>')+6,end=doc.lastIndexOf('</body>');
  aidBox.innerHTML=doc.slice(start,end);
  $('#video-modal').classList.add('active');
}
function openQuestionText(qid,title,text){
  stopSpeech();
  $('#video-title').textContent=title+' 問題文';
  $('#video-frame').src='';
  $('#video-frame').style.display='none';
  const aidBox=$('#aid-content');
  aidBox.style.display='block';
  setTtsVisible(true);
  const clean=String(text||'').trim();
  aidBox.innerHTML='<h2>'+esc(title)+' 問題文</h2>'
    +'<div class="note">PDFから抽出・登録した問題文テキストです。</div>'
    +'<div class="box" style="margin-top:12px"><h3>問題文</h3>'
    +'<div class="tts-unit" data-tts-text="'+ttsAttr(clean)+'" style="white-space:pre-wrap">'+esc(clean)+'</div></div>';
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
  const qRead=e.target.closest('[data-question-read]');
  if(qRead&&!qRead.disabled){openQuestionText(qRead.dataset.questionRead,qRead.dataset.title||'問題',qRead.dataset.questionText||'');return}
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
      <div style="margin-top:10px"><label>問題文テキスト（PDFから抽出した本文）</label><textarea id="edit-question-text" rows="8" placeholder="ここに問題文を貼ると、トップ画面に「問題文読み上げ」ボタンが出ます。"></textarea></div>
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
    $('#q-table-wrap').innerHTML='<table><thead><tr><th>ID</th><th>科目</th><th>論点</th><th>PDF</th><th>問題文</th><th>動画</th><th></th></tr></thead><tbody>'
      +d.questions.map(q=>'<tr>'
        +'<td>'+esc(q.question_id)+'</td>'
        +'<td>'+(q.subject?'<span class="tag">'+esc(q.subject)+'</span>':'<span class="muted">未設定</span>')+'</td>'
        +'<td class="muted" style="font-size:12px">'+esc(q.topic||'')+'</td>'
        +'<td>'+(q.pdf_url?'✓':'')+(q.pdf_page?' p.'+q.pdf_page:'')+'</td>'
        +'<td>'+(q.question_text?'✓':'')+'</td>'
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
  $('#edit-question-text').value=currentQ.question_text||'';
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
    calls.push(api('/api/questions/link',{method:'POST',body:JSON.stringify({question_id:currentQ.question_id,field:'question_text',value:$('#edit-question-text').value})}));
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

