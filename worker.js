const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const jsonHeaders = {
  ...corsHeaders,
  'Content-Type': 'application/json; charset=utf-8',
};

const questionOrder = `
  CASE substr(question_id, 1, 1)
    WHEN 'H' THEN 1
    WHEN 'R' THEN 2
    WHEN 'K' THEN 3
    ELSE 9
  END,
  CAST(substr(question_id, 2, 2) AS INTEGER),
  number
`;

const questionOrderQ = `
  CASE substr(q.question_id, 1, 1)
    WHEN 'H' THEN 1
    WHEN 'R' THEN 2
    WHEN 'K' THEN 3
    ELSE 9
  END,
  CAST(substr(q.question_id, 2, 2) AS INTEGER),
  q.number
`;

const INDEX_HTML = `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>土地家屋調査士 合格アプリ</title>
  <style>
    *{box-sizing:border-box}body{margin:0;background:#f4f7f2;color:#203127;font-family:system-ui,-apple-system,"Noto Sans JP",sans-serif;line-height:1.6}.app{max-width:520px;margin:0 auto;min-height:100vh;background:#fbfdf9}header{background:#1f6130;color:#fff;padding:18px 16px}h1{font-size:20px;margin:0}.sub{font-size:12px;opacity:.85;margin:4px 0 0}.tabs{position:sticky;top:0;display:grid;grid-template-columns:repeat(4,1fr);background:#fff;border-bottom:1px solid #d9e2d7}.tab{border:0;border-bottom:3px solid transparent;background:#fff;color:#617066;padding:10px 4px;font-weight:700}.tab.active{color:#1f6130;border-bottom-color:#1f6130}main{padding:12px}.panel{display:none}.panel.active{display:block}.card{background:#fff;border:1px solid #d9e2d7;border-radius:8px;padding:14px;margin-bottom:12px;box-shadow:0 4px 12px rgba(22,43,27,.04)}h2{font-size:16px;color:#1f6130;margin:0 0 10px}h3{font-size:16px;margin:0}.muted{color:#617066;font-size:13px}.row{display:flex;justify-content:space-between;gap:10px;align-items:center}button,a.btn{min-height:40px;border:1px solid #1f6130;border-radius:8px;background:#1f6130;color:#fff;padding:8px 10px;font-weight:700;text-align:center;text-decoration:none}button.secondary,a.secondary{background:#fff;color:#1f6130}button.danger{border-color:#b0392d;background:#b0392d}.actions{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:10px}.task{display:grid;grid-template-columns:26px 1fr;gap:8px;padding:8px 0;border-top:1px solid #d9e2d7}.task:first-child{border-top:0}input[type=checkbox]{width:20px;height:20px;accent-color:#1f6130}.statgrid{display:grid;grid-template-columns:1fr 1fr;gap:8px}.stat{border:1px solid #d9e2d7;border-radius:8px;background:#f7faf6;padding:10px}.stat b{display:block;color:#1f6130;font-size:22px}.error{color:#b0392d}
  </style>
</head>
<body>
<div class="app">
  <header><h1>土地家屋調査士 合格アプリ</h1><p class="sub">今日の10問、誤答復習、進捗だけを見る画面</p></header>
  <nav class="tabs">
    <button class="tab active" data-tab="today">今日</button>
    <button class="tab" data-tab="wrong">誤答</button>
    <button class="tab" data-tab="stats">統計</button>
    <button class="tab" data-tab="plan">計画</button>
  </nav>
  <main>
    <section id="today" class="panel active"><div class="card"><div class="row"><h2>今日のノルマ</h2><button class="secondary" id="reload">更新</button></div><div id="tasks"></div><p id="today-status" class="muted"></p></div><div id="today-list"></div></section>
    <section id="wrong" class="panel"><div class="card"><h2>誤答リスト</h2><p class="muted">直近の誤答を復習します。</p></div><div id="wrong-list"></div></section>
    <section id="stats" class="panel"><div class="card"><h2>統計</h2><div id="stats-box" class="statgrid"></div></div></section>
    <section id="plan" class="panel"><div class="card"><h2>使い方</h2><p>1. 今日タブで10問解く<br>2. 正解/不正解を押す<br>3. 不正解は誤答タブに残す<br>4. 翌日も同じ画面を開く</p><p class="muted">この画面はCloudflare D1に保存されます。API設定は不要です。</p></div></section>
  </main>
</div>
<script>
const $=s=>document.querySelector(s);
const $$=s=>Array.from(document.querySelectorAll(s));
const today=()=>new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
async function api(path,opt){const r=await fetch(path,Object.assign({headers:{'Content-Type':'application/json'}},opt||{}));const d=await r.json();if(!r.ok)throw new Error(d.error||'API error');return d}
function esc(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function driveView(v){v=String(v||'').trim();if(!v)return '';if(/^https?:/.test(v))return v;return 'https://drive.google.com/file/d/'+encodeURIComponent(v)+'/view?usp=sharing'}
function card(q){const pdf=driveView(q.pdf_url);return '<article class="card"><div class="row"><div><h3>'+esc(q.year_label)+' 第'+esc(q.number)+'問</h3><div class="muted">'+esc(q.question_id)+'</div></div></div><div class="actions">'+(pdf?'<a class="btn secondary" target="_blank" href="'+esc(pdf)+'">PDF</a>':'<button class="secondary" disabled>PDF未登録</button>')+'<button class="secondary" disabled>動画未登録</button></div><div class="actions"><button data-answer="'+esc(q.question_id)+'" data-result="correct">正解</button><button class="danger" data-answer="'+esc(q.question_id)+'" data-result="wrong">不正解</button></div></article>'}
function empty(msg){return '<div class="card"><p class="muted">'+esc(msg)+'</p></div>'}
async function loadToday(){try{$('#today-status').textContent='読み込み中...';const t=await api('/api/daily-tasks?date='+today());$('#tasks').innerHTML=t.tasks.map(x=>'<label class="task"><input type="checkbox" data-task="'+esc(x.task_id)+'" '+(x.done?'checked':'')+'><span>'+esc(x.title)+'</span></label>').join('');const d=await api('/api/today');$('#today-list').innerHTML=d.questions.map(card).join('')||empty('今日の問題がありません。');$('#today-status').textContent='今日の出題 '+d.questions.length+'問'}catch(e){$('#today-status').innerHTML='<span class="error">'+esc(e.message)+'</span>'}}
async function loadWrong(){try{const d=await api('/api/answers/wrong');$('#wrong-list').innerHTML=d.questions.map(card).join('')||empty('誤答はありません。')}catch(e){$('#wrong-list').innerHTML=empty(e.message)}}
async function loadStats(){try{const d=await api('/api/stats');const t=d.totals;$('#stats-box').innerHTML='<div class="stat"><span class="muted">正答率</span><b>'+t.correct_rate+'%</b></div><div class="stat"><span class="muted">回答数</span><b>'+t.answers+'</b></div><div class="stat"><span class="muted">消化</span><b>'+t.answered_questions+'/'+t.total_questions+'</b></div><div class="stat"><span class="muted">連続</span><b>'+t.streak_days+'日</b></div>'}catch(e){$('#stats-box').innerHTML='<p class="error">'+esc(e.message)+'</p>'}}
document.addEventListener('click',async e=>{const tab=e.target.closest('[data-tab]');if(tab){$$('.tab').forEach(x=>x.classList.toggle('active',x===tab));$$('.panel').forEach(x=>x.classList.toggle('active',x.id===tab.dataset.tab));if(tab.dataset.tab==='today')loadToday();if(tab.dataset.tab==='wrong')loadWrong();if(tab.dataset.tab==='stats')loadStats();return}const b=e.target.closest('[data-answer]');if(b){b.disabled=true;try{await api('/api/answers',{method:'POST',body:JSON.stringify({question_id:b.dataset.answer,result:b.dataset.result,answered_at:today()})});await loadToday()}catch(err){alert(err.message);b.disabled=false}}});
document.addEventListener('change',async e=>{const c=e.target.closest('[data-task]');if(!c)return;try{await api('/api/daily-tasks',{method:'POST',body:JSON.stringify({task_date:today(),task_id:c.dataset.task,done:c.checked?1:0})})}catch(err){alert(err.message)}});
$('#reload').addEventListener('click',loadToday);
loadToday();
</script>
</body>
</html>`;

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      const url = new URL(request.url);
      const path = url.pathname;

      if (path === '/') {
        return new Response(INDEX_HTML, {
          headers: { ...corsHeaders, 'Content-Type': 'text/html; charset=utf-8' },
        });
      }

      if (request.method === 'GET' && path === '/api/questions') {
        return json(await getQuestions(env));
      }

      if (request.method === 'GET' && path === '/api/answers') {
        return json(await getAnswers(env));
      }

      if (request.method === 'GET' && path === '/api/answers/wrong') {
        return json(await getWrongQuestions(env));
      }

      if (request.method === 'GET' && path === '/api/stats') {
        return json(await getStats(env));
      }

      if (request.method === 'POST' && path === '/api/answers') {
        return json(await postAnswer(request, env), 201);
      }

      if (request.method === 'GET' && path === '/api/daily-tasks') {
        const date = url.searchParams.get('date') || todayJst();
        return json(await getDailyTasks(env, date));
      }

      if (request.method === 'POST' && path === '/api/daily-tasks') {
        return json(await postDailyTask(request, env), 201);
      }

      if (request.method === 'GET' && path === '/api/today') {
        return json(await getToday(env));
      }

      return json({ error: 'Not found' }, 404);
    } catch (error) {
      return json({ error: error.message || 'Internal error' }, 500);
    }
  },
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: jsonHeaders });
}

function todayJst() {
  const formatter = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return formatter.format(new Date());
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    throw new Error('Invalid JSON body');
  }
}

async function getQuestions(env) {
  const { results } = await env.DB.prepare(`
    SELECT question_id, type, year_label, number, video_url, pdf_url
    FROM questions
    ORDER BY ${questionOrder}
  `).all();
  return { questions: results };
}

async function getAnswers(env) {
  const { results } = await env.DB.prepare(`
    SELECT a.id, a.question_id, q.year_label, q.number, a.result, a.answered_at, a.created_at
    FROM answers a
    LEFT JOIN questions q ON q.question_id = a.question_id
    ORDER BY a.answered_at DESC, a.id DESC
    LIMIT 500
  `).all();
  return { answers: results };
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
             SUM(CASE WHEN result = 'wrong' THEN 1 ELSE 0 END) AS wrong_count,
             SUM(CASE WHEN result = 'correct' THEN 1 ELSE 0 END) AS correct_count,
             MAX(CASE WHEN result = 'wrong' THEN answered_at END) AS last_wrong_at
      FROM answers
      GROUP BY question_id
    )
    SELECT q.question_id, q.type, q.year_label, q.number, q.video_url, q.pdf_url,
           c.wrong_count, c.correct_count, c.last_wrong_at
    FROM latest l
    JOIN questions q ON q.question_id = l.question_id
    JOIN counts c ON c.question_id = q.question_id
    WHERE l.rn = 1
      AND l.result = 'wrong'
      AND date(l.answered_at) >= date('now', '-30 day')
    ORDER BY c.last_wrong_at DESC, ${questionOrderQ}
  `).all();
  return { questions: results };
}

async function getStats(env) {
  const total = await env.DB.prepare('SELECT COUNT(*) AS count FROM answers').first();
  const correct = await env.DB.prepare("SELECT COUNT(*) AS count FROM answers WHERE result = 'correct'").first();
  const wrong = await env.DB.prepare("SELECT COUNT(*) AS count FROM answers WHERE result = 'wrong'").first();
  const answeredQuestions = await env.DB.prepare('SELECT COUNT(DISTINCT question_id) AS count FROM answers').first();
  const totalQuestions = await env.DB.prepare('SELECT COUNT(*) AS count FROM questions').first();

  const { results: byYear } = await env.DB.prepare(`
    SELECT q.year_label,
           COUNT(a.id) AS attempts,
           SUM(CASE WHEN a.result = 'correct' THEN 1 ELSE 0 END) AS correct,
           ROUND(100.0 * SUM(CASE WHEN a.result = 'correct' THEN 1 ELSE 0 END) / NULLIF(COUNT(a.id), 0), 1) AS rate
    FROM questions q
    LEFT JOIN answers a ON a.question_id = q.question_id
    GROUP BY q.year_label
    ORDER BY
      CASE substr(q.year_label, 1, 1) WHEN 'H' THEN 1 WHEN 'R' THEN 2 ELSE 9 END,
      CAST(substr(q.year_label, 2, 2) AS INTEGER)
  `).all();

  const { results: byType } = await env.DB.prepare(`
    SELECT q.type,
           COUNT(a.id) AS attempts,
           SUM(CASE WHEN a.result = 'correct' THEN 1 ELSE 0 END) AS correct,
           ROUND(100.0 * SUM(CASE WHEN a.result = 'correct' THEN 1 ELSE 0 END) / NULLIF(COUNT(a.id), 0), 1) AS rate
    FROM questions q
    LEFT JOIN answers a ON a.question_id = q.question_id
    GROUP BY q.type
  `).all();

  const { results: days } = await env.DB.prepare(`
    SELECT DISTINCT substr(answered_at, 1, 10) AS day
    FROM answers
    ORDER BY day DESC
    LIMIT 400
  `).all();

  return {
    totals: {
      answers: total.count || 0,
      correct: correct.count || 0,
      wrong: wrong.count || 0,
      correct_rate: total.count ? Math.round((correct.count / total.count) * 1000) / 10 : 0,
      answered_questions: answeredQuestions.count || 0,
      total_questions: totalQuestions.count || 0,
      streak_days: countStreak(days.map((row) => row.day)),
    },
    by_year: byYear,
    by_type: byType,
  };
}

function countStreak(days) {
  const set = new Set(days);
  let cursor = new Date(`${todayJst()}T00:00:00+09:00`);
  let count = 0;
  while (set.has(cursor.toISOString().slice(0, 10))) {
    count += 1;
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return count;
}

async function postAnswer(request, env) {
  const body = await readJson(request);
  const questionId = String(body.question_id || '').trim();
  const result = String(body.result || '').trim();
  const answeredAt = String(body.answered_at || todayJst()).trim();

  if (!questionId || !['correct', 'wrong'].includes(result)) {
    throw new Error('question_id and result(correct/wrong) are required');
  }

  const exists = await env.DB.prepare('SELECT question_id FROM questions WHERE question_id = ?')
    .bind(questionId)
    .first();
  if (!exists) {
    throw new Error(`Unknown question_id: ${questionId}`);
  }

  const info = await env.DB.prepare(`
    INSERT INTO answers (question_id, result, answered_at)
    VALUES (?, ?, ?)
  `).bind(questionId, result, answeredAt).run();

  return { ok: true, id: info.meta.last_row_id };
}

async function getDailyTasks(env, date) {
  const defaultTasks = [
    { task_id: 'watch_video', title: '解説動画を1本見る' },
    { task_id: 'solve_questions', title: '択一を10問解く' },
    { task_id: 'review_wrong', title: '誤答を見直す' },
    { task_id: 'write_note', title: '分からない点を1つ記録する' },
  ];

  const { results } = await env.DB.prepare(`
    SELECT task_id, done
    FROM daily_tasks
    WHERE task_date = ?
  `).bind(date).all();

  const saved = new Map(results.map((row) => [row.task_id, row.done]));
  return {
    task_date: date,
    tasks: defaultTasks.map((task) => ({
      ...task,
      done: saved.get(task.task_id) || 0,
    })),
  };
}

async function postDailyTask(request, env) {
  const body = await readJson(request);
  const taskDate = String(body.task_date || todayJst()).trim();
  const taskId = String(body.task_id || '').trim();
  const done = body.done ? 1 : 0;

  if (!taskDate || !taskId) {
    throw new Error('task_date and task_id are required');
  }

  await env.DB.prepare(`
    INSERT INTO daily_tasks (task_date, task_id, done, updated_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(task_date, task_id)
    DO UPDATE SET done = excluded.done, updated_at = CURRENT_TIMESTAMP
  `).bind(taskDate, taskId, done).run();

  return { ok: true };
}

async function getToday(env) {
  const { results: wrongQuestions } = await env.DB.prepare(`
    WITH latest AS (
      SELECT question_id, result, answered_at,
             ROW_NUMBER() OVER (PARTITION BY question_id ORDER BY answered_at DESC, id DESC) AS rn
      FROM answers
    )
    SELECT q.question_id, q.type, q.year_label, q.number, q.video_url, q.pdf_url, l.answered_at AS last_answered_at
    FROM latest l
    JOIN questions q ON q.question_id = l.question_id
    WHERE l.rn = 1
      AND l.result = 'wrong'
    ORDER BY l.answered_at ASC
    LIMIT 10
  `).all();

  const remaining = Math.max(0, 10 - wrongQuestions.length);
  let fillQuestions = [];
  if (remaining > 0) {
    const excluded = wrongQuestions.map((q) => q.question_id);
    const placeholders = excluded.map(() => '?').join(',');
    const exclusion = excluded.length ? `WHERE q.question_id NOT IN (${placeholders})` : '';
    const statement = env.DB.prepare(`
      SELECT q.question_id, q.type, q.year_label, q.number, q.video_url, q.pdf_url,
             COUNT(a.id) AS attempts,
             MAX(a.answered_at) AS last_answered_at
      FROM questions q
      LEFT JOIN answers a ON a.question_id = q.question_id
      ${exclusion}
      GROUP BY q.question_id
      ORDER BY attempts ASC, ${questionOrderQ}
      LIMIT ?
    `);
    const { results } = await statement.bind(...excluded, remaining).all();
    fillQuestions = results;
  }

  return {
    date: todayJst(),
    questions: [...wrongQuestions, ...fillQuestions].slice(0, 10),
  };
}
