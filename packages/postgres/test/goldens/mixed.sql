BEGIN;
ALTER TABLE public.orders DROP CONSTRAINT orders_legacy_id_fkey;
ALTER TABLE public.users DROP CONSTRAINT users_obsolete_fkey;
ALTER TABLE public.users DROP CONSTRAINT users_group_id_fkey;
DROP TABLE public.audit;
DROP TABLE public.legacy_notes;
DROP TABLE public.legacy;
ALTER TABLE public.users DROP CONSTRAINT users_pkey;
ALTER TABLE public.users DROP COLUMN obsolete;
CREATE TABLE public.sessions (
    id integer NOT NULL,
    user_id integer NOT NULL,
    CONSTRAINT sessions_pkey PRIMARY KEY (id)
);
ALTER TABLE public.users ADD COLUMN email text;
ALTER TABLE public.users ALTER COLUMN name TYPE text;
ALTER TABLE public.users ADD PRIMARY KEY (id);
ALTER TABLE public.sessions ADD CONSTRAINT sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);
ALTER TABLE public.users ADD CONSTRAINT users_group_id_fkey FOREIGN KEY (group_id) REFERENCES public.groups(id) ON DELETE CASCADE;
COMMIT;
