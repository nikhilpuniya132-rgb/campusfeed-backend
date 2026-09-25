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

// --- SESSION COOLDOWNS & VOTE COUNTER (IN-MEMORY & DB RESILIENT TRACKER) ---
const sessionCooldowns = new Map();

const getUserCooldownState = async (userId, userFromDb) => {
  let state = sessionCooldowns.get(userId);
  if (!state) {
    state = {
      session_vote_count: userFromDb?.session_vote_count || 0,
      cooldown_until: userFromDb?.cooldown_until || userFromDb?.cooldown_expires_at || null
    };
    sessionCooldowns.set(userId, state);
  } else if ((userFromDb?.cooldown_until || userFromDb?.cooldown_expires_at) && !state.cooldown_until) {
    state.cooldown_until = userFromDb.cooldown_until || userFromDb.cooldown_expires_at;
  }
  // Check if cooldown has expired
  if (state.cooldown_until && new Date(state.cooldown_until).getTime() <= Date.now()) {
    state.cooldown_until = null;
    state.session_vote_count = 0;
  }
  return state;
};

/**
 * Task 3: Backend Cooldown Reset Logic
 * When User B joins / authenticates with referred_by = 'User_A_Code',
 * automatically reset User A's cooldown_until / cooldown_expires_at timestamp
 * and session_vote_count to 0 to allow immediate voting without delay.
 */
const unlockReferrerCooldown = async (cleanRef, newUserId = null, newUserHandle = null) => {
  if (!cleanRef) return null;
  const ref = cleanRef.trim().replace(/^@/, '');
  if (!ref) return null;

  try {
    let referrer = null;

    // 1. Search referrer by invite_code
    const { data: byCode } = await supabase
      .from('users')
      .select('id, handle, invite_code, my_invite_code, session_vote_count, cooldown_until, cooldown_expires_at, invites, feed_drops')
      .ilike('invite_code', ref)
      .maybeSingle();

    if (byCode) {
      referrer = byCode;
    } else {
      // 2. Search referrer by handle
      const { data: byHandle } = await supabase
        .from('users')
        .select('id, handle, invite_code, my_invite_code, session_vote_count, cooldown_until, cooldown_expires_at, invites, feed_drops')
        .ilike('handle', ref)
        .maybeSingle();

      if (byHandle) {
        referrer = byHandle;
      } else {
        // 3. Search referrer by my_invite_code
        const { data: byMyCode } = await supabase
          .from('users')
          .select('id, handle, invite_code, my_invite_code, session_vote_count, cooldown_until, cooldown_expires_at, invites, feed_drops')
          .ilike('my_invite_code', ref)
          .maybeSingle();
        if (byMyCode) referrer = byMyCode;
      }
    }

    if (!referrer) {
      console.log(`[Referral Loop] Referrer not found for invite code: "${ref}"`);
      return null;
    }

    // Ignore self-referrals
    if (newUserId && referrer.id === newUserId) {
      console.log(`[Referral Loop] Self-referral ignored for ${newUserId}`);
      return null;
    }

    console.log(`⚡ [Referral Loop Verified] Unlocking cooldown for Referrer @${referrer.handle || referrer.id} because friend @${newUserHandle || newUserId || 'joined'} used code "${ref}"!`);

    // Reset in-memory session cooldown
    sessionCooldowns.set(referrer.id, {
      session_vote_count: 0,
      cooldown_until: null
    });

    // Reset database cooldown & award referral bonus (+1 invite, +50 drops)
    const updatedInvites = (referrer.invites || 0) + 1;
    const isBatchCaptain = updatedInvites >= 25;

    const updatePayload = {
      cooldown_until: null,
      session_vote_count: 0,
      invites: updatedInvites,
      is_batch_captain: isBatchCaptain
    };

    try {
      await supabase
        .from('users')
        .update({
          ...updatePayload,
          cooldown_expires_at: null,
          feed_drops: (referrer.feed_drops || 0) + 50
        })
        .eq('id', referrer.id);
    } catch (_) {
      try {
        await supabase
          .from('users')
          .update(updatePayload)
          .eq('id', referrer.id);
      } catch (dbErr) {
        console.error('Error updating referrer in Supabase:', dbErr);
      }
    }

    // Send inbox notification to Referrer
    try {
      await supabase.from('inbox').insert([{
        user_id: referrer.id,
        recipient_id: referrer.id,
        sender_id: newUserId || null,
        sender_name: newUserHandle ? `@${newUserHandle}` : 'A friend',
        text: `⚡ A friend joined using your link! Cooldown cleared & voting instantly unlocked!`,
        created_at: new Date().toISOString()
      }]);
    } catch (_) {}

    return referrer;
  } catch (err) {
    console.error('Failed to unlock referrer cooldown:', err);
    return null;
  }
};

// --- REAL-TIME USER COOLDOWN CHECK ENDPOINT (Task 4) ---
app.get('/api/user/cooldown/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    if (!userId) return res.status(400).json({ error: 'userId is required' });

    const { data: user } = await supabase
      .from('users')
      .select('id, session_vote_count, cooldown_until, cooldown_expires_at, is_pro')
      .eq('id', userId)
      .maybeSingle();

    const state = await getUserCooldownState(userId, user);
    const activeCd = (!user?.is_pro && (state.cooldown_until || user?.cooldown_expires_at)) || null;
    const isCooldownActive = Boolean(activeCd && new Date(activeCd).getTime() > Date.now());

    res.json({
      userId,
      cooldown_until: isCooldownActive ? activeCd : null,
      session_vote_count: isCooldownActive ? state.session_vote_count : 0,
      is_cooldown_active: isCooldownActive,
      is_pro: Boolean(user?.is_pro)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- AUTHENTICATION ---
app.post('/api/auth', async (req, res) => {
  try {
    const { handle, password, grade, avatar, refCode, institute, coaching_hub, coachingHub, stream } = req.body;
    let { data: user } = await supabase.from('users').select('*').eq('handle', handle).single();

    if (!user) {
      const inviteCode = Math.random().toString(36).substring(2, 8).toUpperCase();
      const cleanRef = refCode ? refCode.trim().replace(/^@/, '') : null;
      const finalInstitute = institute || 'Kapil Institute';
      const finalHub = coaching_hub || coachingHub || 'Ajit Road Hub';
      const finalStream = stream || '11th Medical';
      const newUser = {
        handle,
        password,
        grade: parseInt(grade) || 11,
        avatar,
        invite_code: inviteCode,
        invite_code_used: cleanRef,
        referred_by: cleanRef,
        invites: 0,
        feed_drops: 0,
        referral_rewarded: false,
        total_votes: 0,
        is_pro: false,
        district: 'Bathinda',
        institute: finalInstitute,
        school: finalInstitute,
        coaching_hub: finalHub,
        stream: finalStream,
        bio: `${finalInstitute} • ${finalStream}`
      };
      let { data: createdUser, error: insertErr } = await supabase.from('users').insert([newUser]).select().single();
      if (insertErr && (insertErr.message?.includes('institute') || insertErr.message?.includes('coaching_hub') || insertErr.message?.includes('stream') || insertErr.message?.includes('referred_by'))) {
        delete newUser.institute;
        delete newUser.coaching_hub;
        delete newUser.stream;
        delete newUser.referred_by;
        const retry = await supabase.from('users').insert([newUser]).select().single();
        createdUser = retry.data;
      }
      user = createdUser;

      if (cleanRef && user?.id) {
        await unlockReferrerCooldown(cleanRef, user.id, user.handle);
      }
    } else if (user.password !== password) {
      return res.status(401).json({ error: 'Incorrect password' });
    }
    if (user) {
      user.city = 'Bathinda';
      user.institute = user.institute || 'Kapil Institute';
      user.coaching_hub = user.coaching_hub || 'Ajit Road Hub';
      user.stream = user.stream || '11th Medical';
    }
    res.json({ user });
  } catch (err) {
    res.status(500).json({ error: 'Server error during auth' });
  }
});

// --- GOOGLE AUTH SYNC ROUTE ---
app.post('/api/auth/google', async (req, res) => {
  const { googleId, email, name, avatar, grade, refCode, referred_by } = req.body;
  const cleanRef = (refCode || referred_by || '').trim().replace(/^@/, '');

  try {
    // 1. Check if this student already exists in your Supabase 'users' table
    let { data: user, error: searchError } = await supabase
      .from('users')
      .select('*')
      .eq('email', email)
      .single();

    // 2. If they don't exist or profile data is incomplete, return isNewUser flag to trigger onboarding wizard
    if (!user || !user.handle || !user.password || !user.institute) {
      return res.json({
        isNewUser: true,
        googleUser: {
          googleId,
          email,
          name: user?.name || name || '',
          avatar: user?.profile_pic || user?.avatar || avatar || '',
          refCode: cleanRef,
          referred_by: cleanRef
        }
      });
    }

    // If user exists and hadn't used a referral code before, register the referral now and unlock User A
    if (cleanRef && user && !user.invite_code_used && !user.referred_by) {
      try {
        await supabase.from('users').update({
          invite_code_used: cleanRef,
          referred_by: cleanRef
        }).eq('id', user.id);
        await unlockReferrerCooldown(cleanRef, user.id, user.handle);
      } catch (_) {}
    }

    // 3. If user exists, send their profile back to unlock UI with coaching taxonomy
    user.city = 'Bathinda';
    user.institute = user.institute || 'Kapil Institute';
    user.coaching_hub = user.coaching_hub || 'Ajit Road Hub';
    user.stream = user.stream || '11th Medical';
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
    password,
    gender = 'boy',
    school,
    institute = 'Kapil Institute',
    coaching_hub,
    coachingHub = 'Ajit Road Hub',
    stream = '11th Medical',
    city = 'Bathinda',
    grade = 11,
    avatar,
    profilePic = '',
    refCode
  } = req.body;

  try {
    const cleanHandle = (handle || name || 'campus').replace(/^@/, '').trim();
    const finalInstitute = institute || school || 'Kapil Institute';
    const finalHub = coaching_hub || coachingHub || 'Ajit Road Hub';
    const finalStream = stream || '11th Medical';

    // Check if handle is already taken
    const { data: existingHandle } = await supabase
      .from('users')
      .select('id')
      .ilike('handle', cleanHandle)
      .maybeSingle();

    let finalHandle = cleanHandle;
    if (existingHandle) {
      finalHandle = `${cleanHandle}${Math.floor(100 + Math.random() * 900)}`;
    }

    // Generate user invite code & record referrer
    const inviteCode = Math.random().toString(36).substring(2, 8).toUpperCase();
    const cleanRef = (refCode || req.body.referred_by || '').trim().replace(/^@/, '');

    // Default avatar based on gender
    const defaultAvatar = avatar || (gender === 'girl' ? '🌸' : gender === 'boy' ? '😎' : '✨');
    const safeEmail = email || `${finalHandle.toLowerCase()}@bathinda.centerinsider.local`;

    // Check if user already exists by email or googleId to support update/re-onboarding safely
    let existingUser = null;
    if (email) {
      const { data: byEmail } = await supabase.from('users').select('*').eq('email', email).maybeSingle();
      existingUser = byEmail;
    }
    if (!existingUser && googleId) {
      const { data: byGid } = await supabase.from('users').select('*').eq('google_id', googleId).maybeSingle();
      existingUser = byGid;
    }

    let userResult = null;

    if (existingUser) {
      const updatePayload = {
        name: name || existingUser.name,
        handle: finalHandle,
        password: password || existingUser.password || null,
        gender: gender || existingUser.gender || 'boy',
        grade: parseInt(grade) || existingUser.grade || 11,
        school: finalInstitute,
        institute: finalInstitute,
        coaching_hub: finalHub,
        stream: finalStream,
        district: 'Bathinda',
        profile_pic: profilePic || existingUser.profile_pic || '',
        avatar: defaultAvatar,
        my_invite_code: finalHandle,
        invite_code_used: existingUser.invite_code_used || cleanRef,
        referred_by: existingUser.referred_by || cleanRef,
        bio: existingUser.bio || `${finalInstitute} • ${finalStream}`
      };

      let { data: updatedUser, error: updateError } = await supabase
        .from('users')
        .update(updatePayload)
        .eq('id', existingUser.id)
        .select()
        .single();

      if (updateError && (updateError.message?.includes('institute') || updateError.message?.includes('coaching_hub') || updateError.message?.includes('stream') || updateError.message?.includes('referred_by'))) {
        delete updatePayload.institute;
        delete updatePayload.coaching_hub;
        delete updatePayload.stream;
        delete updatePayload.referred_by;
        const retry = await supabase
          .from('users')
          .update(updatePayload)
          .eq('id', existingUser.id)
          .select()
          .single();
        updatedUser = retry.data;
        updateError = retry.error;
      }

      if (updateError) {
        console.error('Update User Onboarding Error:', updateError);
        return res.status(400).json({ error: 'Failed to update user profile: ' + updateError.message });
      }
      userResult = updatedUser;
    } else {
      const newUser = {
        email: safeEmail,
        google_id: googleId || null,
        name: name || '',
        handle: finalHandle,
        password: password || null,
        gender: gender || 'boy',
        grade: parseInt(grade) || 11,
        school: finalInstitute,
        institute: finalInstitute,
        coaching_hub: finalHub,
        stream: finalStream,
        district: 'Bathinda',
        profile_pic: profilePic || '',
        avatar: defaultAvatar,
        invite_code: inviteCode,
        my_invite_code: finalHandle,
        invite_code_used: cleanRef,
        referred_by: cleanRef,
        invites: 0,
        feed_drops: 0,
        referral_rewarded: false,
        total_votes: 0,
        is_pro: false,
        ring: 'none',
        bio: `${finalInstitute} • ${finalStream}`
      };

      let { data: createdUser, error: insertError } = await supabase
        .from('users')
        .insert([newUser])
        .select()
        .single();

      if (insertError && (insertError.message?.includes('feed_drops') || insertError.message?.includes('city') || insertError.message?.includes('institute') || insertError.message?.includes('coaching_hub') || insertError.message?.includes('stream') || insertError.message?.includes('referred_by'))) {
        delete newUser.feed_drops;
        delete newUser.referral_rewarded;
        delete newUser.city;
        delete newUser.institute;
        delete newUser.coaching_hub;
        delete newUser.stream;
        delete newUser.referred_by;
        const retry = await supabase
          .from('users')
          .insert([newUser])
          .select()
          .single();
        createdUser = retry.data;
        insertError = retry.error;
      }

      if (insertError) {
        console.error('Insert User Onboarding Error:', insertError);
        return res.status(400).json({ error: 'Failed to create user profile: ' + insertError.message });
      }
      userResult = createdUser;
    }

    if (userResult) {
      userResult.city = 'Bathinda';
      userResult.institute = userResult.institute || finalInstitute;
      userResult.coaching_hub = userResult.coaching_hub || finalHub;
      userResult.stream = userResult.stream || finalStream;

      // Task 3: Automatically unlock Referrer's cooldown timestamp & reset session votes
      if (cleanRef) {
        await unlockReferrerCooldown(cleanRef, userResult.id, userResult.handle);
      }
    }

    res.json({ user: userResult });
  } catch (error) {
    console.error('Complete Onboarding Error:', error);
    res.status(500).json({ error: 'Internal server error during onboarding' });
  }
});

// --- CLASSMATE SUGGESTIONS FOR ONBOARDING STEP 6 ---
const BATHINDA_COACHING_FALLBACK_PEERS = [
  { id: 'bti-seed-1', name: 'Gursharan Singh', handle: 'gursharan', avatar: '😎', mutual: 18, grade: 11, stream: '11th Medical', institute: 'Kapil Institute', coaching_hub: 'Ajit Road Hub' },
  { id: 'bti-seed-2', name: 'Piyush Bansal', handle: 'piyush_b', avatar: '🔥', mutual: 24, grade: 11, stream: '11th Non-Med', institute: 'UNCRAM', coaching_hub: 'Ajit Road Hub' },
  { id: 'bti-seed-3', name: 'Harsh Pawar', handle: 'harsh_pawar', avatar: '🦊', mutual: 15, grade: 12, stream: '12th Board', institute: 'Aakash Institute', coaching_hub: '100 Feet Road Hub' },
  { id: 'bti-seed-4', name: 'Altaf Khan', handle: 'altaf', avatar: '👑', mutual: 21, grade: 12, stream: 'NEET Droppers', institute: 'ALLEN Career Institute', coaching_hub: 'Other Bathinda Locations' },
  { id: 'bti-seed-5', name: 'Karamveer Brar', handle: 'karam_brar', avatar: '⚡', mutual: 14, grade: 11, stream: '11th Medical', institute: 'Prof J.S Brar Institute', coaching_hub: 'Ajit Road Hub' },
  { id: 'bti-seed-6', name: 'Harman Kaur', handle: 'harman_k', avatar: '🌸', mutual: 19, grade: 11, stream: '11th Medical', institute: 'Kapil Institute', coaching_hub: 'Ajit Road Hub' },
  { id: 'bti-seed-7', name: 'Navjot Singh', handle: 'navjot_s', avatar: '💫', mutual: 16, grade: 11, stream: '11th Non-Med', institute: 'REAL INSTITUTE OF MATHS', coaching_hub: 'Ajit Road Hub' },
  { id: 'bti-seed-8', name: 'Simran Dhillon', handle: 'simran_d', avatar: '✨', mutual: 11, grade: 12, stream: '12th Board', institute: 'Tanya Commerce Institute', coaching_hub: 'Ajit Road Hub' },
  { id: 'bti-seed-9', name: 'Khushi Jindal', handle: 'khushi_j', avatar: '💖', mutual: 13, grade: 11, stream: '11th Medical', institute: 'Mahak Science Classes', coaching_hub: 'Ajit Road Hub' },
  { id: 'bti-seed-10', name: 'Arjun Sharma', handle: 'arjun_phy', avatar: '🏀', mutual: 17, grade: 12, stream: 'NEET Droppers', institute: 'Arjun Physics Classes', coaching_hub: 'Ajit Road Hub' }
];

app.get('/api/classmates/suggested', async (req, res) => {
  try {
    const { grade, stream, school, excludeId } = req.query;
    let query = supabase.from('users').select('id, handle, name, avatar, profile_pic, grade, stream, institute, coaching_hub, is_pro, ring');
    if (excludeId) query = query.neq('id', excludeId);
    if (stream && stream !== 'all' && stream !== 'All Bathinda') {
      query = query.ilike('stream', `%${stream}%`);
    } else if (grade && grade !== 'all') {
      query = query.or(`grade.eq.${grade},grade.eq.${parseInt(grade) || grade}`);
    }
    let { data: users } = await query.limit(10);
    if (!users || users.length < 6) {
      let fallbackQuery = supabase.from('users').select('id, handle, name, avatar, profile_pic, grade, stream, institute, coaching_hub, is_pro, ring');
      if (excludeId) fallbackQuery = fallbackQuery.neq('id', excludeId);
      const { data: schoolUsers } = await fallbackQuery.limit(10);
      users = schoolUsers || [];
    }

    // Merge fallback seed peers if needed to ensure a full list matching the coaching hubs
    const finalUsers = [...(users || [])];
    BATHINDA_COACHING_FALLBACK_PEERS.forEach(seed => {
      if (finalUsers.length < 10 && !finalUsers.some(u => u.handle === seed.handle || u.name === seed.name)) {
        finalUsers.push(seed);
      }
    });

    res.json({ classmates: finalUsers });
  } catch (err) {
    res.status(500).json({ error: err.message, classmates: BATHINDA_COACHING_FALLBACK_PEERS });
  }
});

// --- PLAY & VOTING ---
const TUITION_POLLS_FALLBACK = [
  { id: 1, question: "Always sleeps through 5 PM Physics?", is_crush_poll: false },
  { id: 2, question: "Most likely to crack NEET on the first attempt?", is_crush_poll: false },
  { id: 3, question: "Spends more time at the Maggi point than in class?", is_crush_poll: false },
  { id: 4, question: "Solves HC Verma questions during recess?", is_crush_poll: false },
  { id: 5, question: "Has handwritten formula cheat sheets everyone borrows?", is_crush_poll: false },
  { id: 6, question: "Sells their Allen/Aakash test series analysis for samosas?", is_crush_poll: false },
  { id: 7, question: "Secret crush in the coaching batch", is_crush_poll: true },
  { id: 8, question: "Biggest drip at Ajit Road", is_crush_poll: false }
];

app.get('/api/play/:userId', async (req, res) => {
  try {
    const { gradeFilter, streamFilter } = req.query;
    const voterId = req.params.userId;
    const { data: user } = await supabase.from('users').select('*').eq('id', voterId).maybeSingle();
    const cooldownState = await getUserCooldownState(voterId, user);

    let { data: polls } = await supabase.from('polls').select('*');
    if (!polls || polls.length === 0) {
      polls = TUITION_POLLS_FALLBACK;
    }
    const randomPoll = polls[Math.floor(Math.random() * polls.length)];

    const targetInstitute = (req.query.institute || user?.institute || '').trim();
    let query = supabase.from('users').select('id, handle, name, avatar, profile_pic, grade, stream, institute, coaching_hub, is_pro, ring, selected_ring').neq('id', voterId);
    
    // Strict multi-tenant institute silo
    if (targetInstitute) {
      query = query.eq('institute', targetInstitute);
    }

    const activeFilter = streamFilter || gradeFilter;
    if (activeFilter && activeFilter !== 'all' && activeFilter !== 'All Bathinda') {
      if (activeFilter.includes('Med') || activeFilter.includes('Board') || activeFilter.includes('Dropper') || activeFilter.includes('Commerce')) {
        query = query.ilike('stream', `%${activeFilter}%`);
      } else {
        query = query.or(`grade.eq.${activeFilter},grade.eq.${parseInt(activeFilter) || activeFilter}`);
      }
    }

    let { data: allUsers } = await query;
    // Strictly isolate: do not augment with rival institutes or other schools
    const instituteUsers = (allUsers || []).filter(u => !targetInstitute || u.institute === targetInstitute);

    const shuffledOptions = instituteUsers.sort(() => 0.5 - Math.random()).slice(0, 4);
    res.json({
      poll: randomPoll,
      options: shuffledOptions,
      cooldown_until: cooldownState.cooldown_until,
      session_vote_count: cooldownState.session_vote_count
    });
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

    // Track voter cooldown & 12-vote session count
    const { data: voter } = await supabase.from('users').select('*').eq('id', voterId).maybeSingle();
    let state = await getUserCooldownState(voterId, voter);

    let cooldown_until = state.cooldown_until;
    let session_vote_count = (state.session_vote_count || 0) + 1;

    // Check 12-vote threshold for free users
    if (!voter?.is_pro && session_vote_count >= 12) {
      cooldown_until = new Date(Date.now() + 30 * 60 * 1000).toISOString();
      session_vote_count = 0;
    }

    state.session_vote_count = session_vote_count;
    state.cooldown_until = cooldown_until;
    sessionCooldowns.set(voterId, state);

    try {
      await supabase.from('users').update({
        session_vote_count,
        cooldown_until
      }).eq('id', voterId);
    } catch (_) {}

    // --- ANTI-CHEAT REFERRAL VERIFICATION (3-POLL + GOOGLE AUTH RULE) ---
    if (voter && voter.invite_code_used && !voter.referral_rewarded) {
      try {
        const { count: totalVotesCount } = await supabase
          .from('votes')
          .select('*', { count: 'exact', head: true })
          .eq('voter_id', voterId);

        const isGoogleUser = Boolean(voter.google_id || (voter.email && !voter.email.includes('.local')));

        if (totalVotesCount >= 3 && isGoogleUser) {
          const cleanRef = voter.invite_code_used.trim().replace(/^@/, '');
          const filterParts = [`invite_code.ilike.${cleanRef}`, `handle.ilike.${cleanRef}`];
          if (!isNaN(cleanRef) || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cleanRef)) {
            filterParts.push(`id.eq.${cleanRef}`);
          }

          const { data: referrer } = await supabase
            .from('users')
            .select('id, invites, feed_drops, is_batch_captain, batch_captain_admin_override')
            .or(filterParts.join(','))
            .maybeSingle();

          if (referrer && referrer.id !== voterId) {
            const updatedInvites = (referrer.invites || 0) + 1;
            const updatedDrops = (referrer.feed_drops || 0) + 50;
            // Elite Batch Captain requires exactly 25 active recruits OR admin override
            const isBatchCaptain = updatedInvites >= 25 || Boolean(referrer.batch_captain_admin_override);

            try {
              await supabase
                .from('users')
                .update({ 
                  invites: updatedInvites, 
                  feed_drops: updatedDrops,
                  is_batch_captain: isBatchCaptain
                })
                .eq('id', referrer.id);
            } catch (_) {
              await supabase
                .from('users')
                .update({ 
                  invites: updatedInvites,
                  is_batch_captain: isBatchCaptain
                })
                .eq('id', referrer.id);
            }

            try {
              await supabase
                .from('users')
                .update({ referral_rewarded: true })
                .eq('id', voterId);
            } catch (_) {}

            console.log(`🛡️ [Anti-Cheat Verified] User @${voter.handle || voterId} reached 3 votes with Google Auth! Referrer @${referrer.id} awarded +1 Invite (Total: ${updatedInvites}/25) & +50 Feed Drops. Elite Status: ${isBatchCaptain}`);
          }
        }
      } catch (refCheckErr) {
        console.error('Referral verification check error:', refCheckErr);
      }
    }

    res.json({ success: true, session_vote_count, cooldown_until });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Clear Cooldown (God Mode VIP activation or verified timer expiry)
app.post('/api/cooldown/skip', async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId is required' });

    // Validate that user is Pro OR cooldown is already expired/cleared in DB
    const { data: user } = await supabase.from('users').select('id, is_pro, cooldown_until, cooldown_expires_at').eq('id', userId).maybeSingle();
    const activeCd = user?.cooldown_until || user?.cooldown_expires_at;
    const isExpired = !activeCd || new Date(activeCd).getTime() <= Date.now();

    if (!user?.is_pro && !isExpired) {
      return res.status(403).json({ error: 'Cooldown active. Timer unlocks when a friend authenticates with your invite code!' });
    }

    sessionCooldowns.set(userId, { session_vote_count: 0, cooldown_until: null });
    try {
      await supabase.from('users').update({
        session_vote_count: 0,
        cooldown_until: null,
        cooldown_expires_at: null
      }).eq('id', userId);
    } catch (_) {}

    res.json({ success: true, cooldown_until: null, session_vote_count: 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update Aura Ring Route (Saved directly to users table)
app.post('/api/user/ring', async (req, res) => {
  try {
    const { userId, selected_ring } = req.body;
    if (!userId || !selected_ring) return res.status(400).json({ error: 'Missing userId or selected_ring' });

    let updatedUser = null;
    try {
      const { data, error } = await supabase
        .from('users')
        .update({
          selected_ring,
          ring: selected_ring
        })
        .eq('id', userId)
        .select()
        .single();
      if (error) throw error;
      updatedUser = data;
    } catch (e) {
      // Fallback in case selected_ring column is named ring in Supabase
      const { data } = await supabase
        .from('users')
        .update({ ring: selected_ring })
        .eq('id', userId)
        .select()
        .single();
      updatedUser = data;
    }

    res.json({ success: true, user: updatedUser });
  } catch (err) {
    console.error('Ring update error:', err);
    res.status(500).json({ error: err.message });
  }
});

// --- PROFILE MANAGEMENT ---
app.put('/api/profile/:userId', async (req, res) => {
  try {
    const { bio, avatar, ring, profile_pic, grade, city, institute, coaching_hub, coachingHub, stream } = req.body;
    const updateData = {};
    if (bio !== undefined) updateData.bio = bio;
    if (avatar !== undefined) updateData.avatar = avatar;
    if (ring !== undefined) updateData.ring = ring;
    if (profile_pic !== undefined) updateData.profile_pic = profile_pic;
    if (grade !== undefined) updateData.grade = grade.toString();
    if (institute !== undefined) {
      updateData.institute = institute;
      updateData.school = institute;
    }
    if (coaching_hub !== undefined || coachingHub !== undefined) {
      updateData.coaching_hub = coaching_hub || coachingHub;
    }
    if (stream !== undefined) updateData.stream = stream;
    updateData.district = 'Bathinda';

    let { data: updatedUser, error } = await supabase
      .from('users')
      .update(updateData)
      .eq('id', req.params.userId)
      .select()
      .single();

    if (error && (error.message?.includes('city') || error.message?.includes('institute') || error.message?.includes('coaching_hub') || error.message?.includes('stream') || error.code === '42703')) {
      delete updateData.city;
      delete updateData.institute;
      delete updateData.coaching_hub;
      delete updateData.stream;
      const retry = await supabase
        .from('users')
        .update(updateData)
        .eq('id', req.params.userId)
        .select()
        .single();
      updatedUser = retry.data;
      error = retry.error;
    }

    if (error) throw error;
    if (updatedUser) {
      updatedUser.city = 'Bathinda';
      updatedUser.institute = updatedUser.institute || institute || 'Kapil Institute';
      updatedUser.coaching_hub = updatedUser.coaching_hub || coaching_hub || coachingHub || 'Ajit Road Hub';
      updatedUser.stream = updatedUser.stream || stream || '11th Medical';
    }
    res.json({ success: true, user: updatedUser });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/profile/:userId', async (req, res) => {
  try {
    const { password } = req.body;
    if (!password || !password.trim()) {
      return res.status(400).json({ error: 'Password is required to confirm account deletion' });
    }
    const { data: user, error: fetchErr } = await supabase.from('users').select('password').eq('id', req.params.userId).single();
    if (fetchErr || !user) {
      return res.status(404).json({ error: 'User profile not found' });
    }
    if (user.password !== password.trim()) {
      return res.status(401).json({ error: 'Incorrect password. Account deletion aborted.' });
    }
    
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
    const { userId } = req.body;
    // Support both ₹99/week (9900 paise) and ₹149/month (14900 paise) subscription offerings
    const requestedAmount = Number(req.body.amount);
    const amount = (requestedAmount === 14900 || requestedAmount === 9900) ? requestedAmount : 9900;
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
      sessionCooldowns.set(userId, { session_vote_count: 0, cooldown_until: null });
      const { data } = await supabase.from('users').update({ is_pro: true, ring: 'gold', selected_ring: 'gold' }).eq('id', userId).select().single();
      try {
        await supabase.from('users').update({ session_vote_count: 0, cooldown_until: null }).eq('id', userId);
      } catch (_) {}
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
    const { data: votes } = await supabase
      .from('votes')
      .select(`id, created_at, polls(question), users!voter_id(handle, name, avatar, profile_pic, ring, is_pro, gender)`)
      .eq('receiver_id', req.params.userId)
      .order('created_at', { ascending: false });
    
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

    const messages = (votes || []).map(v => {
      const voterGender = v.users?.gender || 'boy';

      if (!canReveal) {
        // STRICT SECURITY GATING: Mask voter identity completely!
        // Return ONLY question, voterGender, and voteId
        return {
          voteId: v.id,
          question: v.polls?.question || 'Secret Compliment',
          voterGender,
          isLocked: true
        };
      } else {
        // UNLOCKED: Return complete voter profile
        return {
          voteId: v.id,
          question: v.polls?.question || 'Secret Compliment',
          voterGender,
          voterHandle: v.users?.handle,
          voterName: v.users?.name || v.users?.handle,
          voterAvatar: v.users?.avatar || '😎',
          voterPic: v.users?.profile_pic || '',
          isPro: Boolean(v.users?.is_pro),
          ring: v.users?.ring || 'none',
          isLocked: false
        };
      }
    });

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
      .select(`id, poll_id, voter_id, users!voter_id(id, handle, name, avatar, profile_pic, ring, is_pro, gender), polls(question)`)
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
      voterGender: vote.users?.gender || 'boy',
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
    const { q, userId, institute } = req.query;
    if (!q || !q.trim()) return res.json({ users: [] });

    const cleanQuery = q.trim().replace(/^@/, '');
    let query = supabase
      .from('users')
      .select('id, handle, name, avatar, profile_pic, grade, ring, is_pro, institute')
      .ilike('handle', `%${cleanQuery}%`)
      .limit(25);

    if (institute && institute.trim()) {
      query = query.eq('institute', institute.trim());
    }

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

// Incoming pending friend requests for notifications
app.get('/api/friends/pending/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const { data: requests, error } = await supabase
      .from('friendships')
      .select('*')
      .eq('receiver_id', userId)
      .eq('status', 'pending')
      .order('created_at', { ascending: false });

    if (error) throw error;
    if (!requests || requests.length === 0) return res.json({ pending: [] });

    const requesterIds = requests.map(r => r.requester_id).filter(Boolean);
    const { data: requesters } = await supabase
      .from('users')
      .select('id, handle, name, avatar, profile_pic, grade, ring, is_pro')
      .in('id', requesterIds);

    const userMap = {};
    (requesters || []).forEach(u => { userMap[u.id] = u; });

    const pending = requests.map(r => ({
      friendshipId: r.id,
      requesterId: r.requester_id,
      createdAt: r.created_at,
      requester: userMap[r.requester_id] || { handle: 'classmate', avatar: '😎' }
    }));

    res.json({ pending });
  } catch (err) {
    console.error('Pending Friends Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Respond to friend request (accept or decline)
app.post('/api/friends/respond', async (req, res) => {
  try {
    const { friendshipId, action } = req.body;
    if (!friendshipId || !action) {
      return res.status(400).json({ error: 'friendshipId and action are required' });
    }

    if (action === 'accept') {
      const { data, error } = await supabase
        .from('friendships')
        .update({ status: 'accepted' })
        .eq('id', friendshipId)
        .select()
        .single();
      if (error) throw error;
      return res.json({ success: true, status: 'accepted', friendship: data });
    } else {
      const { error } = await supabase
        .from('friendships')
        .delete()
        .eq('id', friendshipId);
      if (error) throw error;
      return res.json({ success: true, status: 'declined' });
    }
  } catch (err) {
    console.error('Respond Friend Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Accepted friends count and list for Profile tab
app.get('/api/friends/accepted/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const { data: list, error } = await supabase
      .from('friendships')
      .select('*')
      .eq('status', 'accepted')
      .or(`requester_id.eq.${userId},receiver_id.eq.${userId}`);

    if (error) throw error;
    if (!list || list.length === 0) return res.json({ count: 0, friends: [] });

    const friendIds = list.map(f => f.requester_id === userId ? f.receiver_id : f.requester_id).filter(Boolean);
    const { data: friendsUsers } = await supabase
      .from('users')
      .select('id, handle, name, avatar, profile_pic, grade, ring, is_pro, total_votes')
      .in('id', friendIds);

    res.json({ count: (friendsUsers || []).length, friends: friendsUsers || [] });
  } catch (err) {
    console.error('Accepted Friends Error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/explore/leaderboard', async (req, res) => {
  try {
    const targetInstitute = (req.query.institute || '').trim();
    let query = supabase
      .from('users')
      .select('id, handle, name, avatar, profile_pic, ring, selected_ring, total_votes, is_pro, grade, stream, institute, coaching_hub, invites, is_batch_captain');

    if (targetInstitute) {
      query = query.eq('institute', targetInstitute);
    }

    let result = await query
      .order('total_votes', { ascending: false })
      .limit(100);

    if (result.error && (result.error.message?.includes('stream') || result.error.message?.includes('institute') || result.error.code === '42703')) {
      let retryQuery = supabase
        .from('users')
        .select('id, handle, name, avatar, profile_pic, ring, selected_ring, total_votes, is_pro, grade, invites');
      result = await retryQuery
        .order('total_votes', { ascending: false })
        .limit(100);
    }

    const leaderboard = (result.data || [])
      .filter(u => !targetInstitute || u.institute === targetInstitute)
      .map(u => ({
        ...u,
        institute: u.institute || targetInstitute || 'Kapil Institute',
        stream: u.stream || (u.grade === 12 ? '12th Board' : '11th Medical'),
        grade: u.grade || 11,
        coaching_hub: u.coaching_hub || 'Ajit Road Hub',
        is_batch_captain: Boolean(u.is_batch_captain || ((u.invites || 0) >= 25))
      }));

    res.json({ success: true, leaderboard });
  } catch (err) {
    res.status(500).json({ error: err.message, leaderboard: [] });
  }
});

// --- BATCH CAPTAINS (REFERRAL ENGINE) LEADERBOARD (Strict 25+ Recruits) ---
app.get('/api/referrals/leaderboard', async (req, res) => {
  try {
    const targetInstitute = (req.query.institute || '').trim();
    let query = supabase
      .from('users')
      .select('id, handle, name, avatar, profile_pic, grade, stream, institute, coaching_hub, district, invites, feed_drops, total_votes, is_pro, ring, is_batch_captain, batch_captain_admin_override')
      .gte('invites', 25);

    if (targetInstitute) {
      query = query.eq('institute', targetInstitute);
    }

    let result = await query
      .order('invites', { ascending: false })
      .limit(50);

    // Resilient fallback if Supabase migration has not been executed yet
    if (result.error && (result.error.message?.includes('city') || result.error.message?.includes('stream') || result.error.message?.includes('institute') || result.error.message?.includes('feed_drops') || result.error.message?.includes('is_batch_captain') || result.error.code === '42703')) {
      result = await supabase
        .from('users')
        .select('id, handle, name, avatar, profile_pic, grade, district, invites, total_votes, is_pro, ring')
        .gte('invites', 25)
        .order('invites', { ascending: false })
        .limit(50);
    }

    // Strict 25+ recruits filter - do NOT display users with 0, 1, or 3 recruits
    const rawList = result.data || [];
    const captains = rawList
      .filter(u => !targetInstitute || u.institute === targetInstitute)
      .filter(u => ((u.invites || u.recruits || 0) >= 25 || u.batch_captain_admin_override))
      .map(u => ({
        ...u,
        stream: u.stream || (u.grade === 12 ? '12th Board' : '11th Medical'),
        institute: u.institute || targetInstitute || 'Kapil Institute',
        coaching_hub: u.coaching_hub || 'Ajit Road Hub',
        feed_drops: u.feed_drops !== undefined && u.feed_drops !== null ? u.feed_drops : (u.invites || 0) * 50,
        is_batch_captain: true,
        batch_captain_admin_override: Boolean(u.batch_captain_admin_override)
      }));
    res.json({ success: true, leaderboard: captains });
  } catch (err) {
    console.error('Batch Captains Leaderboard Error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/explore/legends', async (req, res) => {
  try {
    const targetInstitute = (req.query.institute || '').trim();
    let query = supabase
      .from('users')
      .select('id, handle, name, avatar, profile_pic, ring, selected_ring, total_votes, is_pro, grade, stream, institute, invites, is_batch_captain, batch_captain_admin_override')
      .gte('invites', 25);

    if (targetInstitute) {
      query = query.eq('institute', targetInstitute);
    }

    let result = await query
      .order('invites', { ascending: false })
      .limit(50);

    if (result.error && (result.error.message?.includes('stream') || result.error.message?.includes('institute') || result.error.code === '42703')) {
      result = await supabase
        .from('users')
        .select('id, handle, name, avatar, profile_pic, ring, selected_ring, total_votes, is_pro, grade, invites')
        .gte('invites', 25)
        .order('invites', { ascending: false })
        .limit(50);
    }

    let allUsers = result.data || [];
    // Filter strictly for users from current institute who achieved 25+ recruits
    let legends = allUsers
      .filter(u => !targetInstitute || u.institute === targetInstitute)
      .filter(u => ((u.invites || u.recruits || 0) >= 25 || u.batch_captain_admin_override))
      .map(u => ({
        ...u,
        is_batch_captain: true
      }));

    res.json({ success: true, legends });
  } catch (err) {
    console.error('Legends fetch error:', err);
    res.status(500).json({ error: err.message, legends: [] });
  }
});

app.get('/api/explore/trending', async (req, res) => {
  try {
    let { data: polls, error: pollErr } = await supabase
      .from('polls')
      .select('id, question')
      .limit(3);

    if (pollErr || !polls || polls.length === 0) {
      polls = [
        { id: 1, question: "Always sleeps through 5 PM Physics?" },
        { id: 2, question: "Most likely to crack NEET on the first attempt?" },
        { id: 3, question: "Spends more time at the Maggi point than in class?" }
      ];
    } else {
      polls = polls.slice(0, 3);
    }

    const trending = await Promise.all(
      polls.map(async (poll) => {
        try {
          const { data: votes } = await supabase
            .from('votes')
            .select('receiver_id')
            .eq('poll_id', poll.id);

          const countMap = {};
          (votes || []).forEach(v => {
            if (v.receiver_id) {
              countMap[v.receiver_id] = (countMap[v.receiver_id] || 0) + 1;
            }
          });

          const sortedReceiverIds = Object.keys(countMap)
            .sort((a, b) => countMap[b] - countMap[a])
            .slice(0, 3);

          let topStudents = [];
          if (sortedReceiverIds.length > 0) {
            const { data: students } = await supabase
              .from('users')
              .select('id, handle, name, avatar, profile_pic, ring, selected_ring, is_pro')
              .in('id', sortedReceiverIds);

            topStudents = (students || []).map(s => ({
              ...s,
              votes: countMap[s.id] || 0
            })).sort((a, b) => b.votes - a.votes);
          }

          if (topStudents.length === 0) {
            const { data: fallbackUsers } = await supabase
              .from('users')
              .select('id, handle, name, avatar, profile_pic, ring, selected_ring, is_pro, total_votes')
              .order('total_votes', { ascending: false })
              .limit(3);

            topStudents = (fallbackUsers || []).map((u, i) => ({
              ...u,
              votes: Math.max(1, (u.total_votes || 1) - i * 3)
            }));
          }

          return {
            id: poll.id,
            question: poll.question,
            topStudents
          };
        } catch (e) {
          return { id: poll.id, question: poll.question, topStudents: [] };
        }
      })
    );

    res.json({ trending });
  } catch (err) {
    console.error('Trending fetch error:', err);
    res.status(500).json({ error: err.message, trending: [] });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));