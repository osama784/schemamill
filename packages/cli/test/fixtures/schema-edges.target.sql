--
-- PostgreSQL database dump (schema-edges target)
--

CREATE SCHEMA app;

CREATE TABLE app.gadgets (
    id integer NOT NULL
);

CREATE TABLE app.widgets (
    id bigint NOT NULL,
    name text NOT NULL
);

CREATE TABLE public."MixedCase" (
    "Id" integer NOT NULL,
    "Note" character varying(50),
    "Extra" text
);

CREATE TABLE public."Quoted Added" (
    "Key" integer NOT NULL,
    "Value" text
);

CREATE TABLE public.empty (
    id integer NOT NULL
);

CREATE TABLE public.empty_added (
);

ALTER TABLE ONLY app.gadgets ADD CONSTRAINT gadgets_pkey PRIMARY KEY (id);

ALTER TABLE ONLY app.widgets ADD CONSTRAINT widgets_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public."MixedCase" ADD CONSTRAINT "MixedCase_pkey" PRIMARY KEY ("Id");

ALTER TABLE ONLY public."MixedCase"
    ADD CONSTRAINT "MixedCase_widget_id_fkey" FOREIGN KEY ("Id") REFERENCES app.widgets(id);

ALTER TABLE ONLY public."Quoted Added" ADD CONSTRAINT "Quoted Added_pkey" PRIMARY KEY ("Key");
