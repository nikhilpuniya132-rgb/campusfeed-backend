import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';
import Razorpay from 'razorpay';
import crypto from 'crypto';

const app = express();
app.use(cors({ origin: '*' }));
app.options('*', cors());
app.use(express.json({ limit: '5mb' }));

// Initialize Database & Payment Gateway
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// --- AUTHENTICATION ---
app.post('/api/auth', async (req, res) => {
  try {
    const { handle, password, grade, avatar, refCode } = req.body;
    let { data: user } = await supabase.from('users').select('*').eq('handle', handle).single();

    if (!user) {
      const inviteCode = Math.random().toString(36).substring(2, 8).toUpperCase();
      if (refCode) {
        const { data: referrer } = await supabase.from('users').select('*').eq('invite_code', refCode.trim().toUpperCase()).single();
        if (referrer) await supabase.from('users').update({ invites: referrer.invites + 1 }).eq('id', referrer.id);
      }
      const newUser = { handle, password, grade, avatar, invite_code: inviteCode, invites: 0, total_votes: 0, is_pro: false };
      const { data: createdUser } = await supabase.from('users').insert([newUser]).select().single();
      user = createdUser;
    } else if (user.password !== password) {
      return res.status(401).json({ error: 'Incorrect password' });
    }
    res.json({ user });
  } catch (err) {
    res.status(500).json({ error: 'Server error during auth' });
  }
});

// --- GOOGLE AUTH SYNC ROUTE ---
app.post('/api/auth/google', async (req, res) => {
  const { googleId, email, name, avatar, grade } = req.body;

  try {
    // 1. Check if this student already exists in your Supabase 'users' table
    let { data: user, error: searchError } = await supabase
      .from('users')
      .select('*')
      .eq('email', email)
      .single();

    // 2. If they don't exist, this is a brand new signup! Let's create their profile.
    if (!user) {
      // Auto-generate a handle using their first name + random numbers (e.g., nikhil832)
      const baseHandle = name ? name.split(' ')[0].toLowerCase().replace(/[^a-z0-9]/g, '') : 'campus';
      const randomTag = Math.floor(100 + Math.random() * 900);
      const newHandle = `${baseHandle}${randomTag}`;

      const { data: newUser, error: insertError } = await supabase
        .from('users')
        .insert([{
          email: email,
          google_id: googleId,
          handle: newHandle,
          grade: parseInt(grade) || 11,
          profile_pic: avatar, // Sets their Google photo as their main picture
          avatar: '😎',        // Default emoji avatar backup
          is_pro: false,
          total_votes: 0,
          ring: 'none',
          bio: `Class ${grade} - St. Kabir`
        }])
        .select()
        .single();

      if (insertError) {
        console.error("Insert Error:", insertError);
        return res.status(400).json({ error: 'Failed to create new user profile' });
      }
      
      user = newUser;
    } else {
      // Optional: If they already exist, you could update their grade if it changed
      if (user.grade.toString() !== grade) {
        const { data: updatedUser } = await supabase
          .from('users')
          .update({ grade: parseInt(grade) })
          .eq('id', user.id)
          .select()
          .single();
        if (updatedUser) user = updatedUser;
      }
    }

    // 3. Send the complete user profile back to the React frontend
    res.json({ user });

  } catch (error) {
    console.error("Google Auth Sync Error:", error);
    res.status(500).json({ error: 'Internal server error during authentication' });
  }
});

// --- PLAY & VOTING ---
app.get('/api/play/:userId', async (req, res) => {
  try {
    const { gradeFilter } = req.query;
    const { data: polls } = await supabase.from('polls').select('*');
    const randomPoll = polls && polls.length > 0 ? polls[Math.floor(Math.random() * polls.length)] : null;

    let query = supabase.from('users').select('id, handle, avatar, profile_pic, grade, is_pro').neq('id', req.params.userId);
    if (gradeFilter && gradeFilter !== 'all') query = query.eq('grade', gradeFilter);

    const { data: allUsers } = await query;
    const shuffledOptions = allUsers ? allUsers.sort(() => 0.5 - Math.random()).slice(0, 4) : [];
    res.json({ poll: randomPoll, options: shuffledOptions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/vote', async (req, res) => {
  try {
    const { pollId, voterId, receiverId } = req.body;
    await supabase.from('votes').insert([{ poll_id: pollId, voter_id: voterId, receiver_id: receiverId }]);
    const { data: receiver } = await supabase.from('users').select('total_votes').eq('id', receiverId).single();
    if (receiver) await supabase.from('users').update({ total_votes: (receiver.total_votes || 0) + 1 }).eq('id', receiverId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- PROFILE MANAGEMENT ---
app.put('/api/profile/:userId', async (req, res) => {
  try {
    const { bio, avatar, ring } = req.body; 
    const { data: updatedUser } = await supabase.from('users').update({ bio, avatar, ring }).eq('id', req.params.userId).select().single();
    res.json({ success: true, user: updatedUser });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/profile/:userId', async (req, res) => {
  try {
    const { password } = req.body;
    const { data: user } = await supabase.from('users').select('password').eq('id', req.params.userId).single();
    if (!user || user.password !== password) return res.status(401).json({ error: 'Incorrect password' });
    
    await supabase.from('users').delete().eq('id', req.params.userId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/profile/public/:userId', async (req, res) => {
  try {
    const { data: user } = await supabase.from('users').select('id, handle, bio, avatar, profile_pic, total_votes, is_pro').eq('id', req.params.userId).single();
    res.json({ user });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- RAZORPAY GATEWAY ---
app.post('/api/pay/order', async (req, res) => {
  try {
    const { userId, amount = 9900 } = req.body; // 9900 paise = 99 INR
    const order = await razorpay.orders.create({ amount, currency: 'INR', receipt: `rcpt_${userId}_${Date.now()}` });
    res.json(order);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to create order' });
  }
});

app.post('/api/pay/verify', async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, userId } = req.body;
    
    const hmac = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET);
    hmac.update(`${razorpay_order_id}|${razorpay_payment_id}`);
    
    if (hmac.digest('hex') === razorpay_signature) {
      const { data } = await supabase.from('users').update({ is_pro: true, ring: 'gold' }).eq('id', userId).select().single();
      res.json({ success: true, user: data });
    } else {
      res.status(400).json({ success: false, message: 'Invalid signature' });
    }
  } catch (error) {
    res.status(500).json({ error: 'Verification failure' });
  }
});

// --- INBOX & EXPLORE ---
app.get('/api/inbox/:userId', async (req, res) => {
  try {
    const { data: user } = await supabase.from('users').select('invites, is_pro').eq('id', req.params.userId).single();
    const { data: votes } = await supabase.from('votes').select(`id, polls(question), users!voter_id(handle, avatar)`).eq('receiver_id', req.params.userId).order('created_at', { ascending: false });
    
    const canReveal = Boolean(user?.is_pro) || (user && user.invites >= 4);
    const messages = (votes || []).map(v => ({
      voteId: v.id, question: v.polls?.question, 
      voterHandle: canReveal ? v.users?.handle : null, 
      voterAvatar: canReveal ? v.users?.avatar : '🔒'
    }));
    res.json({ canReveal, messages });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/explore/leaderboard', async (req, res) => {
  try {
    const { data: leaderboard } = await supabase.from('users').select('id, handle, avatar, profile_pic, total_votes, is_pro').order('total_votes', { ascending: false }).limit(30);
    res.json({ leaderboard: leaderboard || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/profile/:userId', async (req, res) => {
  try {
    const { data: user } = await supabase.from('users').select('*').eq('id', req.params.userId).single();
    res.json({ user });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));