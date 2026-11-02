--
-- PostgreSQL database dump (baseline)
--

CREATE TABLE public.teams (
    id integer NOT NULL
);

CREATE TABLE public.guests (
    id integer NOT NULL,
    team_id integer
);

CREATE TABLE public.members (
    id integer NOT NULL,
    team_id integer
);

ALTER TABLE ONLY public.teams ADD CONSTRAINT teams_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.guests ADD CONSTRAINT guests_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.members ADD CONSTRAINT members_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.guests ADD CONSTRAINT guests_team_fk FOREIGN KEY (team_id) REFERENCES public.teams(id) NOT ENFORCED;
ALTER TABLE ONLY public.members ADD CONSTRAINT members_team_fk FOREIGN KEY (team_id) REFERENCES public.teams(id);
