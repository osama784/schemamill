--
-- PostgreSQL database dump (comments baseline)
--

CREATE SEQUENCE public.invoice_seq
    AS bigint
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

CREATE TABLE public.accounts (
    id integer NOT NULL,
    email text,
    status text
);

CREATE TABLE public.audit (
    id integer NOT NULL,
    note text,
    amount integer,
    CONSTRAINT audit_note_check CHECK (note <> ''),
    CONSTRAINT audit_amount_check CHECK (amount >= 0)
);

CREATE TABLE public.members (
    id integer NOT NULL,
    team_id integer
);

CREATE TABLE public.teams (
    id integer NOT NULL,
    code text
);

CREATE MATERIALIZED VIEW public.account_totals AS SELECT count(*) AS n FROM public.accounts WITH NO DATA;

CREATE VIEW public.active_accounts AS SELECT id,email FROM public.accounts WHERE status = 'active';

ALTER TABLE ONLY public.audit
    ADD CONSTRAINT audit_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.members
    ADD CONSTRAINT members_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.teams
    ADD CONSTRAINT teams_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.teams
    ADD CONSTRAINT teams_code_key UNIQUE (code);

ALTER TABLE ONLY public.members
    ADD CONSTRAINT members_team_fkey FOREIGN KEY (team_id) REFERENCES public.teams(id);

CREATE INDEX accounts_email_lookup ON public.accounts USING btree (email);

CREATE INDEX accounts_status_idx ON public.accounts USING btree (status);

COMMENT ON TABLE public.accounts IS 'accounts v1';

COMMENT ON TABLE public.audit IS 'temporary table note';

COMMENT ON COLUMN public.accounts.email IS 'login address';

COMMENT ON SEQUENCE public.invoice_seq IS 'invoice numbering';

COMMENT ON MATERIALIZED VIEW public.account_totals IS 'totals snapshot';

COMMENT ON VIEW public.active_accounts IS 'active accounts view';

COMMENT ON INDEX accounts_email_lookup IS 'email lookup';

COMMENT ON INDEX accounts_status_idx IS 'status filter';

COMMENT ON CONSTRAINT audit_amount_check ON public.audit IS 'amount guard';

COMMENT ON CONSTRAINT audit_note_check ON public.audit IS 'note v1';

COMMENT ON CONSTRAINT members_team_fkey ON public.members IS 'member team';

COMMENT ON CONSTRAINT teams_pkey ON public.teams IS 'team identity';

COMMENT ON CONSTRAINT teams_code_key ON public.teams IS 'team code v1';
