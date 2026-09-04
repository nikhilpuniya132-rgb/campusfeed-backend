import dotenv from 'dotenv';
dotenv.config();
import express from 'express';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));

const supabaseUrl = process.env.SUPABASE_URL || 'YOUR_SUPABASE_URL';
const supabaseKey = process.env.SUPABASE_KEY || 'YOUR_SUPABASE_KEY';
const supabase = createClient(supabaseUrl, supabaseKey);

// ==========================================
// AUTHENTICATION & LOGIN
// ==========================================
app.post('/api/auth', async (req, res) => {
  const { handle, password, grade, avatar, refCode, instagramHandle, profilePic } = req.body;
  
  let { data: user, error } = await supabase.from('users').select('*').eq('handle', handle).single();
  
  if (!user) {
    const inviteCode = Math.random().toString(36).substring(2, 8).toUpperCase();
    const newUser = { 
      handle, password, grade, avatar, ref_code: refCode, invite_code: inviteCode, 
      invites: 3, total_votes: 0, instagram_handle: instagramHandle, profile_pic: profilePic 
    };
    
    const { data: createdUser, error: insertError } = await supabase.from('users').insert([newUser]).select().single();
    if (insertError) return res.status(500).json({ error: insertError.message });
    user = createdUser;
  } else if (user.password !== password) {
    return res.status(401).json({ error: 'Incorrect password' });
  }
  
  res.json({ user });
});

// ==========================================
// POLLS & VOTING
// ==========================================
app.get('/api/play/:userId', async (req, res) => {
  const { gradeFilter } = req.query;
  const { data: polls } = await supabase.from('polls').select('*');
  const randomPoll = polls[Math.floor(Math.random() * polls.length)];
  
  let query = supabase.from('users').select('id, handle, avatar, profile_pic, grade').neq('id', req.params.userId).limit(4);
  if (gradeFilter !== 'all') query = query.eq('grade', gradeFilter);
  const { data: options } = await query;
  
  res.json({ poll: randomPoll, options });
});

app.post('/api/vote', async (req, res) => {
  const { pollId, voterId, receiverId } = req.body;
  await supabase.from('votes').insert([{ poll_id: pollId, voter_id: voterId, receiver_id: receiverId }]);
  
  const { data: receiver } = await supabase.from('users').select('total_votes').eq('id', receiverId).single();
  await supabase.from('users').update({ total_votes: receiver.total_votes + 1 }).eq('id', receiverId);
  res.json({ success: true });
});

// ==========================================
// INBOX & NOTIFICATIONS
// ==========================================
app.get('/api/inbox/:userId', async (req, res) => {
  const { data: user } = await supabase.from('users').select('invites').eq('id', req.params.userId).single();
  
  const { data: votes } = await supabase
    .from('votes')
    .select(`id, status, is_saved, is_crush, polls(question), users!voter_id(handle)`)
    .eq('receiver_id', req.params.userId)
    .order('created_at', { ascending: false });

  const formattedVotes = votes ? votes.map(v => ({
    voteId: v.id,
    question: v.polls ? v.polls.question : '',
    voterHandle: v.users ? v.users.handle : null,
    isSaved: v.is_saved
  })) : [];

  res.json({ invites: user ? user.invites : 0, messages: formattedVotes });
});

app.delete('/api/inbox/:voteId', async (req, res) => {
  await supabase.from('votes').delete().eq('id', req.params.voteId);
  res.json({ success: true });
});

app.put('/api/inbox/:voteId/save', async (req, res) => {
  await supabase.from('votes').update({ is_saved: true }).eq('id', req.params.voteId);
  res.json({ success: true });
});

// ==========================================
// EXPLORE & PROFILE
// ==========================================
app.get('/api/explore/leaderboard', async (req, res) => {
  const { data: leaderboard } = await supabase.from('users').select('id, handle, avatar, profile_pic, grade, total_votes').order('total_votes', { ascending: false }).limit(10);
  res.json({ leaderboard });
});

app.get('/api/profile/public/:userId', async (req, res) => {
  const { data: user } = await supabase.from('users').select('id, handle, bio, avatar, profile_pic, instagram_handle, total_votes').eq('id', req.params.userId).single();
  res.json({ user });
});

app.get('/api/profile/:userId', async (req, res) => {
  const { data: user } = await supabase.from('users').select('*').eq('id', req.params.userId).single();
  res.json({ user, totalVotes: user ? user.total_votes : 0 });
});

app.post('/api/profile/edit', async (req, res) => {
  const { userId, bio, instaId, avatar } = req.body;
  await supabase.from('users').update({ bio, instagram_handle: instaId, avatar }).eq('id', userId);
  res.json({ success: true });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));