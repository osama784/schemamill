BEGIN;
ALTER TABLE public.users DROP CONSTRAINT users_age_check;
ALTER TABLE public.users DROP CONSTRAINT users_age_key;
ALTER TABLE public.users ADD CONSTRAINT users_name_key UNIQUE (name);
ALTER TABLE public.users ADD CONSTRAINT users_age_check CHECK (age >= 18);
COMMIT;
