--
-- PostgreSQL database dump (views baseline)
--

CREATE TABLE public.accounts (
    id integer NOT NULL,
    email text,
    active boolean NOT NULL,
    balance integer NOT NULL
);

CREATE VIEW public.active_accounts AS SELECT id,email FROM public.accounts WHERE active;

CREATE MATERIALIZED VIEW public.account_totals AS SELECT count(*) AS n FROM public.accounts WITH NO DATA;

CREATE VIEW public.checked_accounts AS SELECT id FROM public.accounts WHERE balance > 0 WITH LOCAL CHECK OPTION;

CREATE VIEW public.obsolete_accounts AS SELECT id FROM public.accounts;

CREATE MATERIALIZED VIEW public.obsolete_totals AS SELECT count(*) AS n FROM public.accounts WITH NO DATA;

CREATE VIEW public.promote_me AS SELECT id FROM public.accounts;
