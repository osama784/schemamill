--
-- PostgreSQL database dump (target)
--

CREATE TABLE public.teams (
    id integer NOT NULL
);

CREATE TABLE public.users (
    id integer NOT NULL,
    email text CONSTRAINT users_email_nn_v2 NOT NULL,
    team_id integer
);

ALTER TABLE ONLY public.teams ADD CONSTRAINT teams_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.users ADD CONSTRAINT users_pkey PRIMARY KEY (id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY public.users ADD CONSTRAINT users_email_key UNIQUE (email) DEFERRABLE;

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_check_v2 CHECK (email <> '') NOT ENFORCED;

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_team_fkey FOREIGN KEY (team_id) REFERENCES public.teams(id) NOT ENFORCED;
