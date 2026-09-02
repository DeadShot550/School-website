import crypto from 'crypto';
import supabase from '../db-client.js';

export function cors(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return true;
  }
  return false;
}

export function hashPassword(pw) {
  return crypto.createHash('sha256').update(`citypublic::${pw}`).digest('hex');
}

export function genToken() {
  return crypto.randomBytes(32).toString('hex');
}

export function genPassword() {
  const alpha = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz';
  const digits = '23456789';
  let s = '';
  for (let i = 0; i < 5; i++) s += alpha[crypto.randomInt(alpha.length)];
  for (let i = 0; i < 3; i++) s += digits[crypto.randomInt(digits.length)];
  return s;
}

export function firstNameSlug(name) {
  const first = (name || '').trim().split(/\s+/)[0] || 'student';
  return first.toLowerCase().replace(/[^a-z]/g, '') || 'student';
}

export async function uniqueUsername(fullName) {
  const base = firstNameSlug(fullName);
  for (let i = 0; i < 20; i++) {
    const candidate = `${base}${1000 + crypto.randomInt(9000)}`;
    const { data } = await supabase.from('students').select('id').eq('username', candidate).maybeSingle();
    if (!data) return candidate;
  }
  return `${base}${Date.now().toString().slice(-6)}`;
}

export async function nextAdmissionNo() {
  const year = new Date().getFullYear();
  const { count } = await supabase.from('students').select('id', { count: 'exact', head: true });
  let n = (count || 0) + 1;
  for (let i = 0; i < 50; i++) {
    const candidate = `CPS-${year}-${String(n).padStart(4, '0')}`;
    const { data } = await supabase.from('students').select('id').eq('admission_no', candidate).maybeSingle();
    if (!data) return candidate;
    n++;
  }
  return `CPS-${year}-${Date.now().toString().slice(-5)}`;
}

export async function nextRollNo(classId) {
  const { data } = await supabase
    .from('students')
    .select('roll_no')
    .eq('class_id', classId)
    .order('roll_no', { ascending: false })
    .limit(1);
  return (data?.[0]?.roll_no || 0) + 1;
}

export async function createSession(role, ids) {
  const token = genToken();
  const expires = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
  const { error } = await supabase.from('sessions').insert({
    token,
    role,
    student_id: ids.student_id || null,
    admin_id: ids.admin_id || null,
    expires_at: expires,
  });
  if (error) throw error;
  return token;
}

export function tokenFrom(req) {
  return (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
}

export async function getSession(req) {
  const token = tokenFrom(req);
  if (!token) return null;
  const { data } = await supabase.from('sessions').select('*').eq('token', token).maybeSingle();
  if (!data) return null;
  if (new Date(data.expires_at).getTime() < Date.now()) return null;
  return data;
}

export async function requireRole(req, res, role) {
  const s = await getSession(req);
  if (!s || (role && s.role !== role)) {
    res.status(401).json({ error: 'Your session has expired. Please sign in again.' });
    return null;
  }
  return s;
}

export function stripPassword(student) {
  if (!student) return student;
  const { password, ...rest } = student;
  return rest;
}

export async function createStudentRecord(input) {
  const admission_no = input.admission_no?.trim() || (await nextAdmissionNo());
  const username = await uniqueUsername(input.full_name);
  const password = genPassword();
  const roll_no = Number(input.roll_no) || (await nextRollNo(input.class_id));
  const { data, error } = await supabase
    .from('students')
    .insert({
      admission_no,
      full_name: input.full_name.trim(),
      username,
      password,
      class_id: Number(input.class_id),
      roll_no,
      guardian_name: input.guardian_name || '',
      guardian_phone: input.guardian_phone || '',
      guardian_email: input.guardian_email || '',
      address: input.address || '',
      dob: input.dob || '',
      gender: input.gender || '',
      blood_group: input.blood_group || '',
      status: 'active',
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}
