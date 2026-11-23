CREATE TABLE public.widgets (
    id integer NOT NULL,
    label text,
    CONSTRAINT widgets_pkey PRIMARY KEY (id)
);

CREATE TABLE public.retired (
    id integer NOT NULL
);

CREATE VIEW public.widget_names AS SELECT id,label FROM public.widgets;

COMMENT ON TABLE public.widgets IS 'old label';
