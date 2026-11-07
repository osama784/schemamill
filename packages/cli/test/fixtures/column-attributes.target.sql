--
-- PostgreSQL database dump (column-attributes target)
--

CREATE TABLE public.attrs (
    id integer NOT NULL,
    d_add integer DEFAULT 1,
    d_change integer DEFAULT 2,
    d_remove integer,
    c_add text COLLATE pg_catalog."C",
    c_change text COLLATE pg_catalog."POSIX",
    c_remove text,
    s_add text,
    s_remove text,
    comp_add text,
    comp_remove text,
    merged character varying(12) COLLATE pg_catalog."POSIX",
    fresh text COLLATE pg_catalog."C"
);

ALTER TABLE ONLY public.attrs ALTER COLUMN s_add SET STORAGE EXTERNAL;

ALTER TABLE ONLY public.attrs ALTER COLUMN comp_add SET COMPRESSION pglz;

ALTER TABLE ONLY public.attrs ALTER COLUMN fresh SET STORAGE EXTENDED;

ALTER TABLE ONLY public.attrs ALTER COLUMN fresh SET COMPRESSION lz4;

CREATE TABLE public.backed (
    id integer NOT NULL
);

CREATE UNLOGGED TABLE public.flipped (
    id integer NOT NULL
);
