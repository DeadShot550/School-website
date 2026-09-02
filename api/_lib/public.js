import supabase from './db-client.js';
import { cors } from './_lib/helpers.js';

export default async function handler(req, res) {
  if (cors(req, res)) return;
  try {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

    const today = new Date().toISOString().slice(0, 10);
    const [classesQ, studentsQ, facultyQ, testimonialsQ, noticesQ, examsQ] = await Promise.all([
      supabase.from('classes').select('*').order('level', { ascending: true }),
      supabase.from('students').select('class_id').eq('status', 'active'),
      supabase.from('faculty').select('*').order('id', { ascending: true }),
      supabase.from('testimonials').select('*').order('id', { ascending: true }),
      supabase.from('notices').select('*').eq('audience', 'all').order('pinned', { ascending: false }).order('created_at', { ascending: false }).limit(6),
      supabase.from('exams').select('*').is('class_id', null).gte('end_date', today).order('start_date', { ascending: true }).limit(3),
    ]);
    if (classesQ.error) throw classesQ.error;

    const counts = {};
    for (const s of studentsQ.data || []) counts[s.class_id] = (counts[s.class_id] || 0) + 1;
    const classes = (classesQ.data || []).map((c) => ({ ...c, student_count: counts[c.id] || 0 }));

    return res.status(200).json({
      classes,
      faculty: facultyQ.data || [],
      testimonials: testimonialsQ.data || [],
      notices: noticesQ.data || [],
      exams: examsQ.data || [],
      stats: {
        students: (studentsQ.data || []).length,
        classes: classes.length,
        faculty: (facultyQ.data || []).length,
        founded: 1924,
      },
    });
  } catch (err) {
    console.error('public error', err);
    return res.status(500).json({ error: err.message });
  }
}
