-- ============================================================================
-- CAMPUSFEED BETA 1.0 MIGRATION: City-Wide Coaching Network Model (Bathinda)
-- Adds Coaching Hub, Institute & Academic Stream Taxonomy + Tuition Poll Seeds
-- ============================================================================

-- 1. Ensure 'city' column exists and defaults strictly to 'Bathinda'
ALTER TABLE public.users 
ADD COLUMN IF NOT EXISTS city TEXT DEFAULT 'Bathinda';

ALTER TABLE public.users 
ALTER COLUMN city SET DEFAULT 'Bathinda';

-- 2. Add 'institute' column (e.g. 'Kapil Institute', 'Aakash Institute', 'UNCRAM', etc.)
ALTER TABLE public.users 
ADD COLUMN IF NOT EXISTS institute TEXT DEFAULT 'Kapil Institute';

-- 3. Add 'coaching_hub' column (e.g. 'Ajit Road Hub', '100 Feet Road Hub', 'Other Bathinda Locations')
ALTER TABLE public.users 
ADD COLUMN IF NOT EXISTS coaching_hub TEXT DEFAULT 'Ajit Road Hub';

-- 4. Add 'stream' column (e.g. '11th Medical', '11th Non-Med', '12th Commerce', 'Dropper')
ALTER TABLE public.users 
ADD COLUMN IF NOT EXISTS stream TEXT DEFAULT '11th Medical';

-- 5. Backfill existing rows without institute/stream
UPDATE public.users 
SET 
  institute = COALESCE(NULLIF(institute, ''), 'Kapil Institute'),
  coaching_hub = COALESCE(NULLIF(coaching_hub, ''), 'Ajit Road Hub'),
  stream = COALESCE(NULLIF(stream, ''), CASE 
    WHEN grade = 12 THEN '12th Board'
    WHEN grade = 11 THEN '11th Medical'
    ELSE '11th Medical'
  END),
  city = 'Bathinda'
WHERE city IS NULL OR city = '' OR institute IS NULL OR stream IS NULL;

-- 6. Performance indexes for Hub, Stream & Institute queries
CREATE INDEX IF NOT EXISTS idx_users_coaching_hub ON public.users(coaching_hub);
CREATE INDEX IF NOT EXISTS idx_users_stream ON public.users(stream);
CREATE INDEX IF NOT EXISTS idx_users_institute ON public.users(institute);
CREATE INDEX IF NOT EXISTS idx_users_hub_stream ON public.users(coaching_hub, stream);

-- 7. Seed Tuition-Focused Questions into Polls
INSERT INTO public.polls (question, is_crush_poll)
SELECT q, is_crush FROM (VALUES
  ('Always sleeps through 5 PM Physics?', false),
  ('Most likely to crack NEET on the first attempt?', false),
  ('Spends more time at the Maggi point than in class?', false),
  ('Solves HC Verma questions during recess?', false),
  ('Has handwritten formula cheat sheets everyone borrows?', false),
  ('Sells their Allen/Aakash test series analysis for samosas?', false),
  ('Secret crush in the coaching batch', true),
  ('Biggest drip at Ajit Road', false),
  ('Most likely to crack JEE Advanced in top 100?', false)
) AS t(q, is_crush)
WHERE NOT EXISTS (
  SELECT 1 FROM public.polls WHERE question = t.q
);
