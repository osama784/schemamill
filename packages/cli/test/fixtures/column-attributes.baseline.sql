--
-- PostgreSQL database dump (column-attributes baseline)
--

CREATE TABLE public.attrs (
    id integer NOT NULL,
    d_add integer,
    d_change integer DEFAULT 1,
    d_remove integer DEFAULT 7,
    c_add text,
    c_change text COLLATE pg_catalog."C",
    c_remove text COLLATE pg_catalog."C",
    s_add text,
    s_remove text,
    comp_add text,
    comp_remove text,
    merged text COLLATE pg_catalog."C"
);

ALTER TABLE ONLY public.attrs ALTER COLUMN s_remove SET STORAGE MAIN;

ALTER TABLE ONLY public.attrs ALTER COLUMN comp_remove SET COMPRESSION pglz;

CREATE UNLOGGED TABLE public.backed (
    id integer NOT NULL
);

CREATE TABLE public.flipped (
    id integer NOT NULL
);
