--
-- PostgreSQL database dump (target)
--

CREATE TABLE public.added (
    id integer NOT NULL,
    code text,
    CONSTRAINT added_code_check CHECK (code <> '')
);

CREATE TABLE public.users (
    id integer NOT NULL,
    email text,
    nickname text,
    age integer,
    CONSTRAINT users_age_check CHECK (age >= 0)
);

ALTER TABLE ONLY public.added ADD CONSTRAINT added_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.added ADD CONSTRAINT added_code_key UNIQUE (code);

ALTER TABLE ONLY public.users ADD CONSTRAINT users_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.users ADD CONSTRAINT users_nickname_key_v2 UNIQUE (nickname);

CREATE UNIQUE INDEX added_code_idx ON public.added USING btree (code);

CREATE UNIQUE INDEX users_email_idx ON public.users USING btree (email);

CREATE INDEX CONCURRENTLY users_age_idx_v2 ON public.users USING btree (age);
