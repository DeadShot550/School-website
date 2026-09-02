import supabase from './db-client.js';
import { cors, hashPassword, createSession, getSession, tokenFrom, stripPassword } from './_lib/helpers.js';

async function loadUser(session) {
  if (session.role === 'admin') {
    const { data } = await supabase.from('admins').select('id, username, name').eq('id', session.admin_id).maybeSingle();
    return data;
  }
  const { data: student } = await supabase.from('students').select('*').eq('id', session.student_id).maybeSingle();
  if (!student) return null;
  const { data: cls } = await supabase.from('classes').select('*').eq('id', student.class_id).maybeSingle();
  return { ...stripPassword(student), class: cls || null };
}

export default async function handler(req, res) {
  if (cors(req, res)) return;
  try {
    if (req.method === 'GET') {
      const session = await getSession(req);
      if (!session) return res.status(401).json({ error: 'Not signed in' });
      const user = await loadUser(session);
      if (!user) return res.status(401).json({ error: 'Account not found' });
      return res.status(200).json({ role: session.role, user });
    }

    if (req.method === 'POST') {
      const body = req.body || {};
      const { action } = body;

      if (action === 'login') {
        const { role, username, password } = body;
        if (!username?.trim() || !password) {
          return res.status(400).json({ error: 'Username and password are required.' });
        }
        if (role === 'admin') {
          const { data: admin } = await supabase.from('admins').select('*').ilike('username', username.trim()).maybeSingle();
          if (!admin) return res.status(401).json({ error: 'Invalid administrator username.' });
          if (admin.password_hash !== hashPassword(password)) {
            return res.status(401).json({ error: 'Incorrect administrator password.' });
          }
          const token = await createSession('admin', { admin_id: admin.id });
          return res.status(200).json({ token, role: 'admin', user: { id: admin.id, username: admin.username, name: admin.name } });
        }
        const { data: student } = await supabase.from('students').select('*').ilike('username', username.trim()).maybeSingle();
        if (!student) return res.status(401).json({ error: 'No account found with this username.' });
        if (student.password !== password) return res.status(401).json({ error: 'Incorrect password. Please try again.' });
        if (student.status !== 'active') {
          return res.status(403).json({ error: 'This account is inactive. Please contact the school office.' });
        }
        const token = await createSession('student', { student_id: student.id });
        const user = await loadUser({ role: 'student', student_id: student.id });
        return res.status(200).json({ token, role: 'student', user });
      }

      if (action === 'logout') {
        const token = tokenFrom(req);
        if (token) await supabase.from('sessions').delete().eq('token', token);
        return res.status(200).json({ ok: true });
      }

      if (action === 'change-password') {
        const session = await getSession(req);
        if (!session) return res.status(401).json({ error: 'Not signed in' });
        const { current, next } = body;
        if (!next || next.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters.' });
        if (session.role === 'admin') {
          const { data: admin } = await supabase.from('admins').select('*').eq('id', session.admin_id).single();
          if (admin.password_hash !== hashPassword(current || '')) {
            return res.status(400).json({ error: 'Current password is incorrect.' });
          }
          const { error } = await supabase.from('admins').update({ password_hash: hashPassword(next) }).eq('id', admin.id);
          if (error) throw error;
          return res.status(200).json({ ok: true });
        }
        const { data: student } = await supabase.from('students').select('*').eq('id', session.student_id).single();
        if (student.password !== (current || '')) return res.status(400).json({ error: 'Current password is incorrect.' });
        const { error } = await supabase.from('students').update({ password: next }).eq('id', student.id);
        if (error) throw error;
        return res.status(200).json({ ok: true });
      }

      return res.status(400).json({ error: 'Unknown action' });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('auth error', err);
    return res.status(500).json({ error: err.message });
  }
}
