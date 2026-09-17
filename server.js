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
      const cleanRef = refCode ? refCode.trim().replace(/^@/, '') : null;
      if (cleanRef) {
        const { data: referrer } = await supabase
          .from('users')
          .select('*')
          .or(`invite_code.ilike.${cleanRef},handle.ilike.${cleanRef}`)
          .maybeSingle();
        if (referrer) await supabase.from('users').update({ invites: (referrer.invites || 0) + 1 }).eq('id', referrer.id);
      }
      const newUser = { handle, password, grade, avatar, invite_code: inviteCode, invite_code_used: cleanRef, invites: 0, total_votes: 0, is_pro: false };
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

    // 2. If they don't exist, this is a new signup! Return isNewUser flag and basic info (no auto-insert)
    if (!user) {
      return res.json({
        isNewUser: true,
        googleUser: {
          googleId,
          email,
          name: name || '',
          avatar: avatar || ''
        }
      });
    }

    // 3. If user exists, send their profile back to unlock UI
    res.json({ isNewUser: false, user });

  } catch (error) {
    console.error("Google Auth Sync Error:", error);
    res.status(500).json({ error: 'Internal server error during authentication' });
  }
});

// --- COMPLETE ONBOARDING ROUTE ---
app.post('/api/user/complete-onboarding', async (req, res) => {
  const {
    googleId,
    email,
    name,
    handle,
    gender,
    school = 'St. Kabir Convent Senior Secondary School',
    city = 'Bathinda',
    grade = 11,
    avatar = '😎',
    profilePic = '',
    refCode
  } = req.body;

  try {
    const cleanHandle = (handle || name || 'campus').replace(/^@/, '').trim();

    // Check if handle is already taken
    const { data: existingHandle } = await supabase
      .from('users')
      .select('id')
      .ilike('handle', cleanHandle)
      .single();

    let finalHandle = cleanHandle;
    if (existingHandle) {
      finalHandle = `${cleanHandle}${Math.floor(100 + Math.random() * 900)}`;
    }

    // Handle invite code
    const inviteCode = Math.random().toString(36).substring(2, 8).toUpperCase();
    const cleanRef = refCode ? refCode.trim().replace(/^@/, '') : null;
    if (cleanRef) {
      const { data: referrer } = await supabase
        .from('users')
        .select('*')
        .or(`invite_code.ilike.${cleanRef},handle.ilike.${cleanRef}`)
        .maybeSingle();
      if (referrer) {
        await supabase
          .from('users')
          .update({ invites: (referrer.invites || 0) + 1 })
          .eq('id', referrer.id);
      }
    }

    // Insert new user into Supabase
    const newUser = {
      email,
      google_id: googleId,
      handle: finalHandle,
      grade: parseInt(grade) || 11,
      profile_pic: profilePic || '',
      avatar: avatar || '😎',
      invite_code: inviteCode,
      invite_code_used: cleanRef,
      invites: 0,
      total_votes: 0,
      is_pro: false,
      ring: 'none',
      bio: `Class ${grade} • St. Kabir`
    };

    const { data: createdUser, error: insertError } = await supabase
      .from('users')
      .insert([newUser])
      .select()
      .single();

    if (insertError) {
      console.error('Insert User Onboarding Error:', insertError);
      return res.status(400).json({ error: 'Failed to create user profile: ' + insertError.message });
    }

    res.json({ user: createdUser });
  } catch (error) {
    console.error('Complete Onboarding Error:', error);
    res.status(500).json({ error: 'Internal server error during onboarding' });
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
    const { data: user } = await supabase.from('users').select('*').eq('id', req.params.userId).single();
    const { data: votes } = await supabase.from('votes').select(`id, polls(question), users!voter_id(handle, name, avatar, profile_pic, ring, is_pro)`).eq('receiver_id', req.params.userId).order('created_at', { ascending: false });
    
    let inviteCount = 0;
    const cleanHandle = user?.handle?.replace(/^@/, '').trim();
    const cleanCode = user?.invite_code?.trim();
    const filterParts = [];
    if (cleanHandle) filterParts.push(`invite_code_used.ilike.${cleanHandle}`);
    if (cleanCode) filterParts.push(`invite_code_used.ilike.${cleanCode}`);
    if (filterParts.length > 0) {
      const { data: invitedUsers } = await supabase.from('users').select('id').or(filterParts.join(','));
      inviteCount = (invitedUsers || []).length;
    }
    const effectiveInvites = Math.max(inviteCount, user?.invites || 0);
    const canReveal = Boolean(user?.is_pro) || effectiveInvites >= 3;

    const messages = (votes || []).map(v => ({
      voteId: v.id,
      question: v.polls?.question,
      voterHandle: canReveal ? v.users?.handle : null,
      voterName: canReveal ? (v.users?.name || v.users?.handle) : null,
      voterAvatar: canReveal ? v.users?.avatar : '🔒',
      voterPic: canReveal ? v.users?.profile_pic : '',
      isPro: canReveal ? Boolean(v.users?.is_pro) : false,
      ring: canReveal ? (v.users?.ring || 'none') : 'none'
    }));
    res.json({ canReveal, effectiveInvites, remaining: Math.max(0, 3 - effectiveInvites), messages });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- 3-INVITE REWARD & REVEAL LOGIC ---
const handleRevealRequest = async (voteId, userId, res) => {
  try {
    if (!voteId || !userId) {
      return res.status(400).json({ error: 'voteId and userId are required' });
    }

    const { data: user, error: userError } = await supabase
      .from('users')
      .select('*')
      .eq('id', userId)
      .single();

    if (userError || !user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Query users table to count how many accounts have invite_code_used matching the requesting user's handle
    let count = 0;
    const cleanHandle = user.handle?.replace(/^@/, '').trim();
    const cleanCode = user.invite_code?.trim();
    const filterParts = [];
    if (cleanHandle) filterParts.push(`invite_code_used.ilike.${cleanHandle}`);
    if (cleanCode) filterParts.push(`invite_code_used.ilike.${cleanCode}`);

    if (filterParts.length > 0) {
      const { data: invitedUsers } = await supabase
        .from('users')
        .select('id')
        .or(filterParts.join(','));
      count = (invitedUsers || []).length;
    }
    const effectiveInvites = Math.max(count, user.invites || 0);

    // If count < 3 and user is not Pro, return HTTP 403 with { locked: true, remaining: 3 - count }
    if (!user.is_pro && effectiveInvites < 3) {
      const remaining = Math.max(0, 3 - effectiveInvites);
      return res.status(403).json({
        locked: true,
        remaining,
        count: effectiveInvites,
        error: 'Invite requirement not met'
      });
    }

    // Fetch the vote with voter and poll details
    const { data: vote, error: voteError } = await supabase
      .from('votes')
      .select(`id, poll_id, voter_id, users!voter_id(id, handle, name, avatar, profile_pic, ring, is_pro), polls(question)`)
      .eq('id', voteId)
      .single();

    if (voteError || !vote) {
      return res.status(404).json({ error: 'Vote not found' });
    }

    res.json({
      success: true,
      locked: false,
      revealed: true,
      voterName: vote.users?.name || vote.users?.handle || 'Classmate',
      voterHandle: vote.users?.handle,
      voterAvatar: vote.users?.avatar || '😎',
      voterPic: vote.users?.profile_pic || '',
      isPro: Boolean(vote.users?.is_pro),
      ring: vote.users?.ring || 'none',
      question: vote.polls?.question
    });
  } catch (err) {
    console.error('Reveal Error:', err);
    res.status(500).json({ error: err.message });
  }
};

app.get('/api/inbox/reveal/:voteId', async (req, res) => {
  const { voteId } = req.params;
  const userId = req.query.userId;
  await handleRevealRequest(voteId, userId, res);
});

app.post('/api/inbox/reveal', async (req, res) => {
  const { voteId, userId } = req.body;
  await handleRevealRequest(voteId, userId, res);
});

// --- IN-APP FRIEND SYSTEM ---
app.get('/api/friends/search', async (req, res) => {
  try {
    const { q, userId } = req.query;
    if (!q || !q.trim()) return res.json({ users: [] });

    const cleanQuery = q.trim().replace(/^@/, '');
    let query = supabase
      .from('users')
      .select('id, handle, name, avatar, profile_pic, grade, ring, is_pro')
      .ilike('handle', `%${cleanQuery}%`)
      .limit(25);

    if (userId) {
      query = query.neq('id', userId);
    }

    const { data: matchedUsers, error: usersErr } = await query;
    if (usersErr) throw usersErr;

    let results = matchedUsers || [];

    if (userId && results.length > 0) {
      const userIds = results.map(u => u.id);
      const { data: userFriendships } = await supabase
        .from('friendships')
        .select('*')
        .or(`and(requester_id.eq.${userId},receiver_id.in.(${userIds.join(',')})),and(receiver_id.eq.${userId},requester_id.in.(${userIds.join(',')}))`);

      const friendshipMap = {};
      (userFriendships || []).forEach(f => {
        if (f.requester_id === userId) {
          friendshipMap[f.receiver_id] = f.status || 'pending';
        } else if (f.receiver_id === userId) {
          friendshipMap[f.requester_id] = f.status === 'pending' ? 'incoming' : f.status;
        }
      });

      results = results.map(u => ({
        ...u,
        friendshipStatus: friendshipMap[u.id] || 'none'
      }));
    }

    res.json({ users: results });
  } catch (err) {
    console.error('Friend Search Error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/friends/request', async (req, res) => {
  try {
    const { userId, friendId, requester_id, receiver_id } = req.body;
    const reqId = userId || requester_id;
    const recId = friendId || receiver_id;

    if (!reqId || !recId) {
      return res.status(400).json({ error: 'Both requester and receiver are required' });
    }

    // Check if relationship already exists
    const { data: existing } = await supabase
      .from('friendships')
      .select('*')
      .or(`and(requester_id.eq.${reqId},receiver_id.eq.${recId}),and(requester_id.eq.${recId},receiver_id.eq.${reqId})`)
      .maybeSingle();

    if (existing) {
      return res.json({ success: true, friendship: existing, alreadyExisted: true });
    }

    const { data: created, error: insertErr } = await supabase
      .from('friendships')
      .insert([{ requester_id: reqId, receiver_id: recId, status: 'pending' }])
      .select()
      .single();

    if (insertErr) throw insertErr;

    res.json({ success: true, friendship: created });
  } catch (err) {
    console.error('Friend Request Error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/friends/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const { data: friendships, error } = await supabase
      .from('friendships')
      .select('*')
      .or(`requester_id.eq.${userId},receiver_id.eq.${userId}`);

    if (error) throw error;
    res.json({ friendships: friendships || [] });
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