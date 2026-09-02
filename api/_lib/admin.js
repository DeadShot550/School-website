import supabase from './db-client.js';
import { cors, requireRole, createStudentRecord, genPassword, stripPassword } from './_lib/helpers.js';

const TABLES = {
  classes: { order: 'level' },
  syllabus: { order: 'subject' },
  exams: { order: 'start_date' },
  notices: { order: 'created_at', desc: true },
  faculty: { order: 'id' },
  testimonials: { order: 'id' },
  timetable: { order: 'period' },
};

async function crud(table, req, res, filters) {
  const cfg = TABLES[table];
  if (req.method === 'GET') {
    let q = supabase.from(table).select('*');
    for (const [k, v] of Object.entries(filters)) {
      if (v !== undefined && v !== '' && v !== 'all') q = q.eq(k, v);
    }
    q = q.order(cfg.order, { ascending: !cfg.desc });
    if (cfg.order !== 'id') q = q.order('id', { ascending: true });
    const { data, error } = await q;
    if (error) throw error;
    return res.status(200).json(data);
  }
  if (req.method === 'POST') {
    const { id, created_at, student_count, ...payload } = req.body || {};
    const { data, error } = await supabase.from(table).insert(payload).select().single();
    if (error) throw error;
    return res.status(201).json(data);
  }
  if (req.method === 'PUT') {
    const { id, created_at, student_count, ...payload } = req.body || {};
    if (!id) return res.status(400).json({ error: 'id is required' });
    const { data, error } = await supabase.from(table).update(payload).eq('id', id).select().single();
    if (error) throw error;
    return res.status(200).json(data);
  }
  if (req.method === 'DELETE') {
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ error: 'id is required' });
    const { error } = await supabase.from(table).delete().eq('id', id);
    if (error) throw error;
    return res.status(200).json({ ok: true });
  }
  return res.status(405).json({ error: 'Method not allowed' });
}

async function dashboard(res) {
  const today = new Date().toISOString().slice(0, 10);
  const [students, classes, admissions, exams, results, notices, recentStudents, classList] = await Promise.all([
    supabase.from('students').select('id', { count: 'exact', head: true }),
    supabase.from('classes').select('id', { count: 'exact', head: true }),
    supabase.from('admissions').select('*').order('created_at', { ascending: false }),
    supabase.from('exams').select('*').order('start_date', { ascending: true }),
    supabase.from('results').select('exam_id, student_id'),
    supabase.from('notices').select('id', { count: 'exact', head: true }),
    supabase.from('students').select('*').order('created_at', { ascending: false }).limit(5),
    supabase.from('classes').select('id, name'),
  ]);
  const cmap = Object.fromEntries((classList.data || []).map((c) => [c.id, c.name]));
  const adm = admissions.data || [];
  const pending = adm.filter((a) => a.status === 'pending');
  const upcoming = (exams.data || []).filter((e) => e.end_date >= today);
  const reportCards = new Set((results.data || []).map((r) => `${r.exam_id}-${r.student_id}`)).size;
  return res.status(200).json({
    students: students.count || 0,
    classes: classes.count || 0,
    pendingAdmissions: pending.length,
    totalAdmissions: adm.length,
    approvedAdmissions: adm.filter((a) => a.status === 'approved').length,
    upcomingExams: upcoming.slice(0, 4).map((e) => ({ ...e, class_name: e.class_id ? cmap[e.class_id] : 'All Classes' })),
    totalExams: (exams.data || []).length,
    reportCards,
    notices: notices.count || 0,
    recentAdmissions: adm.slice(0, 5).map((a) => ({ ...a, class_name: cmap[a.applying_class_id] || '—' })),
    recentStudents: (recentStudents.data || []).map((s) => ({ ...stripPassword(s), class_name: cmap[s.class_id] || '—' })),
  });
}

async function students(req, res, action, body) {
  if (req.method === 'GET') {
    const [studs, classes] = await Promise.all([
      supabase.from('students').select('*').order('class_id', { ascending: true }).order('roll_no', { ascending: true }),
      supabase.from('classes').select('*'),
    ]);
    if (studs.error) throw studs.error;
    const cmap = Object.fromEntries((classes.data || []).map((c) => [c.id, c]));
    return res.status(200).json((studs.data || []).map((s) => ({ ...s, class: cmap[s.class_id] || null })));
  }
  if (req.method === 'POST' && action === 'reset-password') {
    const password = genPassword();
    const { data, error } = await supabase.from('students').update({ password }).eq('id', body.id).select().single();
    if (error) throw error;
    return res.status(200).json(data);
  }
  if (req.method === 'POST') {
    if (!body.full_name?.trim()) return res.status(400).json({ error: 'Student name is required.' });
    if (!body.class_id) return res.status(400).json({ error: 'Please choose a class.' });
    const student = await createStudentRecord(body);
    return res.status(201).json(student);
  }
  if (req.method === 'PUT') {
    const { id, class: _cls, created_at, ...payload } = body;
    if (!id) return res.status(400).json({ error: 'id is required' });
    if (payload.username) {
      const { data: clash } = await supabase.from('students').select('id').ilike('username', payload.username).neq('id', id).maybeSingle();
      if (clash) return res.status(400).json({ error: 'That username is already in use. Pick another.' });
    }
    if (payload.class_id) payload.class_id = Number(payload.class_id);
    if (payload.roll_no) payload.roll_no = Number(payload.roll_no);
    const { data, error } = await supabase.from('students').update(payload).eq('id', id).select().single();
    if (error) throw error;
    return res.status(200).json(data);
  }
  if (req.method === 'DELETE') {
    const { id } = body;
    if (!id) return res.status(400).json({ error: 'id is required' });
    await Promise.all([
      supabase.from('results').delete().eq('student_id', id),
      supabase.from('sessions').delete().eq('student_id', id),
    ]);
    const { error } = await supabase.from('students').delete().eq('id', id);
    if (error) throw error;
    return res.status(200).json({ ok: true });
  }
  return res.status(405).json({ error: 'Method not allowed' });
}

async function results(req, res, filters, body) {
  if (req.method === 'GET') {
    let q = supabase.from('results').select('*');
    if (filters.exam_id) q = q.eq('exam_id', filters.exam_id);
    if (filters.student_id) q = q.eq('student_id', filters.student_id);
    const { data, error } = await q.order('id', { ascending: true });
    if (error) throw error;
    return res.status(200).json(data);
  }
  if (req.method === 'POST') {
    const { exam_id, student_id, rows } = body;
    if (!exam_id || !student_id || !Array.isArray(rows)) return res.status(400).json({ error: 'exam_id, student_id and rows are required' });
    const clean = rows
      .filter((r) => r.subject && String(r.subject).trim())
      .map((r) => ({
        exam_id: Number(exam_id),
        student_id: Number(student_id),
        subject: String(r.subject).trim(),
        max_marks: Number(r.max_marks) || 100,
        marks_obtained: Math.max(0, Number(r.marks_obtained) || 0),
        remarks: r.remarks || '',
      }));
    await supabase.from('results').delete().eq('exam_id', exam_id).eq('student_id', student_id);
    if (clean.length === 0) return res.status(200).json([]);
    const { data, error } = await supabase.from('results').insert(clean).select();
    if (error) throw error;
    return res.status(200).json(data);
  }
  if (req.method === 'DELETE') {
    const { exam_id, student_id } = body;
    const { error } = await supabase.from('results').delete().eq('exam_id', exam_id).eq('student_id', student_id);
    if (error) throw error;
    return res.status(200).json({ ok: true });
  }
  return res.status(405).json({ error: 'Method not allowed' });
}

async function bulkTimetable(res, body) {
  const { class_id, entries } = body;
  if (!class_id || !Array.isArray(entries)) return res.status(400).json({ error: 'class_id and entries are required' });
  await supabase.from('timetable').delete().eq('class_id', class_id);
  const clean = entries
    .filter((e) => e.subject && String(e.subject).trim())
    .map((e) => ({ class_id: Number(class_id), day: e.day, period: Number(e.period), subject: String(e.subject).trim(), teacher: e.teacher || '', start_time: e.start_time || '', end_time: e.end_time || '' }));
  if (clean.length === 0) return res.status(200).json([]);
  const { data, error } = await supabase.from('timetable').insert(clean).select();
  if (error) throw error;
  return res.status(200).json(data);
}

async function classesList(res) {
  const [classes, studs] = await Promise.all([
    supabase.from('classes').select('*').order('level', { ascending: true }),
    supabase.from('students').select('class_id').eq('status', 'active'),
  ]);
  if (classes.error) throw classes.error;
  const counts = {};
  for (const s of studs.data || []) counts[s.class_id] = (counts[s.class_id] || 0) + 1;
  return res.status(200).json((classes.data || []).map((c) => ({ ...c, student_count: counts[c.id] || 0 })));
}

export default async function handler(req, res) {
  if (cors(req, res)) return;
  try {
    const session = await requireRole(req, res, 'admin');
    if (!session) return;
    const { resource, action, ...filters } = req.query || {};
    const body = req.body || {};

    if (resource === 'dashboard') return dashboard(res);
    if (resource === 'students') return students(req, res, action, body);
    if (resource === 'results') return results(req, res, filters, body);
    if (resource === 'timetable' && req.method === 'POST' && action === 'bulk') return bulkTimetable(res, body);
    if (resource === 'classes' && req.method === 'GET') return classesList(res);
    if (resource === 'classes' && req.method === 'DELETE') {
      const { count } = await supabase.from('students').select('id', { count: 'exact', head: true }).eq('class_id', body.id);
      if (count > 0) return res.status(400).json({ error: `This class still has ${count} student(s). Move or remove them first.` });
      await Promise.all([
        supabase.from('syllabus').delete().eq('class_id', body.id),
        supabase.from('timetable').delete().eq('class_id', body.id),
      ]);
    }
    if (resource === 'exams' && req.method === 'DELETE') {
      await supabase.from('results').delete().eq('exam_id', body.id);
    }
    if (TABLES[resource]) return crud(resource, req, res, filters);
    return res.status(404).json({ error: 'Unknown resource' });
  } catch (err) {
    console.error('admin error', err);
    return res.status(500).json({ error: err.message });
  }
}
