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
  const { handle, password, grade, avatar, refCode } = req.body;
  
  let { data: user, error } = await supabase.from('users').select('*').eq('handle', handle).single();
  
  if (!user) {
    const inviteCode = Math.random().toString(36).substring(2, 8).toUpperCase();
    
    // If they used a referral code, credit the referrer
    if (refCode) {
      const { data: referrer } = await supabase.from('users').select('*').eq('invite_code', refCode.trim().toUpperCase()).single();
      if (referrer) {
        await supabase.from('users').update({ invites: referrer.invites + 1 }).eq('id', referrer.id);
      }
    }

    const newUser = { 
      handle, password, grade, avatar, invite_code: inviteCode, 
      invites: 3, total_votes: 0 
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
// POLLS, SHUFFLING & VOTING
// ==========================================
app.get('/api/play/:userId', async (req, res) => {
  const { gradeFilter } = req.query;
  const { data: polls } = await supabase.from('polls').select('*');
  const randomPoll = polls ? polls[Math.floor(Math.random() * polls.length)] : null;
  
  let query = supabase.from('users').select('id, handle, avatar, profile_pic, grade').neq('id', req.params.userId);
  if (gradeFilter && gradeFilter !== 'all') {
    query = query.eq('grade', gradeFilter);
  }
  
  const { data: allUsers } = await query;
  // Shuffle options randomly on the server side
  const shuffledOptions = allUsers ? allUsers.sort(() => 0.5 - Math.random()).slice(0, 4) : [];
  
  res.json({ poll: randomPoll, options: shuffledOptions });
});

app.post('/api/vote', async (req, res) => {
  const { pollId, voterId, receiverId } = req.body;
  await supabase.from('votes').insert([{ poll_id: pollId, voter_id: voterId, receiver_id: receiverId }]);
  
  const { data: receiver } = await supabase.from('users').select('total_votes').eq('id', receiverId).single();
  if (receiver) {
    await supabase.from('users').update({ total_votes: receiver.total_votes + 1 }).eq('id', receiverId);
  }
  res.json({ success: true });
});

// ==========================================
// INBOX & PRIVACY LOCK
// ==========================================
app.get('/api/inbox/:userId', async (req, res) => {
  const { data: user } = await supabase.from('users').select('invites').eq('id', req.params.userId).single();
  
  const { data: votes } = await supabase
    .from('votes')
    .select(`id, status, is_saved, is_crush, polls(question), users!voter_id(handle, profile_pic, avatar)`)
    .eq('receiver_id', req.params.userId)
    .order('created_at', { ascending: false });

  // Privacy lock: If user has less than 4 invites (meaning they haven't shared with a friend to gain more), hide voter identities
  const userInvites = user ? user.invites : 3;
  const canReveal = userInvites > 3;

  const formattedVotes = votes ? votes.map(v => ({
    voteId: v.id,
    question: v.polls ? v.polls.question : '',
    voterHandle: canReveal ? (v.users ? v.users.handle : null) : null,
    isSaved: v.is_saved
  })) : [];

  res.json({ invites: userInvites, canReveal, messages: formattedVotes });
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
// EXPLORE, PROFILE & ACCOUNT DELETION
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
  const { userId, bio, instaId, avatar, profilePic } = req.body;
  await supabase.from('users').update({ 
    bio, 
    instagram_handle: instaId, 
    avatar, 
    profile_pic: profilePic 
  }).eq('id', userId);
  res.json({ success: true });
});

app.post('/api/profile/delete', async (req, res) => {
  const { userId, password } = req.body;
  const { data: user } = await supabase.from('users').select('password').eq('id', userId).single();
  
  if (!user || user.password !== password) {
    return res.status(401).json({ error: 'Incorrect password' });
  }

  await supabase.from('users').delete().eq('id', userId);
  res.json({ success: true });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));