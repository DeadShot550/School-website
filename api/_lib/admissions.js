import crypto from 'crypto';
import supabase from './db-client.js';
import { cors, getSession, createStudentRecord } from './_lib/helpers.js';

async function uniqueApplicationNo() {
  const year = new Date().getFullYear();
  for (let i = 0; i < 20; i++) {
    const candidate = `APP-${year}-${10000 + crypto.randomInt(90000)}`;
    const { data } = await supabase.from('admissions').select('id').eq('application_no', candidate).maybeSingle();
    if (!data) return candidate;
  }
  return `APP-${year}-${Date.now().toString().slice(-6)}`;
}

async function withClassNames(rows) {
  const { data: classes } = await supabase.from('classes').select('id, name, section');
  const map = Object.fromEntries((classes || []).map((c) => [c.id, c]));
  return rows.map((r) => ({ ...r, class_name: map[r.applying_class_id]?.name || 'Unassigned' }));
}

export default async function handler(req, res) {
  if (cors(req, res)) return;
  try {
    // Public: submit application
    if (req.method === 'POST') {
      const b = req.body || {};
      const required = ['applicant_name', 'dob', 'gender', 'applying_class_id', 'guardian_name', 'guardian_phone'];
      for (const key of required) {
        if (!b[key] || String(b[key]).trim() === '') {
          return res.status(400).json({ error: `Missing required field: ${key.replace(/_/g, ' ')}` });
        }
      }
      const application_no = await uniqueApplicationNo();
      const { data, error } = await supabase
        .from('admissions')
        .insert({
          application_no,
          applicant_name: b.applicant_name.trim(),
          dob: b.dob,
          gender: b.gender,
          applying_class_id: Number(b.applying_class_id),
          guardian_name: b.guardian_name.trim(),
          guardian_phone: b.guardian_phone.trim(),
          guardian_email: (b.guardian_email || '').trim(),
          address: (b.address || '').trim(),
          previous_school: (b.previous_school || '').trim(),
          notes: (b.notes || '').trim(),
          status: 'pending',
          review_note: '',
          student_id: null,
        })
        .select()
        .single();
      if (error) throw error;
      const [row] = await withClassNames([data]);
      return res.status(201).json(row);
    }

    if (req.method === 'GET') {
      // Public: track by application number
      if (req.query.application_no) {
        const appNo = String(req.query.application_no).trim().toUpperCase();
        const { data } = await supabase.from('admissions').select('*').eq('application_no', appNo).maybeSingle();
        if (!data) return res.status(404).json({ error: 'No application found with that number.' });
        const [row] = await withClassNames([data]);
        const { guardian_email, address, notes, ...safe } = row;
        return res.status(200).json(safe);
      }
      // Admin: list all
      const session = await getSession(req);
      if (!session || session.role !== 'admin') return res.status(401).json({ error: 'Unauthorized' });
      const { data, error } = await supabase.from('admissions').select('*').order('created_at', { ascending: false });
      if (error) throw error;
      return res.status(200).json(await withClassNames(data || []));
    }

    // Admin: review
    const session = await getSession(req);
    if (!session || session.role !== 'admin') return res.status(401).json({ error: 'Unauthorized' });

    if (req.method === 'PUT') {
      const { id, status, review_note } = req.body || {};
      if (!id || !['pending', 'approved', 'rejected'].includes(status)) {
        return res.status(400).json({ error: 'Invalid review payload' });
      }
      const { data: app } = await supabase.from('admissions').select('*').eq('id', id).single();
      if (!app) return res.status(404).json({ error: 'Application not found' });

      let credentials = null;
      let student_id = app.student_id;
      if (status === 'approved' && !app.student_id) {
        const student = await createStudentRecord({
          full_name: app.applicant_name,
          class_id: app.applying_class_id,
          guardian_name: app.guardian_name,
          guardian_phone: app.guardian_phone,
          guardian_email: app.guardian_email,
          address: app.address,
          dob: app.dob,
          gender: app.gender,
        });
        student_id = student.id;
        credentials = { username: student.username, password: student.password, admission_no: student.admission_no, student_id: student.id };
      }
      const { data, error } = await supabase
        .from('admissions')
        .update({ status, review_note: review_note || '', student_id, reviewed_at: new Date().toISOString() })
        .eq('id', id)
        .select()
        .single();
      if (error) throw error;
      const [row] = await withClassNames([data]);
      return res.status(200).json({ admission: row, credentials });
    }

    if (req.method === 'DELETE') {
      const { id } = req.body || {};
      const { error } = await supabase.from('admissions').delete().eq('id', id);
      if (error) throw error;
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('admissions error', err);
    return res.status(500).json({ error: err.message });
  }
}
