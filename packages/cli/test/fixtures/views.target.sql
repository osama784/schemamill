--
-- PostgreSQL database dump (views target)
--

CREATE TABLE public.accounts (
    id integer NOT NULL,
    email text,
    active boolean NOT NULL,
    balance integer NOT NULL
);

CREATE VIEW public.active_accounts AS SELECT id,email,active FROM public.accounts WHERE active AND email IS NOT NULL;

CREATE MATERIALIZED VIEW public.account_totals AS SELECT count(*) AS n FROM public.accounts WHERE active WITH NO DATA;

CREATE VIEW public.checked_accounts AS SELECT id FROM public.accounts WHERE balance > 0 WITH CASCADED CHECK OPTION;

CREATE MATERIALIZED VIEW public.kept_totals AS SELECT id, email, balance FROM public.accounts WHERE active WITH NO DATA;

CREATE MATERIALIZED VIEW public.recent_accounts AS SELECT id FROM public.accounts WHERE active WITH NO DATA;

CREATE MATERIALIZED VIEW public.promote_me AS SELECT id FROM public.accounts WITH NO DATA;

CREATE VIEW public.positive_accounts AS SELECT id FROM public.accounts WHERE balance >= 0 WITH LOCAL CHECK OPTION;

CREATE UNIQUE INDEX account_totals_balance_uq ON public.account_totals (balance);

CREATE INDEX kept_totals_fresh_idx ON public.kept_totals (balance);

CREATE INDEX kept_totals_shift_idx ON public.kept_totals (email);

CREATE INDEX recent_totals_lookup ON public.recent_accounts (id);
