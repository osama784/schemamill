--
-- A diagnostic-rich DDL dump for the import fidelity report golden.
--

\restrict fidelity

CREATE VIEW app.v AS SELECT 1;

CREATE INDEX z_v_idx ON app.v (id);

CREATE INDEX a_v_idx ON app.v (id);

COPY public.users (id, email) FROM stdin;
1 alice@example.test
\.

CREATE TABLE app.like (LIKE app.t INCLUDING ALL);

CREATE TABLE public.broken (id bigint UNSIGNED);

\unrestrict fidelity
