CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;

CREATE SEQUENCE public.widget_seq
    AS bigint
    INCREMENT BY 0
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

CREATE TABLE public.widgets (
    id integer NOT NULL,
    label text NOT NULL,
    score integer,
    CONSTRAINT widgets_pkey PRIMARY KEY (id)
);

CREATE TABLE public.gadgets (
    id integer NOT NULL,
    widget_id integer,
    CONSTRAINT gadgets_pkey PRIMARY KEY (id)
);

CREATE INDEX widgets_score_idx ON public.widgets USING btree (score);

CREATE VIEW public.widget_names AS SELECT id,label,score FROM public.widgets;

CREATE MATERIALIZED VIEW public.widget_scores AS SELECT id,score FROM public.widgets WITH NO DATA;

CREATE INDEX CONCURRENTLY widget_scores_score_idx ON public.widget_scores USING btree (score);

COMMENT ON TABLE public.widgets IS 'new label';

COMMENT ON EXTENSION pgcrypto IS 'crypto helpers';
