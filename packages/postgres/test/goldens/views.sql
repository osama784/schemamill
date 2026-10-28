BEGIN;
DROP MATERIALIZED VIEW app.demote;
DROP MATERIALIZED VIEW app.gone_totals;
DROP VIEW app.gone_view;
DROP VIEW app.promote;
DROP MATERIALIZED VIEW public.totals;
DROP TABLE public.stale;
CREATE TABLE public.ledger (
    id integer NOT NULL
);
CREATE VIEW app.demote AS SELECT team_id,count(*) AS n FROM app.events GROUP BY team_id;
CREATE MATERIALIZED VIEW app.promote AS SELECT id,count(*) AS n FROM app.events GROUP BY id WITH NO DATA;
CREATE VIEW public.added AS SELECT id FROM public.ledger;
CREATE MATERIALIZED VIEW public.new_totals AS SELECT team_id,count(*) AS n FROM public.accounts GROUP BY team_id WITH NO DATA;
CREATE VIEW public.positive AS SELECT id FROM public.accounts WHERE balance >= 0 WITH LOCAL CHECK OPTION;
CREATE MATERIALIZED VIEW public.totals AS SELECT count(*) AS n FROM public.accounts WHERE active WITH NO DATA;
CREATE OR REPLACE VIEW public.active AS SELECT id,email,active FROM public.accounts WHERE active AND email IS NOT NULL;
CREATE OR REPLACE VIEW public.checked AS SELECT id FROM public.accounts WHERE balance > 0 WITH CASCADED CHECK OPTION;
COMMIT;
