--
-- PostgreSQL database dump (baseline)
--

CREATE TABLE public.gone (
    id integer NOT NULL,
    email text,
    age integer,
    CONSTRAINT gone_age_check CHECK (age >= 0)
);

CREATE TABLE public.users (
    id integer NOT NULL,
    email text,
    nickname text,
    age integer,
    CONSTRAINT users_age_check CHECK (age >= 18)
);

ALTER TABLE ONLY public.gone ADD CONSTRAINT gone_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.gone ADD CONSTRAINT gone_email_key UNIQUE (email);

ALTER TABLE ONLY public.users ADD CONSTRAINT users_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.users ADD CONSTRAINT users_nickname_key UNIQUE (nickname);

CREATE INDEX gone_email_idx ON public.gone USING btree (email);

CREATE INDEX users_email_idx ON public.users USING btree (email);

CREATE INDEX CONCURRENTLY users_age_idx ON public.users USING btree (age);
