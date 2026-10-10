--
-- PostgreSQL database dump (baseline)
--

CREATE TABLE public.teams (
    id integer NOT NULL
);

CREATE TABLE public.users (
    id integer NOT NULL,
    email text CONSTRAINT users_email_nn NOT NULL,
    team_id integer
);

ALTER TABLE ONLY public.teams ADD CONSTRAINT teams_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.users ADD CONSTRAINT users_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.users ADD CONSTRAINT users_email_key UNIQUE (email);

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_team_fkey FOREIGN KEY (team_id) REFERENCES public.teams(id) NOT VALID;
