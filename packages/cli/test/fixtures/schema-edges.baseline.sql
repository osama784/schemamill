--
-- PostgreSQL database dump (schema-edges baseline)
--

CREATE SCHEMA app;

CREATE TABLE app.widgets (
    id integer NOT NULL,
    name text
);

CREATE TABLE public."MixedCase" (
    "Id" integer NOT NULL,
    "Note" text
);

CREATE TABLE public."Quoted Target" (
    id integer NOT NULL
);

CREATE TABLE public.empty (
);

ALTER TABLE ONLY app.widgets ADD CONSTRAINT widgets_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public."MixedCase" ADD CONSTRAINT "MixedCase_pkey" PRIMARY KEY ("Id");

ALTER TABLE ONLY public."MixedCase"
    ADD CONSTRAINT "MixedCase_widget_id_fkey" FOREIGN KEY ("Id") REFERENCES app.widgets(id);

ALTER TABLE ONLY public."Quoted Target" ADD CONSTRAINT "Quoted Target_pkey" PRIMARY KEY (id);
