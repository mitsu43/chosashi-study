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

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      const url = new URL(request.url);
      const path = url.pathname;

      if (path === '/') {
        return new Response('chosashi-study API is running', {
          headers: { ...corsHeaders, 'Content-Type': 'text/plain; charset=utf-8' },
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
    ORDER BY c.last_wrong_at DESC, ${questionOrder}
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
      ORDER BY attempts ASC, ${questionOrder}
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
