-- ============================================================================
-- CENTERINSIDER MIGRATION: RLS SECURITY HARDENING & PERFORMANCE OPTIMIZATION
-- 
-- 1. ENABLE ROW LEVEL SECURITY on public.polls2 and create policies allowing
--    authenticated users to read and insert data.
-- 2. Update all existing RLS policies on users, votes, and custom_polls tables
--    to replace auth.uid() with (SELECT auth.uid()) to resolve the
--    "Auth RLS Initialization Plan" performance warnings.
-- 3. Create an explicit INSERT policy on public.users allowing authenticated
--    users to insert their own rows during the onboarding sequence.
-- ============================================================================

-- ============================================================================
-- 1. ROW LEVEL SECURITY (RLS) FOR public.polls2
-- ============================================================================
ALTER TABLE IF EXISTS public.polls2 ENABLE ROW LEVEL SECURITY;

-- Drop any previous policies on polls2
DROP POLICY IF EXISTS "Authenticated users can read polls2" ON public.polls2;
DROP POLICY IF EXISTS "Allow authenticated read polls2" ON public.polls2;
DROP POLICY IF EXISTS "Allow authenticated or anon to read polls2" ON public.polls2;
DROP POLICY IF EXISTS "Authenticated users can insert polls2" ON public.polls2;
DROP POLICY IF EXISTS "Allow authenticated insert polls2" ON public.polls2;

-- Read policy: Authenticated users can read polls2
CREATE POLICY "Allow authenticated read polls2"
ON public.polls2
FOR SELECT
TO authenticated
USING (true);

-- Insert policy: Authenticated users can insert polls2
CREATE POLICY "Allow authenticated insert polls2"
ON public.polls2
FOR INSERT
TO authenticated
WITH CHECK (true);


-- ============================================================================
-- 2. RESOLVE "Auth RLS Initialization Plan" WARNINGS ON public.votes
-- ============================================================================
ALTER TABLE IF EXISTS public.votes ENABLE ROW LEVEL SECURITY;

-- Drop existing policies
DROP POLICY IF EXISTS "Only God Mode receivers can read votes directly" ON public.votes;
DROP POLICY IF EXISTS "Allow authenticated or anon to cast votes" ON public.votes;
DROP POLICY IF EXISTS "Allow authenticated users to cast votes" ON public.votes;

-- Policy: Strict SELECT access on votes table using (SELECT auth.uid())
CREATE POLICY "Only God Mode receivers can read votes directly"
ON public.votes
FOR SELECT
TO authenticated
USING (
  (
    (SELECT auth.uid()) = receiver_id 
    OR (SELECT auth.uid())::text = receiver_id::text
  )
  AND EXISTS (
    SELECT 1 FROM public.users u
    WHERE (u.id = (SELECT auth.uid()) OR u.id::text = (SELECT auth.uid())::text)
      AND u.is_pro = true
  )
);

-- Policy: Casting votes (INSERT)
CREATE POLICY "Allow authenticated or anon to cast votes"
ON public.votes
FOR INSERT
TO authenticated, anon
WITH CHECK (true);


-- ============================================================================
-- 3. RESOLVE "Auth RLS Initialization Plan" WARNINGS ON public.custom_polls
-- ============================================================================
ALTER TABLE IF EXISTS public.custom_polls ENABLE ROW LEVEL SECURITY;

-- Drop existing policies
DROP POLICY IF EXISTS "Public can view approved custom polls" ON public.custom_polls;
DROP POLICY IF EXISTS "Users can view their own custom polls" ON public.custom_polls;
DROP POLICY IF EXISTS "Users can insert their own custom polls" ON public.custom_polls;
DROP POLICY IF EXISTS "Users can update their own custom polls" ON public.custom_polls;
DROP POLICY IF EXISTS "Users can delete their own custom polls" ON public.custom_polls;

-- Policy: Everyone can view approved custom polls
CREATE POLICY "Public can view approved custom polls"
ON public.custom_polls
FOR SELECT
TO anon, authenticated
USING (status = 'approved');

-- Policy: Users can view their own submitted custom polls (using (SELECT auth.uid()))
CREATE POLICY "Users can view their own custom polls"
ON public.custom_polls
FOR SELECT
TO authenticated
USING (
  (SELECT auth.uid()) = created_by 
  OR (SELECT auth.uid())::text = created_by::text
);

-- Policy: Users can insert their own custom polls (using (SELECT auth.uid()))
CREATE POLICY "Users can insert their own custom polls"
ON public.custom_polls
FOR INSERT
TO authenticated
WITH CHECK (
  (SELECT auth.uid()) = created_by 
  OR (SELECT auth.uid())::text = created_by::text
);

-- Policy: Users can update their own custom polls (using (SELECT auth.uid()))
CREATE POLICY "Users can update their own custom polls"
ON public.custom_polls
FOR UPDATE
TO authenticated
USING (
  (SELECT auth.uid()) = created_by 
  OR (SELECT auth.uid())::text = created_by::text
)
WITH CHECK (
  (SELECT auth.uid()) = created_by 
  OR (SELECT auth.uid())::text = created_by::text
);

-- Policy: Users can delete their own custom polls (using (SELECT auth.uid()))
CREATE POLICY "Users can delete their own custom polls"
ON public.custom_polls
FOR DELETE
TO authenticated
USING (
  (SELECT auth.uid()) = created_by 
  OR (SELECT auth.uid())::text = created_by::text
);


-- ============================================================================
-- 4. public.users POLICIES & ONBOARDING INSERT POLICY
-- ============================================================================
ALTER TABLE IF EXISTS public.users ENABLE ROW LEVEL SECURITY;

-- Drop existing policies
DROP POLICY IF EXISTS "Allow authenticated or anon to read users" ON public.users;
DROP POLICY IF EXISTS "Allow authenticated read on users" ON public.users;
DROP POLICY IF EXISTS "Public profiles are viewable by everyone" ON public.users;
DROP POLICY IF EXISTS "Allow authenticated users to insert own profile" ON public.users;
DROP POLICY IF EXISTS "Users can insert their own profile" ON public.users;
DROP POLICY IF EXISTS "Allow authenticated users to update own profile" ON public.users;
DROP POLICY IF EXISTS "Users can update their own profile" ON public.users;

-- SELECT Policy: Allow authenticated and anon users to read profiles for discovery & voting
CREATE POLICY "Allow authenticated or anon to read users"
ON public.users
FOR SELECT
TO authenticated, anon
USING (true);

-- INSERT Policy: Explicitly allow authenticated users to insert their own profile during onboarding
CREATE POLICY "Allow authenticated users to insert own profile"
ON public.users
FOR INSERT
TO authenticated
WITH CHECK (
  (SELECT auth.uid()) = id 
  OR (SELECT auth.uid())::text = id::text 
  OR (SELECT auth.uid())::text = google_id::text
);

-- UPDATE Policy: Allow authenticated users to update their own profile (using (SELECT auth.uid()))
CREATE POLICY "Allow authenticated users to update own profile"
ON public.users
FOR UPDATE
TO authenticated
USING (
  (SELECT auth.uid()) = id 
  OR (SELECT auth.uid())::text = id::text 
  OR (SELECT auth.uid())::text = google_id::text
)
WITH CHECK (
  (SELECT auth.uid()) = id 
  OR (SELECT auth.uid())::text = id::text 
  OR (SELECT auth.uid())::text = google_id::text
);


-- ============================================================================
-- 5. BONUS: OPTIMIZE public.inbox & public.profiles (IF PRESENT)
-- ============================================================================
DO $$
BEGIN
  -- Inbox table optimization
  IF EXISTS (SELECT FROM pg_tables WHERE schemaname = 'public' AND tablename = 'inbox') THEN
    ALTER TABLE public.inbox ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS "Users can only read their own inbox" ON public.inbox;
    CREATE POLICY "Users can only read their own inbox"
    ON public.inbox
    FOR SELECT
    TO authenticated
    USING (
      (SELECT auth.uid()) = user_id 
      OR (SELECT auth.uid()) = recipient_id
      OR (SELECT auth.uid())::text = user_id::text
      OR (SELECT auth.uid())::text = recipient_id::text
    );
  END IF;

  -- Profiles table optimization (if schema uses separate profiles table)
  IF EXISTS (SELECT FROM pg_tables WHERE schemaname = 'public' AND tablename = 'profiles') THEN
    ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS "Allow authenticated or anon to read profiles" ON public.profiles;
    DROP POLICY IF EXISTS "Allow authenticated users to insert own profile record" ON public.profiles;
    DROP POLICY IF EXISTS "Allow authenticated users to update own profile record" ON public.profiles;

    CREATE POLICY "Allow authenticated or anon to read profiles"
    ON public.profiles FOR SELECT
    TO authenticated, anon
    USING (true);

    CREATE POLICY "Allow authenticated users to insert own profile record"
    ON public.profiles FOR INSERT
    TO authenticated
    WITH CHECK ((SELECT auth.uid()) = id OR (SELECT auth.uid())::text = id::text);

    CREATE POLICY "Allow authenticated users to update own profile record"
    ON public.profiles FOR UPDATE
    TO authenticated
    USING ((SELECT auth.uid()) = id OR (SELECT auth.uid())::text = id::text)
    WITH CHECK ((SELECT auth.uid()) = id OR (SELECT auth.uid())::text = id::text);
  END IF;
END $$;
